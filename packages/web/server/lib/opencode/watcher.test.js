import { projectedFrame, createProjectedStreamClient } from '../event-stream/test-projected-stream.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLoopbackOpenCodeFixtureForGeneration } from '../../../../../scripts/perf/loopback-opencode-fixtures.mjs';
import { createGlobalMessageStreamHub } from '../event-stream/global-hub.js';
import { createOpenCodeClient } from './opencode-client/index.js';
import { createOpenCodeWatcherRuntime } from './watcher.js';

function createSseResponse({ blocks = [], signal, holdOpen = false }) {
  const encoder = new TextEncoder();
  let index = 0;

  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (index < blocks.length) {
              return { value: encoder.encode(blocks[index++]), done: false };
            }

            if (!holdOpen) {
              return { value: undefined, done: true };
            }

            return new Promise((_resolve, reject) => {
              const onAbort = () => {
                signal.removeEventListener('abort', onAbort);
                const error = new Error('Aborted');
                error.name = 'AbortError';
                reject(error);
              };
              signal.addEventListener('abort', onAbort, { once: true });
            });
          },
        };
      },
    },
  };
}

describe('createOpenCodeWatcherRuntime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('waits for OpenCode readiness and forwards projected native payloads', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const payloads = [];
    const directories = [];
    const fetchCalls = [];

    const watcher = createOpenCodeWatcherRuntime({
      openCodeClient: createProjectedStreamClient(),
      waitForOpenCodePort: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
      onPayload(payload, directory) {
        payloads.push(payload); directories.push(directory);
        watcher.stop();
      },
      fetchImpl: async (url, options) => {
        fetchCalls.push({ url, headers: options.headers });
        return createSseResponse({
          signal: options.signal,
          blocks: [
            projectedFrame({"type": "session.updated", "properties": {"sessionID": "ses_1"}}, {"id": "evt-1", "directory": "/tmp/project"}),
          ],
        });
      },
    });

    await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(directories).toEqual(['/tmp/project']);
    expect(fetchCalls).toEqual([
      {
        url: 'http://127.0.0.1:4096/api/event',
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          Authorization: 'Bearer test-token',
        },
      },
    ]);
    expect(payloads).toEqual([
      {
        type: 'session.updated',
        properties: {
          sessionID: 'ses_1',
        },
      },
    ]);
  });

  it('retries readiness after an initial failure and starts the shared hub exactly once', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const waitForOpenCodePort = vi.fn()
      .mockRejectedValueOnce(new Error('OpenCode port not ready'))
      .mockResolvedValueOnce(undefined);
    const unsubscribeEvent = vi.fn();
    const unsubscribeStatus = vi.fn();
    const globalEventHub = {
      resolveGeneration: () => 2,
      start: vi.fn(),
      subscribeEvent: vi.fn(() => unsubscribeEvent),
      subscribeStatus: vi.fn(() => unsubscribeStatus),
    };
    const watcher = createOpenCodeWatcherRuntime({
      openCodeClient: createProjectedStreamClient(),
      waitForOpenCodePort,
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      globalEventHub,
      onPayload() {},
      upstreamReconnectDelayMs: 0,
    });

    await watcher.start();

    expect(waitForOpenCodePort).toHaveBeenCalledTimes(2);
    expect(globalEventHub.subscribeEvent).toHaveBeenCalledTimes(1);
    expect(globalEventHub.subscribeStatus).toHaveBeenCalledTimes(1);
    expect(globalEventHub.start).toHaveBeenCalledTimes(1);

    watcher.stop();
    expect(unsubscribeEvent).toHaveBeenCalledTimes(1);
    expect(unsubscribeStatus).toHaveBeenCalledTimes(1);
  });

  it('reconnects a stalled native watcher without Last-Event-ID', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchLastEventIds = [];
    const payloads = [];
    let attempt = 0;

    const watcher = createOpenCodeWatcherRuntime({
      openCodeClient: createProjectedStreamClient(),
      waitForOpenCodePort: async () => {},
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      onPayload(payload) {
        payloads.push(payload.type);
        if (payload.type === 'session.updated') {
          watcher.stop();
        }
      },
      fetchImpl: async (_url, options) => {
        fetchLastEventIds.push(options.headers['Last-Event-ID'] ?? null);
        attempt += 1;

        if (attempt === 1) {
          return createSseResponse({
            signal: options.signal,
            holdOpen: true,
            blocks: [
              projectedFrame({"type": "server.connected", "properties": {}}, {"id": "evt-1"}),
            ],
          });
        }

        return createSseResponse({
          signal: options.signal,
          blocks: [
            projectedFrame({"type": "session.updated", "properties": {}}, {"id": "evt-2"}),
          ],
        });
      },
      generation2StallTimeoutMs: 10,
      upstreamReconnectDelayMs: 0,
    });

    await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(payloads).toEqual(['server.connected', 'session.updated']);
    expect(fetchLastEventIds.slice(0, 2)).toEqual([null, null]);
  });

  it('subscribes to a shared global event hub instead of opening its own upstream stream', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const payloads = [];
    let hubFetchCalls = 0;
    let watcherFetchCalls = 0;

    const globalEventHub = createGlobalMessageStreamHub({
      openCodeClient: createProjectedStreamClient(),
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 0,
      fetchImpl: async (_url, options) => {
        hubFetchCalls += 1;
        return createSseResponse({
          signal: options.signal,
          holdOpen: true,
          blocks: [
            projectedFrame({"type": "session.updated", "properties": {"sessionID": "ses_1"}}, {"id": "evt-1"}),
          ],
        });
      },
    });

    const watcher = createOpenCodeWatcherRuntime({
      openCodeClient: createProjectedStreamClient(),
      waitForOpenCodePort: async () => {},
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      globalEventHub,
      onPayload(payload) {
        payloads.push(payload);
        watcher.stop();
      },
      fetchImpl: async () => {
        watcherFetchCalls += 1;
        throw new Error('watcher fetch should not be called');
      },
    });

    await watcher.start();
    globalEventHub.publishSyntheticEvent({
      eventId: 'synthetic-1',
      payload: {
        type: 'session.status',
        properties: {
          sessionID: 'ses_synthetic',
          status: { type: 'busy' },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    globalEventHub.stop();
    expect(hubFetchCalls).toBe(1);
    expect(watcherFetchCalls).toBe(0);
    expect(payloads).toEqual([
      {
        type: 'session.updated',
        properties: {
          sessionID: 'ses_1',
        },
      },
    ]);
  });

  it('does not stop a shared global event hub when the watcher stops', async () => {
    const events = new Set();
    const statuses = new Set();
    let startCalls = 0;
    let stopCalls = 0;

    const globalEventHub = {
      resolveGeneration: () => 2,
      start() {
        startCalls += 1;
      },
      stop() {
        stopCalls += 1;
      },
      subscribeEvent(subscriber) {
        events.add(subscriber);
        return () => {
          events.delete(subscriber);
        };
      },
      subscribeStatus(subscriber) {
        statuses.add(subscriber);
        return () => {
          statuses.delete(subscriber);
        };
      },
    };

    const watcher = createOpenCodeWatcherRuntime({
      openCodeClient: createProjectedStreamClient(),
      waitForOpenCodePort: async () => {},
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      globalEventHub,
      onPayload() {},
    });

    await watcher.start();
    watcher.stop();

    expect(startCalls).toBe(1);
    expect(stopCalls).toBe(0);
    expect(events.size).toBe(0);
    expect(statuses.size).toBe(0);
  });
});


it('retains the shared hub directory for exact receipt ingestion', async () => {
  let accept;
  const onPayload = vi.fn();
  const watcher = createOpenCodeWatcherRuntime({ waitForOpenCodePort: async () => {}, onPayload,
    globalEventHub: { resolveGeneration: () => 2, start() {}, subscribeEvent(callback) { accept = callback; return () => {}; }, subscribeStatus() { return () => {}; } },
  });
  await watcher.start();
  const payload = { type: 'message.part.updated', properties: { part: { sessionID: 'ses_1', messageID: 'msg_1', type: 'tool' } } };
  accept({ payload, directory: '/fixture/project' });
  expect(onPayload).toHaveBeenCalledWith(payload, '/fixture/project');
  accept({ payload, directory: 'global' });
  expect(onPayload).toHaveBeenLastCalledWith(payload, null);
  watcher.stop();
});

describe('createOpenCodeWatcherRuntime gen 2', () => {
  let directory;
  let fixture;

  beforeAll(async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'devryan-watcher-v2-'));
    fixture = await createLoopbackOpenCodeFixtureForGeneration(2, { directory, heartbeatMs: 50 });
  });

  afterAll(async () => {
    await fixture?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  const waitFor = async (assertion) => {
    const deadline = Date.now() + 2000;
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
  };

  const runtimeDeps = () => {
    const fetchPaths = [];
    const getRuntime = () => ({ generation: 2, baseUrl: fixture.origin });
    const getAuthHeaders = () => ({ ...fixture.authHeaders });
    const fetchImpl = (url, init) => {
      fetchPaths.push(new URL(url).pathname);
      return globalThis.fetch(url, init);
    };
    return {
      fetchPaths,
      getRuntime,
      getAuthHeaders,
      fetchImpl,
      openCodeClient: createOpenCodeClient({ getRuntime, getAuthHeaders, fetchImpl }),
    };
  };

  it('projects the raw 2.0.20 stream through a private hub when no shared hub exists', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { fetchPaths, getRuntime, getAuthHeaders, fetchImpl, openCodeClient } = runtimeDeps();
    const received = [];
    const watcher = createOpenCodeWatcherRuntime({
      waitForOpenCodePort: async () => {},
      buildOpenCodeUrl: () => {
        throw new Error('the gen-1 stream must not be built');
      },
      getOpenCodeAuthHeaders: getAuthHeaders,
      fetchImpl,
      upstreamReconnectDelayMs: 10,
      openCodeClient,
      getOpenCodeRuntime: getRuntime,
      onPayload(payload, payloadDirectory) {
        received.push({ payload, directory: payloadDirectory });
      },
    });
    try {
      await watcher.start();
      await waitFor(() => expect(received.some(({ payload }) => payload.type === 'server.connected')).toBe(true));
      const played = fixture.playSequence('two-step-tool-turn', { until: 'session.execution.succeeded' });
      const [sessionID] = played.sessionIDs;
      await waitFor(() => expect(received.some(({ payload }) => payload.type === 'session.status'
        && payload.properties.sessionID === sessionID && payload.properties.status.type === 'busy')).toBe(true));
      // The v1 vocabulary only, routed by the session's location.
      expect(received.some(({ payload }) => payload.type.startsWith('session.step.') || payload.type.startsWith('session.text.'))).toBe(false);
      expect(received.filter(({ payload }) => payload.properties?.sessionID === sessionID).every((entry) => entry.directory === directory)).toBe(true);
      expect(fetchPaths).toContain('/api/event');
      expect(fetchPaths).not.toContain('/global/event');

      // A SubscriberOverflow drop: the reconnect reconciles the busy session from /api/session/active.
      const before = received.length;
      fixture.playSequence('stream-drop');
      await waitFor(() => {
        const after = received.slice(before);
        expect(after.some(({ payload }) => payload.type === 'session.status' && payload.properties.sessionID === sessionID)).toBe(true);
      });
      // The hub's gap control entry never reaches the canonical consumers.
      expect(received.some(({ payload }) => payload.type === 'devryan.stream.gap')).toBe(false);
      played.resume();
      await waitFor(() => expect(received.some(({ payload }) => payload.type === 'session.idle' && payload.properties.sessionID === sessionID)).toBe(true));
    } finally {
      watcher.stop();
    }
  });

  it('skips hub gap control entries on a shared gen-2 hub', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { getRuntime, getAuthHeaders, fetchImpl, openCodeClient } = runtimeDeps();
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: () => {
        throw new Error('the gen-1 stream must not be built');
      },
      getOpenCodeAuthHeaders: getAuthHeaders,
      fetchImpl,
      upstreamReconnectDelayMs: 10,
      openCodeClient,
      getOpenCodeRuntime: getRuntime,
    });
    const statuses = [];
    hub.subscribeStatus((status) => { statuses.push(status.type); });
    const received = [];
    const watcher = createOpenCodeWatcherRuntime({
      openCodeClient: createProjectedStreamClient(),
      waitForOpenCodePort: async () => {},
      globalEventHub: hub,
      onPayload(payload) {
        received.push(payload.type);
      },
    });
    try {
      await watcher.start();
      await waitFor(() => expect(received).toContain('server.connected'));
      fixture.dropEventStream({ afterFrames: 0 });
      await waitFor(() => expect(statuses).toContain('gap'));
      await waitFor(() => expect(received.filter((type) => type === 'server.connected')).toHaveLength(2));
      expect(received).not.toContain('devryan.stream.gap');
    } finally {
      watcher.stop();
      hub.stop();
    }
  });

  it('never opens a stream on an unknown runtime generation and retries until it is known (fail closed)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchImpl = vi.fn(async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    let generation = 3;
    const watcher = createOpenCodeWatcherRuntime({
      waitForOpenCodePort: async () => {},
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl,
      upstreamReconnectDelayMs: 5,
      openCodeClient: createOpenCodeClient({ getRuntime: () => ({ generation, baseUrl: 'http://127.0.0.1:4096' }) }),
      onPayload() {},
    });
    const started = watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    generation = 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchImpl).not.toHaveBeenCalled();
    generation = 2;
    await started;
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:4096/api/event', expect.any(Object)));
    watcher.stop();
  });
});
