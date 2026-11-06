import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { RiGitBranchLine } from '@remixicon/react';

import { useI18n } from '@/lib/i18n';
import { resolveDisplaySessionTitle } from '@/lib/sessionTitles';
import { cn } from '@/lib/utils';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSession } from '@/sync/sync-context';
import type { SessionFork } from '@/sync/types';
import { SESSION_FORK_BOUNDARY_LABEL_KEYS } from './sessionLifecyclePresentation';

type SessionForkProvenanceProps = {
  fork: SessionFork;
  className?: string;
};

/**
 * "Forked from <title> (before/through message)". The source is linked only
 * when it is in the principal's accessible session lists; otherwise neither
 * its title nor its id is shown. Fork provenance never changes `parentID`,
 * grouping or the session tree.
 */
export function SessionForkProvenance({ fork, className }: SessionForkProvenanceProps) {
  const { t } = useI18n();
  const sourceSessionID = fork.sessionID;
  const liveSource = useSession(sourceSessionID);
  const listedSource = useGlobalSessionsStore(
    React.useCallback((state): Session | null => (
      state.activeSessions.find((session) => session.id === sourceSessionID)
      ?? state.archivedSessions.find((session) => session.id === sourceSessionID)
      ?? null
    ), [sourceSessionID]),
  );
  const source = liveSource ?? listedSource;
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const sourceTitle = source
    ? resolveDisplaySessionTitle({ title: source.title, fallback: t('sessions.sidebar.session.untitled') })
    : null;
  const openSource = React.useCallback(() => {
    if (!source) return;
    setCurrentSession(source.id, resolveGlobalSessionDirectory(source));
  }, [setCurrentSession, source]);

  return (
    <span className={cn('flex min-w-0 items-center gap-1 typography-micro text-muted-foreground', className)}>
      <RiGitBranchLine className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="shrink-0">{t('sessions.fork.label')}</span>
      {source && sourceTitle !== null ? (
        <button
          type="button"
          onClick={openSource}
          aria-label={t('sessions.fork.openSourceAria', { title: sourceTitle })}
          className="min-w-0 truncate rounded-sm text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          {sourceTitle}
        </button>
      ) : (
        <span className="min-w-0 truncate">{t('sessions.fork.unavailableSource')}</span>
      )}
      <span className="shrink-0">({t(SESSION_FORK_BOUNDARY_LABEL_KEYS[fork.boundary.type])})</span>
    </span>
  );
}
