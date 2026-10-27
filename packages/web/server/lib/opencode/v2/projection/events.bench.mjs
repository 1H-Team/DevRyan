#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Gen 2 event projector cost on the hub's streaming path (DESIGN.md F13).
//
// Simulates N concurrent sessions, each streaming D deltas per second for S
// simulated seconds, as real v2 envelopes (already parsed: protocol.js parses
// each frame once before projection). Every session runs back-to-back turns:
// inbox delivery, execution start, reasoning, text, a tool call with progress,
// a second step, and the execution terminal. Sessions interleave by
// timestamp, so the session LRU is touched on almost every event.
//
// Only `projector.project(envelope)` is timed, per event, with
// process.hrtime.bigint(); envelope generation happens before the timed loop.
//
//   node packages/web/server/lib/opencode/v2/projection/events.bench.mjs
//     [--sessions 8] [--deltas-per-second 10] [--seconds 300] [--json]
//
// Exits 1 when the gen 2 p99 is not below the 50 µs budget.
// ---------------------------------------------------------------------------

import { pathToFileURL } from 'node:url';

import { createEventProjector } from './events.js';

export const EVENT_PROJECTOR_P99_BUDGET_US = 50;

const DIRECTORY = '/bench/workspace';
const DELTA_TEXT = 'lorem ipsum dolor ';

const sessionId = (index) => `ses_bench${String(index).padStart(4, '0')}normalized0000`;

/**
 * Builds the envelope stream for one session, timestamped in simulated ms.
 * @param {number} index session index
 * @param {{ deltasPerSecond: number, seconds: number }} options
 */
const sessionStream = (index, { deltasPerSecond, seconds }) => {
  const sessionID = sessionId(index);
  const location = { directory: DIRECTORY };
  const events = [];
  let sequence = 0;
  let message = 0;
  // Offset each session so the streams interleave instead of arriving in lockstep.
  let time = 1_767_225_600_000 + index * 7;
  const end = time + seconds * 1000;
  const deltaGap = Math.max(1, Math.round(1000 / deltasPerSecond));
  const push = (type, data, withLocation = true) => {
    sequence += 1;
    const envelope = { id: `evt_b${index}_${sequence}`, created: time, type, data: { sessionID, ...data } };
    if (withLocation) envelope.location = location;
    events.push(envelope);
  };
  const messageId = () => {
    message += 1;
    return `msg_b${index}_${String(message).padStart(8, '0')}`;
  };
  const stream = (kind, assistantMessageID, count) => {
    push(`session.${kind}.started`, { assistantMessageID, ordinal: 0 });
    let text = '';
    for (let delta = 0; delta < count && time < end; delta += 1) {
      time += deltaGap;
      text += DELTA_TEXT;
      push(`session.${kind}.delta`, { assistantMessageID, ordinal: 0, delta: DELTA_TEXT });
    }
    push(`session.${kind}.ended`, { assistantMessageID, ordinal: 0, text });
  };

  push('session.created', {
    slug: `bench-${index}`, version: '2.0.20', projectID: 'bench', location, subpath: '', title: `Bench ${index}`,
  });
  while (time < end) {
    const userID = messageId();
    push('session.inbox.enqueued', { inboxID: userID, item: { type: 'user', payload: { text: 'go' }, delivery: 'steer' } });
    push('session.execution.started', {}, false);
    time += 1;
    push('session.inbox.delivered', { inboxID: userID });
    const first = messageId();
    time += 1;
    push('session.step.started', { agent: 'build', model: { id: 'm1', providerID: 'sim' }, assistantMessageID: first, started: time });
    stream('reasoning', first, deltasPerSecond);
    stream('text', first, deltasPerSecond * 2);
    const callID = `call_${first}`;
    push('session.tool.input.started', { assistantMessageID: first, id: callID, name: 'read' });
    push('session.tool.called', { assistantMessageID: first, id: callID, input: { path: 'README.md' }, executed: false });
    time += 50;
    push('session.tool.progress', { assistantMessageID: first, id: callID, metadata: { phase: 'read' } }, false);
    time += 50;
    push('session.tool.success', {
      assistantMessageID: first, id: callID, content: [{ type: 'text', text: 'ok' }], metadata: { truncated: false }, executed: false,
    });
    const tokens = { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } };
    push('session.step.ended', { assistantMessageID: first, finish: 'tool-calls', cost: 0, tokens });
    push('session.usage.updated', { cost: 0, tokens }, false);
    const second = messageId();
    time += 1;
    push('session.step.started', { agent: 'build', model: { id: 'm1', providerID: 'sim' }, assistantMessageID: second, started: time });
    stream('text', second, deltasPerSecond * 2);
    push('session.step.ended', { assistantMessageID: second, finish: 'stop', cost: 0, tokens });
    push('session.execution.succeeded', {}, false);
    time += 500;
  }
  return events;
};

/**
 * Merges per-session streams by simulated time (stable for equal times).
 * @param {object[][]} streams
 */
const interleave = (streams) => {
  const merged = [];
  const cursors = streams.map(() => 0);
  for (;;) {
    let best = -1;
    for (let index = 0; index < streams.length; index += 1) {
      const event = streams[index][cursors[index]];
      if (event === undefined) continue;
      if (best === -1 || event.created < streams[best][cursors[best]].created) best = index;
    }
    if (best === -1) return merged;
    merged.push(streams[best][cursors[best]]);
    cursors[best] += 1;
  }
};

const percentile = (sorted, fraction) => {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)];
};

/**
 * Runs the benchmark and returns per-event projection latency in microseconds.
 * @param {{ sessions?: number, deltasPerSecond?: number, seconds?: number, warmupSeconds?: number }} [options]
 */
export function runEventProjectorBench({
  sessions = 8,
  deltasPerSecond = 10,
  seconds = 300,
  warmupSeconds = 20,
} = {}) {
  // Warm the JIT on a separate projector so the measured run starts from optimized code.
  const warmup = createEventProjector();
  const warmupEvents = interleave(Array.from({ length: sessions }, (_, index) => (
    sessionStream(index, { deltasPerSecond, seconds: warmupSeconds })
  )));
  for (const envelope of warmupEvents) warmup.project(envelope);

  const events = interleave(Array.from({ length: sessions }, (_, index) => (
    sessionStream(index + sessions, { deltasPerSecond, seconds })
  )));
  const projector = createEventProjector();
  const samples = new Float64Array(events.length);
  let payloads = 0;
  let deltas = 0;
  for (let index = 0; index < events.length; index += 1) {
    const envelope = events[index];
    const started = process.hrtime.bigint();
    const projected = projector.project(envelope);
    const elapsed = process.hrtime.bigint() - started;
    samples[index] = Number(elapsed) / 1000;
    payloads += projected.length;
    if (envelope.type.endsWith('.delta')) deltas += 1;
  }
  const sorted = Array.from(samples).sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const round = (value) => Math.round(value * 1000) / 1000;
  return {
    generation: 2,
    sessions,
    deltasPerSecond,
    simulatedSeconds: seconds,
    events: events.length,
    deltas,
    payloads,
    p50Us: round(percentile(sorted, 0.5)),
    p99Us: round(percentile(sorted, 0.99)),
    maxUs: round(sorted[sorted.length - 1] ?? 0),
    meanUs: round(events.length === 0 ? 0 : total / events.length),
    budgetUs: EVENT_PROJECTOR_P99_BUDGET_US,
    stats: projector.stats(),
  };
}

const readFlag = (args, name, fallback) => {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const args = process.argv.slice(2);
  const result = runEventProjectorBench({
    sessions: readFlag(args, '--sessions', 8),
    deltasPerSecond: readFlag(args, '--deltas-per-second', 10),
    seconds: readFlag(args, '--seconds', 300),
  });
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `gen 2 event projector: ${result.events} events (${result.deltas} deltas) from ${result.sessions} sessions `
      + `x ${result.deltasPerSecond} deltas/s over ${result.simulatedSeconds} simulated s\n`
      + `p50 ${result.p50Us} µs  p99 ${result.p99Us} µs  max ${result.maxUs} µs  mean ${result.meanUs} µs  `
      + `(budget p99 < ${result.budgetUs} µs)\n`,
    );
  }
  if (!(result.p99Us < EVENT_PROJECTOR_P99_BUDGET_US)) process.exitCode = 1;
}
