import { expect, it } from 'vitest';
import { createWebManagedOrchestrationRuntime } from './runtime.js';

const failure = { name: 'UnknownError', data: { message: JSON.stringify({
  type: 'api_error', message: 'Claude Code returned an error result: API Error: Connection closed mid-response. The response above may be incomplete.\nSubprocess stderr: Warning: Custom betas are only available for API key users. Ignoring provided betas.',
}) } };

it.each(['completed', 'failed', 'unavailable'])('routes live disconnects through durable same-model and backup recovery: %s', async (backupOutcome) => {
  let clock = 10_000;
  let snapshot = null;
  let taskIndex = 0;
  let creates = 0;
  let quotaProbes = 0;
  const prompts = [];
  const messages = [];
  const receipts = [];
  const runtime = createWebManagedOrchestrationRuntime({
    now: () => clock, createTaskId: () => `dvr_task_transport_${++taskIndex}`,
    createLeaseToken: () => `dvr_lease_transport_${taskIndex}`,
    persistence: {
      async load() { return snapshot; },
      async save(next) {
        snapshot = structuredClone(next);
        receipts.push(...next.tasks.filter((t) => t.transportRecovery).map((t) => structuredClone(t.transportRecovery)));
      },
    },
    resolveTaskPromptPreamble: () => null,
    resolveBackupExecution: async () => ({ providerId: 'openai', modelId: 'gpt-backup', variant: 'high' }),
    resolveProviderReset: () => { quotaProbes++; throw new Error('Transport failure must not probe quota'); },
    validateAgentExecution: async ({ providerId }) => providerId === 'openai' ? backupOutcome !== 'unavailable' : true,
    buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
    getOpenCodeAuthHeaders: () => ({}),
    fetchImpl: async (url, init) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/session' && init.method === 'POST') { creates++; return Response.json({ id: 'ses_transport' }); }
      if (pathname.endsWith('/prompt_async')) {
        const body = JSON.parse(init.body);
        if (prompts.length > 0) {
          expect(snapshot.tasks.some((t) => t.transportRecovery?.phase === 'reserved'
            && t.transportRecovery.recoveryMessageId === body.messageID)).toBe(true);
        }
        prompts.push(body);
        clock += 100;
        const userId = body.messageID ?? 'msg_original_user';
        const id = `msg_assistant_${prompts.length}`;
        messages.push({ info: { id: userId, role: 'user' }, parts: body.parts });
        const fails = prompts.length < 3 || backupOutcome === 'failed';
        messages.push({
          info: { id, parentID: userId, role: 'assistant', time: { created: clock, completed: clock + 1 },
            ...(fails ? { error: failure } : { finish: 'stop' }) },
          parts: [{ type: 'text', text: fails ? 'Existing completed work' : 'Finished on the backup' },
            ...(fails ? [{ type: 'tool', tool: 'edit', callID: `tool_pending_${prompts.length}`,
              state: { status: 'error', input: {}, time: {}, error: 'Tool execution aborted' } }] : [])],
        });
        if (fails) runtime.processOpenCodeEvent({
          id: `evt_failure_${prompts.length}`, type: 'session.error',
          properties: { sessionID: 'ses_transport', error: failure },
        }, '/workspace');
        return new Response(null, { status: 204 });
      }
      if (pathname === '/session/status') return Response.json({ ses_transport: { type: 'idle' } });
      if (pathname.endsWith('/message')) return Response.json(messages);
      if (pathname === '/session/ses_transport') return Response.json({ id: 'ses_transport' });
      throw new Error(`Unexpected fixture request ${pathname}`);
    },
  });
  try {
    await runtime.handleRpc({ method: 'submit', params: {
      idempotencyKey: 'transport-incident', rootSessionId: 'ses_root', directory: '/workspace',
      mode: 'orchestrator', dispatchGroupId: 'msg_parent', parentTaskId: null,
      providerId: 'anthropic', modelId: 'claude-opus-5', agent: 'designer', variant: 'medium',
      label: 'Transport recovery', prompt: 'Finish the existing task',
    } });
    const deadline = Date.now() + 8_000;
    let state;
    for (;;) {
      state = await runtime.getSnapshot({ rootSessionId: 'ses_root' });
      const source = state.resultEnvelopes[0];
      if (['succeeded', 'ended', 'exhausted'].includes(source?.autoResume?.state)) break;
      if (Date.now() > deadline) throw new Error('Transport recovery fixture did not settle');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(creates).toBe(1);
    expect(prompts.map((p) => p.model.providerID)).toEqual(backupOutcome === 'unavailable'
      ? ['anthropic', 'anthropic'] : ['anthropic', 'anthropic', 'openai']);
    expect(prompts[1].parts[0].text).toContain('connection was interrupted');
    expect(state.resultEnvelopes[0].autoResume).toMatchObject({
      trigger: 'provider_transport', rejectionsInWindow: 0, resetAt: null,
      state: backupOutcome === 'completed' ? 'succeeded' : backupOutcome === 'failed' ? 'ended' : 'exhausted',
    });
    if (backupOutcome !== 'unavailable') {
      expect(prompts[2]).toMatchObject({ agent: 'designer', variant: 'high' });
      expect(prompts[2].parts[0].text).toContain('after a provider connection interruption');
      expect(state.tasks[1]).toMatchObject({ childSessionId: 'ses_transport', status: backupOutcome,
        transportRecovery: { sameModelAttempts: 1, backupAttempts: 1 } });
      if (backupOutcome === 'failed') expect(state.resultEnvelopes[1]).toMatchObject({ autoResume: null, resumable: true, action: null });
    }
    expect(receipts.some((r) => r.phase === 'reserved')).toBe(true);
    expect(quotaProbes).toBe(0);
    expect(runtime.getDiagnostics().scheduler.providerBreakerCount).toBe(0);
  } finally {
    await runtime.shutdown();
  }
}, 12_000);
