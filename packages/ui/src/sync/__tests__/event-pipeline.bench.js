/**
 * Synthetic benchmark for the event pipeline.
 *
 * Measures how much per-directory queueing + delta coalescing shrinks the
 * delivered event stream and how long enqueue/flush takes for realistic
 * multi-session workloads (parent + subagent token streaming).
 *
 * Run with:
 *   bun packages/ui/src/sync/__tests__/event-pipeline.bench.js
 *
 * This is NOT a bun:test file — it prints a report and exits. Integrity is a
 * hard assertion so incomplete replay can never masquerade as event loss.
 */

import assert from 'node:assert/strict';

import { createEventPipeline } from '../event-pipeline.ts';
import {
  getResponsivenessPerfSnapshot,
  resetStreamPerf,
  setStreamPerfEnabled,
} from '../../stores/utils/streamDebug.ts';

// ---------------------------------------------------------------------------
// Minimal DOM stubs (same approach as the unit tests)
// ---------------------------------------------------------------------------

const storage = new Map();
const windowEvents = new EventTarget();

globalThis.document = {
  visibilityState: 'visible',
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window = {
  localStorage: {
    getItem(key) {
      return storage.get(key) ?? null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    },
  },
  addEventListener: windowEvents.addEventListener.bind(windowEvents),
  removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
  dispatchEvent: windowEvents.dispatchEvent.bind(windowEvents),
};

// ---------------------------------------------------------------------------
// SDK mock that replays a pre-generated event list
// ---------------------------------------------------------------------------

function createReplaySdk(events, hold) {
  let resolveReplayComplete;
  const replayComplete = new Promise((resolve) => {
    resolveReplayComplete = resolve;
  });

  const sdk = {
    global: {
      event: async () => ({
        stream: (async function* () {
          for (const event of events) {
            yield event;
          }
          resolveReplayComplete();
          await hold;
        })(),
      }),
    },
  };

  return { sdk, replayComplete };
}

// ---------------------------------------------------------------------------
// Workload generators
// ---------------------------------------------------------------------------

/**
 * Token-stream workload: N sessions in `directoryCount` directories, each
 * emitting `tokensPerSession` text deltas plus a few framing events.
 *
 * Shape is intentionally close to a real opencode session:
 *   session.status(busy)
 *   message.part.delta × tokensPerSession   (coalescible)
 *   message.part.updated                    (final state)
 *   session.status(idle)
 */
function buildTokenStreamWorkload({
  directoryCount,
  sessionsPerDirectory,
  tokensPerSession,
}) {
  const events = [];
  for (let d = 0; d < directoryCount; d++) {
    const directory = `dir-${d}`;
    for (let s = 0; s < sessionsPerDirectory; s++) {
      const sessionID = `dir-${d}-s${s}`;
      const messageID = `${sessionID}-m1`;
      const partID = `${messageID}-p1`;
      let finalText = '';

      events.push({
        directory,
        payload: {
          type: 'session.status',
          properties: { sessionID, status: { type: 'busy' } },
        },
      });

      for (let t = 0; t < tokensPerSession; t++) {
        // Use an unambiguous incremental character. Repeated "x" chunks can
        // legitimately be collapsed by the production duplicate-frame guard
        // once they form a long adjacent repeat, which makes them unsuitable
        // for byte-integrity measurement.
        const delta = String.fromCharCode(0xe000 + t);
        finalText += delta;
        events.push({
          directory,
          payload: {
            type: 'message.part.delta',
            properties: {
              messageID,
              partID,
              field: 'text',
              delta,
            },
          },
        });
      }

      events.push({
        directory,
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: partID,
              type: 'text',
              messageID,
              text: finalText,
            },
          },
        },
      });

      events.push({
        directory,
        payload: {
          type: 'session.status',
          properties: { sessionID, status: { type: 'idle' } },
        },
      });
    }
  }

  // Interleave events across directories/sessions so we exercise the real
  // "parent + subagent" arrival pattern instead of one session at a time.
  return interleave(events);
}

// Shuffle events within each directory bucket so arrivals are interleaved but
// still ordered within a single (sessionID, partID) stream (deltas must stay
// ordered relative to each other for append semantics to remain correct).
function interleave(events) {
  const buckets = new Map(); // directory -> list of events (in original order)
  for (const e of events) {
    const bucket = buckets.get(e.directory) ?? [];
    bucket.push(e);
    buckets.set(e.directory, bucket);
  }
  const out = [];
  let more = true;
  while (more) {
    more = false;
    for (const bucket of buckets.values()) {
      if (bucket.length > 0) {
        out.push(bucket.shift());
        more = true;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runner — pushes a workload through the pipeline and measures
// ---------------------------------------------------------------------------

async function runScenario(label, workload) {
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });

  let delivered = 0;
  let deliveredDeltas = 0;
  let deliveredDeltaBytes = 0;

  const { sdk, replayComplete } = createReplaySdk(workload, hold);
  setStreamPerfEnabled(true);
  resetStreamPerf();

  const startWall = performance.now();
  const { cleanup } = createEventPipeline({
    sdk,
    transport: 'sse',
    onEvent: (_directory, payload) => {
      delivered++;
      if (payload.type === 'message.part.delta') {
        deliveredDeltas++;
        deliveredDeltaBytes += payload.properties.delta.length;
      }
    },
  });

  await replayComplete;
  cleanup();
  release();
  const endWall = performance.now();

  // Count input-side delta events for comparison
  const inputDeltas = workload.filter((e) => e.payload.type === 'message.part.delta').length;
  const inputDeltaBytes = workload
    .filter((e) => e.payload.type === 'message.part.delta')
    .reduce((n, e) => n + e.payload.properties.delta.length, 0);

  const wallMs = endWall - startWall;
  const reductionPct = inputDeltas === 0 ? 0 : (1 - deliveredDeltas / inputDeltas) * 100;
  const perfEntries = new Map(
    getResponsivenessPerfSnapshot().entries.map((entry) => [entry.metric, entry]),
  );
  const flushCount = perfEntries.get('responsiveness.event_pipeline.flush_count')?.count ?? 0;
  const flushSize = perfEntries.get('responsiveness.event_pipeline.flush_size');
  const flushDuration = perfEntries.get('responsiveness.event_pipeline.flush_ms');
  // Bun and Node currently expose different maxRSS units on macOS. Use the
  // unambiguous current RSS sample instead of publishing a false peak value.
  const rssBytes = process.memoryUsage().rss;

  assert.equal(
    deliveredDeltaBytes,
    inputDeltaBytes,
    `${label}: delivered delta bytes must match input delta bytes`,
  );

  return {
    label,
    inputEvents: workload.length,
    inputDeltas,
    inputDeltaBytes,
    deliveredEvents: delivered,
    deliveredDeltas,
    deliveredDeltaBytes,
    reductionPct,
    wallMs,
    flushCount,
    maxFlushSize: flushSize?.max ?? 0,
    totalFlushMs: flushDuration?.total ?? 0,
    rssBytes,
  };
}

function formatRow(r) {
  const cols = [
    r.label.padEnd(44),
    String(r.inputEvents).padStart(8),
    String(r.deliveredEvents).padStart(8),
    String(r.inputDeltas).padStart(8),
    String(r.deliveredDeltas).padStart(8),
    `${r.reductionPct.toFixed(1)}%`.padStart(8),
    String(r.flushCount).padStart(7),
    String(r.maxFlushSize).padStart(8),
    `${r.totalFlushMs.toFixed(1)}ms`.padStart(10),
    `${r.wallMs.toFixed(1)}ms`.padStart(10),
    `${(r.rssBytes / 1024 / 1024).toFixed(1)}MiB`.padStart(10),
    'bytes ✓',
  ];
  return cols.join('  ');
}

function header() {
  const cols = [
    'scenario'.padEnd(44),
    'in'.padStart(8),
    'out'.padStart(8),
    'in Δ'.padStart(8),
    'out Δ'.padStart(8),
    'reduce'.padStart(8),
    'flushes'.padStart(7),
    'max batch'.padStart(8),
    'flush ms'.padStart(10),
    'wall'.padStart(10),
    'RSS'.padStart(10),
    'integrity',
  ];
  return cols.join('  ');
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const scenarios = [
  {
    label: 'single project, 1 session, 500 tokens',
    workload: buildTokenStreamWorkload({
      directoryCount: 1,
      sessionsPerDirectory: 1,
      tokensPerSession: 500,
    }),
  },
  {
    label: 'single project, parent + 1 subagent, 500 tokens each',
    workload: buildTokenStreamWorkload({
      directoryCount: 1,
      sessionsPerDirectory: 2,
      tokensPerSession: 500,
    }),
  },
  {
    label: 'single project, parent + 3 subagents, 500 tokens each',
    workload: buildTokenStreamWorkload({
      directoryCount: 1,
      sessionsPerDirectory: 4,
      tokensPerSession: 500,
    }),
  },
  {
    label: 'single project, parent + 9 subagents, 200 tokens each',
    workload: buildTokenStreamWorkload({
      directoryCount: 1,
      sessionsPerDirectory: 10,
      tokensPerSession: 200,
    }),
  },
  {
    label: '3 projects, 1 session each, 500 tokens',
    workload: buildTokenStreamWorkload({
      directoryCount: 3,
      sessionsPerDirectory: 1,
      tokensPerSession: 500,
    }),
  },
  {
    label: '3 projects × (parent + subagent), 500 tokens each',
    workload: buildTokenStreamWorkload({
      directoryCount: 3,
      sessionsPerDirectory: 2,
      tokensPerSession: 500,
    }),
  },
  {
    label: '5 projects × parent + 3 subagents, 200 tokens',
    workload: buildTokenStreamWorkload({
      directoryCount: 5,
      sessionsPerDirectory: 4,
      tokensPerSession: 200,
    }),
  },
  {
    label: 'stress: 10 projects × 5 sessions × 1000 tokens',
    workload: buildTokenStreamWorkload({
      directoryCount: 10,
      sessionsPerDirectory: 5,
      tokensPerSession: 1000,
    }),
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('event-pipeline synthetic benchmark\n');
  console.log(header());
  console.log('-'.repeat(header().length + 8));

  const selectedScenarios = process.env.EVENT_PIPELINE_BENCH_SCENARIO === 'small'
    ? scenarios.slice(0, 1)
    : scenarios;
  const results = [];
  for (const { label, workload } of selectedScenarios) {
    const r = await runScenario(label, workload);
    results.push(r);
    console.log(formatRow(r));
  }

  console.log('\nLegend:');
  console.log('  in       — total events fed into the pipeline');
  console.log('  out      — total events dispatched via onEvent after coalescing + flush');
  console.log('  in Δ     — input events of type message.part.delta');
  console.log('  out Δ    — delta events that actually made it to onEvent (after merging)');
  console.log('  reduce   — (1 − outΔ / inΔ) × 100, i.e. how much delta traffic shrunk');
  console.log('  flushes  — number of per-directory batches dispatched');
  console.log('  max batch — largest number of events dispatched in one flush');
  console.log('  flush ms — total time spent invoking onEvent across flushes');
  console.log('  wall     — total wall-clock time through replay completion and final flush');
  console.log('  RSS      — process resident set size sampled after the final flush');
  console.log('  integrity — "bytes ✓" means the concatenated delta bytes match the input total');
  console.log('');
  console.log('Interpretation:');
  console.log('  Higher reduce % = fewer reducer invocations, fewer React setState calls,');
  console.log('  fewer allocations inside the flush loop. The integrity check confirms no');
  console.log('  text was dropped during coalescing.');
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('benchmark failed:', error);
    process.exitCode = 1;
  });
