import { getPatchText, isToolDiffPreviewOversized } from './toolDiffPreview'

export type DiffPatchEntry = {
  id: string
  title: string
  patch: string
}

const hasUnifiedDiffHunk = (patch: string): boolean => /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/m.test(patch)

const getUnifiedDiffPath = (patch: string, fallbackTitle: string): string => {
  const plusHeader = patch.match(/^\+\+\+\s+(?:[ab]\/(.+)|(.+))$/m)
  const rawPath = plusHeader?.[1] ?? plusHeader?.[2]
  if (!rawPath || rawPath === '/dev/null') {
    return fallbackTitle
  }
  return rawPath
}

const isUnifiedFileHeaderPair = (line: string, nextLine: string): boolean => {
  return /^---\s+\S+/.test(line) && /^\+\+\+\s+\S+/.test(nextLine)
}

const normalizeDisplayPath = (value: string): string => {
  const trimmed = value.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (!trimmed || trimmed === '/') {
    return trimmed
  }
  return trimmed.replace(/\/+$/, '')
}

const getRelativePath = (absolutePath: string, currentDirectory: string): string => {
  const normalizedAbsolutePath = normalizeDisplayPath(absolutePath)
  const normalizedCurrentDirectory = normalizeDisplayPath(currentDirectory)

  if (!normalizedAbsolutePath) {
    return ''
  }

  if (!normalizedCurrentDirectory) {
    return normalizedAbsolutePath
  }

  if (normalizedAbsolutePath === normalizedCurrentDirectory) {
    return '.'
  }

  const prefix = `${normalizedCurrentDirectory}/`
  if (normalizedAbsolutePath.startsWith(prefix)) {
    return normalizedAbsolutePath.slice(prefix.length)
  }

  return normalizedAbsolutePath
}

export const splitUnifiedDiffPatch = (patch: string): DiffPatchEntry[] => {
  if (isToolDiffPreviewOversized(patch)) return [{ id: 'oversized-0', title: 'Diff 1', patch }]
  const normalized = patch.replace(/\r\n/g, '\n').trim()
  if (!normalized) {
    return []
  }

  const lines = normalized.split('\n')
  const starts: number[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const nextLine = lines[index + 1] ?? ''
    if (line.startsWith('diff --git ') || line.startsWith('Index: ') || isUnifiedFileHeaderPair(line, nextLine)) {
      starts.push(index)
    }
  }

  const chunks = starts.length > 0
    ? starts.map((start, index) => lines.slice(start, starts[index + 1] ?? lines.length).join('\n').trim())
    : [normalized]

  return chunks
    .map((chunk, index) => {
      if (!hasUnifiedDiffHunk(chunk)) {
        return null
      }

      const title = getUnifiedDiffPath(chunk, `Diff ${index + 1}`)
      return {
        id: `${title}-${index}`,
        title,
        patch: chunk,
      } satisfies DiffPatchEntry
    })
    .filter((entry): entry is DiffPatchEntry => entry !== null)
}

export const getDiffPatchEntries = (
  metadata: Record<string, unknown> | undefined,
  fallbackDiff: string,
  currentDirectory: string,
): DiffPatchEntry[] => {
  const files = Array.isArray(metadata?.files) ? metadata.files : []

  const entries = files
    .flatMap((file, index) => {
      if (!file || typeof file !== 'object') {
        return []
      }

      const record = file as { relativePath?: unknown; filePath?: unknown; patch?: unknown; patchText?: unknown; diff?: unknown; changes?: unknown }
      const patch = getPatchText(record.patch) ?? getPatchText(record.patchText) ?? getPatchText(record.diff) ?? getPatchText(record.changes) ?? ''
      if (!patch) {
        return []
      }

      const rawPath = typeof record.relativePath === 'string'
        ? record.relativePath
        : typeof record.filePath === 'string'
          ? record.filePath
          : `File ${index + 1}`

      const title = typeof rawPath === 'string'
        ? getRelativePath(rawPath, currentDirectory)
        : `File ${index + 1}`

      if (isToolDiffPreviewOversized(patch)) return [{ id: `oversized-${index}`, title, patch }]
      if (!hasUnifiedDiffHunk(patch)) return []

      const splitEntries = splitUnifiedDiffPatch(patch)
      if (splitEntries.length > 1) {
        return splitEntries.map((entry, splitIndex) => ({
          id: `${entry.title}-${index}-${splitIndex}`,
          title: getRelativePath(entry.title, currentDirectory),
          patch: entry.patch,
        } satisfies DiffPatchEntry))
      }

      return [{
        id: `${title}-${index}`,
        title,
        patch: splitEntries[0]?.patch ?? patch,
      } satisfies DiffPatchEntry]
    })
    .filter((entry): entry is DiffPatchEntry => entry !== null)

  if (entries.length > 0) {
    return entries
  }

  const splitEntries = splitUnifiedDiffPatch(fallbackDiff).map((entry) => ({
    ...entry,
    title: getRelativePath(entry.title, currentDirectory),
  }))

  if (splitEntries.length > 0) {
    return splitEntries
  }

  return []
}

export const resolveRawPatchFallback = (
  patch: string | null | undefined,
  entries: readonly DiffPatchEntry[],
): string | null => {
  if (entries.length > 0) {
    return null
  }

  if (typeof patch !== 'string') {
    return null
  }

  if (isToolDiffPreviewOversized(patch)) return patch
  const trimmed = patch.trim()
  return trimmed.length > 0 ? trimmed : null
}
