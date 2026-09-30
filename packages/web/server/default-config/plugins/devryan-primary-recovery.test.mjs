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
  delete globalThis[Symbol.for('devryan.primary-recovery.ready.v1')];
  delete globalThis[Symbol.for('devryan.preexecution-rejection.v1')];
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
  it('forwards the exact Claude execution identity through the shared guard bridge', async () => {
    const f = await setup();
    await f.plugin['chat.params']({ sessionID: 'ses_fixture', agent: 'orchestrator',
      model: { providerID: 'anthropic', id: 'claude-opus-5' }, message: { id: 'msg_user', variant: 'high' } });
    expect(f.calls.at(-1)).toMatchObject({ action: 'step', userMessageID: 'msg_user', assistantMessageID: 'msg_assistant',
      execution: { providerID: 'anthropic', modelID: 'claude-opus-5', agent: 'orchestrator', variant: 'high' } });
    await expect(f.plugin['tool.execute.before']({ sessionID: 'ses_fixture', callID: 'call_tool', tool: 'edit' }))
      .rejects.toThrow('requires_user_action');
  });
  it("resolves a tool call's invoking step once for both of its hooks", async () => {
    const f = await setup();
    await f.plugin['tool.execute.before']({ sessionID: 'ses_fixture', callID: 'call_tool', tool: 'read' });
    await f.plugin['tool.execute.after']({ sessionID: 'ses_fixture', callID: 'call_tool', tool: 'read' });
    expect(f.client.session.messages).toHaveBeenCalledTimes(1);
    expect(f.calls.filter((p) => p.action === 'tool_after')).toEqual([
      expect.objectContaining({ assistantMessageID: 'msg_assistant', userMessageID: 'msg_user', callID: 'call_tool' })]);
    // The finished call is forgotten: a later hook for it looks the step up again.
    await f.plugin['tool.execute.before']({ sessionID: 'ses_fixture', callID: 'call_tool', tool: 'read' });
    expect(f.client.session.messages).toHaveBeenCalledTimes(2);
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


describe('read-only scope transport recovery', () => {
  it.each(['request', 'response'])('retries one failed scope %s before submitting a model step', async (phase) => {
    process.env.DEVRYAN_ORCHESTRATION_URL = 'http://127.0.0.1:12345/rpc';
    process.env.DEVRYAN_ORCHESTRATION_TOKEN = 'isolated-fixture-token';
    const actions = [];
    let scopes = 0;
    const plugin = await DevRyanPrimaryRecoveryPlugin({
      client: { session: { messages: async () => ({ data: [{ info: { id: 'msg_assistant', parentID: 'msg_user', role: 'assistant' }, parts: [] }] }) } },
      fetchImpl: async (_url, init) => {
        const { params } = JSON.parse(init.body);
        actions.push(params.action);
        if (params.action === 'scope' && ++scopes === 1) {
          const cause = new DOMException('Timed out', 'TimeoutError');
          if (phase === 'request') throw cause;
          return { json: async () => { throw cause; } };
        }
        return new Response(JSON.stringify({ ok: true, result: params.action === 'scope'
          ? { tracked: true, enforced: true, readOnly: false, agent: 'orchestrator' } : { allowed: true } }));
      },
    });
    await plugin['chat.params']({ sessionID: 'ses_fixture', agent: 'orchestrator', message: { id: 'msg_user' } });
    expect(actions).toEqual(['hello', 'scope', 'scope', 'step']);
  });

  it.each(['transport', 'rejection'])('keeps a persistent scope %s fail-closed without model or tool execution', async (failure) => {
    process.env.DEVRYAN_ORCHESTRATION_URL = 'http://127.0.0.1:12345/rpc';
    process.env.DEVRYAN_ORCHESTRATION_TOKEN = 'isolated-fixture-token';
    const actions = [];
    const plugin = await DevRyanPrimaryRecoveryPlugin({ fetchImpl: async (_url, init) => {
      const { params } = JSON.parse(init.body);
      actions.push(params.action);
      if (params.action === 'scope') {
        if (failure === 'transport') throw new DOMException('Timed out', 'TimeoutError');
        return new Response(JSON.stringify({ ok: false, error: { code: 'recovery_owner_mismatch' } }), { status: 409 });
      }
      return new Response(JSON.stringify({ ok: true, result: {} }));
    } });
    await expect(plugin['chat.params']({ sessionID: 'ses_fixture', message: { id: 'msg_user' } })).rejects.toThrow();
    expect(actions).toEqual(failure === 'transport' ? ['hello', 'scope', 'scope'] : ['hello', 'scope']);
  });
});

// In observe mode, or on a runtime outside the recovery allow-list, the host
// reports `enforced: false`. Its hooks then only observe.
describe('a host that does not enforce recovery', () => {
  const advisorySetup = async ({ enforced = false, scope = { tracked: true, enforced: false, readOnly: false, agent: 'orchestrator' } } = {}) => {
    process.env.DEVRYAN_ORCHESTRATION_URL = 'http://127.0.0.1:12345/rpc';
    process.env.DEVRYAN_ORCHESTRATION_TOKEN = 'isolated-fixture-token';
    const state = { actions: [], unreachable: false, rejected: null };
    const plugin = await DevRyanPrimaryRecoveryPlugin({ directory: '/fixture',
      client: { session: { messages: async () => ({ data: [{ info: { id: 'msg_assistant', parentID: 'msg_user', role: 'assistant' },
        parts: [{ id: 'prt_tool', type: 'tool', callID: 'call_tool' }] }] }) }, tool: { ids: async () => ({ data: ['read'] }) } },
      fetchImpl: async (_url, init) => {
        const { params } = JSON.parse(init.body);
        state.actions.push(params.action);
        if (params.action !== 'hello' && state.unreachable) throw new DOMException('The operation timed out.', 'TimeoutError');
        if (params.action !== 'hello' && state.rejected) return new Response(JSON.stringify({ ok: false, error: { code: state.rejected } }), { status: 409 });
        return new Response(JSON.stringify({ ok: true, result: params.action === 'hello' ? { supported: true, enforced }
          : params.action === 'scope' ? scope : { allowed: true } }));
      } });
    return { plugin, state };
  };
  const step = { sessionID: 'ses_fixture', agent: 'orchestrator', message: { id: 'msg_user' } };
  const tool = { sessionID: 'ses_fixture', callID: 'call_tool', tool: 'bash' };
  afterEach(() => { vi.useRealTimers(); delete process.env.DEVRYAN_RECOVERY_ADVISORY_PLUGIN; });

  it('does not fail a turn when the host is unreachable', async () => {
    const { plugin, state } = await advisorySetup();
    await plugin['chat.message']({ sessionID: 'ses_fixture' }, { message: { id: 'msg_user' } });
    state.unreachable = true;
    await expect(plugin['chat.message']({ sessionID: 'ses_fixture' }, { message: { id: 'msg_user' } })).resolves.toBeUndefined();
    await expect(plugin['chat.params'](step)).resolves.toBeUndefined();
    await expect(plugin['tool.execute.before'](tool)).resolves.toBeUndefined();
    await expect(plugin['tool.execute.after'](tool)).resolves.toBeUndefined();
  });

  it('reuses a verdict that cannot stop a turn for 30 seconds, until the next user message', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const { plugin, state } = await advisorySetup();
    const scopes = () => state.actions.filter((action) => action === 'scope').length;
    await plugin['chat.params'](step);
    await plugin['tool.execute.before'](tool);
    await plugin['tool.execute.after'](tool);
    expect(scopes()).toBe(1);
    expect(state.actions).toEqual(['hello', 'scope', 'step', 'tool_before', 'tool_after']);
    vi.setSystemTime(1_000_000 + 30_001);
    await plugin['chat.params'](step);
    expect(scopes()).toBe(2);
    await plugin['chat.message']({ sessionID: 'ses_fixture' }, { message: { id: 'msg_next' } });
    await plugin['chat.params'](step);
    expect(scopes()).toBe(3);
  });

  it('keeps every host rejection', async () => {
    const { plugin, state } = await advisorySetup();
    await plugin['chat.params'](step);
    state.rejected = 'provider_recovery_fenced';
    await expect(plugin['tool.execute.before'](tool)).rejects.toMatchObject({ code: 'provider_recovery_fenced' });
    await expect(plugin['chat.message']({ sessionID: 'ses_fixture' }, { message: { id: 'msg_user' } }))
      .rejects.toMatchObject({ code: 'provider_recovery_fenced' });
  });

  it('never reuses or forgives a verdict that can stop a turn', async () => {
    const guarded = await advisorySetup({ scope: { tracked: true, enforced: false, readOnly: true, agent: 'orchestrator' } });
    await guarded.plugin['chat.params'](step);
    await guarded.plugin['chat.params'](step);
    expect(guarded.state.actions.filter((action) => action === 'scope')).toHaveLength(2);
    guarded.state.unreachable = true;
    await expect(guarded.plugin['chat.params'](step)).rejects.toThrow('Primary recovery scope request failed');
    await expect(guarded.plugin['tool.execute.before'](tool)).rejects.toThrow('Primary recovery scope request failed');
  });

  it('stays fail-closed while the host enforces, and with the kill switch', async () => {
    const enforcing = await advisorySetup({ enforced: true });
    await enforcing.plugin['chat.params'](step);
    await enforcing.plugin['chat.params'](step);
    expect(enforcing.state.actions.filter((action) => action === 'scope')).toHaveLength(2);
    enforcing.state.unreachable = true;
    await expect(enforcing.plugin['chat.params'](step)).rejects.toThrow('Primary recovery scope request failed');
    await expect(enforcing.plugin['chat.message']({ sessionID: 'ses_fixture' }, { message: { id: 'msg_user' } }))
      .rejects.toThrow('Primary recovery message request failed');

    process.env.DEVRYAN_RECOVERY_ADVISORY_PLUGIN = '0';
    const disabled = await advisorySetup();
    await disabled.plugin['chat.params'](step);
    disabled.state.unreachable = true;
    await expect(disabled.plugin['chat.params'](step)).rejects.toThrow('Primary recovery scope request failed');
  });
});
