import { describe, expect, test } from 'bun:test';
import { createManagedTaskRecord } from './contract.js';
import { createManagedOpenCodeExecutor } from './open-code-executor.js';
import { createManagedTerminalErrorRegistry } from './terminal-error-registry.js';
import { createManagedRecoveryMessageId, validateManagedTransportRecovery } from './transport-recovery.js';

const FAILURE = JSON.stringify({ type: 'api_error', message: 'Claude Code returned an error result: API Error: Connection closed mid-response. The response above may be incomplete.\nSubprocess stderr: Warning: Custom betas are only available for API key users. Ignoring provided betas.' });
const error = { name: 'UnknownError', data: { message: FAILURE } };
const user = (id) => ({ info: { id, role: 'user' }, parts: [] });
const failed = (id, parentID, parts = []) => ({
  info: { id, parentID, role: 'assistant', error, time: { created: 1_000, completed: 2_000 } }, parts,
});
const done = (parentID) => ({
  info: { id: 'msg_done', parentID, role: 'assistant', finish: 'stop', time: { completed: 5_000 } },
  parts: [{ type: 'text', text: 'Finished without repeating the completed edit' }],
});

const fixture = ({ onPrompt, beforeRead, afterReservation, persisted = null, persistenceFails = false } = {}) => {
  let clock = 3_000;
  let messages = [user('msg_user'), failed('msg_failed', 'msg_user', [
    { type: 'text', text: 'Preserved completed work' },
    { type: 'tool', tool: 'edit', callID: 'tool_pending', state: { status: 'error', input: {}, error: 'Tool execution aborted', time: {} } },
  ])];
  const registry = createManagedTerminalErrorRegistry({ now: () => clock });
  const event = { id: 'evt_failed', type: 'session.error', properties: { sessionID: 'ses_child', error } };
  registry.observe(event);
  const prompts = [];
  const receipts = [];
  let saved = persisted;
  const task = { ...createManagedTaskRecord({
    taskId: 'dvr_task_fixture', idempotencyKey: 'fixture', rootSessionId: 'ses_root',
    childSessionId: 'ses_child', parentTaskId: null, directory: '/fixture', sequence: 1,
    mode: 'orchestrator', providerId: 'anthropic', modelId: 'claude-opus-5', agent: 'designer',
    variant: 'medium', label: 'Connection recovery', prompt: 'Preserve existing work',
    attempt: 2, priorTaskId: null, executionKind: 'resume', createdAt: 0, timeoutAt: null,
  }), status: 'running', startedAt: 1_000, transportRecovery: persisted };
  const control = {
    async markAccepted() { return true; },
    async recordProgress() { return true; },
    async recordTransportRecovery(receipt, expectedRevision) {
      if (persistenceFails) throw new Error('Fixture disk failure');
      if ((saved?.revision ?? 0) !== expectedRevision) return false;
      saved = validateManagedTransportRecovery(receipt);
      receipts.push(saved);
      if (saved.phase === 'reserved') await afterReservation?.({ executor, task, setMessages });
      return true;
    },
  };
  const transport = {
    async createSession() { throw new Error('Must preserve the child'); },
    async deleteSession() { throw new Error('Must preserve the child'); },
    async abortSession() { return true; },
    async readSession() { return { id: 'ses_child' }; },
    async readStatus() { return { type: 'idle' }; },
    async readMessages() { await beforeRead?.({ clock, prompts, setMessages }); return messages; },
    async readTerminalError(input) { return registry.read(input); },
    async promptSession(input) {
      expect(saved?.phase).toBe('reserved');
      expect(saved?.recoveryMessageId).toBe(input.messageId);
      prompts.push(input);
      if (onPrompt) return await onPrompt({ input, setMessages, messages, registry, event, executor });
      messages = [...messages, user(input.messageId), done(input.messageId)];
    },
  };
  const setMessages = (value) => { messages = value; };
  const executor = createManagedOpenCodeExecutor({
    transport, now: () => clock, sleep: async () => { clock += 1_000; },
    continuationStartGraceMs: 5_000, resumeTeardownSettleMs: 3_000,
  });
  return { executor, task, control, prompts, receipts, registry, event, setMessages,
    run: () => executor.observe(task, control), get saved() { return saved; } };
};

describe('durable managed transport recovery', () => {
  test('recovers the incident through the live event channel with its same child and model', async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({ status: 'completed' });
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]).toMatchObject({ sessionId: 'ses_child', providerId: 'anthropic', modelId: 'claude-opus-5', variant: 'medium' });
    expect(f.receipts.map((r) => r.phase)).toEqual(['reserved', 'submitted', 'recovered']);
    expect(f.saved).toMatchObject({ sameModelAttempts: 1, backupAttempts: 0, eventId: 'evt_failed' });
  });

  test('waits for the event-before-message/tool teardown race', async () => {
    const f = fixture({ beforeRead({ clock, setMessages }) {
      if (clock < 5_000) setMessages([user('msg_user'), {
        info: { id: 'msg_failed', parentID: 'msg_user', role: 'assistant', time: {} },
        parts: [{ type: 'tool', tool: 'edit', state: { status: 'pending', input: {} } }],
      }]);
      else if (clock === 5_000) setMessages([user('msg_user'), failed('msg_failed', 'msg_user')]);
    } });
    expect(await f.run()).toMatchObject({ status: 'completed' });
    expect(f.receipts[0].reservedAt).toBe(5_000);
  });

  test('repeated failure exhausts the same-model budget without another prompt', async () => {
    const f = fixture({ onPrompt({ input, messages, setMessages, registry }) {
      setMessages([...messages, user(input.messageId), failed('msg_second_failure', input.messageId)]);
      registry.observe({ id: 'evt_second', type: 'session.error', properties: { sessionID: 'ses_child', error } });
    } });
    expect(await f.run()).toMatchObject({ status: 'failed', failureReason: FAILURE, partial: true });
    expect(f.prompts).toHaveLength(1);
    expect(f.saved.phase).toBe('exhausted');
  });

  test('does not let repeated delivery of the old error fail the continuation', async () => {
    const f = fixture({ onPrompt({ input, messages, setMessages, registry, event }) {
      registry.observe(event, { observedAt: 10_000 });
      setMessages([...messages, user(input.messageId), done(input.messageId)]);
    } });
    expect(await f.run()).toMatchObject({ status: 'completed' });
    expect(f.prompts).toHaveLength(1);
  });

  test('never sends when the recovery reservation cannot be persisted', async () => {
    const f = fixture({ persistenceFails: true });
    expect(await f.run()).toMatchObject({ status: 'interrupted', partial: true });
    expect(f.prompts).toHaveLength(0);
  });

  test('an ambiguous POST can complete when its exact transcript receipt exists', async () => {
    const f = fixture({ onPrompt({ input, messages, setMessages }) {
      setMessages([...messages, user(input.messageId), done(input.messageId)]);
      throw new TypeError('fetch failed');
    } });
    expect(await f.run()).toMatchObject({ status: 'completed' });
    expect(f.prompts).toHaveLength(1);
  });

  test('an ambiguous POST without evidence becomes uncertain and is never resent', async () => {
    const f = fixture({ onPrompt() { throw new TypeError('fetch failed'); } });
    expect(await f.run()).toMatchObject({ status: 'interrupted', partial: true });
    expect(f.prompts).toHaveLength(1);
    expect(f.saved.phase).toBe('uncertain');
    const restart = fixture({ persisted: f.saved });
    expect(await restart.run()).toMatchObject({ status: 'interrupted' });
    expect(restart.prompts).toHaveLength(0);
  });

  test.each(['reserved', 'submitted'])('observes a %s request after restart without resending it', async (phase) => {
    const first = fixture();
    await first.run();
    const restart = fixture({ persisted: first.receipts.find((receipt) => receipt.phase === phase) });
    restart.setMessages([user(first.saved.recoveryMessageId), done(first.saved.recoveryMessageId)]);
    expect(await restart.executor.reconcile(restart.task)).toEqual({ state: 'live' });
    expect(await restart.run()).toMatchObject({ status: 'completed' });
    expect(restart.prompts).toHaveLength(0);
  });

  test('never recovers an aborted tool whose effects are unknown', async () => {
    const f = fixture();
    f.setMessages([user('msg_user'), failed('msg_failed', 'msg_user', [{
      type: 'tool', tool: 'bash', state: { status: 'error', input: { command: 'submit-order' }, error: 'Tool execution aborted', time: { start: 1_000 } },
    }])]);
    expect(await f.run()).toMatchObject({ status: 'interrupted', failureReason: expect.stringContaining('settlement is unconfirmed') });
    expect(f.prompts).toHaveLength(0);
  });

  test('newer input fences a previously reserved recovery', async () => {
    const first = fixture();
    await first.run();
    const f = fixture({ persisted: first.receipts[0] });
    f.setMessages([user('msg_new_input'), done('msg_new_input')]);
    expect(await f.run()).toMatchObject({ status: 'interrupted', failureReason: expect.stringContaining('newer input') });
    expect(f.prompts).toHaveLength(0);
  });

  test('cancellation after reservation prevents dispatch', async () => {
    const f = fixture({ async afterReservation({ executor, task }) { await executor.abort(task); } });
    expect(await f.run()).toMatchObject({ status: 'interrupted' });
    expect(f.prompts).toHaveLength(0);
    expect(f.saved.phase).toBe('reserved');
  });

  test('input arriving while the reservation is saved prevents dispatch', async () => {
    const f = fixture({ afterReservation({ setMessages }) {
      setMessages([user('msg_newer'), done('msg_newer')]);
    } });
    expect(await f.run()).toMatchObject({ status: 'interrupted', failureReason: expect.stringContaining('superseded before dispatch') });
    expect(f.prompts).toHaveLength(0);
    expect(f.saved.phase).toBe('blocked');
  });

  test('recovery IDs sort after canonical future-clock messages', () => {
    const tail = 'msg_ffffffff0000abcdefgh';
    expect(createManagedRecoveryMessageId(1, tail) > tail).toBe(true);
  });

  test.each([false, true])('the backup preserves history and never gains another retry (fails=%s)', async (backupFails) => {
    const first = fixture({ onPrompt({ input, messages, setMessages }) {
      setMessages([...messages, user(input.messageId), failed('msg_second_failure', input.messageId)]);
    } });
    await first.run();
    const backup = fixture({
      persisted: { ...first.saved, revision: first.saved.revision + 1, phase: 'backup_pending', backupAttempts: 1 },
      onPrompt({ input, messages, setMessages }) {
        setMessages([...messages, user(input.messageId), backupFails
          ? failed('msg_backup_failure', input.messageId) : done(input.messageId)]);
      },
    });
    backup.task.providerId = 'openai';
    backup.task.modelId = 'gpt-backup';
    backup.task.variant = 'high';
    backup.task.executionKind = 'retry_in_place';
    backup.setMessages([user(first.saved.recoveryMessageId), failed('msg_second_failure', first.saved.recoveryMessageId)]);
    expect(await backup.executor.retryInPlace(backup.task, backup.control))
      .toMatchObject({ status: backupFails ? 'failed' : 'completed' });
    expect(backup.prompts).toHaveLength(1);
    expect(backup.prompts[0]).toMatchObject({ sessionId: 'ses_child', providerId: 'openai', modelId: 'gpt-backup', variant: 'high' });
    expect(backup.prompts[0].prompt).toContain('after a provider connection interruption');
    expect(backup.prompts[0].prompt).not.toContain('usage limit');
    expect(backup.saved.backupAttempts).toBe(1);
  });

  test('a cancelled in-flight recovery cannot be resent', async () => {
    let sentSignal;
    const f = fixture({ async onPrompt({ input, executor }) {
      sentSignal = input.signal;
      await executor.abort(f.task);
      throw new Error('cancelled');
    } });
    expect(await f.run()).toMatchObject({ status: 'interrupted' });
    expect(sentSignal.aborted).toBe(true);
    expect(f.prompts).toHaveLength(1);
  });

  test('shutdown cancels an in-flight recovery while retaining its ambiguous reservation', async () => {
    let sentSignal;
    const f = fixture({ async onPrompt({ input, executor }) {
      sentSignal = input.signal;
      await executor.shutdown();
      throw new Error('cancelled');
    } });
    await expect(f.run()).rejects.toThrow('shut down');
    expect(sentSignal.aborted).toBe(true);
    expect(f.saved.phase).toBe('reserved');
    expect(f.prompts).toHaveLength(1);
  });

  test('a backup never aborts a newer turn to take its place', async () => {
    const first = fixture();
    await first.run();
    const backup = fixture({ persisted: { ...first.saved, phase: 'backup_pending', backupAttempts: 1 } });
    backup.task.executionKind = 'retry_in_place';
    backup.setMessages([user('msg_newer'), failed('msg_newer_failed', 'msg_newer')]);
    expect(await backup.executor.retryInPlace(backup.task, backup.control)).toMatchObject({ status: 'interrupted' });
    expect(backup.prompts).toHaveLength(0);
  });
});
