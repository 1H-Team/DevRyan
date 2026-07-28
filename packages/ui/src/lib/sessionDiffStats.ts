export type SessionDiffStats = {
  additions: number
  deletions: number
}

export type SessionSummaryDiffEntry = {
  file?: string | null
  additions?: number | string | null
  deletions?: number | string | null
  [key: string]: unknown
}

export type SessionSummaryDiffStats = SessionSummaryDiffEntry & {
  files?: number | null
  diffs?: SessionSummaryDiffEntry[] | null
}

export type SessionDiffSummaryTarget = {
  summary?: SessionSummaryDiffStats | null
}

export type WorkingTreeDiffStats = Record<string, {
  insertions?: number | null
  deletions?: number | null
}>

export const parseSessionDiffCount = (value: number | string | null | undefined): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, value)
  }
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
  }
  return 0
}

export const getSessionSummaryDiffTotals = (summary?: SessionSummaryDiffStats | null): SessionDiffStats => {
  if (!summary) {
    return { additions: 0, deletions: 0 }
  }

  if (summary.additions !== undefined || summary.deletions !== undefined) {
    return {
      additions: parseSessionDiffCount(summary.additions),
      deletions: parseSessionDiffCount(summary.deletions),
    }
  }

  let additions = 0
  let deletions = 0
  for (const diff of summary.diffs ?? []) {
    additions += parseSessionDiffCount(diff.additions)
    deletions += parseSessionDiffCount(diff.deletions)
  }
  return { additions, deletions }
}

export const resolveSessionDiffStats = (summary?: SessionSummaryDiffStats | null): SessionDiffStats | null => {
  const stats = getScopedMessageDiffTotals(summary)
  return stats.additions === 0 && stats.deletions === 0 ? null : stats
}

const normalizeSessionDiffPath = (value: string): string => {
  return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

export const resolveTouchedFileWorkingTreeDiffStats = (
  touchedFiles: readonly string[],
  diffStats: WorkingTreeDiffStats | undefined,
): SessionDiffStats | null => {
  let additions = 0
  let deletions = 0

  for (const file of touchedFiles) {
    const stats = diffStats?.[normalizeSessionDiffPath(file)]
    additions += parseSessionDiffCount(stats?.insertions)
    deletions += parseSessionDiffCount(stats?.deletions)
  }

  return additions === 0 && deletions === 0 ? null : { additions, deletions }
}

export const getScopedMessageDiffTotals = (summary?: SessionSummaryDiffStats | null): SessionDiffStats => {
  let additions = 0
  let deletions = 0

  // Decision: message-owned session badges only trust scoped diff entries. Bare
  // additions/deletions can reflect stale/global workspace totals, which caused
  // no-op turns to inherit large unrelated diff counters.
  for (const diff of summary?.diffs ?? []) {
    additions += parseSessionDiffCount(diff.additions)
    deletions += parseSessionDiffCount(diff.deletions)
  }

  return { additions, deletions }
}

export const stripUntrustedSessionDiffSummary = <T extends SessionDiffSummaryTarget>(target: T): T => {
  const summary = target.summary
  if (!summary) {
    return target
  }

  const nextSummary: SessionSummaryDiffStats = { ...summary }
  const beforeKeys = Object.keys(nextSummary).length
  delete nextSummary.additions
  delete nextSummary.deletions
  delete nextSummary.files
  delete nextSummary.diffs

  if (Object.keys(nextSummary).length === beforeKeys) {
    return target
  }

  if (Object.keys(nextSummary).length > 0) {
    return { ...target, summary: nextSummary } as T
  }

  const { summary: _summary, ...withoutSummary } = target
  void _summary
  return withoutSummary as T
}

export const normalizeChatOwnedDiffSummary = <T extends SessionDiffSummaryTarget>(
  target: T,
  messages: readonly unknown[] | undefined,
): T => {
  // OpenCode message summaries and patch snapshots describe shared working-tree
  // state, not authoritative per-session ownership. Keep them out of session
  // metadata entirely; the dedicated attribution store derives touched paths
  // from successful file tools instead.
  void messages
  return stripUntrustedSessionDiffSummary(target)
}
