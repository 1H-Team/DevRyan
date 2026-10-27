import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createManagedOpenCodeExecutor, createManagedTaskRecord, createManagedTaskResultEnvelope, createManagedTaskScheduler } from './index.js';

const content = '## Phase 1\nImplement the assigned behavior.';
const approvedPlanRef = { rootSessionId: 'ses_root', objectiveId: 'msg_goal', sourceMessageId: 'msg_plan', version: 'a'.repeat(64),
  phase: 'Phase 1', paths: ['source.js'], content, contentHash: createHash('sha256').update(content).digest('hex') };
const task = () => createManagedTaskRecord({ taskId: 'dvr_task_approved', idempotencyKey: 'approved', rootSessionId: 'ses_root',
  directory: '/workspace', parentTaskId: null, dispatchGroupId: null, sequence: 1, mode: 'orchestrator',
  providerId: 'fixture', modelId: 'model', agent: 'fixer', variant: null, label: 'Assigned behavior', prompt: 'Implement assigned behavior and verify it.',
  attempt: 1, priorTaskId: null, executionKind: 'start', createdAt: 1, timeoutAt: null, approvedPlanRef });
const assistant = (id, text) => ({ info: { id, role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text }] });

test.each(['Finished and verified.\n**Status:** complete', 'Still implementing the assigned behavior.'])('continues incomplete approved work in the same child and reports its actual outcome: %s', async final => {
  const prompts = [];
  const executor = createManagedOpenCodeExecutor({ sleep: async () => {}, transport: {
    async createSession() { return { id: 'ses_child' }; }, async promptSession(input) { prompts.push(input); },
    async readSession() { return { id: 'ses_child' }; }, async readStatus() { return { type: 'idle' }; },
    async readMessages() { return prompts.length === 1 ? [assistant('msg_first', 'Implementation is underway.')]
      : [assistant('msg_first', 'Implementation is underway.'), { info: { id: 'msg_continue', role: 'user' }, parts: [{ type: 'text', text: prompts[1].prompt }] }, assistant('msg_final', final)]; },
    async abortSession() {}, async deleteSession() {},
  } });
  try {
    const result = await executor.start(task(), { async setChildSessionId() { return true; }, async markAccepted() { return true; } });
    expect(prompts).toHaveLength(2);
    expect(prompts.every(prompt => prompt.sessionId === 'ses_child' && prompt.tools.devryan_plan_read === true)).toBe(true);
    expect(prompts[1].prompt).toContain('Implement assigned behavior and verify it.');
    expect(result.status).toBe(final.endsWith('**Status:** complete') ? 'completed' : 'failed');
    if (result.status === 'failed') expect(result).toMatchObject({ partial: true, resumable: true });
  } finally { await executor.shutdown(); }
});

test('does not manufacture completion from a blocked child report', async () => {
  const executor = createManagedOpenCodeExecutor({ sleep: async () => {}, transport: {
    async createSession() { return { id: 'ses_child' }; }, async promptSession() {}, async readSession() { return { id: 'ses_child' }; },
    async readStatus() { return { type: 'idle' }; }, async readMessages() { return [assistant('msg_blocked', 'Docker daemon unavailable.\n**Status:** blocked')]; },
    async abortSession() {}, async deleteSession() {},
  } });
  try {
    expect(await executor.start(task(), { async setChildSessionId() { return true; }, async markAccepted() { return true; } }))
      .toMatchObject({ status: 'failed', partial: true, failureReason: 'Managed child reports blocked; review retained evidence before continuing' });
  } finally { await executor.shutdown(); }
});

test('completed approved assignments refuse retry and resume while retaining their immutable record', async () => {
  const completed = { ...task(), status: 'completed', childSessionId: 'ses_child', leaseToken: 'dvr_lease_1', startedAt: 2, finishedAt: 3 };
  const envelope = createManagedTaskResultEnvelope(completed, { sequence: 2, createdAt: 3, resumable: true });
  const scheduler = createManagedTaskScheduler({ now: () => 10, persistence: { async load() { return { version: 1, tasks: [completed], resultEnvelopes: [envelope] }; }, async save() {} },
    executor: { async start() { throw Error('completed assignment must not execute'); } } });
  try {
    await scheduler.initialize();
    for (const action of ['retry', 'resume']) await expect(scheduler.acknowledgeResult(completed.taskId, { action, idempotencyKey: action }))
      .rejects.toMatchObject({ code: 'approved_plan_assignment_completed' });
    expect(scheduler.getTask(completed.taskId)).toEqual(completed);
  } finally { await scheduler.shutdown(); }
});
