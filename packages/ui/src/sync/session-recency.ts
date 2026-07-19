import type { Session } from '@opencode-ai/sdk/v2/client';

const finiteTimestamp = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

export const getSessionRecency = (session: Session): number | null => (
  finiteTimestamp(session.time?.updated) ?? finiteTimestamp(session.time?.created)
);

/** Missing timestamps are treated as incomparable, so the event stays eligible. */
export const compareSessionRecency = (incoming: Session, current: Session): -1 | 0 | 1 => {
  const incomingTime = getSessionRecency(incoming);
  const currentTime = getSessionRecency(current);
  if (incomingTime === null || currentTime === null || incomingTime === currentTime) return 0;
  return incomingTime < currentTime ? -1 : 1;
};

export const isStrictlyOlderSession = (incoming: Session, current: Session): boolean => (
  compareSessionRecency(incoming, current) < 0
);

const structurallyEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => structurallyEqual(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => (
    Object.hasOwn(rightRecord, key) && structurallyEqual(leftRecord[key], rightRecord[key])
  ));
};

export const areSessionRecordsEqual = (left: Session, right: Session): boolean => (
  structurallyEqual(left, right)
);
