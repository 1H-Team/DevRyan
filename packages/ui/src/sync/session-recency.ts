import type { Session } from '@opencode-ai/sdk/v2/client';
import {
  readSessionLifecycle,
  sameSessionLifecycle,
  withSessionLifecycle,
  type SessionLifecycle,
} from './display-session';
import type { DisplaySession } from './types';

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

const maxDefined = (left: number | undefined, right: number | undefined): number | undefined => {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
};

/**
 * Monotonic lifecycle facts of two records of one session. `current` is the
 * stored record and `incoming` the arriving one:
 * - `busy` and `viewed` are max watermarks;
 * - `(idle, outcome)` move together and come from the side with the larger
 *   `idle`; a tie keeps the current pair;
 * - `fork` is the first defined value.
 * `time.updated` plays no part, so a record that is older by `updated` can
 * still advance lifecycle facts.
 */
export const resolveSessionLifecycle = (
  current: DisplaySession,
  incoming: DisplaySession,
): SessionLifecycle => {
  const left = readSessionLifecycle(current);
  const right = readSessionLifecycle(incoming);
  const lifecycle: SessionLifecycle = {};
  const busy = maxDefined(left.busy, right.busy);
  if (busy !== undefined) lifecycle.busy = busy;
  const incomingIdleWins = right.idle !== undefined && (left.idle === undefined || right.idle > left.idle);
  const pairSource = incomingIdleWins ? right : left;
  if (pairSource.idle !== undefined) lifecycle.idle = pairSource.idle;
  const outcome = left.idle === undefined && right.idle === undefined
    ? left.outcome ?? right.outcome
    : pairSource.outcome;
  if (outcome !== undefined) lifecycle.outcome = outcome;
  const viewed = maxDefined(left.viewed, right.viewed);
  if (viewed !== undefined) lifecycle.viewed = viewed;
  const fork = left.fork ?? right.fork;
  if (fork !== undefined) lifecycle.fork = fork;
  return lifecycle;
};

/**
 * Accepts `incoming` (newer or equal by recency) over `current`, keeping the
 * monotonic lifecycle facts of both. Returns `incoming` itself when its facts
 * already are the merged ones.
 */
export const mergeSessionLifecycle = (
  current: DisplaySession | undefined,
  incoming: DisplaySession,
): DisplaySession => (
  current ? withSessionLifecycle(incoming, resolveSessionLifecycle(current, incoming)) : incoming
);

/**
 * Keeps `retained` when an older `rejected` record is refused by a recency
 * gate, while still taking any lifecycle facts the rejected record advances.
 * Returns `retained` itself when nothing advances.
 */
export const retainSessionLifecycle = (
  retained: DisplaySession,
  rejected: DisplaySession,
): DisplaySession => withSessionLifecycle(retained, resolveSessionLifecycle(retained, rejected));

/** True when `incoming` would advance any lifecycle fact of `current`. */
export const hasNewerSessionLifecycle = (
  current: DisplaySession,
  incoming: DisplaySession,
): boolean => !sameSessionLifecycle(readSessionLifecycle(current), resolveSessionLifecycle(current, incoming));

/**
 * Merges lifecycle facts from the stored list into an authoritative snapshot
 * list. Snapshot membership and fields win; only monotonic lifecycle facts are
 * carried forward. Returns `next` itself when no record changes.
 */
export const mergeSessionListLifecycle = (
  current: readonly DisplaySession[],
  next: DisplaySession[],
): DisplaySession[] => {
  if (current.length === 0 || next.length === 0) return next;
  const currentById = new Map(current.map((session) => [session.id, session]));
  let merged: DisplaySession[] | null = null;
  for (let index = 0; index < next.length; index += 1) {
    const session = next[index];
    const stored = currentById.get(session.id);
    if (!stored) continue;
    const mergedSession = mergeSessionLifecycle(stored, session);
    if (mergedSession === session) continue;
    merged ??= next.slice();
    merged[index] = mergedSession;
  }
  return merged ?? next;
};

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
