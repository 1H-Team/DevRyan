import type { Message, Part } from '@opencode-ai/sdk/v2/client'

import { normalizeToolStatus } from '@/lib/toolStatus'
import type { State } from '@/sync/types'

export type SessionChangeAttribution = {
  paths: readonly string[]
  hasUnattributedMutations: boolean
}

const EMPTY_ATTRIBUTION: SessionChangeAttribution = Object.freeze({
  paths: Object.freeze([] as string[]),
  hasUnattributedMutations: false,
})

const FILE_MUTATION_TOOLS = new Set([
  'apply_patch',
  'create',
  'edit',
  'file_write',
  'multiedit',
  'str_replace',
  'str_replace_based_edit_tool',
  'write',
])

const UNATTRIBUTED_MUTATION_TOOLS = new Set([
  'bash',
  'cmd',
  'powershell',
  'terminal',
])

const SUCCESS_TOOL_STATUSES = new Set(['complete', 'completed', 'done'])

const TOOL_NAME_ALIASES = new Map<string, string>([
  ['applypatch', 'apply_patch'],
  ['apply_patch_tool', 'apply_patch'],
  ['patch', 'apply_patch'],
  ['file_patch', 'apply_patch'],
  ['patch_file', 'apply_patch'],
  ['apply_diff', 'apply_patch'],
  ['edit_file', 'edit'],
  ['file_edit', 'edit'],
  ['write_file', 'write'],
  ['create_file', 'create'],
  ['oc_write', 'write'],
  ['oc_edit', 'edit'],
  ['oc_bash', 'bash'],
  ['shell_command', 'bash'],
  ['terminal_command', 'bash'],
  ['run_command', 'bash'],
  ['execute_command', 'bash'],
  ['exec_command', 'bash'],
  ['command', 'bash'],
  ['shell', 'bash'],
  ['sh', 'bash'],
])

const PATH_KEYS = [
  'filePath',
  'file_path',
  'targetFile',
  'target_file',
  'relativePath',
  'movePath',
  'path',
  'file',
  'filename',
] as const

const PATCH_KEYS = ['patch', 'patchText', 'diff', 'changes'] as const

const normalizeToolName = (value: unknown): string => {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''

  let normalized = trimmed.replace(/:\d+$/, '')
  if (normalized.includes('.')) {
    const parts = normalized.split('.').filter(Boolean)
    normalized = parts[parts.length - 1] ?? normalized
  }
  normalized = normalized
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase()
    .replace(/_?tool_?call$/, '')

  return TOOL_NAME_ALIASES.get(normalized) ?? normalized
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const normalizeDirectory = (value: string): string => {
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized || '/'
}

const normalizeCandidatePath = (value: unknown, directory: string): string | null => {
  if (typeof value !== 'string') return null
  const raw = value.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (!raw) return null

  const base = normalizeDirectory(directory)
  const isAbsolute = raw.startsWith('/') || /^[a-zA-Z]:\//.test(raw)
  let relative = raw

  if (isAbsolute) {
    const lowerRaw = raw.toLowerCase()
    const lowerBase = base.toLowerCase()
    if (lowerRaw === lowerBase) return null
    if (!lowerRaw.startsWith(`${lowerBase}/`)) return null
    relative = raw.slice(base.length + 1)
  }

  relative = relative
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')

  if (!relative || relative === '.' || relative.startsWith('../') || relative.includes('/../')) {
    return null
  }
  return relative
}

const collectRecordPathCandidates = (record: Record<string, unknown>, target: unknown[]) => {
  for (const key of PATH_KEYS) {
    target.push(record[key])
  }
}

const collectPatchPaths = (value: unknown, target: unknown[]) => {
  if (typeof value !== 'string') return
  for (const line of value.split('\n')) {
    const applyPatchMatch = line.match(/^\*\*\* (?:Add|Delete|Update|Move to) File:\s+(.+?)\s*$/)
    if (applyPatchMatch?.[1]) {
      target.push(applyPatchMatch[1])
      continue
    }
    const unifiedMatch = line.match(/^(?:\+\+\+|---)\s+(?:[ab]\/)?(.+?)\s*$/)
    if (unifiedMatch?.[1] && unifiedMatch[1] !== '/dev/null') {
      target.push(unifiedMatch[1])
    }
  }
}

const collectToolPathCandidates = (part: Part): unknown[] => {
  if (part.type !== 'tool') return []
  const state: Record<string, unknown> = isRecord(part.state) ? part.state : {}
  const partRecord = part as Part & { input?: unknown; metadata?: unknown }
  const input = isRecord(state.input)
    ? state.input
    : isRecord(partRecord.input)
      ? partRecord.input
      : {}
  const metadata = isRecord(state.metadata)
    ? state.metadata
    : isRecord(partRecord.metadata)
      ? partRecord.metadata
      : {}
  const candidates: unknown[] = []

  collectRecordPathCandidates(input, candidates)
  collectRecordPathCandidates(metadata, candidates)

  for (const container of [input, metadata]) {
    for (const key of PATCH_KEYS) {
      collectPatchPaths(container[key], candidates)
    }
  }

  const files = Array.isArray(metadata.files) ? metadata.files : []
  for (const file of files) {
    if (!isRecord(file)) continue
    collectRecordPathCandidates(file, candidates)
  }

  if (isRecord(metadata.filediff)) {
    collectRecordPathCandidates(metadata.filediff, candidates)
  }

  const results = Array.isArray(metadata.results) ? metadata.results : []
  for (const result of results) {
    if (!isRecord(result) || !isRecord(result.filediff)) continue
    collectRecordPathCandidates(result.filediff, candidates)
  }

  return candidates
}

const isSuccessfulToolPart = (part: Part): boolean => {
  if (part.type !== 'tool') return false
  const status = normalizeToolStatus((part.state as { status?: unknown } | undefined)?.status)
  return status ? SUCCESS_TOOL_STATUSES.has(status) : false
}

const getVisibleMessages = (state: State, sessionID: string): readonly Message[] => {
  const messages = state.message[sessionID] ?? []
  const session = state.session.find((entry) => entry.id === sessionID)
  const revertMessageID = (session as { revert?: { messageID?: unknown } } | undefined)?.revert?.messageID
  if (typeof revertMessageID !== 'string' || !revertMessageID) return messages
  return messages.filter((message) => message.id < revertMessageID)
}

export const projectSessionChangeAttribution = (
  state: State,
  sessionID: string,
  directory: string,
): SessionChangeAttribution => {
  if (!sessionID || !directory) return EMPTY_ATTRIBUTION

  const paths = new Set<string>()
  let hasUnattributedMutations = false

  for (const message of getVisibleMessages(state, sessionID)) {
    if (message.role !== 'assistant') continue
    for (const part of state.part[message.id] ?? []) {
      if (part.type !== 'tool' || !isSuccessfulToolPart(part)) continue
      const tool = normalizeToolName(part.tool)

      if (UNATTRIBUTED_MUTATION_TOOLS.has(tool)) {
        hasUnattributedMutations = true
        continue
      }
      if (!FILE_MUTATION_TOOLS.has(tool)) continue

      let attributed = false
      for (const candidate of collectToolPathCandidates(part)) {
        const path = normalizeCandidatePath(candidate, directory)
        if (!path) continue
        paths.add(path)
        attributed = true
      }
      if (!attributed) {
        hasUnattributedMutations = true
      }
    }
  }

  if (paths.size === 0 && !hasUnattributedMutations) return EMPTY_ATTRIBUTION
  return {
    paths: [...paths].sort(),
    hasUnattributedMutations,
  }
}

export const areSessionChangeAttributionsEqual = (
  left: SessionChangeAttribution | undefined,
  right: SessionChangeAttribution,
): boolean => {
  if (!left) return right.paths.length === 0 && !right.hasUnattributedMutations
  if (left.hasUnattributedMutations !== right.hasUnattributedMutations) return false
  if (left.paths.length !== right.paths.length) return false
  return left.paths.every((path, index) => path === right.paths[index])
}
