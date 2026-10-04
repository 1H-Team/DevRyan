import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createOpenCodeClient } from '../opencode/opencode-client/index.js';
import { acceptDirectoryMessageStreamWsConnection } from './directory-ws-bridge.js';
import { createGlobalMessageStreamHub } from './global-hub.js';

const VECTOR = JSON.parse(readFileSync(new URL('../opencode/v2/__vectors__/01-two-step-tool-turn.json', import.meta.url), 'utf8'));
const WORKSPACE = '<home>/workspace';
const BASE_URL = 'http://127.0.0.1:4096';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.sent = [];
    this.closeCalls = [];
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  ping() {
    void 0;
  }

  close(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeCalls.push({ code, reason });
    this.emit('close');
  }
}

function createSseResponse({ blocks, signal, holdOpen }) {
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

async function waitFor(assertion) {
  const deadline = Date.now() + 1000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

/** A hub over a fake upstream: `connections[n]` is the n-th stream's blocks; REST answers 503. */
function createHub({ generation = 2, connections = [VECTOR.frames] } = {}) {
  const fetchUrls = [];
  let connection = 0;
  const getRuntime = () => ({ generation, baseUrl: BASE_URL });
  const fetchImpl = async (url, init = {}) => {
    fetchUrls.push(url);
    const pathname = new URL(url).pathname;
    if (pathname === '/api/event' || pathname === '/event' || pathname === '/global/event') {
      const blocks = connections[Math.min(connection, connections.length - 1)];
      connection += 1;
      return createSseResponse({ blocks, signal: init.signal, holdOpen: connection >= connections.length });
    }
    return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
  };
  const hub = createGlobalMessageStreamHub({
    buildOpenCodeUrl: (pathname) => `${BASE_URL}${pathname}`,
    getOpenCodeAuthHeaders: () => ({}),
    fetchImpl,
    upstreamReconnectDelayMs: 5,
    openCodeClient: createOpenCodeClient({ getRuntime, fetchImpl }),
    getOpenCodeRuntime: getRuntime,
  });
  return { hub, fetchUrls, fetchImpl };
}

const accept = (socket, hub, { directory = WORKSPACE, lastEventId = '', eventFilter = null, fetchImpl, wsClients = new Set() } = {}) => {
  acceptDirectoryMessageStreamWsConnection({
    socket,
    requestedLastEventId: lastEventId,
    requestedDirectory: directory,
    buildOpenCodeUrl: (pathname) => `${BASE_URL}${pathname}`,
    getOpenCodeAuthHeaders: () => ({}),
    wsClients,
    heartbeatIntervalMs: 60_000,
    upstreamReconnectDelayMs: 5,
    fetchImpl,
    eventFilter,
    globalHub: hub,
  });
  return wsClients;
};

const eventsOf = (socket) => socket.sent.filter((frame) => frame.type === 'event');

describe('acceptDirectoryMessageStreamWsConnection gen 2 (served from the hub)', () => {
  it('serves directory sockets from the global hub with a directory filter and no per-directory upstream', async () => {
    const { hub, fetchUrls, fetchImpl } = createHub({ connections: [VECTOR.frames.slice(0, 12), VECTOR.frames.slice(12)] });
    const workspace = new FakeSocket();
    const elsewhere = new FakeSocket();
    try {
      accept(workspace, hub, { fetchImpl });
      accept(elsewhere, hub, { directory: '/elsewhere', fetchImpl });
      await waitFor(() => {
        expect(eventsOf(workspace).some((frame) => frame.payload.type === 'session.idle')).toBe(true);
      });
      expect(fetchUrls.map((url) => new URL(url).pathname).filter((pathname) => pathname.endsWith('event'))).toEqual(['/api/event', '/api/event']);
      expect(workspace.sent[0]).toEqual({ type: 'ready', scope: 'directory' });
      expect(elsewhere.sent[0]).toEqual({ type: 'ready', scope: 'directory' });

      const upstream = eventsOf(workspace).filter((frame) => frame.eventId?.startsWith('evt_'));
      expect(upstream.length).toBeGreaterThan(10);
      expect(upstream.every((frame) => frame.directory === WORKSPACE)).toBe(true);
      // The gen-1 compatibility events still follow every session.status.
      expect(eventsOf(workspace).some((frame) => frame.payload.type === 'openchamber:session-status' && frame.directory === 'global')).toBe(true);
      // The reconnect gap reaches every directory socket as a top-level frame.
      expect(workspace.sent).toContainEqual({ type: 'gap', scope: 'global', reason: 'upstream_reconnect' });
      expect(elsewhere.sent).toContainEqual({ type: 'gap', scope: 'global', reason: 'upstream_reconnect' });
      // Another directory never sees the workspace's session events.
      expect(eventsOf(elsewhere).every((frame) => frame.payload.type === 'server.connected')).toBe(true);
    } finally {
      workspace.close();
      elsewhere.close();
      hub.stop();
    }
  });

  it('replays the hub buffer after lastEventId for the directory and marks unknown ids as a gap', async () => {
    const { hub, fetchImpl } = createHub();
    const first = new FakeSocket();
    const resumed = new FakeSocket();
    const unknown = new FakeSocket();
    try {
      accept(first, hub, { fetchImpl });
      await waitFor(() => {
        expect(eventsOf(first).some((frame) => frame.payload.type === 'session.idle')).toBe(true);
      });
      const frames = eventsOf(first).filter((frame) => frame.eventId);
      const anchor = frames[Math.floor(frames.length / 2)];

      accept(resumed, hub, { fetchImpl, lastEventId: anchor.eventId });
      accept(unknown, hub, { fetchImpl, lastEventId: 'evt_missing' });
      await waitFor(() => {
        expect(eventsOf(resumed).filter((frame) => frame.eventId).map((frame) => frame.eventId))
          .toEqual(frames.slice(frames.indexOf(anchor) + 1).map((frame) => frame.eventId));
      });
      expect(resumed.sent.some((frame) => frame.type === 'gap')).toBe(false);
      expect(unknown.sent[1]).toEqual({ type: 'gap', scope: 'directory', lastEventId: 'evt_missing' });
    } finally {
      first.close();
      resumed.close();
      unknown.close();
      hub.stop();
    }
  });

  it('applies the principal event filter to hub entries', async () => {
    const { hub, fetchImpl } = createHub();
    const socket = new FakeSocket();
    const seen = [];
    try {
      accept(socket, hub, {
        fetchImpl,
        eventFilter: async (_principal, entry) => {
          seen.push(entry.directory);
          return entry.payload.type !== 'message.part.delta';
        },
      });
      await waitFor(() => {
        expect(eventsOf(socket).some((frame) => frame.payload.type === 'session.idle')).toBe(true);
      });
      expect(eventsOf(socket).some((frame) => frame.payload.type === 'message.part.delta')).toBe(false);
      expect(seen).toContain(WORKSPACE);
    } finally {
      socket.close();
      hub.stop();
    }
  });

  it.each([1, 3, undefined])('refuses unsupported hub generation %s without fetching', (generation) => {
    const { hub, fetchUrls, fetchImpl } = createHub({ generation });
    const socket = new FakeSocket();
    const wsClients = accept(socket, generation === undefined ? null : hub, { fetchImpl, wsClients: new Set([socket]) });
    expect(socket.sent).toEqual([{ type: 'error', message: 'OpenCode service unavailable' }]);
    expect(socket.closeCalls).toEqual([{ code: 1011, reason: 'OpenCode service unavailable' }]);
    expect(wsClients.has(socket)).toBe(false);
    expect(fetchUrls).toEqual([]);
  });
});
