import type { Event, Part } from "@opencode-ai/sdk/v2/client"
import { appendNonOverlappingDelta, appendStreamingTextDelta, normalizeAssistantPartText } from "./part-delta"
import type { State } from "./types"

export type PendingPartDelta = {
  messageID: string
  partID: string
  field: string
  delta: string
  updatedAt: number
}

export type PendingPartDeltaStore = Map<string, PendingPartDelta>
export type PartTypeHintStore = Map<string, { type: string; updatedAt: number }>

const PENDING_PART_DELTA_TTL_MS = 30_000
const MAX_PENDING_PART_DELTAS = 500
// Hints outlive the delta buffer: a part's type is announced once at creation,
// while its deltas can keep buffering for the rest of a long turn.
const PART_TYPE_HINT_TTL_MS = 300_000
const MAX_PART_TYPE_HINTS = 500
const KEY_SEPARATOR = "\u0000"

type PendingPartDeltaInput = Omit<PendingPartDelta, "updatedAt">
type ApplyPendingPartDeltasOptions = {
  sanitizeAssistantText?: boolean
}

function pendingPartDeltaKey(directory: string, messageID: string, partID: string, field: string) {
  return [directory, messageID, partID, field].join(KEY_SEPARATOR)
}

function pendingPartDeltaPrefix(directory: string, messageID: string, partID: string) {
  return [directory, messageID, partID, ""].join(KEY_SEPARATOR)
}

function appendPendingDelta(field: string, existing: string | undefined, incoming: string): string {
  if (field === "text" || field === "output") {
    return appendStreamingTextDelta(existing, incoming)
  }

  return existing ? existing + incoming : incoming
}

function partTypeHintKey(directory: string, partID: string) {
  return [directory, partID].join(KEY_SEPARATOR)
}

function prunePartTypeHints(store: PartTypeHintStore, now: number) {
  for (const [key, hint] of store) {
    if (now - hint.updatedAt > PART_TYPE_HINT_TTL_MS) {
      store.delete(key)
    }
  }

  if (store.size <= MAX_PART_TYPE_HINTS) {
    return
  }

  const overflow = store.size - MAX_PART_TYPE_HINTS
  const oldest = Array.from(store.entries())
    .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
    .slice(0, overflow)

  for (const [key] of oldest) {
    store.delete(key)
  }
}

/**
 * Remembers the announced type of every part seen on the raw event stream so a
 * later provisional part built from buffered deltas is not forced to guess.
 * Recorded regardless of whether the reducer applied the event — a skipped
 * part.updated is exactly the case where the hint is needed.
 */
export function recordPartTypeHintFromEvent(
  store: PartTypeHintStore,
  directory: string,
  event: Event,
  now = Date.now(),
) {
  if (!directory || directory === "global") return
  if (event.type !== "message.part.updated") return

  const part = (event.properties as { part?: { id?: unknown; type?: unknown } }).part
  if (typeof part?.id !== "string" || part.id.length === 0 || typeof part.type !== "string" || part.type.length === 0) {
    return
  }

  prunePartTypeHints(store, now)
  store.set(partTypeHintKey(directory, part.id), { type: part.type, updatedAt: now })
}

export function getPartTypeHint(
  store: PartTypeHintStore,
  directory: string,
  partID: string,
  now = Date.now(),
): string | undefined {
  const hint = store.get(partTypeHintKey(directory, partID))
  if (!hint) return undefined
  if (now - hint.updatedAt > PART_TYPE_HINT_TTL_MS) {
    store.delete(partTypeHintKey(directory, partID))
    return undefined
  }
  return hint.type
}

export function clearPartTypeHintsForDirectory(store: PartTypeHintStore, directory: string) {
  if (!directory || directory === "global") return
  const prefix = `${directory}${KEY_SEPARATOR}`
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key)
    }
  }
}

export function readPendingPartDeltaFromEvent(event: Event): PendingPartDeltaInput | null {
  if (event.type !== "message.part.delta") {
    return null
  }

  const props = event.properties as {
    messageID?: unknown
    partID?: unknown
    field?: unknown
    delta?: unknown
  }

  if (
    typeof props.messageID !== "string"
    || props.messageID.length === 0
    || typeof props.partID !== "string"
    || props.partID.length === 0
    || typeof props.field !== "string"
    || props.field.length === 0
    || typeof props.delta !== "string"
    || props.delta.length === 0
  ) {
    return null
  }

  return {
    messageID: props.messageID,
    partID: props.partID,
    field: props.field,
    delta: props.delta,
  }
}

function prunePendingPartDeltas(store: PendingPartDeltaStore, now: number) {
  for (const [key, pending] of store) {
    if (now - pending.updatedAt > PENDING_PART_DELTA_TTL_MS) {
      store.delete(key)
    }
  }

  if (store.size <= MAX_PENDING_PART_DELTAS) {
    return
  }

  const overflow = store.size - MAX_PENDING_PART_DELTAS
  const oldest = Array.from(store.entries())
    .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
    .slice(0, overflow)

  for (const [key] of oldest) {
    store.delete(key)
  }
}

export function addPendingPartDelta(
  store: PendingPartDeltaStore,
  directory: string,
  pending: PendingPartDeltaInput,
  now = Date.now(),
) {
  if (!directory || directory === "global") {
    return
  }

  prunePendingPartDeltas(store, now)

  const key = pendingPartDeltaKey(directory, pending.messageID, pending.partID, pending.field)
  const existing = store.get(key)
  store.set(key, {
    ...pending,
    delta: appendPendingDelta(pending.field, existing?.delta, pending.delta),
    updatedAt: now,
  })

  prunePendingPartDeltas(store, now)
}

export function consumePendingPartDeltas(
  store: PendingPartDeltaStore,
  directory: string,
  messageID: string,
  partID: string,
  now = Date.now(),
): PendingPartDelta[] {
  prunePendingPartDeltas(store, now)

  const prefix = pendingPartDeltaPrefix(directory, messageID, partID)
  const pending: PendingPartDelta[] = []

  for (const [key, value] of store) {
    if (!key.startsWith(prefix)) {
      continue
    }
    pending.push(value)
    store.delete(key)
  }

  return pending.sort((left, right) => left.updatedAt - right.updatedAt)
}

/**
 * True if any buffered delta is still waiting for one of the given messages' parts
 * to materialize. Used to decide whether a session re-fetch actually drained the
 * buffer (vs. raced the server before the streamed part was persisted).
 */
export function hasPendingPartDeltasForMessages(
  store: PendingPartDeltaStore,
  directory: string,
  messageIDs: Iterable<string>,
): boolean {
  if (!directory || directory === "global" || store.size === 0) {
    return false
  }
  const ids = messageIDs instanceof Set ? messageIDs : new Set(messageIDs)
  if (ids.size === 0) {
    return false
  }
  for (const key of store.keys()) {
    const parts = key.split(KEY_SEPARATOR)
    if (parts[0] === directory && ids.has(parts[1])) {
      return true
    }
  }
  return false
}

export function clearPendingPartDeltasForDirectory(
  store: PendingPartDeltaStore,
  directory: string,
): number {
  if (!directory || directory === "global") return 0
  const prefix = `${directory}${KEY_SEPARATOR}`
  let cleared = 0
  for (const key of store.keys()) {
    if (!key.startsWith(prefix)) continue
    store.delete(key)
    cleared += 1
  }
  return cleared
}

export function clearPendingPartDeltasForMessages(
  store: PendingPartDeltaStore,
  directory: string,
  messageIDs: Iterable<string>,
): number {
  if (!directory || directory === "global" || store.size === 0) return 0
  const ids = messageIDs instanceof Set ? messageIDs : new Set(messageIDs)
  if (ids.size === 0) return 0

  let cleared = 0
  for (const [key, pending] of store) {
    if (!ids.has(pending.messageID) || !key.startsWith(`${directory}${KEY_SEPARATOR}`)) continue
    store.delete(key)
    cleared += 1
  }
  return cleared
}

/**
 * Folds buffered deltas for one part into a provisional part so streamed
 * output renders immediately instead of staying invisible until a session
 * refetch drains the buffer. Only text-field deltas qualify — anything else
 * returns null so the caller re-buffers and the normal drain path handles it.
 * The part type comes from the recorded type hint when the raw stream has
 * announced it (Grok interleaves reasoning deltas on the same "text" field, so
 * guessing "text" would render thoughts as visible message text); without a
 * hint it defaults to "text". A hint for any other type (e.g. tool) also
 * returns null — a provisional would render it wrong. The authoritative
 * message.part.updated replaces the provisional by id (shouldPreserveExistingPart
 * never preserves non-tool parts) and __dedupeNextDeltaFields reconciles any
 * text overlap.
 */
export function buildProvisionalPartFromPendingDeltas(
  messageID: string,
  partID: string,
  sessionID: string,
  pendingDeltas: PendingPartDelta[],
  partTypeHint?: string,
): Part | null {
  if (pendingDeltas.length === 0) return null

  const partType = partTypeHint ?? "text"
  if (partType !== "text" && partType !== "reasoning") return null

  let text: string | undefined
  for (const pending of pendingDeltas) {
    if (pending.field !== "text") return null
    text = appendPendingDelta(pending.field, text, pending.delta)
  }

  const normalized = normalizeAssistantPartText(text ?? "", partType)
  if (normalized.length === 0) return null

  return {
    id: partID,
    messageID,
    sessionID,
    type: partType,
    text: normalized,
    __provisionalFromDelta: true,
  } as unknown as Part
}

export function applyPendingPartDeltasToParts(
  parts: Part[],
  partID: string,
  pendingDeltas: PendingPartDelta[],
  options: ApplyPendingPartDeltasOptions = {},
): { parts: Part[]; applied: boolean } {
  if (pendingDeltas.length === 0) {
    return { parts, applied: false }
  }

  const partIndex = parts.findIndex((part) => part.id === partID)
  if (partIndex < 0) {
    return { parts, applied: false }
  }

  const previousPart = parts[partIndex] as Record<string, unknown>
  let nextPart: Record<string, unknown> | null = null

  for (const pending of pendingDeltas) {
    const source = nextPart ?? previousPart
    const existingValue = source[pending.field]
    const appendedValue = appendNonOverlappingDelta(
      typeof existingValue === "string" ? existingValue : undefined,
      pending.delta,
      { messageID: pending.messageID, partID, field: pending.field },
    )
    const nextValue = options.sanitizeAssistantText === true && pending.field === "text"
      ? normalizeAssistantPartText(appendedValue, typeof previousPart.type === "string" ? previousPart.type : undefined)
      : appendedValue
    if (existingValue === nextValue) {
      continue
    }
    nextPart = nextPart ?? { ...previousPart }
    nextPart[pending.field] = nextValue
  }

  if (!nextPart) {
    return { parts, applied: false }
  }

  const nextParts = [...parts]
  nextParts[partIndex] = nextPart as unknown as Part
  return { parts: nextParts, applied: true }
}

function isAssistantMessage(state: State, messageID: string): boolean {
  for (const messages of Object.values(state.message)) {
    if (messages.some((message) => message.id === messageID && message.role === "assistant")) {
      return true
    }
  }
  return false
}

export function applyPendingPartDeltasToState(
  state: State,
  messageID: string,
  partID: string,
  pendingDeltas: PendingPartDelta[],
): { part: State["part"] } | null {
  const parts = state.part[messageID]
  if (!parts) {
    return null
  }

  const result = applyPendingPartDeltasToParts(parts, partID, pendingDeltas, {
    sanitizeAssistantText: isAssistantMessage(state, messageID),
  })
  if (!result.applied) {
    return null
  }

  return {
    part: {
      ...state.part,
      [messageID]: result.parts,
    },
  }
}
