import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { DEFAULT_MESSAGE_LIMIT } from "@/stores/types/sessionTypes"
import { collapseExactAdjacentTextRepeats, normalizeAssistantPartText } from "./part-delta"
import { unwrapSdkResult } from "./sdk-result"

export type MessageRecord = {
  info?: Message
  parts?: Part[]
}

export type MaterializedMessageRecord = MessageRecord & {
  info: Message
}

export function hasMessageRecordInfo(record: MessageRecord): record is MaterializedMessageRecord {
  return typeof record?.info?.id === "string" && record.info.id.length > 0
}

export function normalizeMessageFetchLimit(limit: number | undefined, fallback = DEFAULT_MESSAGE_LIMIT): number {
  if (!Number.isFinite(limit) || typeof limit !== "number" || limit <= 0) {
    return fallback
  }
  return Math.floor(limit)
}

export function normalizeSessionMessagePageLimit(limit: number | undefined): number {
  return Math.max(DEFAULT_MESSAGE_LIMIT, normalizeMessageFetchLimit(limit))
}

export function resolveRetainedMessageLimit(input: {
  requestedLimit: number | undefined
  materializedCount: number
}): number {
  return Math.max(
    normalizeSessionMessagePageLimit(input.requestedLimit),
    Number.isFinite(input.materializedCount) ? Math.floor(input.materializedCount) : 0,
  )
}

export function resolveMessagePagePagination(input: {
  requestedLimit: number
  returnedCount: number
  cursor: string | undefined
}): { cursor: string | undefined; complete: boolean } {
  const requestedLimit = normalizeMessageFetchLimit(input.requestedLimit)
  const cursor = input.cursor || undefined
  // OpenCode can return the oldest record as a `before` cursor even when the
  // page is already exhausted, so only a full page makes that cursor usable.
  const complete = !cursor || input.returnedCount < requestedLimit

  return {
    cursor: complete ? undefined : cursor,
    complete,
  }
}

function normalizeFetchedPart(part: Part, role?: Message["role"]): Part {
  if (part.type !== "text" && part.type !== "reasoning") {
    return part
  }

  const text = (part as { text?: unknown }).text
  if (typeof text !== "string") {
    return part
  }

  const normalized = role === "assistant"
    ? normalizeAssistantPartText(text, part.type)
    : collapseExactAdjacentTextRepeats(text)
  if (normalized === text) {
    return part
  }

  return { ...part, text: normalized } as Part
}

export function normalizeFetchedMessageRecords(records: MessageRecord[]): MessageRecord[] {
  return records.map((record) => {
    const parts = record.parts
    if (!Array.isArray(parts) || parts.length === 0) {
      return record
    }

    let changed = false
    const normalizedParts = parts.map((part) => {
      const normalized = normalizeFetchedPart(part, record.info?.role)
      changed ||= normalized !== part
      return normalized
    })

    return changed ? { ...record, parts: normalizedParts } : record
  })
}

export function unwrapMessageRecordsResult(
  result: { data?: MessageRecord[]; error?: unknown; response?: { status?: number } },
): MessageRecord[] {
  return normalizeFetchedMessageRecords(unwrapSdkResult(result, "session.messages"))
}
