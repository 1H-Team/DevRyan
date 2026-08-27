import {
  assertBotBoolean,
  assertBotBoundaryObject,
  assertBotEnum,
  assertBotTimestamp,
} from './contract.js';

export const BOT_ROUTINE_MISSED_POLICIES = Object.freeze([
  'skip',
  'run_once',
  'replay_capped',
]);

export const resolveDefaultBotRoutineMissedPolicy = (input) => {
  assertBotBoundaryObject(input, {
    label: 'routine default input',
    required: ['performsExternalWrites'],
  });
  return assertBotBoolean(input.performsExternalWrites, 'performsExternalWrites')
    ? 'run_once'
    : 'skip';
};

export const resolveMissedBotRoutineOccurrences = (input) => {
  assertBotBoundaryObject(input, {
    label: 'routine recovery input',
    required: [
      'missedPolicy',
      'missedRunCap',
      'scheduledFor',
      'performsExternalWrites',
    ],
  });
  const missedPolicy = assertBotEnum(
    input.missedPolicy,
    BOT_ROUTINE_MISSED_POLICIES,
    'missedPolicy',
  );
  if (!Number.isSafeInteger(input.missedRunCap) || input.missedRunCap < 1 || input.missedRunCap > 3) {
    throw new TypeError('missedRunCap must be an integer between 1 and 3');
  }
  if (!Array.isArray(input.scheduledFor)) {
    throw new TypeError('scheduledFor must be an array');
  }
  const performsExternalWrites = assertBotBoolean(
    input.performsExternalWrites,
    'performsExternalWrites',
  );
  const occurrences = [...new Set(input.scheduledFor.map((value, index) => (
    assertBotTimestamp(value, `scheduledFor[${index}]`)
  )))].sort((left, right) => left - right);

  let selected = [];
  if (missedPolicy === 'run_once' && occurrences.length > 0) {
    selected = occurrences.slice(-1);
  } else if (missedPolicy === 'replay_capped') {
    selected = occurrences.slice(-input.missedRunCap);
  }

  return {
    disposition: missedPolicy,
    occurrences: selected,
    approvalRequired: performsExternalWrites && selected.length > 0,
  };
};
