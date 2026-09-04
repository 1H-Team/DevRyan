import {
  isTerminalManagedTaskStatus,
  validateManagedTaskRecord,
} from './contract.js';

const ALLOWED_TRANSITIONS = Object.freeze({
  queued: new Set(['starting', 'aborted']),
  starting: new Set(['running', 'failed', 'aborted', 'interrupted']),
  running: new Set(['completed', 'failed', 'aborted', 'interrupted']),
  completed: new Set(),
  failed: new Set(),
  aborted: new Set(),
  interrupted: new Set(),
});

const IMMUTABLE_FIELDS = Object.freeze([
  'owner',
  'taskId',
  'idempotencyKey',
  'rootSessionId',
  'dispatchGroupId',
  'dispatchCallId',
  'dispatchWaveId',
  'parentTaskId',
  'directory',
  'sequence',
  'mode',
  'readOnly',
  'providerId',
  'modelId',
  'agent',
  'variant',
  'label',
  'prompt',
  'attempt',
  'priorTaskId',
  'executionKind',
  'createdAt',
  'timeoutAt',
  'recoveryLineageId',
]);

const terminalRecordChanged = (previous, next) => {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) {
    if (!Object.is(previous[key], next[key])) return true;
  }
  return false;
};

export const canTransitionManagedTaskStatus = (from, to) => (
  from === to || Boolean(ALLOWED_TRANSITIONS[from]?.has(to))
);

export const assertManagedTaskTransition = (previous, next) => {
  validateManagedTaskRecord(previous);

  if (isTerminalManagedTaskStatus(previous.status) && terminalRecordChanged(previous, next)) {
    throw new Error(`terminal task ${previous.taskId} is immutable`);
  }

  for (const field of IMMUTABLE_FIELDS) {
    if (!Object.is(previous[field], next[field])) {
      throw new Error(`${field} is immutable`);
    }
  }

  // `waitingReason` is mutable only while the task is queued; leaving `queued`
  // (launch or abort) must clear it.
  if (next.status !== 'queued' && next.waitingReason !== null) {
    throw new Error('waitingReason must be null unless the task is queued');
  }

  validateManagedTaskRecord(next);

  if (!canTransitionManagedTaskStatus(previous.status, next.status)) {
    throw new Error(`invalid managed task transition: ${previous.status} -> ${next.status}`);
  }

  return next;
};
