import { describe, expect, it, vi } from 'vitest';

import { createGlobalMessageStreamHub } from './global-hub.js';

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

  it('continues fanout when an event subscriber throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          'id: evt-1\ndata: {"type":"session.updated","properties":{}}\n\n',
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
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          'id: evt-1\ndata: {"type":"message.updated","properties":{"info":{"id":"msg_1","role":"assistant","tokens":{"input":10}}}}\n\n',
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
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          'id: evt-1\ndata: {"type":"session.updated","properties":{}}\n\n',
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
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          'id: evt-1\ndata: {"type":"session.updated","properties":{"sequence":1}}\n\n',
          'id: evt-1\ndata: {"type":"session.updated","properties":{"sequence":1}}\n\n',
          'data: {"type":"server.connected","properties":{"sequence":2}}\n\n',
          'data: {"type":"server.connected","properties":{"sequence":3}}\n\n',
        ],
      }),
      transformEventPayload,
    });
    hub.subscribeEvent((event) => received.push(event));

    try {
      hub.start();
      await waitForAssertion(() => expect(received).toHaveLength(3));
      expect(received.map((event) => event.eventId)).toEqual(['evt-1', undefined, undefined]);
      expect(transformEventPayload).toHaveBeenCalledTimes(3);
      expect(hub.replayAfter('missing').events.map((event) => event.eventId)).toEqual(['evt-1']);
    } finally {
      hub.stop();
    }
  });

  it('releases deduplication IDs when replay entries are evicted', async () => {
    const received = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      replayLimit: 2,
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          'id: evt-1\ndata: {"type":"session.updated","properties":{"sequence":1}}\n\n',
          'id: evt-2\ndata: {"type":"session.updated","properties":{"sequence":2}}\n\n',
          'id: evt-3\ndata: {"type":"session.updated","properties":{"sequence":3}}\n\n',
          'id: evt-1\ndata: {"type":"session.updated","properties":{"sequence":4}}\n\n',
        ],
      }),
    });
    hub.subscribeEvent((event) => received.push(event));

    try {
      hub.start();
      await waitForAssertion(() => expect(received).toHaveLength(4));
      expect(received.map((event) => event.eventId)).toEqual(['evt-1', 'evt-2', 'evt-3', 'evt-1']);
      expect(hub.replayAfter('missing').events.map((event) => event.eventId)).toEqual(['evt-3', 'evt-1']);
    } finally {
      hub.stop();
    }
  });

  it('continues fanout when an async event subscriber rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          'id: evt-1\ndata: {"type":"session.updated","properties":{}}\n\n',
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
