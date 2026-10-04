import { describe, expect, it } from 'vitest';

import { createUpstreamSseReader } from './upstream-reader.js';

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

function createTrackedSignal() {
  const listeners = new Set();
  return {
    signal: {
      aborted: false,
      addEventListener(type, listener) {
        if (type === 'abort') {
          listeners.add(listener);
        }
      },
      removeEventListener(type, listener) {
        if (type === 'abort') {
          listeners.delete(listener);
        }
      },
    },
    getListenerCount() {
      return listeners.size;
    },
  };
}

describe('createUpstreamSseReader', () => {
  it('emits parsed events and tracks the latest event id', async () => {
    const events = [];
    let reader;

    reader = createUpstreamSseReader({
      buildUrl: () => 'http://127.0.0.1:4096/global/event',
      reconnectDelayMs: 0,
      fetchImpl: async (_url, options) => createSseResponse({
        signal: options.signal,
        blocks: [
          'id: evt-1\r\ndata: {"type":"server.connected","properties":{"directory":"/tmp/project"}}\r\n\r\n',
        ],
      }),
      onEvent(event) {
        events.push(event);
        reader.stop();
      },
    });

    await reader.start();

    expect(events).toHaveLength(1);
    expect(events[0].eventId).toBe('evt-1');
    expect(events[0].directory).toBe('/tmp/project');
    expect(events[0].payload).toEqual({
      type: 'server.connected',
      properties: {
        directory: '/tmp/project',
      },
    });
    expect(reader.getLastEventId()).toBe('evt-1');
  });

  it('reconnects a stalled stream with Last-Event-ID', async () => {
    const fetchLastEventIds = [];
    const events = [];
    let attempt = 0;
    let reader;

    reader = createUpstreamSseReader({
      buildUrl: () => 'http://127.0.0.1:4096/global/event',
      stallTimeoutMs: 10,
      reconnectDelayMs: 0,
      fetchImpl: async (_url, options) => {
        fetchLastEventIds.push(options.headers['Last-Event-ID'] ?? null);
        attempt += 1;

        if (attempt === 1) {
          return createSseResponse({
            signal: options.signal,
            holdOpen: true,
            blocks: [
              'id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n',
            ],
          });
        }

        return createSseResponse({
          signal: options.signal,
          blocks: [
            'id: evt-2\ndata: {"type":"session.updated","properties":{}}\n\n',
          ],
        });
      },
      onEvent(event) {
        events.push(event.eventId);
        if (event.eventId === 'evt-2') {
          reader.stop();
        }
      },
    });

    await reader.start();

    expect(events).toEqual(['evt-1', 'evt-2']);
    expect(fetchLastEventIds.slice(0, 2)).toEqual([null, 'evt-1']);
    expect(reader.getLastEventId()).toBe('evt-2');
  });

  it('resolves the stall timeout for each upstream read window', async () => {
    const events = [];
    let attempt = 0;
    let currentTimeout = 10;
    let reader;

    reader = createUpstreamSseReader({
      buildUrl: () => 'http://127.0.0.1:4096/global/event',
      stallTimeoutMs: () => currentTimeout,
      reconnectDelayMs: 0,
      fetchImpl: async (_url, options) => {
        attempt += 1;

        if (attempt === 1) {
          currentTimeout = 60;
          return createSseResponse({
            signal: options.signal,
            holdOpen: true,
            blocks: [
              'id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n',
            ],
          });
        }

        return createSseResponse({
          signal: options.signal,
          blocks: [
            'id: evt-2\ndata: {"type":"session.updated","properties":{}}\n\n',
          ],
        });
      },
      onEvent(event) {
        events.push(event.eventId);
        if (event.eventId === 'evt-2') {
          reader.stop();
        }
      },
    });

    await reader.start();

    expect(events).toEqual(['evt-1', 'evt-2']);
    expect(attempt).toBe(2);
  });

  it('reports unavailable upstream responses and continues reconnecting until stopped', async () => {
    const errors = [];
    let attempt = 0;
    let unavailableBodyCanceled = false;
    let reader;

    reader = createUpstreamSseReader({
      buildUrl: () => 'http://127.0.0.1:4096/global/event',
      reconnectDelayMs: 0,
      fetchImpl: async (_url, options) => {
        attempt += 1;
        if (attempt === 1) {
          return {
            ok: false,
            status: 503,
            body: {
              cancel: async () => {
                unavailableBodyCanceled = true;
              },
            },
          };
        }

        return createSseResponse({
          signal: options.signal,
          blocks: [
            'id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n',
          ],
        });
      },
      onError(error) {
        errors.push(error);
      },
      onEvent() {
        reader.stop();
      },
    });

    await reader.start();

    expect(errors).toEqual([
      expect.objectContaining({
        type: 'upstream_unavailable',
        status: 503,
      }),
    ]);
    expect(unavailableBodyCanceled).toBe(true);
    expect(attempt).toBe(2);
  });

  it('removes reconnect delay abort listeners after normal timeout completion', async () => {
    const tracked = createTrackedSignal();
    let attempt = 0;
    let reader;

    reader = createUpstreamSseReader({
      buildUrl: () => 'http://127.0.0.1:4096/global/event',
      reconnectDelayMs: 1,
      signal: tracked.signal,
      fetchImpl: async (_url, options) => {
        attempt += 1;
        if (attempt === 1) {
          return {
            ok: false,
            status: 503,
            body: {
              cancel: async () => {},
            },
          };
        }

        return createSseResponse({
          signal: options.signal,
          blocks: [
            'id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n',
          ],
        });
      },
      onEvent() {
        reader.stop();
      },
    });

    await reader.start();

    expect(attempt).toBe(2);
    // The top-level stop listener remains; the reconnect-delay listener should be removed.
    expect(tracked.getListenerCount()).toBe(1);
  });

  it('neither sends nor records Last-Event-ID when resumption is off (gen 2)', async () => {
    const fetchLastEventIds = [];
    const events = [];
    let attempt = 0;
    let resume = true;
    let reader;

    reader = createUpstreamSseReader({
      buildUrl: () => 'http://127.0.0.1:4096/api/event',
      reconnectDelayMs: 0,
      resumeWithLastEventId: () => resume,
      fetchImpl: async (_url, options) => {
        fetchLastEventIds.push(options.headers['Last-Event-ID'] ?? null);
        attempt += 1;
        if (attempt === 1) {
          return createSseResponse({ signal: options.signal, blocks: ['id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n'] });
        }
        return createSseResponse({ signal: options.signal, blocks: ['id: evt-3\ndata: {"type":"session.updated","properties":{}}\n\n'] });
      },
      onEvent(event) {
        events.push(event.eventId);
        // The next connection resolves resumption off (a gen-2 connection).
        resume = false;
        if (event.eventId === 'evt-3') reader.stop();
      },
    });

    await reader.start();

    expect(events).toEqual(['evt-1', 'evt-3']);
    expect(fetchLastEventIds).toEqual([null, null]);
    expect(reader.getLastEventId()).toBe('');
  });

  it('reports keepalive blocks without emitting events and keeps a commented stream alive', async () => {
    const events = [];
    let keepalives = 0;
    let attempts = 0;
    const encoder = new TextEncoder();
    let reader;

    reader = createUpstreamSseReader({
      buildUrl: () => 'http://127.0.0.1:4096/api/event',
      stallTimeoutMs: () => 40,
      reconnectDelayMs: 0,
      parseBlock: (block) => (block.startsWith(':') ? { keepalive: true } : { eventId: null, directory: null, payload: { block } }),
      fetchImpl: async (_url, options) => {
        attempts += 1;
        let reads = 0;
        return {
          ok: true,
          status: 200,
          body: {
            getReader() {
              return {
                async read() {
                  reads += 1;
                  // Comments every 15 ms for 150 ms: longer than the 40 ms stall window.
                  if (reads <= 10) {
                    await new Promise((resolve) => setTimeout(resolve, 15));
                    return { value: encoder.encode(': heartbeat\n\n'), done: false };
                  }
                  if (reads === 11) return { value: encoder.encode('data: {}\n\n'), done: false };
                  return new Promise((_resolve, reject) => {
                    options.signal.addEventListener('abort', () => {
                      const error = new Error('Aborted');
                      error.name = 'AbortError';
                      reject(error);
                    }, { once: true });
                  });
                },
              };
            },
          },
        };
      },
      onKeepalive() {
        keepalives += 1;
      },
      onEvent(event) {
        events.push(event.payload);
      },
      onDisconnect({ reason }) {
        if (reason === 'upstream_stalled') reader.stop();
      },
    });

    await reader.start();

    expect(keepalives).toBe(10);
    expect(events).toEqual([{ block: 'data: {}' }]);
    // One connection survived the comments; it stalled only after they stopped.
    expect(attempts).toBe(1);
  });
});
