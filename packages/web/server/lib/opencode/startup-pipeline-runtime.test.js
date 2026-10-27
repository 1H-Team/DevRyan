import { describe, expect, it, vi } from 'vitest';
import { createStartupPipelineRuntime } from './startup-pipeline-runtime.js';

const compose = async (openCodeClient) => {
  const routes = new Map();
  const legacyHandlerFactory = vi.fn(() => { throw new Error('Legacy SSE selected'); });
  const hub = { subscribeEvent: vi.fn(), replayAfter: vi.fn(() => ({ events: [] })) };
  const runtime = createStartupPipelineRuntime({
    createTerminalRuntime: () => ({}),
    createMessageStreamWsRuntime: () => ({}),
    createGlobalMessageStreamSseHandler: legacyHandlerFactory,
    createServerStartupRuntime: () => ({
      resolveBindHost: host => host,
      startListeningAndMaybeTunnel: async () => ({ activePort: 3000 }),
      attachProcessHandlers: () => {},
    }),
  });
  await runtime.run({
    app: { get: (route, handler) => routes.set(route, handler) },
    openCodeClient, globalEventHub: hub,
    setupProxy: () => {}, scheduleOpenCodeApiDetection: () => {},
    staticRoutesRuntime: { registerStaticRoutes: () => {} },
    tunnelRuntimeContext: { setActivePort: () => {} }, host: '127.0.0.1', port: 3000,
  });
  return { routes, hub, legacyHandlerFactory };
};

const response = () => ({
  statusCode: 0, payload: null,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.payload = payload; return this; },
});

describe('native-only startup event composition', () => {
  it.each([undefined, null, {}, { generation: () => 1 }, { generation: () => 3 }])(
    'refuses invalid runtime identity before subscribing to the hub (%j)', async client => {
      const { routes, hub, legacyHandlerFactory } = await compose(client), res = response();
      await routes.get('/api/global/event')({ headers: {}, originalUrl: '/api/global/event' }, res);
      expect(res.statusCode).toBe(503);
      expect(res.payload.code).toBe('opencode_generation_invalid');
      expect(hub.subscribeEvent).not.toHaveBeenCalled();
      expect(legacyHandlerFactory).not.toHaveBeenCalled();
    },
  );
  it('keeps explicit v2 identity distinct from an unavailable event source', async () => {
    const { routes, legacyHandlerFactory } = await compose({ generation: () => 2 });
    const res = response();
    // An unavailable native hub is readiness failure, not unsupported protocol.
    await routes.get('/api/global/event')({ headers: {}, principal: { scope: 'managed' }, originalUrl: '/api/global/event' }, res);
    expect(res.statusCode).toBe(503);
    expect(res.payload.code).toBe('opencode_unavailable');
    expect(legacyHandlerFactory).not.toHaveBeenCalled();
  });
});
