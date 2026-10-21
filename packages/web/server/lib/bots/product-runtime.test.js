import { describe, expect, it } from 'vitest';
import { createProductBotsRuntime } from './product-runtime.js';

describe('retired product Bots', () => {
  it('never initializes dependencies, probes Docker, or writes data', async () => {
    const runtime = createProductBotsRuntime(new Proxy({}, { get() { throw new Error('Dependency accessed'); } }));
    await runtime.start();
    expect(runtime.enabled).toBe(false);
    expect(await runtime.prepareStartup({ ensureRuntime() { throw new Error('Docker started'); } }))
      .toEqual({ state: 'skipped', reason: 'bots_retired' });
    expect(runtime.getRestartBlockers()).toEqual([]);
    await expect(runtime.validateTunnelBotSelection({ role: 'admin' }, ['existing-bot']))
      .rejects.toMatchObject({ code: 'bots_retired', status: 410 });
    await runtime.shutdown();
  });

  it('blocks every retained Bot route family without claiming ordinary routes', () => {
    const runtime = createProductBotsRuntime({});
    let route, handler;
    runtime.registerRoutes({ use(pattern, callback) { route = pattern; handler = callback; } });
    for (const family of ['bots', 'bot-actions', 'bot-channels', 'bot-runs', 'bot-specs', 'bot-signers', 'bot-audit']) {
      expect(route.test(`/api/${family}/anything`)).toBe(true);
    }
    expect(route.test('/api/sessions')).toBe(false);
    expect(route.test('/api/bots-unrelated')).toBe(false);
    let status, body;
    handler({}, { status(value) { status = value; return this; }, json(value) { body = value; } });
    expect(status).toBe(410);
    expect(body.code).toBe('bots_retired');
  });
});
