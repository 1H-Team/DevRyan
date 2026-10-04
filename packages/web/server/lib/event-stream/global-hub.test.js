import { projectedFrame, createProjectedStreamClient } from './test-projected-stream.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLoopbackOpenCodeFixtureForGeneration } from '../../../../../scripts/perf/loopback-opencode-fixtures.mjs';
import { createOpenCodeClient } from '../opencode/opencode-client/index.js';
import { createEventProjector } from '../opencode/v2/projection/events.js';
import {
  createGlobalMessageStreamHub,
  GLOBAL_HUB_DIAGNOSTICS,
  matchesMessageStreamDirectory,
} from './global-hub.js';
import { createGlobalMessageStreamWsBridge } from './global-ws-bridge.js';
import { isMessageStreamControlPayload, MESSAGE_STREAM_GAP_CONTROL_TYPE } from './protocol.js';
import { GEN2_UPSTREAM_STALL_TIMEOUT_MS } from './upstream-reader.js';
import { stripEventDiffContent } from '../opencode/diff-summary.js';

function createSseResponse({ blocks = [] } = {}) {
  const encoder = new TextEncoder();
  let index = 0;

  return {
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            if (index < blocks.length) {
              return { value: encoder.encode(blocks[index++]), done: false };
            }
            return { value: undefined, done: true };
          },
        };
      },
    },
  };
}

async function waitForAssertion(assertion) {
  const deadline = Date.now() + 1000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw lastError;
}

describe('createGlobalMessageStreamHub', () => {
  it('publishes synthetic events through subscribers and replay', async () => {
    const received = [];
    const hub = createGlobalMessageStreamHub({
      openCodeClient: createProjectedStreamClient(),
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse(),
    });

    hub.subscribeEvent((event) => {
      received.push(event);
    });

    const published = hub.publishSyntheticEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'text',
            text: 'hello',
          },
        },
      },
      directory: '/tmp/project',
      eventId: 'synthetic-1',
    });

    expect(published).toEqual({
      envelope: {
        directory: '/tmp/project',
        eventId: 'synthetic-1',
      },
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'text',
            text: 'hello',
          },
        },
      },
      directory: '/tmp/project',
      eventId: 'synthetic-1',
      synthetic: true,
    });
    expect(received).toEqual([published]);
    expect(hub.replayAfter('')).toEqual({ events: [], gap: false });
    expect(hub.replayAfter('synthetic-1')).toEqual({ events: [], gap: false });
    expect(hub.replayAfter('missing-id')).toEqual({ events: [published], gap: true });
  });

  it('replays only the existing bounded buffer for explicit cursor-free recovery and preserves initial subscriptions', () => {
    const hub = createGlobalMessageStreamHub({ openCodeClient: createProjectedStreamClient(), replayLimit: 2 });
    expect(hub.replayAfter('', { unanchored: true })).toEqual({ events: [], gap: true });
    for (const [index, directory] of [[1, '/one'], [2, '/two'], [3, '/one']]) {
      hub.publishSyntheticEvent({ eventId: `evt-${index}`, directory, payload: { type: 'message.part.delta', properties: { index } } });
    }
    expect(hub.replayAfter('')).toEqual({ events: [], gap: false });
    expect(hub.replayAfter('', { unanchored: true }).events.map(entry => entry.eventId)).toEqual(['evt-2', 'evt-3']);
    expect(hub.replayAfter('', { unanchored: true, directory: '/one' }).events.map(entry => entry.eventId)).toEqual(['evt-3']);
    expect(hub.replayAfter('evt-2', { unanchored: true }).gap).toBe(false);
    expect(hub.replayAfter('evt-2', { unanchored: true }).events.map(entry => entry.eventId)).toEqual(['evt-3']);
  });

  it('continues fanout when an event subscriber throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received = [];
    const hub = createGlobalMessageStreamHub({
      openCodeClient: createProjectedStreamClient(),
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          projectedFrame({"type": "session.updated", "properties": {}}, {"id": "evt-1"}),
        ],
      }),
    });

    hub.subscribeEvent(() => {
      throw new Error('subscriber failed');
    });
    hub.subscribeEvent((event) => {
      received.push(event.eventId);
    });

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(received).toEqual(['evt-1']);
      });
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      hub.stop();
      warnSpy.mockRestore();
    }
  });

  it('continues status fanout when a status subscriber throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received = [];
    const hub = createGlobalMessageStreamHub({
      openCodeClient: createProjectedStreamClient(),
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse(),
    });

    hub.subscribeStatus(() => {
      throw new Error('status subscriber failed');
    });
    hub.subscribeStatus((status) => {
      received.push(status.type);
    });

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(received).toContain('connect');
      });
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      hub.stop();
      warnSpy.mockRestore();
    }
  });

  it('applies transformEventPayload before fanout and replay', async () => {
    const received = [];
    const hub = createGlobalMessageStreamHub({
      openCodeClient: createProjectedStreamClient(),
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          projectedFrame({"type": "message.updated", "properties": {"info": {"id": "msg_1", "role": "assistant", "tokens": {"input": 10}}}}, {"id": "evt-1"}),
        ],
      }),
      transformEventPayload: (payload) => {
        if (payload?.type !== 'message.updated') return payload;
        return {
          ...payload,
          properties: {
            ...payload.properties,
            transformed: true,
          },
        };
      },
    });

    hub.subscribeEvent((event) => {
      received.push(event);
    });

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(received).toHaveLength(1);
      });
      expect(received[0].payload.properties.transformed).toBe(true);
      const replay = hub.replayAfter('missing-id');
      expect(replay.events[0].payload.properties.transformed).toBe(true);
    } finally {
      hub.stop();
    }
  });

  it('keeps the original event when transformEventPayload throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received = [];
    const hub = createGlobalMessageStreamHub({
      openCodeClient: createProjectedStreamClient(),
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          projectedFrame({"type": "session.updated", "properties": {}}, {"id": "evt-1"}),
        ],
      }),
      transformEventPayload: () => {
        throw new Error('transform failed');
      },
    });

    hub.subscribeEvent((event) => {
      received.push(event.eventId);
    });

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(received).toEqual(['evt-1']);
      });
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      hub.stop();
      warnSpy.mockRestore();
    }
  });

  it('drops repeated upstream IDs before transformation while retaining ID-less events', async () => {
    const received = [];
    const transformEventPayload = vi.fn((payload) => payload);
    const hub = createGlobalMessageStreamHub({
      openCodeClient: createProjectedStreamClient(),
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          projectedFrame({"type": "session.updated", "properties": {"sequence": 1}}, {"id": "evt-1"}),
          projectedFrame({"type": "session.updated", "properties": {"sequence": 1}}, {"id": "evt-1"}),
          projectedFrame({"type": "server.connected", "properties": {"sequence": 2}}),
          projectedFrame({"type": "server.connected", "properties": {"sequence": 3}}),
        ],
      }),
      transformEventPayload,
    });
    hub.subscribeEvent((event) => received.push(event));

    try {
      hub.start();
      await waitForAssertion(() => expect(received).toHaveLength(3));
      expect(received[0].eventId).toBe('evt-1');
      expect(received[1].eventId).toMatch(/^devryan-/);
      expect(received[2].eventId).toMatch(/^devryan-/);
      expect(received[2].eventId).not.toBe(received[1].eventId);
      expect(received[1].envelope.eventId).toBeUndefined();
      expect(transformEventPayload).toHaveBeenCalledTimes(3);
      expect(hub.replayAfter('missing').events).toEqual(received);
      expect(hub.replayAfter(received[1].eventId).events).toEqual([received[2]]);
    } finally {
      hub.stop();
    }
  });

  it('strips diff patch bodies from message.updated before fanout and replay with the shared transform', async () => {
    const received = [];
    const upstream = {
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_1',
          role: 'user',
          summary: {
            additions: 2,
            deletions: 1,
            files: 1,
            diffs: [{ file: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b' }],
          },
        },
      },
    };
    const hub = createGlobalMessageStreamHub({
      openCodeClient: createProjectedStreamClient(),
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [projectedFrame(upstream, { id: 'evt-1' })],
      }),
      transformEventPayload: stripEventDiffContent,
    });
    hub.subscribeEvent((event) => received.push(event));

    try {
      hub.start();
      await waitForAssertion(() => expect(received).toHaveLength(1));
      const expectedSummary = {
        additions: 2,
        deletions: 1,
        files: 1,
        diffs: [{ file: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 }],
      };
      expect(received[0].payload.properties.info.summary).toEqual(expectedSummary);
      expect(hub.replayAfter('missing').events[0].payload.properties.info.summary).toEqual(expectedSummary);
      // Replay must not retain the untransformed payload through the envelope.
      expect(received[0].envelope).toEqual({ eventId: 'evt-1', directory: 'global' });
      expect(JSON.stringify(hub.replayAfter('missing').events)).not.toContain('@@ -1 +1 @@');
    } finally {
      hub.stop();
    }
  });

  it('retains native deduplication IDs independently of replay eviction', async () => {
    const received = [];
    const hub = createGlobalMessageStreamHub({
      openCodeClient: createProjectedStreamClient(),
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      replayLimit: 2,
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          projectedFrame({"type": "session.updated", "properties": {"sequence": 1}}, {"id": "evt-1"}),
          projectedFrame({"type": "session.updated", "properties": {"sequence": 2}}, {"id": "evt-2"}),
          projectedFrame({"type": "session.updated", "properties": {"sequence": 3}}, {"id": "evt-3"}),
          projectedFrame({"type": "session.updated", "properties": {"sequence": 4}}, {"id": "evt-1"}),
        ],
      }),
    });
    hub.subscribeEvent((event) => received.push(event));

    try {
      hub.start();
      await waitForAssertion(() => expect(received).toHaveLength(3));
      expect(received.map((event) => event.eventId)).toEqual(['evt-1', 'evt-2', 'evt-3']);
      expect(hub.replayAfter('missing').events.map((event) => event.eventId)).toEqual(['evt-2', 'evt-3']);
    } finally {
      hub.stop();
    }
  });

  it('continues fanout when an async event subscriber rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received = [];
    const hub = createGlobalMessageStreamHub({
      openCodeClient: createProjectedStreamClient(),
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          projectedFrame({"type": "session.updated", "properties": {}}, {"id": "evt-1"}),
        ],
      }),
    });

    hub.subscribeEvent(async () => {
      throw new Error('async subscriber failed');
    });
    hub.subscribeEvent((event) => {
      received.push(event.eventId);
    });

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(received).toEqual(['evt-1']);
      });
      await waitForAssertion(() => {
        expect(warnSpy).toHaveBeenCalled();
      });
    } finally {
      hub.stop();
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Gen 2 (OpenCode 2.0.20, DESIGN.md B.7)

const VECTORS = new URL('../opencode/v2/__vectors__/', import.meta.url);
const readVector = (name) => JSON.parse(readFileSync(new URL(name, VECTORS), 'utf8'));
const frameEnvelope = (frame) => JSON.parse(frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n'));
const V2_BASE_URL = 'http://127.0.0.1:4096';

function createHeldSseResponse({ blocks = [], signal, holdOpen = false }) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (index < blocks.length) return { value: encoder.encode(blocks[index++]), done: false };
            if (!holdOpen) return { value: undefined, done: true };
            return new Promise((_resolve, reject) => {
              const onAbort = () => {
                const error = new Error('Aborted');
                error.name = 'AbortError';
                reject(error);
              };
              if (signal.aborted) onAbort();
              else signal.addEventListener('abort', onAbort, { once: true });
            });
          },
        };
      },
    },
  };
}

const unavailable = () => new Response(JSON.stringify({ _tag: 'ServiceUnavailable', message: 'test' }), {
  status: 503,
  headers: { 'content-type': 'application/json' },
});

/** A gen-2 hub over a fake upstream: `/api/event` answers `connections[n]`, REST answers 503. */
function createFakeV2Hub({ connections, generation = 2, rest = unavailable, ...options }) {
  const fetchCalls = [];
  const diagnostics = [];
  let connection = 0;
  const getRuntime = () => ({ generation, baseUrl: V2_BASE_URL });
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url);
    fetchCalls.push({ method: init.method ?? 'GET', pathname: target.pathname, search: target.search, headers: { ...(init.headers ?? {}) } });
    if (target.pathname === '/api/event' || target.pathname === '/global/event') {
      const blocks = connections[Math.min(connection, connections.length - 1)];
      connection += 1;
      return createHeldSseResponse({ blocks, signal: init.signal, holdOpen: connection >= connections.length });
    }
    return rest(target, init);
  };
  const hub = createGlobalMessageStreamHub({
    buildOpenCodeUrl: (pathname) => `${V2_BASE_URL}${pathname}`,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic test' }),
    fetchImpl,
    upstreamReconnectDelayMs: 5,
    openCodeClient: createOpenCodeClient({ getRuntime, fetchImpl }),
    getOpenCodeRuntime: getRuntime,
    recordDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    ...options,
  });
  const events = [];
  const statuses = [];
  hub.subscribeEvent((event) => { events.push(event); });
  hub.subscribeStatus((status) => { statuses.push(status); });
  return { hub, events, statuses, fetchCalls, diagnostics };
}

describe('createGlobalMessageStreamHub gen 2 ingress (vectors)', () => {
  it('projects the data-only 2.0.20 frames 1->n with #k ids, ignores comment frames and sends no Last-Event-ID', async () => {
    const vector = readVector('01-two-step-tool-turn.json');
    const { hub, events, fetchCalls, diagnostics } = createFakeV2Hub({
      connections: [[': heartbeat\n\n', ...vector.frames.slice(0, 1), ': heartbeat\n\n', ...vector.frames.slice(1)]],
    });
    // The reference: the same projector fed the same envelopes after the cold-start gap.
    const reference = createEventProjector();
    reference.handleGap('cold_start');
    const expected = vector.frames.flatMap((frame) => reference.project(frameEnvelope(frame)));
    try {
      hub.start();
      await waitForAssertion(() => {
        expect(events.length).toBeGreaterThanOrEqual(expected.length);
      });
      const live = events.filter((event) => event.eventId.startsWith('evt_'));
      expect(live.map(({ eventId, directory, payload }) => ({ eventId, directory, payload })))
        .toEqual(expected.map(({ eventId, directory, payload }) => ({ eventId, directory, payload })));
      expect(live.some((event) => /#\d+$/.test(event.eventId))).toBe(true);
      expect(new Set(live.map((event) => event.directory))).toEqual(new Set(['<home>/workspace']));
      expect(live.filter((event) => event.payload.type === 'message.part.delta').every((event) => event.payload.properties.field === 'text')).toBe(true);
      expect(hub.replayAfter(live[0].eventId).events).toHaveLength(events.length - events.indexOf(live[0]) - 1);
      expect(hub.getProjector()?.generation).toBe(2);
      const streams = fetchCalls.filter((call) => call.pathname === '/api/event');
      expect(streams.length).toBeGreaterThan(0);
      for (const call of streams) {
        expect(call.headers['Last-Event-ID']).toBeUndefined();
        expect(call.headers.Accept).toBe('text/event-stream');
        expect(call.headers.Authorization).toBe('Basic test');
      }
      expect(fetchCalls.some((call) => call.pathname === '/global/event')).toBe(false);
      // The cold-start reconciliation ran; its 503 is a recorded, retryable reseed failure.
      await waitForAssertion(() => {
        expect(fetchCalls.some((call) => call.pathname === '/api/session/active')).toBe(true);
        expect(diagnostics.some((diagnostic) => diagnostic.code === GLOBAL_HUB_DIAGNOSTICS.reseedFailed && diagnostic.kind === 'active')).toBe(true);
      });
    } finally {
      hub.stop();
    }
  });

  it('drops a repeated upstream id once (defect guard) and records it', async () => {
    const [created] = readVector('01-two-step-tool-turn.json').frames;
    const { hub, events, diagnostics } = createFakeV2Hub({ connections: [[created, created]] });
    try {
      hub.start();
      await waitForAssertion(() => {
        expect(diagnostics.some((diagnostic) => diagnostic.code === GLOBAL_HUB_DIAGNOSTICS.duplicate)).toBe(true);
      });
      expect(events.filter((event) => event.payload.type === 'session.created')).toHaveLength(1);
    } finally {
      hub.stop();
    }
  });

  it('treats every reconnect as a gap: status, control frame, replay gap and a fresh reconciliation', async () => {
    const vector = readVector('01-two-step-tool-turn.json');
    const { hub, events, statuses, fetchCalls } = createFakeV2Hub({
      connections: [vector.frames.slice(0, 4), vector.frames.slice(4, 6)],
    });
    try {
      hub.start();
      await waitForAssertion(() => {
        expect(statuses.filter((status) => status.type === 'connect')).toHaveLength(2);
      });
      // The first connection is a cold start, not a reconnect.
      expect(statuses.filter((status) => status.type === 'gap')).toEqual([{ type: 'gap', scope: 'global', reason: 'upstream_reconnect' }]);
      const gapIndex = statuses.findIndex((status) => status.type === 'gap');
      expect(statuses[gapIndex + 1]).toEqual({ type: 'connect', wasReady: true });
      const controls = events.filter((event) => event.control === 'gap');
      expect(controls).toHaveLength(1);
      expect(controls[0]).toMatchObject({ directory: 'global', eventId: undefined, synthetic: true });
      expect(isMessageStreamControlPayload(controls[0].payload)).toBe(true);
      expect(controls[0].payload.type).toBe(MESSAGE_STREAM_GAP_CONTROL_TYPE);
      const beforeGap = events.filter((event) => event.eventId?.startsWith('evt_'));
      const firstOld = beforeGap[0];
      expect(hub.replayAfter(firstOld.eventId).gap).toBe(true);
      await waitForAssertion(() => {
        const after = events.slice(events.indexOf(controls[0]) + 1).filter((event) => event.eventId?.startsWith('evt_'));
        expect(after.length).toBeGreaterThan(0);
        expect(hub.replayAfter(after[0].eventId).gap).toBe(false);
      });
      // Control entries are never buffered for replay.
      expect(hub.replayAfter(firstOld.eventId).events.some((event) => event.control)).toBe(false);
      await waitForAssertion(() => {
        expect(fetchCalls.filter((call) => call.pathname === '/api/session/active').length).toBeGreaterThanOrEqual(2);
      });
    } finally {
      hub.stop();
    }
  });

  it('revokes old global WS readiness and delivers the replacement replay gap as a top-level frame', async () => {
    const frames = readVector('01-two-step-tool-turn.json').frames;
    const { hub, statuses } = createFakeV2Hub({ connections: [frames.slice(0, 4), frames.slice(4, 8)] });
    const sent = [];
    const socket = {
      readyState: 1,
      bufferedAmount: 0,
      send(raw) { sent.push(JSON.parse(raw)); },
      ping() {},
      on() {},
      close() { this.readyState = 3; },
    };
    const bridge = createGlobalMessageStreamWsBridge({
      globalHub: hub,
      ownsGlobalHub: true,
      wsClients: new Set(),
      heartbeatIntervalMs: 60_000,
    });
    try {
      bridge.accept(socket, {});
      await waitForAssertion(() => {
        expect(socket.readyState).toBe(3);
        expect(statuses.filter(status => status.type === 'connect')).toHaveLength(2);
      });
      expect(sent[0]).toEqual({ type: 'ready', scope: 'global' });
      expect(statuses).toContainEqual({ type: 'gap', scope: 'global', reason: 'upstream_reconnect' });
      const cursor = sent.find(frame => frame.type === 'event' && frame.eventId)?.eventId;
      expect(typeof cursor).toBe('string');
      const replacementFrames = [];
      const replacement = { ...socket, readyState: 1, send(raw) { replacementFrames.push(JSON.parse(raw)); } };
      bridge.accept(replacement, { requestedLastEventId: cursor });
      await waitForAssertion(() => {
        expect(replacementFrames).toContainEqual({ type: 'gap', scope: 'global', lastEventId: cursor });
        expect(replacementFrames.some(frame => frame.type === 'event')).toBe(true);
      });
      expect(replacementFrames[0]).toEqual({ type: 'ready', scope: 'global' });
      expect(replacementFrames.filter(frame => frame.type === 'event').some(frame => frame.payload.type === MESSAGE_STREAM_GAP_CONTROL_TYPE)).toBe(false);
    } finally {
      bridge.close();
    }
  });

  it('never lets a stale /api/session/active snapshot undo a live status that arrived meanwhile', async () => {
    const frames = readVector('01-two-step-tool-turn.json').frames;
    const started = frames.findIndex((frame) => frameEnvelope(frame).type === 'session.execution.started');
    const sessionID = frameEnvelope(frames[0]).data.sessionID;
    let releaseActive;
    const activeAnswered = new Promise((resolve) => { releaseActive = resolve; });
    const { hub, events } = createFakeV2Hub({
      connections: [frames.slice(0, started + 1)],
      rest: async (target) => {
        if (target.pathname !== '/api/session/active') return unavailable();
        // Fetched at connect, answered only after the live execution.started.
        await activeAnswered;
        return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const statusesOf = () => events.filter((event) => event.payload.type === 'session.status' && event.payload.properties.sessionID === sessionID)
      .map((event) => event.payload.properties.status.type);
    try {
      hub.start();
      await waitForAssertion(() => expect(statusesOf()).toEqual(['busy']));
      releaseActive();
      await waitForAssertion(() => expect(hub.reseedStats().active).toBe(0));
      expect(statusesOf()).toEqual(['busy']);
      expect(hub.getProjector().sessionStatus(sessionID)).toEqual({ type: 'busy' });
      expect(events.some((event) => event.payload.type === 'session.idle')).toBe(false);
    } finally {
      hub.stop();
    }
  });

  it('uses the 45 s gen-2 stall window instead of the gen-1 window', async () => {
    expect(GEN2_UPSTREAM_STALL_TIMEOUT_MS).toBe(45_000);
    const { hub, statuses } = createFakeV2Hub({
      connections: [[': heartbeat\n\n']],
      upstreamStallTimeoutMs: 60_000,
      generation2StallTimeoutMs: 30,
    });
    try {
      hub.start();
      await waitForAssertion(() => {
        expect(statuses.some((status) => status.type === 'disconnect' && status.reason === 'upstream_stalled')).toBe(true);
        expect(statuses.some((status) => status.type === 'gap')).toBe(true);
      });
    } finally {
      hub.stop();
    }
  });

  it.each([1, 3, undefined])('refuses unsupported runtime generation %s before fetch', async (generation) => {
    const { hub, statuses, fetchCalls } = createFakeV2Hub({ connections: [[]],
      openCodeClient: { generation: () => generation },
    });
    try {
      hub.start();
      await waitForAssertion(() => expect(statuses[0]).toMatchObject({ type: 'initial-error', buildUrlFailed: true }));
      expect(fetchCalls).toEqual([]);
      expect(() => hub.resolveGeneration()).toThrow();
    } finally { hub.stop(); }
  });

  it('refuses a missing native client before fetch', async () => {
    const fetchImpl = vi.fn();
    const hub = createGlobalMessageStreamHub({ fetchImpl });
    const statuses = [];
    hub.subscribeStatus((status) => statuses.push(status));
    try {
      hub.start();
      await waitForAssertion(() => expect(statuses[0]).toMatchObject({ type: 'initial-error', buildUrlFailed: true }));
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally { hub.stop(); }
  });

  it('filters entries by directory, keeping control frames and server.connected', () => {
    const control = { payload: { type: 'x' }, directory: 'global' };
    expect(matchesMessageStreamDirectory({ payload: { type: 'session.status' }, directory: '/a' }, '/a')).toBe(true);
    expect(matchesMessageStreamDirectory({ payload: { type: 'session.status' }, directory: '/b' }, '/a')).toBe(false);
    expect(matchesMessageStreamDirectory({ payload: { type: 'server.connected' }, directory: 'global' }, '/a')).toBe(true);
    expect(matchesMessageStreamDirectory({ payload: { type: 'installation.updated' }, directory: 'global' }, '/a')).toBe(false);
    expect(matchesMessageStreamDirectory(control, '/a')).toBe(false);
    expect(matchesMessageStreamDirectory({ payload: { type: 'session.status' }, directory: '/b' }, '')).toBe(true);
  });
});

describe('createGlobalMessageStreamHub gen 2 against the v2 fixture', () => {
  let directory;
  let fixture;

  beforeAll(async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'devryan-hub-v2-'));
    fixture = await createLoopbackOpenCodeFixtureForGeneration(2, { directory, heartbeatMs: 50 });
  });

  afterAll(async () => {
    await fixture?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  const createFixtureHub = () => {
    const fetchCalls = [];
    const diagnostics = [];
    const getRuntime = () => ({ generation: 2, baseUrl: fixture.origin });
    const getAuthHeaders = () => ({ ...fixture.authHeaders });
    const fetchImpl = (url, init = {}) => {
      const target = new URL(url);
      fetchCalls.push({ method: init.method ?? 'GET', pathname: target.pathname, search: target.search, headers: { ...(init.headers ?? {}) } });
      return globalThis.fetch(url, init);
    };
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: () => {
        throw new Error('the gen-1 stream must not be built');
      },
      getOpenCodeAuthHeaders: getAuthHeaders,
      fetchImpl,
      upstreamReconnectDelayMs: 10,
      openCodeClient: createOpenCodeClient({ getRuntime, getAuthHeaders, fetchImpl }),
      getOpenCodeRuntime: getRuntime,
      recordDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const events = [];
    const statuses = [];
    const elsewhere = [];
    hub.subscribeEvent((event) => { events.push(event); });
    hub.subscribeStatus((status) => { statuses.push(status); });
    hub.subscribeDirectoryEvent('/elsewhere', (event) => { elsewhere.push(event); });
    return { hub, events, statuses, elsewhere, fetchCalls, diagnostics };
  };

  const payloadsOf = (events, sessionID, type) => events.filter((event) => event.payload?.type === type
    && (event.payload.properties?.sessionID === sessionID || event.payload.properties?.info?.sessionID === sessionID));

  it('serves a replayed two-step tool turn as v1 payloads routed by location', async () => {
    const { hub, events, elsewhere, fetchCalls } = createFixtureHub();
    try {
      hub.start();
      await waitForAssertion(() => expect(hub.isConnected()).toBe(true));
      const played = fixture.playSequence('two-step-tool-turn', { deltaFirst: true });
      const [sessionID] = played.sessionIDs;
      await waitForAssertion(() => expect(payloadsOf(events, sessionID, 'session.idle')).toHaveLength(1));
      expect(events[0]).toMatchObject({ directory: 'global', payload: { type: 'server.connected' } });
      expect(payloadsOf(events, sessionID, 'session.status').map((event) => event.payload.properties.status.type)).toEqual(['busy', 'idle']);
      const sessionEvents = events.filter((event) => event.payload.properties?.sessionID === sessionID);
      expect(new Set(sessionEvents.map((event) => event.directory))).toEqual(new Set([directory]));
      expect(sessionEvents.some((event) => /^evt_.+#\d+$/.test(event.eventId))).toBe(true);
      const deltas = payloadsOf(events, sessionID, 'message.part.delta');
      expect(deltas.length).toBeGreaterThan(0);
      // First sight under deltaFirst: every delta's part was announced before it.
      for (const delta of deltas) {
        const { partID, field } = delta.payload.properties;
        expect(field).toBe('text');
        const announced = events.findIndex((event) => event.payload.type === 'message.part.updated' && event.payload.properties.part.id === partID);
        expect(announced).toBeGreaterThan(-1);
        expect(announced).toBeLessThan(events.indexOf(delta));
      }
      // Another directory's stream sees only server.connected.
      expect(elsewhere.map((event) => event.payload.type)).toEqual(['server.connected']);
      expect(hub.replayAfter(events[0].eventId, { directory: '/elsewhere' }).events).toEqual([]);
      expect(hub.replayAfter(events[0].eventId, { directory }).events.every((event) => event.directory === directory)).toBe(true);
      expect(fetchCalls.filter((call) => call.pathname === '/api/event').every((call) => call.headers['Last-Event-ID'] === undefined)).toBe(true);
    } finally {
      hub.stop();
    }
  });

  it('reconciles status from /api/session/active after a SubscriberOverflow stream drop', async () => {
    const { hub, events, statuses, fetchCalls } = createFixtureHub();
    try {
      hub.start();
      await waitForAssertion(() => expect(hub.isConnected()).toBe(true));
      const played = fixture.playSequence('two-step-tool-turn', { until: 'session.execution.succeeded' });
      const [sessionID] = played.sessionIDs;
      // The cold-start reconciliation may land after the live busy; it restates, never undoes it.
      await waitForAssertion(() => {
        const types = payloadsOf(events, sessionID, 'session.status').map((event) => event.payload.properties.status.type);
        expect(types.length).toBeGreaterThan(0);
        expect(new Set(types)).toEqual(new Set(['busy']));
      });
      expect(hub.getProjector().sessionStatus(sessionID)).toEqual({ type: 'busy' });
      const lastBeforeDrop = events.at(-1);
      const activeBefore = fetchCalls.filter((call) => call.pathname === '/api/session/active').length;

      // The overflow sequence ends the subscriber after its frames (F7: a clean end).
      fixture.playSequence('stream-drop');
      await waitForAssertion(() => expect(statuses.some((status) => status.type === 'gap')).toBe(true));
      const control = events.find((event) => event.control === 'gap');
      expect(control?.payload.properties).toEqual({ scope: 'global', reason: 'upstream_reconnect' });
      expect(hub.replayAfter(lastBeforeDrop.eventId).gap).toBe(true);
      // The previously busy session gets a reconciled status from the new active list.
      await waitForAssertion(() => {
        expect(fetchCalls.filter((call) => call.pathname === '/api/session/active').length).toBeGreaterThan(activeBefore);
        const reconciled = events.slice(events.indexOf(control) + 1)
          .filter((event) => event.payload.type === 'session.status' && event.payload.properties.sessionID === sessionID);
        expect(reconciled).toHaveLength(1);
        expect(reconciled[0].eventId.startsWith('devryan-')).toBe(true);
        expect(reconciled[0].directory).toBe(directory);
      });
      expect(fixture.getState().sseConnectionCount).toBeGreaterThanOrEqual(2);
      played.resume();
      await waitForAssertion(() => expect(hub.getProjector().sessionStatus(sessionID)).toEqual({ type: 'idle' }));
    } finally {
      hub.stop();
    }
  });
});
