import type { SessionMutationFailure } from '@/sync/session-actions';

const UNKNOWN_FAILURE_MESSAGES = new Set(['', 'Unknown error']);

export const resolveSessionDeleteFailureDescription = (
  failures: SessionMutationFailure[],
  fallback: string,
): string => {
  if (failures.length === 0) {
    return fallback;
  }

  const messages = new Set(
    failures
      .map((failure) => failure.message.trim())
      .filter((message) => !UNKNOWN_FAILURE_MESSAGES.has(message)),
  );
  if (messages.size !== 1) {
    return fallback;
  }
  return messages.values().next().value ?? fallback;
};
