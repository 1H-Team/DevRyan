import { expect, test } from 'bun:test';
import { createManagedTaskScheduler } from './scheduler.js';
import { validatePrimaryStepBudget } from './designer-step-budget.js';

const fixture = async ({ accepted = true } = {}) => {
  let saved = null, failSave = false, ready;
  const started = new Promise(resolve => { ready = resolve; });
  let control;
  const persistence = { load: async () => saved, save: async value => {
    if (failSave) throw Error('disk unavailable');
    saved = structuredClone(value);
  } };
  const options = { persistence, now: () => 1000, createTaskId: () => 'dvr_task_budget',
    executor: { start: async (task, owner) => {
      control = owner;
      await owner.setChildSessionId('ses_child'); await owner.markAccepted();
      await owner.recordProgress({ childPromptedAt: 1000 }); ready();
      return new Promise(() => {});
    }, observe: async () => new Promise(() => {}), reconcile: async () => ({ state: 'live', accepted: true }) } };
  const scheduler = createManagedTaskScheduler(options);
  await scheduler.submit({ idempotencyKey: 'budget', rootSessionId: 'ses_root', directory: '/workspace', mode: 'orchestrator',
    providerId: 'claude-agent', modelId: 'opus', agent: 'designer', label: 'Design', prompt: 'Implement the phase.', timeoutAt: null });
  await started;
  const scope = { taskId: 'dvr_task_budget', leaseToken: scheduler.getTask('dvr_task_budget').leaseToken,
    sessionId: 'ses_child', directory: '/workspace', createdAt: 1000, userMessageId: 'msg_user' };
  if (accepted) await scheduler.acceptPrimaryPrompt({ ...scope, userMessageId: 'msg_user' });
  return { scheduler, options, scope, control, fail: value => { failSave = value; } };
};

test('counts canonical primary IDs once and durably claims one warning across restart', async () => {
  const f = await fixture();
  let restored;
  try {
    expect(await f.scheduler.recordPrimaryStep({ ...f.scope, messageId: 'msg_old', createdAt: 999 })).toBeNull();
    expect(await f.scheduler.recordPrimaryStep({ ...f.scope, messageId: 'msg_forged', leaseToken: 'stale' })).toBeNull();
    for (let index = 1; index <= 179; index++) await f.scheduler.recordPrimaryStep({ ...f.scope, messageId: `msg_${index}` });
    const claim = { ...f.scope, messageId: 'msg_179', callId: 'call_one' };
    expect(await f.scheduler.claimPrimaryStepBudgetWarning(claim)).toBeNull();
    expect(await f.scheduler.recordPrimaryStep({ ...f.scope, messageId: 'msg_179' })).toEqual({ usedSteps: 179 });
    await f.scheduler.recordPrimaryStep({ ...f.scope, messageId: 'msg_180' });
    const claims = await Promise.all([1, 2].map(() => f.scheduler.claimPrimaryStepBudgetWarning({ ...claim, messageId: 'msg_180' })));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)).toMatchObject({ notice: { code: 'designer_step_budget_warning', usedSteps: 180, limit: 260, attempt: 1 } });
    expect(await f.control.readPrimaryStepBudget()).toMatchObject({ usedSteps: 180 });
    const exposed = f.scheduler.getTask(f.scope.taskId); exposed.primaryStepBudget.assistantMessageIDs.push('msg_mutated');
    expect(f.scheduler.getTask(f.scope.taskId).primaryStepBudget.assistantMessageIDs).toHaveLength(180);
    await f.scheduler.shutdown();
    restored = createManagedTaskScheduler(f.options); await restored.initialize();
    const task = restored.getTask(f.scope.taskId);
    expect(task.primaryStepBudget.assistantMessageIDs).toHaveLength(180);
    expect(await restored.acceptPrimaryPrompt({ ...f.scope, leaseToken: task.leaseToken })).toBe(true);
    expect(await restored.recordPrimaryStep({ ...f.scope, messageId: 'msg_180', leaseToken: task.leaseToken })).toEqual({ usedSteps: 180 });
    expect(await restored.claimPrimaryStepBudgetWarning({ ...claim, messageId: 'msg_180', leaseToken: task.leaseToken })).toBeNull();
  } finally { await restored?.shutdown(); await f.scheduler.shutdown(); }
});

test('a failed durable claim rolls back and the retry can deliver the warning', async () => {
  const f = await fixture();
  try {
    for (let index = 1; index <= 180; index++) await f.scheduler.recordPrimaryStep({ ...f.scope, messageId: `msg_${index}` });
    f.fail(true);
    await expect(f.scheduler.claimPrimaryStepBudgetWarning({ ...f.scope, messageId: 'msg_180', callId: 'call_one' })).rejects.toThrow('disk unavailable');
    expect(f.scheduler.getTask(f.scope.taskId).primaryStepBudget.warningClaimedAt).toBeNull();
    f.fail(false);
    expect(await f.scheduler.claimPrimaryStepBudgetWarning({ ...f.scope, messageId: 'msg_180', callId: 'call_two' })).not.toBeNull();
  } finally { f.fail(false); await f.scheduler.shutdown(); }
});

test('validates persisted bounded IDs and warning ordering', () => {
  expect(() => validatePrimaryStepBudget({ acceptedPrompts: [{ userMessageID: 'msg_user', createdAt: 1 }], userMessageID: 'msg_user', assistantMessageIDs: ['msg_1', 'msg_1'], warningClaimedAt: null })).toThrow();
  expect(() => validatePrimaryStepBudget({ acceptedPrompts: [{ userMessageID: 'msg_user', createdAt: 1 }], userMessageID: 'msg_user', assistantMessageIDs: [], warningClaimedAt: 1 })).toThrow();
  expect(() => validatePrimaryStepBudget({ acceptedPrompts: [{ userMessageID: 'msg_user', createdAt: 1 }], userMessageID: 'msg_user', assistantMessageIDs: Array.from({ length: 261 }, (_, i) => `msg_${i}`), warningClaimedAt: null })).toThrow();
});

test('a separately accepted prompt resets steps and warning only when its own primary step starts', async () => {
  const f = await fixture();
  try {
    for (let index = 1; index <= 180; index++) await f.scheduler.recordPrimaryStep({ ...f.scope, messageId: `msg_${index}` });
    expect(await f.scheduler.claimPrimaryStepBudgetWarning({ ...f.scope, messageId: 'msg_180', callId: 'call_old' })).not.toBeNull();
    await f.scheduler.acceptPrimaryPrompt({ ...f.scope, userMessageId: 'msg_next', createdAt: 1001 });
    expect(await f.control.readPrimaryStepBudget()).toMatchObject({ usedSteps: 180 });
    expect(await f.scheduler.recordPrimaryStep({ ...f.scope, messageId: 'msg_next_step', userMessageId: 'msg_next', createdAt: 1001 })).toEqual({ usedSteps: 1 });
    expect(f.scheduler.getTask(f.scope.taskId).primaryStepBudget.warningClaimedAt).toBeNull();
    expect(await f.scheduler.recordPrimaryStep({ ...f.scope, messageId: 'msg_179' })).toBeNull();
    expect(await f.scheduler.acceptPrimaryPrompt({ ...f.scope, userMessageId: 'msg_user' })).toBe(true);
    expect(await f.scheduler.recordPrimaryStep({ ...f.scope, messageId: 'msg_next_step', userMessageId: 'msg_next', createdAt: 1001 })).toEqual({ usedSteps: 1 });
    expect(await f.scheduler.recordPrimaryStep({ ...f.scope, messageId: 'msg_unaccepted', userMessageId: 'msg_unregistered' })).toBeNull();
    for (let index = 2; index <= 180; index++) await f.scheduler.recordPrimaryStep({ ...f.scope, userMessageId: 'msg_next', messageId: `msg_next_${index}`, createdAt: 1001 });
    expect(await f.scheduler.claimPrimaryStepBudgetWarning({ ...f.scope, messageId: 'msg_next_180', callId: 'call_next' })).toMatchObject({ notice: { usedSteps: 180 } });
  } finally { await f.scheduler.shutdown(); }
});

test('the emergency counter is bounded and stale or unknown prompt replay cannot restart it', async () => {
  const f = await fixture();
  try {
    for (let index = 1; index <= 261; index++) await f.scheduler.recordPrimaryStep({ ...f.scope, messageId: `msg_${index}` });
    expect(await f.control.readPrimaryStepBudget()).toMatchObject({ usedSteps: 260 });
    expect(f.scheduler.getTask(f.scope.taskId).primaryStepBudget.assistantMessageIDs).toHaveLength(260);
    expect(await f.scheduler.acceptPrimaryPrompt({ ...f.scope, userMessageId: 'msg_before_task', createdAt: 999 })).toBeNull();
    expect(await f.scheduler.recordPrimaryStep({ ...f.scope, messageId: 'msg_fake', userMessageId: 'msg_before_task' })).toBeNull();
  } finally { await f.scheduler.shutdown(); }
});

test('canonical maintenance aliases and legacy backfill keep one allowance and survive reattachment', async () => {
  const f = await fixture();
  let restored;
  try {
    const history = Array.from({ length: 179 }, (_, index) => ({ messageId: `msg_prior_${index}`, createdAt: 1000 }));
    expect(await f.scheduler.recordPrimaryStep({ ...f.scope, messageId: 'msg_after_compaction',
      maintenanceParentId: 'msg_compaction', historicalSteps: history })).toEqual({ usedSteps: 180 });
    expect(f.scheduler.getTask(f.scope.taskId).primaryStepBudget.maintenanceParents).toEqual([{ parentID: 'msg_compaction', userMessageID: 'msg_user' }]);
    expect(await f.scheduler.claimPrimaryStepBudgetWarning({ ...f.scope, messageId: 'msg_after_compaction', callId: 'call_compaction' })).not.toBeNull();
    await f.scheduler.shutdown(); restored = createManagedTaskScheduler(f.options); await restored.initialize();
    const task = restored.getTask(f.scope.taskId);
    expect(task.primaryStepBudget.maintenanceParents).toEqual([{ parentID: 'msg_compaction', userMessageID: 'msg_user' }]);
    expect(await restored.recordPrimaryStep({ ...f.scope, leaseToken: task.leaseToken, messageId: 'msg_after_compaction', historicalSteps: history })).toEqual({ usedSteps: 180 });
    expect(await restored.claimPrimaryStepBudgetWarning({ ...f.scope, leaseToken: task.leaseToken, messageId: 'msg_after_compaction', callId: 'call_replay' })).toBeNull();
  } finally { await restored?.shutdown(); await f.scheduler.shutdown(); }
});

test('a live pre-upgrade task can initialize only from its canonical accepted user and native primary history', async () => {
  const f = await fixture({ accepted: false });
  try {
    expect(f.scheduler.getTask(f.scope.taskId).primaryStepBudget).toBeUndefined();
    expect(await f.scheduler.recordPrimaryStep({ ...f.scope, messageId: 'msg_live' })).toBeNull();
    await f.scheduler.acceptPrimaryPrompt(f.scope);
    expect(await f.scheduler.recordPrimaryStep({ ...f.scope, messageId: 'msg_live', historicalSteps: [
      { messageId: 'msg_native_prior', createdAt: 1000 }, { messageId: 'msg_live', createdAt: 1000 } ] })).toEqual({ usedSteps: 2 });
    expect(await f.scheduler.recordPrimaryStep({ ...f.scope, messageId: 'msg_live' })).toEqual({ usedSteps: 2 });
  } finally { await f.scheduler.shutdown(); }
});

test('evicted historical prompt replay cannot acquire another allowance even at a tied timestamp', async () => {
  const f = await fixture();
  try {
    for (let index = 1; index <= 33; index++) await f.scheduler.acceptPrimaryPrompt({ ...f.scope, userMessageId: `msg_prompt_${index}`, createdAt: 1001 });
    const persisted = f.scheduler.getTask(f.scope.taskId).primaryStepBudget;
    expect(persisted.acceptedPrompts).toHaveLength(32);
    expect(persisted.retiredPromptThrough).toBe(1001);
    expect(await f.scheduler.acceptPrimaryPrompt({ ...f.scope, userMessageId: 'msg_prompt_1', createdAt: 1001 })).toBeNull();
    expect(await f.scheduler.recordPrimaryStep({ ...f.scope, userMessageId: 'msg_prompt_1', messageId: 'msg_replayed' })).toBeNull();
  } finally { await f.scheduler.shutdown(); }
});
