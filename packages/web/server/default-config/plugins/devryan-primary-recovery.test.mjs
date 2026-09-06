import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevRyanPrimaryRecoveryPlugin } from './devryan-primary-recovery.mjs';

const originalUrl = process.env.DEVRYAN_ORCHESTRATION_URL;
const originalToken = process.env.DEVRYAN_ORCHESTRATION_TOKEN;
afterEach(() => {
  if (originalUrl === undefined) delete process.env.DEVRYAN_ORCHESTRATION_URL;
  else process.env.DEVRYAN_ORCHESTRATION_URL = originalUrl;
  if (originalToken === undefined) delete process.env.DEVRYAN_ORCHESTRATION_TOKEN;
  else process.env.DEVRYAN_ORCHESTRATION_TOKEN = originalToken;
  delete globalThis[Symbol.for('devryan.primary-recovery.instance.v1')];
});

async function setup({ guarded = true, ids = ['read', 'glob', 'grep', 'bash'], fail = false } = {}) {
  process.env.DEVRYAN_ORCHESTRATION_URL = 'http://127.0.0.1:12345/rpc';
  process.env.DEVRYAN_ORCHESTRATION_TOKEN = 'isolated-fixture-token';
  const calls = [];
  const client = { // Deliberately the v1 SDK shape: no client.global.health.
    session: { messages: vi.fn(async () => ({ data: [{ info: { id: 'msg_assistant', parentID: 'msg_user', role: 'assistant' },
      parts: [{ id: 'prt_tool', type: 'tool', callID: 'call_tool' }] }] })) },
    tool: { ids: vi.fn(async () => ({ data: ids })) },
  };
  const plugin = await DevRyanPrimaryRecoveryPlugin({ client, directory: '/fixture', fetchImpl: async (_url, init) => {
    const { params } = JSON.parse(init.body); calls.push(params);
    const blocked = fail || (params.action === 'tool_before' && (!params.nativeToolVerified || params.tool !== 'read'));
    return new Response(JSON.stringify(blocked ? { ok: false, error: { code: 'recovery_requires_user_action' } }
      : { ok: true, result: params.action === 'scope' ? { tracked: true, enforced: true, readOnly: guarded, agent: 'orchestrator' } : { allowed: true } }),
    { status: blocked ? 409 : 200 });
  } });
  return { plugin, client, calls };
}

describe('versioned primary recovery plugin boundary', () => {
  it('uses the private host for version verification and resolves exact model step', async () => {
    const f = await setup();
    await f.plugin['chat.params']({ sessionID: 'ses_fixture', agent: 'orchestrator', message: { id: 'msg_user' }, provider: { options: { timeout: 900000 } } });
    expect(f.calls.map((p) => p.action)).toEqual(['hello', 'scope', 'step']);
    expect(f.calls.at(-1)).toMatchObject({ assistantMessageID: 'msg_assistant', userMessageID: 'msg_user', timeouts: { total: 900000 } });
  });
  it('allows only a uniquely registered native inspection tool', async () => {
    const f = await setup();
    await f.plugin['tool.execute.before']({ sessionID: 'ses_fixture', callID: 'call_tool', tool: 'read' });
    expect(f.calls.at(-1).nativeToolVerified).toBe(true);
    const collision = await setup({ ids: ['read', 'read', 'bash'] });
    await expect(collision.plugin['tool.execute.before']({ sessionID: 'ses_fixture', callID: 'call_tool', tool: 'read' })).rejects.toThrow('requires_user_action');
  });
  it.each(['bash', 'write', 'browser', 'devryan_task', 'mcp_unverified'])('blocks %s before execution', async (tool) => {
    const f = await setup();
    await expect(f.plugin['tool.execute.before']({ sessionID: 'ses_fixture', callID: 'call_tool', tool })).rejects.toThrow('requires_user_action');
  });
  it('fails closed on bridge failure and ignores title helper model calls', async () => {
    const f = await setup({ fail: true });
    await expect(f.plugin['chat.message']({ sessionID: 'ses_fixture' }, { message: { id: 'msg_user' } })).rejects.toThrow();
    const title = await setup();
    await title.plugin['chat.params']({ sessionID: 'ses_fixture', agent: 'title', message: { id: 'msg_user' } });
    expect(title.calls.some((p) => p.action === 'step')).toBe(false);
  });
  it('does not claim safeguards without a managed bridge', async () => {
    delete process.env.DEVRYAN_ORCHESTRATION_URL;
    expect(await DevRyanPrimaryRecoveryPlugin({})).toEqual({});
  });
  it.each(['request', 'response'])('identifies the failed RPC phase without weakening a %s failure', async (phase) => {
    process.env.DEVRYAN_ORCHESTRATION_URL = 'http://127.0.0.1:12345/rpc';
    process.env.DEVRYAN_ORCHESTRATION_TOKEN = 'isolated-fixture-token';
    const cause = new DOMException('The operation timed out.', 'TimeoutError');
    let signal;
    const plugin = await DevRyanPrimaryRecoveryPlugin({ fetchImpl: async (_url, init) => {
      signal = init.signal;
      if (phase === 'request') throw cause;
      return { json: async () => { throw cause; } };
    } });
    await expect(plugin['chat.message']({ sessionID: 'ses_fixture' }, { message: { id: 'msg_user' } }))
      .rejects.toMatchObject({ message: `Primary recovery hello ${phase} failed`, cause });
    expect(signal).toBeInstanceOf(AbortSignal);
  });
  it('accepts a verified hello returned just after the host health budget without retrying', async () => {
    process.env.DEVRYAN_ORCHESTRATION_URL = 'http://127.0.0.1:12345/rpc';
    process.env.DEVRYAN_ORCHESTRATION_TOKEN = 'isolated-fixture-token';
    const actions = [];
    const plugin = await DevRyanPrimaryRecoveryPlugin({ fetchImpl: async (_url, init) => {
      const { params } = JSON.parse(init.body);
      actions.push(params.action);
      if (params.action === 'hello') await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(init.signal.reason); };
        const timer = setTimeout(() => { init.signal.removeEventListener('abort', abort); resolve(); }, 5200);
        init.signal.addEventListener('abort', abort, { once: true });
      });
      return new Response(JSON.stringify({ ok: true, result: { allowed: true } }));
    } });
    await plugin['chat.message']({ sessionID: 'ses_fixture' }, { message: { id: 'msg_user' } });
    expect(actions).toEqual(['hello', 'message']);
  }, 15000);
  it('keeps ordinary message RPCs bounded and fail-closed after the handshake succeeds', async () => {
    process.env.DEVRYAN_ORCHESTRATION_URL = 'http://127.0.0.1:12345/rpc';
    process.env.DEVRYAN_ORCHESTRATION_TOKEN = 'isolated-fixture-token';
    const deadlines = [];
    const originalTimeout = AbortSignal.timeout;
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      deadlines.push(ms); return originalTimeout(ms);
    });
    try {
      const cause = new DOMException('The operation timed out.', 'TimeoutError');
      const plugin = await DevRyanPrimaryRecoveryPlugin({ fetchImpl: async (_url, init) => {
        const { params } = JSON.parse(init.body);
        if (params.action === 'message') throw cause;
        return new Response(JSON.stringify({ ok: true, result: { allowed: true } }));
      } });
      await expect(plugin['chat.message']({ sessionID: 'ses_fixture' }, { message: { id: 'msg_user' } }))
        .rejects.toMatchObject({ message: 'Primary recovery message request failed', cause });
      expect(deadlines).toEqual([10000, 5000]);
    } finally { timeout.mockRestore(); }
  });
});
