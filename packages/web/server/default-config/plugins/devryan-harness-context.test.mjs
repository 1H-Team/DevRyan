import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevRyanHarnessContextPlugin, __test } from './devryan-harness-context.mjs';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); delete globalThis[Symbol.for('devryan.plugin-factories.v1')]; });
const setup = async (handle = () => ({ policies: {} }), client) => {
  vi.stubEnv('DEVRYAN_ORCHESTRATION_URL', 'http://127.0.0.1:12345/rpc');
  vi.stubEnv('DEVRYAN_ORCHESTRATION_TOKEN', 'fixture-token');
  const calls = [];
  const plugin = await DevRyanHarnessContextPlugin({ client, directory: '/fixture', fetchImpl: async (_url, init) => {
    const request = JSON.parse(init.body); calls.push({ ...request, signal: init.signal });
    const result = await handle(request, init.signal);
    return new Response(JSON.stringify({ ok: true, result }));
  } });
  return { plugin, calls };
};
const input = { sessionID: 'ses_fixture', agent: 'orchestrator', message: { id: 'msg_user', variant: 'medium' }, model: { providerID: 'openai', id: 'gpt-6-astra' } };

describe('harness observations and check bridge', () => {
  it('never waits for diagnostic metadata or submits model prompts, and bounds duplicate observations', async () => {
    const f = await setup(({ method }, signal) => method === 'harness_capabilities' ? { policies: {} } : new Promise((resolve) => signal.addEventListener('abort', () => resolve({}), { once: true })));
    globalThis[Symbol.for('devryan.plugin-factories.v1')] = new Map([['a', { name: 'managed', directory: '/fixture', contentHash: 'a'.repeat(64), factoryCalls: 1, ownership: 'managed', secret: 'excluded' }], ['b', { name: 'foreign', directory: '/other' }]]);
    expect(f.plugin['chat.params'](input)).toBeUndefined();
    f.plugin['chat.params'](input);
    expect(f.calls.filter((call) => call.method === 'harness_run')).toHaveLength(1);
    expect(f.calls.at(-1).params.observedPlugins).toEqual([{ name: 'managed', contentHash: 'a'.repeat(64), factoryCalls: 1, ownership: 'managed' }]);
    expect(JSON.stringify(f.calls)).not.toContain('excluded');
    f.plugin.event({ event: { type: 'server.instance.disposed', properties: { directory: '/fixture' } } });
    expect(f.calls.every((call) => call.signal.aborted)).toBe(true);
  });
  it('sends a check receipt only for a tracked native command and uses numeric exit metadata', async () => {
    const client = { session: { messages: vi.fn(async () => ({ data: [{ info: { id: 'msg_child', role: 'assistant', sessionID: 'ses_child' },
      parts: [{ type: 'tool', tool: 'bash', callID: 'call_check', messageID: 'msg_child' }] }] })) } };
    const f = await setup(({ method, params }) => method === 'harness_capabilities' ? { policies: { compactResults: true } }
      : params.phase === 'before' && !params.messageId ? { needsIdentity: true } : { tracked: true }, client);
    const call = { tool: 'bash', sessionID: 'ses_child', callID: 'call_check' };
    await f.plugin['tool.execute.before'](call, { args: { command: 'bun test' } });
    await f.plugin['tool.execute.after'](call, { output: 'Everything passed!', metadata: { exit: 1 } });
    expect(f.calls.at(-1).params).toMatchObject({ phase: 'after', exitCode: 1, messageId: 'msg_child' });
    await f.plugin['tool.execute.after'](call, { metadata: { exit: 0 } });
    expect(f.calls.filter((entry) => entry.params.phase === 'after')).toHaveLength(1);
  });
  it('keeps optional checks off when capability is absent and standalone behavior inert', async () => {
    const f = await setup();
    await f.plugin['tool.execute.before']({ tool: 'bash' }, { args: { command: 'bun test' } });
    expect(f.calls).toHaveLength(1);
    vi.stubEnv('DEVRYAN_ORCHESTRATION_TOKEN', '');
    expect(await DevRyanHarnessContextPlugin()).toEqual({});
  });
  it('retries canonical identity after execution and forwards the command working directory', async () => {
    const client = { session: { messages: vi.fn()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [{ info: { id: 'msg_child', role: 'assistant', sessionID: 'ses_child' },
        parts: [{ type: 'tool', tool: 'bash', callID: 'call_check', messageID: 'msg_child' }] }] }) } };
    const f = await setup(({ method, params }) => method === 'harness_capabilities' ? { policies: { compactResults: true } }
      : params.phase === 'before' && !params.messageId ? { needsIdentity: true } : { tracked: true }, client);
    const call = { tool: 'bash', sessionID: 'ses_child', callID: 'call_check' };
    await f.plugin['tool.execute.before'](call, { args: { command: 'bun test', workdir: '/fixture/other' } });
    expect(f.calls.at(-1).params).toMatchObject({ phase: 'before', workdir: '/fixture/other' });
    await f.plugin['tool.execute.after'](call, { metadata: { exit: 0 } });
    expect(client.session.messages).toHaveBeenCalledTimes(2);
    expect(f.calls.at(-1).params).toMatchObject({ phase: 'after', messageId: 'msg_child', exitCode: 0 });
  });
  it('never completes a receipt when canonical identity remains missing or its bind is rejected', async () => {
    const client = { session: { messages: vi.fn(async () => ({ data: [] })) } };
    const f = await setup(({ method }) => method === 'harness_capabilities' ? { policies: { compactResults: true } }
      : { needsIdentity: true, tracked: false }, client);
    const call = { tool: 'bash', sessionID: 'ses_child', callID: 'call_check' };
    await f.plugin['tool.execute.before'](call, { args: { command: 'bun test' } });
    await f.plugin['tool.execute.after'](call, { metadata: { exit: 0 } });
    expect(f.calls.filter((entry) => entry.params.phase === 'after')).toEqual([]);
    client.session.messages.mockResolvedValue({ data: [{ info: { id: 'msg_child', role: 'assistant' },
      parts: [{ type: 'tool', tool: 'bash', callID: 'call_check' }] }] });
    await f.plugin['tool.execute.before'](call, { args: { command: 'bun test' } });
    await f.plugin['tool.execute.after'](call, { metadata: { exit: 0 } });
    expect(f.calls.filter((entry) => entry.params.phase === 'after')).toEqual([]);
  });
  it('blocks execution when the enabled check observer cannot reserve its pre-execution state', async () => {
    const f = await setup(({ method }) => {
      if (method === 'harness_capabilities') return { policies: { compactResults: true } };
      throw new Error('fixture check reservation unavailable');
    });
    await expect(f.plugin['tool.execute.before']({ tool: 'bash', sessionID: 'ses_child', callID: 'call_check' },
      { args: { command: 'bun test' } })).rejects.toMatchObject({ code: 'managed_check_observer_unavailable' });
  });
  it('retries failed capability negotiation instead of permanently skipping enabled check observation', async () => {
    let available = false;
    const f = await setup(({ method }) => {
      if (method === 'harness_capabilities') {
        if (!available) throw new Error('fixture initial bridge failure');
        return { policies: { compactResults: true } };
      }
      return { tracked: false };
    });
    const call = { tool: 'bash', sessionID: 'ses_child', callID: 'call_check' };
    await expect(f.plugin['tool.execute.before'](call, { args: { command: 'bun test' } }))
      .rejects.toMatchObject({ code: 'managed_check_observer_unavailable' });
    available = true;
    await f.plugin['tool.execute.before'](call, { args: { command: 'bun test' } });
    expect(f.calls.filter(entry => entry.method === 'required_check')).toHaveLength(1);
  });
  it('rejects malformed check reservation acknowledgements before executing a command', async () => {
    const f = await setup(({ method }) => method === 'harness_capabilities' ? { policies: { compactResults: true } } : {});
    await expect(f.plugin['tool.execute.before']({ tool: 'bash', sessionID: 'ses_child', callID: 'call_check' },
      { args: { command: 'bun test' } })).rejects.toMatchObject({ code: 'managed_check_observer_unavailable' });
  });
});

const { projectObservations, measureHeadroom } = __test();
const observation = (id) => ({ info: { id, role: 'assistant', sessionID: 'ses_root' }, parts: [{ type: 'tool',
  callID: `call_${id}`, tool: 'devryan_task', state: { status: 'completed', input: { action: 'wait' }, metadata: {},
    output: JSON.stringify({ task: { taskId: 'dvr_task_a', rootSessionId: 'ses_root', status: 'failed' },
      resultEnvelope: { envelopeId: 'dvr_result_a' }, resultHeader: { schemaVersion: 1, taskId: 'dvr_task_a',
        envelopeId: 'dvr_result_a', outcome: { status: 'failed' }, criticalFailures: ['Unit tests failed'], verification: { status: 'failed' } } }) } }] });

describe('deterministic input projection and measured headroom', () => {
  it('masks only exact duplicate managed observations while preserving canonical history and call pairs', () => {
    const messages = [observation('msg_1'), observation('msg_2')];
    const original = structuredClone(messages);
    const projected = projectObservations(messages);
    expect(projected).not.toBe(messages);
    expect(messages).toEqual(original);
    expect(projected[1].parts[0].callID).toBe('call_msg_2');
    expect(JSON.parse(projected[1].parts[0].state.output)).toMatchObject({ reference: { messageID: 'msg_1', callID: 'call_msg_1' } });
    expect(projected[0]).toBe(messages[0]);
    expect(projected[0].parts[0].state.output).toContain('Unit tests failed');
    const extended = projectObservations([...messages, observation('msg_3')]);
    expect(extended.slice(0, 2)).toEqual(projected);
    expect(JSON.parse(extended[2].parts[0].state.output).reference).toEqual({ messageID: 'msg_1', callID: 'call_msg_1' });
  });
  it('preserves opaque provider material, attachments, changed evidence and separate roots', () => {
    for (const variant of ['provider', 'attachment', 'changed', 'root']) {
      const messages = [observation('msg_1'), observation('msg_2')];
      if (variant === 'provider') messages[0].parts[0].providerMetadata = { opaque: 'signed-data' };
      if (variant === 'attachment') messages[0].parts[0].state.attachments = [{ type: 'file' }];
      if (variant === 'changed') messages[1].parts[0].state.output += ' ';
      if (variant === 'root') messages[1].info.sessionID = 'ses_other';
      expect(projectObservations(messages)).toBe(messages);
    }
  });
  it('uses current declared limits and last measured provider usage without treating bytes or totals as active input', () => {
    const model = { id: 'model', providerID: 'provider', limit: { input: 1000, context: 1200 }, variants: { small: { limit: { input: 800 } } } };
    const messages = [{ info: { id: 'msg_usage', role: 'assistant', providerID: 'provider', modelID: 'model',
      tokens: { input: 400, output: 50, cache: { read: 100 }, total: 1_000_000 } }, parts: [{ type: 'text', text: 'text' }] }];
    expect(measureHeadroom(model, messages, 'small')).toMatchObject({ inputCapacity: 800, previousRequestInputTokens: 500,
      estimatedHeadroomTokens: 250, currentActiveContextTokens: null, visibleContextBytes: 4 });
    expect(measureHeadroom({}, messages).estimatedHeadroomTokens).toBeNull();
    expect(measureHeadroom(model, [...messages, { parts: [{ type: 'compaction' }] }]).previousRequestInputTokens).toBeNull();
  });
  it('restores the same sourced checkpoint across two native compactions without changing the static prefix', async () => {
    const checkpoint = { schemaVersion: 1, sessionID: 'ses_root', anchor: { messageID: 'msg_user' },
      selectedPlan: { sourceMessageId: 'msg_plan' }, children: [{ taskId: 'dvr_task_a', status: 'running' }],
      recovery: { readOnly: true, attemptCount: 1 }, nextAction: { kind: 'inspect-managed-barrier' } };
    const f = await setup(({ method }) => method === 'harness_capabilities' ? { policies: { contextProjection: true } }
      : { available: true, checkpoint });
    for (let i = 0; i < 2; i++) {
      const compact = { context: ['Native context'] };
      await f.plugin['experimental.session.compacting']({ sessionID: 'ses_root' }, compact);
      expect(compact.context[1]).toContain('msg_plan');
      const system = { system: ['Stable role and tool rules'] };
      const prefix = system.system;
      await f.plugin['experimental.chat.system.transform']({ sessionID: 'ses_root', model: {} }, system);
      expect(system.system).toBe(prefix);
      expect(compact.context[1]).toContain('inspect-managed-barrier');
      expect(compact.context[1]).toContain('"readOnly":true');
    }
    expect(f.calls.filter(call => call.method === 'harness_context')).toHaveLength(2);
  });
  it('reports estimated headroom in explicit checkpoint results without adding a system checkpoint request', async () => {
    const f = await setup(({ method }) => method === 'harness_capabilities' ? { policies: { contextProjection: true } } : {});
    await f.plugin['experimental.chat.messages.transform']({}, { messages: [{ info: { id: 'msg_usage', role: 'assistant',
      sessionID: 'ses_root', providerID: 'provider', modelID: 'model', tokens: { input: 400, output: 50, cache: { read: 100 } } },
    parts: [{ type: 'text', text: 'text' }] }] });
    const system = { system: ['Static rules'] };
    await f.plugin['experimental.chat.system.transform']({ sessionID: 'ses_root', model: { providerID: 'provider', id: 'model', limit: { input: 800 } } }, system);
    const output = { output: JSON.stringify({ available: true, checkpoint: { sessionID: 'ses_root' } }) };
    await f.plugin['tool.execute.after']({ tool: 'devryan_task', sessionID: 'ses_root', args: { action: 'checkpoint' } }, output);
    expect(JSON.parse(output.output).headroom).toMatchObject({ previousRequestInputTokens: 500, estimatedHeadroomTokens: 250,
      currentActiveContextTokens: null, sourceMessageID: 'msg_usage' });
    expect(f.calls.filter(call => call.method === 'harness_context')).toEqual([]);
    expect(system.system).toEqual(['Static rules']);
  });
});
