import { formatTimestampForDisplay } from '@/components/chat/message/timeFormat';
import { formatDurationMilliseconds } from '@/lib/duration';
import type { I18nKey } from '@/lib/i18n';
import type { SessionLifecycle } from '@/sync/display-session';
import type { SessionFork, SessionOutcome } from '@/sync/types';

/**
 * Native lifecycle facts shown as display metadata only. Running state comes
 * from `session.status` (never from `busy > idle`), unread state from the
 * notification store, and verified completion from managed orchestration.
 */
export type SessionLifecyclePresentation = {
  outcome: SessionOutcome | null;
  idleAt: number;
  /** Last run duration, present only when `idle >= busy`. */
  durationMs: number | null;
};

type Translate = (key: I18nKey, params?: Record<string, string | number>) => string;

const OUTCOME_LABEL_KEYS: Record<SessionOutcome, I18nKey> = {
  succeeded: 'sessions.lifecycle.outcome.succeeded',
  failed: 'sessions.lifecycle.outcome.failed',
  interrupted: 'sessions.lifecycle.outcome.interrupted',
};

export const SESSION_FORK_BOUNDARY_LABEL_KEYS: Record<SessionFork['boundary']['type'], I18nKey> = {
  before: 'sessions.fork.boundary.before',
  through: 'sessions.fork.boundary.through',
};

/**
 * Takes facts read with `readSessionLifecycle`. Returns null until the session
 * has finished at least one native run.
 */
export const resolveSessionLifecyclePresentation = (
  lifecycle: Pick<SessionLifecycle, 'busy' | 'idle' | 'outcome'>,
): SessionLifecyclePresentation | null => {
  if (lifecycle.idle === undefined) return null;
  return {
    outcome: lifecycle.outcome ?? null,
    idleAt: lifecycle.idle,
    durationMs: lifecycle.busy !== undefined && lifecycle.idle >= lifecycle.busy
      ? lifecycle.idle - lifecycle.busy
      : null,
  };
};

export const formatSessionLifecycleLines = (
  presentation: SessionLifecyclePresentation | null,
  t: Translate,
  formatTime: (timestamp: number) => string = formatTimestampForDisplay,
): string[] => {
  if (!presentation) return [];
  const lines = [
    t(presentation.outcome ? OUTCOME_LABEL_KEYS[presentation.outcome] : 'sessions.lifecycle.outcome.finished'),
  ];
  const time = formatTime(presentation.idleAt);
  if (time) lines.push(t('sessions.lifecycle.idleSince', { time }));
  if (presentation.durationMs !== null) {
    const duration = formatDurationMilliseconds(presentation.durationMs, { final: true });
    if (duration.available) lines.push(t('sessions.lifecycle.duration', { duration: duration.label }));
  }
  return lines;
};

export const SESSION_LIFECYCLE_SEPARATOR = ' · ';
