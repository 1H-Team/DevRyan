import React from 'react'

import { SessionChangesBadge } from '@/components/session/SessionChangesBadge'
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext'
import {
  resolveTouchedFileWorkingTreeDiffStats,
  type SessionDiffStats,
} from '@/lib/sessionDiffStats'
import { useI18n } from '@/lib/i18n'
import { useGitStore } from '@/stores/useGitStore'
import {
  getSessionChangeAttributionKey,
  useSessionChangeAttributionStore,
} from '@/stores/useSessionChangeAttributionStore'

type ActiveSessionChangesBadgeProps = {
  sessionId: string
  directory?: string
}

const toStatsKey = (stats: SessionDiffStats | null): string => {
  return stats ? `${stats.additions}:${stats.deletions}` : ''
}

const fromStatsKey = (value: string): SessionDiffStats | null => {
  if (!value) return null
  const [additions, deletions] = value.split(':').map(Number)
  return { additions, deletions }
}

export const ActiveSessionChangesBadge = React.memo(({
  sessionId,
  directory,
}: ActiveSessionChangesBadgeProps) => {
  const { t } = useI18n()
  const runtime = React.useContext(RuntimeAPIContext)
  const attributionKey = directory
    ? getSessionChangeAttributionKey(directory, sessionId)
    : ''
  const attribution = useSessionChangeAttributionStore(React.useCallback(
    (state) => attributionKey ? state.entries.get(attributionKey) : undefined,
    [attributionKey],
  ))
  const touchedFiles = React.useMemo(
    () => attribution?.paths ?? [],
    [attribution?.paths],
  )
  const refreshKey = touchedFiles.join('\0')
  const statsKey = useGitStore(React.useCallback((state) => {
    if (!directory || touchedFiles.length === 0) return ''
    const diffStats = state.directories.get(directory)?.status?.diffStats
    return toStatsKey(resolveTouchedFileWorkingTreeDiffStats(touchedFiles, diffStats))
  }, [directory, touchedFiles]))
  const fetchStatus = useGitStore((state) => state.fetchStatus)
  const stats = React.useMemo(() => fromStatsKey(statsKey), [statsKey])

  React.useEffect(() => {
    if (!directory || !runtime?.git || touchedFiles.length === 0) return
    void fetchStatus(directory, runtime.git, { silent: true })
  }, [directory, fetchStatus, refreshKey, runtime?.git, touchedFiles.length])

  if (!stats) return null
  const label = attribution?.hasUnattributedMutations
    ? t('sessions.changes.sessionTouchedWithUnattributed')
    : t('sessions.changes.sessionTouched')
  return <SessionChangesBadge stats={stats} title={label} ariaLabel={label} />
})

ActiveSessionChangesBadge.displayName = 'ActiveSessionChangesBadge'
