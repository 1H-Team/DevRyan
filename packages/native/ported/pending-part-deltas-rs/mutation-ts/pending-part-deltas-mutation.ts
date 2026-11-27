// Test wrapper, never part of the product: calls the store-mutating exports of
// `pending-part-deltas.ts` with an explicit clock on a `Map` built from the given entries, and
// returns the store's entries with the result, so a port can be compared.
import type { Event } from "@opencode-ai/sdk/v2/client"
import {
  addPendingPartDelta,
  clearPartTypeHintsForDirectory,
  clearPendingPartDeltasForDirectory,
  clearPendingPartDeltasForMessages,
  consumePendingPartDeltas,
  getPartTypeHint,
  hasPendingPartDeltasForMessages,
  recordPartTypeHintFromEvent,
  type PendingPartDelta,
} from "../../../../ui/src/sync/pending-part-deltas"

type PendingPartDeltaInput = Omit<PendingPartDelta, "updatedAt">
type HintEntries = [string, { type: string; updatedAt: number }][]
type PendingEntries = [string, PendingPartDelta][]

export function recordPartTypeHintReturningStore(entries: HintEntries, directory: string, event: Event, now: number): HintEntries {
  const store = new Map(entries)
  recordPartTypeHintFromEvent(store, directory, event, now)
  return [...store]
}

export function getPartTypeHintReturningStore(entries: HintEntries, directory: string, partID: string, now: number): { result: string | undefined; store: HintEntries } {
  const store = new Map(entries)
  const result = getPartTypeHint(store, directory, partID, now)
  return { result, store: [...store] }
}

export function clearPartTypeHintsReturningStore(entries: HintEntries, directory: string): HintEntries {
  const store = new Map(entries)
  clearPartTypeHintsForDirectory(store, directory)
  return [...store]
}

export function addPendingPartDeltaReturningStore(entries: PendingEntries, directory: string, pending: PendingPartDeltaInput, now: number): PendingEntries {
  const store = new Map(entries)
  addPendingPartDelta(store, directory, pending, now)
  return [...store]
}

export function consumePendingPartDeltasReturningStore(entries: PendingEntries, directory: string, messageID: string, partID: string, now: number): { result: PendingPartDelta[]; store: PendingEntries } {
  const store = new Map(entries)
  const result = consumePendingPartDeltas(store, directory, messageID, partID, now)
  return { result, store: [...store] }
}

export function hasPendingPartDeltasForMessageList(entries: PendingEntries, directory: string, messageIDs: string[] | Set<string>): boolean {
  const store = new Map(entries)
  return hasPendingPartDeltasForMessages(store, directory, messageIDs)
}

export function clearPendingPartDeltasForDirectoryReturningStore(entries: PendingEntries, directory: string): { result: number; store: PendingEntries } {
  const store = new Map(entries)
  const result = clearPendingPartDeltasForDirectory(store, directory)
  return { result, store: [...store] }
}

export function clearPendingPartDeltasForMessagesReturningStore(entries: PendingEntries, directory: string, messageIDs: string[] | Set<string>): { result: number; store: PendingEntries } {
  const store = new Map(entries)
  const result = clearPendingPartDeltasForMessages(store, directory, messageIDs)
  return { result, store: [...store] }
}
