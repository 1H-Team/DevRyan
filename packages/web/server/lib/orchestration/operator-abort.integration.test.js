import { expect, it } from 'vitest';
import { createWebManagedOrchestrationRuntime } from './runtime.js';

// Exercise the current HTTP adapter and operator registry, including Stop
// arriving after the loop's registry poll while a transcript read is pending.
it.each(['after-prompt', 'during-transcript-read'])('settles a user Stop %s without a continuation prompt', async (stopAt) => {
  let clock = 10_000;
  let snapshot = null;
  const prompts = [];
  const messages = [];
  let stopRecorded = false;
  const recordStop = () => {
    if (stopRecorded) return;
    stopRecorded = true;
    runtime.recordOperatorAbort({ sessionId: 'ses_stop', requestedAt: clock });
  };
  const runtime = createWebManagedOrchestrationRuntime({
    now: () => clock,
    createTaskId: () => 'dvr_task_stop',
    createLeaseToken: () => 'dvr_lease_stop',
    persistence: {
      async load() { return snapshot; },
      async save(next) { snapshot = structuredClone(next); },
    },
    resolveTaskPromptPreamble: () => null,
    resolveBackupExecution: async () => null,
    buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
    getOpenCodeAuthHeaders: () => ({}),
    fetchImpl: async (url, init) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/agent') return Response.json([{ name: 'designer', mode: 'subagent' }]);
      if (pathname === '/session' && init.method === 'POST') return Response.json({ id: 'ses_stop' });
      if (pathname.endsWith('/prompt_async')) {
        const body = JSON.parse(init.body);
        prompts.push(body);
        clock += 100;
        messages.push({ info: { id: 'msg_user', role: 'user', time: { created: clock - 50 } }, parts: body.parts });
        messages.push({ info: { id: 'msg_stopped', parentID: 'msg_user', role: 'assistant', time: { created: clock, completed: clock + 1 } }, parts: [] });
        if (stopAt === 'after-prompt') recordStop();
        return new Response(null, { status: 204 });
      }
      if (pathname.endsWith('/abort')) return Response.json(true);
      if (pathname === '/session/status') return Response.json({});
      if (pathname.endsWith('/message')) {
        const response = Response.json(messages);
        if (stopAt === 'during-transcript-read' && messages.length) {
          await Promise.resolve();
          recordStop();
        }
        return response;
      }
      if (pathname === '/session/ses_stop') return Response.json({ id: 'ses_stop' });
      throw new Error(`Unexpected fixture request ${pathname}`);
    },
  });
  try {
    await runtime.handleRpc({ method: 'submit', params: {
      idempotencyKey: 'operator-stop', rootSessionId: 'ses_root', directory: '/workspace',
      mode: 'orchestrator', dispatchGroupId: 'msg_parent', parentTaskId: null,
      providerId: 'anthropic', modelId: 'claude-opus-5', agent: 'designer', variant: 'medium',
      label: 'Operator stop', prompt: 'Do the work',
    } });
    const deadline = Date.now() + 8_000;
    let state;
    for (;;) {
      state = await runtime.getSnapshot({ rootSessionId: 'ses_root' });
      if (['completed', 'failed', 'aborted', 'interrupted'].includes(state.tasks[0]?.status)) break;
      if (Date.now() > deadline) throw new Error('Operator stop fixture did not settle');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(state.tasks[0]).toMatchObject({ status: 'aborted', failureReason: 'Stopped by the user' });
    expect(prompts).toHaveLength(1);
  } finally {
    await runtime.shutdown();
  }
}, 12_000);
