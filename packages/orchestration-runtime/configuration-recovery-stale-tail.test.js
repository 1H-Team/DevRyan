import { describe, expect, test } from 'bun:test';
import { createManagedTaskRecord } from './contract.js';
import { createManagedOpenCodeExecutor } from './open-code-executor.js';
import { validateManagedTransportRecovery } from './transport-recovery.js';

const REGION = "Upstream request failed: This Go model requires Global regions. Select Global in your workspace's Privacy settings to use it.";
const user = (id) => ({ info: { id, role: 'user' }, parts: [] });
const configFailed = { info: { id: 'msg_failed', parentID: 'msg_user', role: 'assistant',
  error: { name: 'APIError', data: { message: REGION, statusCode: 400 } }, time: { created: 1_000, completed: 2_000 } }, parts: [] };
const done = (parentID) => ({ info: { id: 'msg_done', parentID, role: 'assistant', finish: 'stop', time: { completed: 5_000 } },
  parts: [{ type: 'text', text: 'Backup model finished the work' }] });

// OpenCode prompt_async returns before the new user message / busy status are
// observable. Model that window: the first read after the POST still shows the
// old tail; the backup's turn becomes visible on the next read.
const fixture = ({ persisted, priorFailureReason }) => {
  let clock = 3_000;
  let messages = [user('msg_user'), configFailed];
  let pendingAppend = null;
  const prompts = [];
  let saved = persisted;
  const task = { ...createManagedTaskRecord({
    taskId: 'dvr_task_backup', idempotencyKey: 'k', rootSessionId: 'ses_root', childSessionId: 'ses_child',
    parentTaskId: null, directory: '/fixture', sequence: 1, mode: 'orchestrator', providerId: 'opencode',
    modelId: 'deepseek-v4.1-flash', agent: 'designer', variant: 'medium', label: 'Backup', prompt: 'Do the work',
    attempt: 2, priorTaskId: 'dvr_task_source', executionKind: 'retry_in_place', createdAt: 0, timeoutAt: null,
  }), status: 'running', startedAt: 1_000, transportRecovery: persisted };
  const control = {
    readPriorFailureReason() { return priorFailureReason; },
    async markAccepted() { return true; },
    async recordProgress() { return true; },
    async recordTransportRecovery(receipt, expectedRevision) {
      if ((saved?.revision ?? 0) !== expectedRevision) return false;
      saved = validateManagedTransportRecovery(receipt);
      return true;
    },
  };
  const transport = {
    async createSession() { throw new Error('no'); },
    async deleteSession() { throw new Error('no'); },
    async abortSession() { return true; },
    async readSession() { return { id: 'ses_child' }; },
    async readStatus() { return { type: 'idle' }; },
    async readMessages() {
      const snapshot = messages;
      if (pendingAppend) { messages = pendingAppend(messages); pendingAppend = null; }
      return snapshot;
    },
    async readTerminalError() { return null; },
    async promptSession(input) {
      prompts.push(input);
      const id = input.messageId ?? 'msg_retry_prompt';
      pendingAppend = (current) => [...current, user(id), done(id)];
    },
  };
  const executor = createManagedOpenCodeExecutor({ transport, now: () => clock, sleep: async () => { clock += 1_000; },
    continuationStartGraceMs: 5_000, resumeTeardownSettleMs: 3_000 });
  return { executor, task, control, prompts, get saved() { return saved; } };
};

describe('stale configuration tail after a posted continuation', () => {
  test('automatic configuration backup observes the backup turn, not the prior failure', async () => {
    const f = fixture({ priorFailureReason: REGION, persisted: {
      revision: 1, kind: 'connection_failure', phase: 'backup_pending', sameModelAttempts: 1, backupAttempts: 1,
      failedMessageId: 'msg_failed', failedUserMessageId: 'msg_user', recoveryMessageId: 'msg_user',
      eventId: null, reservedAt: 2_500, submittedAt: null } });
    const result = await f.executor.retryInPlace(f.task, f.control);
    expect(f.prompts).toHaveLength(1); // the backup WAS sent to the backup model
    expect(result).toMatchObject({ status: 'completed' });
    await f.executor.shutdown();
  });

  test('manual retry_in_place of a region-rejected task observes the new turn', async () => {
    const f = fixture({ priorFailureReason: REGION, persisted: null });
    const result = await f.executor.retryInPlace(f.task, f.control);
    expect(f.prompts).toHaveLength(1);
    expect(f.saved).toBeNull(); // must not mint an exhausted receipt from the stale tail
    expect(result).toMatchObject({ status: 'completed' });
    await f.executor.shutdown();
  });
});
