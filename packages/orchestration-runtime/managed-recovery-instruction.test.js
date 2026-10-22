import { describe, expect, test } from 'bun:test';

import { createManagedTaskRecord } from './contract.js';
import { MANAGED_RECOVERY_INSTRUCTIONS, managedRecoveryInstruction } from './managed-recovery-instruction.js';
import { prepareManagedResultMetadata } from './managed-result-sections.js';

const task = (overrides = {}) => ({
  ...createManagedTaskRecord({
    taskId: 'dvr_task_01', idempotencyKey: 'root-1:fix', rootSessionId: 'ses_root', dispatchGroupId: 'msg_parent_01',
    dispatchCallId: 'call_dispatch_01', parentTaskId: null, directory: '/workspace', sequence: 1, mode: 'orchestrator',
    providerId: 'openai', modelId: 'gpt-5.5', agent: 'fixer', variant: null, label: 'Fix the parser',
    prompt: 'Fix the parser.', attempt: 1, priorTaskId: null, executionKind: 'start', createdAt: 1_000, timeoutAt: null,
  }),
  childSessionId: 'ses_child', startedAt: 1_100, finishedAt: 1_200,
  ...overrides,
});
const envelope = (overrides = {}) => ({ envelopeId: 'dvr_result_01', action: null, partial: false, resumable: true, ...overrides });

describe('managed recovery instruction', () => {
  test('carries no guidance for completed, live or dispositioned results', () => {
    expect(managedRecoveryInstruction(task({ status: 'completed' }), envelope())).toBeNull();
    expect(managedRecoveryInstruction(task({ status: 'running', finishedAt: null }), envelope())).toBeNull();
    expect(managedRecoveryInstruction(task({ status: 'failed', failureReason: 'boom' }), envelope({ action: 'continue' }))).toBeNull();
    expect(managedRecoveryInstruction(task({ status: 'failed', failureReason: 'boom' }), null)).toBeNull();
  });

  test('keeps a manual Model Recovery result pending for the user', () => {
    const parked = task({ status: 'failed', failureReason: 'out of usage', attempt: 2 });
    expect(managedRecoveryInstruction(parked, envelope())).toBe(MANAGED_RECOVERY_INSTRUCTIONS.manual);
  });

  test('defers to a scheduled automatic resume before any other rule', () => {
    const parked = task({ status: 'failed', failureReason: 'out of usage', attempt: 2 });
    expect(managedRecoveryInstruction(parked, envelope({ autoResume: { enabled: true, state: 'scheduled' } })))
      .toBe(MANAGED_RECOVERY_INSTRUCTIONS.scheduled);
  });

  test('asks for one reframed retry after provider prompt rejection', () => {
    const rejected = task({ status: 'failed', failureReason: 'Invalid prompt: your prompt was flagged as potentially violating our usage policy' });
    expect(managedRecoveryInstruction(rejected, envelope())).toBe(MANAGED_RECOVERY_INSTRUCTIONS.promptRejected);
  });

  test('allows one recovery for an ordinary failure and partial completion', () => {
    expect(managedRecoveryInstruction(task({ status: 'interrupted', failureReason: 'provider disconnected' }), envelope()))
      .toBe(MANAGED_RECOVERY_INSTRUCTIONS.failed);
    expect(managedRecoveryInstruction(task({ status: 'completed' }), envelope({ partial: true }))).toBeNull();
  });

  test('keeps the instruction outside paged v2 metadata', async () => {
    const failed = task({ status: 'failed', failureReason: 'boom' });
    const metadata = await prepareManagedResultMetadata({ task: failed,
      resultEnvelope: { ...envelope(), taskId: failed.taskId, rootSessionId: failed.rootSessionId, directory: failed.directory, status: 'failed' },
      instruction: MANAGED_RECOVERY_INSTRUCTIONS.failed });
    expect(metadata.project(1024).instruction).toBe(MANAGED_RECOVERY_INSTRUCTIONS.failed);
  });
});
