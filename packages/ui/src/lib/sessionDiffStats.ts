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

export type SessionDiffSummaryMessage = {
  role?: string
  summary?: SessionSummaryDiffStats | null
}

export type SessionTouchedFileMessage = {
  role?: string
  summary?: SessionSummaryDiffStats | boolean | null
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

export const getSessionTouchedFilePaths = (
  messages: readonly SessionTouchedFileMessage[] | undefined,
): string[] => {
  const paths = new Set<string>()

  for (const message of messages ?? []) {
    if (message?.role !== 'user') continue
    const summary = message.summary
    if (!summary || typeof summary !== 'object') continue
    for (const diff of summary.diffs ?? []) {
      if (typeof diff.file !== 'string') continue
      const path = normalizeSessionDiffPath(diff.file.trim())
      if (path) paths.add(path)
    }
  }

  return [...paths].sort()
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

export const resolveSessionWorkingTreeDiffStats = (
  messages: readonly SessionTouchedFileMessage[] | undefined,
  diffStats: WorkingTreeDiffStats | undefined,
): SessionDiffStats | null => {
  return resolveTouchedFileWorkingTreeDiffStats(getSessionTouchedFilePaths(messages), diffStats)
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

export const getChatOwnedDiffTotalsFromMessages = (messages: readonly SessionDiffSummaryMessage[] | undefined): SessionDiffStats => {
  let additions = 0
  let deletions = 0

  for (const message of messages ?? []) {
    if (message?.role !== 'user') continue
    const stats = getScopedMessageDiffTotals(message.summary)
    additions += stats.additions
    deletions += stats.deletions
  }

  return { additions, deletions }
}

export const applyChatOwnedDiffTotalsToSummary = (
  summary: SessionSummaryDiffStats | null | undefined,
  totals: SessionDiffStats,
): SessionSummaryDiffStats | undefined => {
  const nextSummary: SessionSummaryDiffStats = { ...(summary ?? {}) }

  delete nextSummary.diffs
  delete nextSummary.files
  delete nextSummary.additions
  delete nextSummary.deletions

  if (totals.additions === 0 && totals.deletions === 0) {
    // No trusted scoped edits for this chat.
  } else {
    nextSummary.diffs = [{
      additions: totals.additions,
      deletions: totals.deletions,
    }]
  }

  return Object.keys(nextSummary).length > 0 ? nextSummary : undefined
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

const areDiffEntriesEqual = (
  left: SessionSummaryDiffEntry[] | null | undefined,
  right: SessionSummaryDiffEntry[] | null | undefined,
): boolean => {
  if (left === right) return true
  const leftEntries = left ?? []
  const rightEntries = right ?? []
  if (leftEntries.length !== rightEntries.length) return false

  for (let index = 0; index < leftEntries.length; index += 1) {
    const leftEntry = leftEntries[index]
    const rightEntry = rightEntries[index]
    if (!leftEntry || !rightEntry) return leftEntry === rightEntry
    if (parseSessionDiffCount(leftEntry.additions) !== parseSessionDiffCount(rightEntry.additions)) return false
    if (parseSessionDiffCount(leftEntry.deletions) !== parseSessionDiffCount(rightEntry.deletions)) return false
  }

  return true
}

const areSummaryValuesEqual = (
  left: SessionSummaryDiffStats | null | undefined,
  right: SessionSummaryDiffStats | null | undefined,
): boolean => {
  if (left === right) return true
  if (!left || !right) return !left && !right

  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false

  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false
    if (key === 'diffs') {
      if (!areDiffEntriesEqual(left.diffs, right.diffs)) return false
      continue
    }
    if (left[key] !== right[key]) return false
  }

  return true
}

export const normalizeChatOwnedDiffSummary = <T extends SessionDiffSummaryTarget>(
  target: T,
  messages: readonly SessionDiffSummaryMessage[] | undefined,
): T => {
  const totals = getChatOwnedDiffTotalsFromMessages(messages)
  const nextSummary = applyChatOwnedDiffTotalsToSummary(target.summary, totals)
  if (areSummaryValuesEqual(target.summary, nextSummary)) {
    return target
  }

  return { ...target, summary: nextSummary } as T
}
