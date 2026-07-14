import React from 'react'

import { SessionChangesBadge } from '@/components/session/SessionChangesBadge'
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext'
import {
  getSessionTouchedFilePaths,
  resolveTouchedFileWorkingTreeDiffStats,
  type SessionDiffStats,
} from '@/lib/sessionDiffStats'
import { useGitStore } from '@/stores/useGitStore'
import { useVisibleSessionMessages } from '@/sync/sync-context'

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
  const runtime = React.useContext(RuntimeAPIContext)
  const messages = useVisibleSessionMessages(sessionId, directory)
  const touchedFiles = React.useMemo(
    () => getSessionTouchedFilePaths(messages),
    [messages],
  )
  const refreshKey = React.useMemo(() => {
    const filesKey = touchedFiles.join('\0')
    const latestMessage = messages.at(-1)
    if (!latestMessage) return filesKey
    if (latestMessage.role !== 'assistant') return `${filesKey}|${latestMessage.id}`
    return `${filesKey}|${latestMessage.id}|${latestMessage.finish ?? ''}|${latestMessage.time.completed ?? ''}`
  }, [messages, touchedFiles])
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

  return stats ? <SessionChangesBadge stats={stats} /> : null
})

ActiveSessionChangesBadge.displayName = 'ActiveSessionChangesBadge'
