import type { Event, Part } from "@opencode-ai/sdk/v2/client"
import { Binary } from "./binary"
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

const PENDING_PART_DELTA_TTL_MS = 30_000
const MAX_PENDING_PART_DELTAS = 500
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

export function applyPendingPartDeltasToParts(
  parts: Part[],
  partID: string,
  pendingDeltas: PendingPartDelta[],
  options: ApplyPendingPartDeltasOptions = {},
): { parts: Part[]; applied: boolean } {
  if (pendingDeltas.length === 0) {
    return { parts, applied: false }
  }

  const result = Binary.search(parts, partID, (part) => part.id)
  if (!result.found) {
    return { parts, applied: false }
  }

  const previousPart = parts[result.index] as Record<string, unknown>
  let nextPart: Record<string, unknown> | null = null

  for (const pending of pendingDeltas) {
    const source = nextPart ?? previousPart
    const existingValue = source[pending.field]
    const appendedValue = appendNonOverlappingDelta(
      typeof existingValue === "string" ? existingValue : undefined,
      pending.delta,
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
  nextParts[result.index] = nextPart as unknown as Part
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
