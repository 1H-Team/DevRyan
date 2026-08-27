import {
  BOT_ACTION_STATES,
  BOT_RUN_STATES,
  assertBotBoundaryObject,
  assertBotEnum,
  assertBotString,
  assertBotTimestamp,
} from './contract.js';

const BOT_RUN_TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const BOT_ACTION_TERMINAL_STATES = new Set([
  'succeeded', 'failed', 'reconciled', 'denied', 'cancelled',
]);

const RUN_TRANSITIONS = Object.freeze({
  queued: new Set(['starting', 'cancelled']),
  starting: new Set(['running', 'failed', 'cancelled', 'interrupted']),
  running: new Set([
    'waiting_approval',
    'needs_reconciliation',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
  ]),
  waiting_approval: new Set([
    'running',
    'needs_reconciliation',
    'failed',
    'cancelled',
    'interrupted',
  ]),
  needs_reconciliation: new Set(['running', 'completed', 'failed', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted: new Set(),
});

const ACTION_TRANSITIONS = Object.freeze({
  proposed: new Set(['pending_approval', 'approved', 'failed', 'denied', 'cancelled']),
  pending_approval: new Set(['approved', 'failed', 'denied', 'cancelled']),
  approved: new Set(['executing', 'failed', 'denied', 'cancelled']),
  executing: new Set(['succeeded', 'failed', 'unknown']),
  succeeded: new Set(),
  failed: new Set(),
  unknown: new Set(['reconciled']),
  reconciled: new Set(),
  denied: new Set(),
  cancelled: new Set(),
});

export const isBotRunTerminalState = (state) => BOT_RUN_TERMINAL_STATES.has(state);
export const isBotActionTerminalState = (state) => BOT_ACTION_TERMINAL_STATES.has(state);
export const isBotActionUnknownWriteState = (state) => state === 'unknown';

export const canTransitionBotRunState = (from, to) => (
  BOT_RUN_STATES.includes(from)
  && BOT_RUN_STATES.includes(to)
  && (from === to || RUN_TRANSITIONS[from].has(to))
);

export const assertBotRunStateTransition = (input) => {
  assertBotBoundaryObject(input, {
    label: 'run transition input',
    required: ['from', 'to'],
  });
  const from = assertBotEnum(input.from, BOT_RUN_STATES, 'from');
  const to = assertBotEnum(input.to, BOT_RUN_STATES, 'to');
  if (from !== to && isBotRunTerminalState(from)) {
    throw new Error(`terminal Bot run state ${from} is immutable`);
  }
  if (!canTransitionBotRunState(from, to)) {
    throw new Error(`invalid Bot run transition: ${from} -> ${to}`);
  }
  return to;
};

export const canTransitionBotActionState = (from, to) => (
  BOT_ACTION_STATES.includes(from)
  && BOT_ACTION_STATES.includes(to)
  && (from === to || ACTION_TRANSITIONS[from].has(to))
);

export const assertBotActionStateTransition = (input) => {
  assertBotBoundaryObject(input, {
    label: 'action transition input',
    required: ['from', 'to'],
  });
  const from = assertBotEnum(input.from, BOT_ACTION_STATES, 'from');
  const to = assertBotEnum(input.to, BOT_ACTION_STATES, 'to');
  if (from !== to && isBotActionTerminalState(from)) {
    throw new Error(`terminal Bot action state ${from} is immutable`);
  }
  if (from === 'unknown' && to !== 'unknown' && to !== 'reconciled') {
    throw new Error('unknown Bot action must be reconciled before more execution');
  }
  if (!canTransitionBotActionState(from, to)) {
    throw new Error(`invalid Bot action transition: ${from} -> ${to}`);
  }
  return to;
};

const validateLease = (lease, requestedScope) => {
  assertBotBoundaryObject(lease, {
    label: 'currentLease',
    required: ['runId', 'computerScopeKey', 'leaseGeneration', 'leaseUntil'],
  });
  assertBotString(lease.runId, 'currentLease.runId');
  assertBotString(lease.computerScopeKey, 'currentLease.computerScopeKey');
  if (!Number.isSafeInteger(lease.leaseGeneration) || lease.leaseGeneration < 1) {
    throw new TypeError('currentLease.leaseGeneration must be a positive safe integer');
  }
  assertBotTimestamp(lease.leaseUntil, 'currentLease.leaseUntil');
  if (lease.computerScopeKey !== requestedScope) {
    throw new TypeError('currentLease computerScopeKey must match the requested scope');
  }
  return lease;
};

export const decideBotRunAdmission = (input) => {
  assertBotBoundaryObject(input, {
    label: 'run admission input',
    required: ['runId', 'computerScopeKey', 'currentLease', 'now'],
  });
  const runId = assertBotString(input.runId, 'runId');
  const computerScopeKey = assertBotString(input.computerScopeKey, 'computerScopeKey');
  const now = assertBotTimestamp(input.now, 'now');
  if (input.currentLease === null) {
    return { admitted: true, reason: 'available', leaseGeneration: 1 };
  }

  const lease = validateLease(input.currentLease, computerScopeKey);
  if (lease.leaseUntil <= now) {
    return {
      admitted: true,
      reason: 'expired',
      leaseGeneration: lease.leaseGeneration + 1,
    };
  }
  if (lease.runId === runId) {
    return {
      admitted: true,
      reason: 'already_owned',
      leaseGeneration: lease.leaseGeneration,
    };
  }
  return {
    admitted: false,
    reason: 'scope_leased',
    leaseGeneration: lease.leaseGeneration,
  };
};

export const resolveInterruptedBotAction = (input) => {
  assertBotBoundaryObject(input, {
    label: 'interrupted action input',
    required: ['currentState', 'operationKind'],
  });
  const currentState = assertBotEnum(input.currentState, BOT_ACTION_STATES, 'currentState');
  const operationKind = assertBotEnum(input.operationKind, ['read', 'write'], 'operationKind');
  if (isBotActionTerminalState(currentState) || currentState === 'unknown') return currentState;
  if (currentState === 'executing' && operationKind === 'write') return 'unknown';
  return 'failed';
};
