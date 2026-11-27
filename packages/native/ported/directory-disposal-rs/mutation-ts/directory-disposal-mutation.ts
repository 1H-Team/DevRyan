// Test wrapper, never part of the product: calls the collection-mutating exports of
// `directory-disposal.ts` on `Map`s and `Set`s built from the given entries, and returns their
// entries with the result, so a port can be compared.
import type { State } from "../../../../ui/src/sync/types"
import {
  clearDirectoryMaterializations,
  clearDirectoryPrefixedEntries,
  releaseDirectoryRoutingIndex,
  type DirectoryMaterialization,
} from "../../../../ui/src/sync/directory-disposal"

type RoutingEntries = {
  sessionDirectoryById: [string, string][]
  messageSessionById: [string, string][]
  sessionMessageIdsById: [string, string[]][]
}

export function releaseDirectoryRoutingIndexReturningIndex(index: RoutingEntries, directory: string, snapshot: State): { result: string[]; index: RoutingEntries } {
  const routingIndex = {
    sessionDirectoryById: new Map(index.sessionDirectoryById),
    messageSessionById: new Map(index.messageSessionById),
    sessionMessageIdsById: new Map(index.sessionMessageIdsById.map(([id, messageIDs]) => [id, new Set(messageIDs)])),
  }
  const result = releaseDirectoryRoutingIndex(routingIndex, directory, snapshot)
  return {
    result: [...result],
    index: {
      sessionDirectoryById: [...routingIndex.sessionDirectoryById],
      messageSessionById: [...routingIndex.messageSessionById],
      sessionMessageIdsById: [...routingIndex.sessionMessageIdsById].map(([id, messageIDs]) => [id, [...messageIDs]]),
    },
  }
}

export function clearDirectoryMaterializationsReturningPending(entries: [string, DirectoryMaterialization][], directory: string): { result: number; pending: [string, DirectoryMaterialization][] } {
  const pending = new Map(entries)
  const result = clearDirectoryMaterializations(pending, directory)
  return { result, pending: [...pending] }
}

export function clearDirectoryPrefixedMapEntriesReturningMap(entries: [string, string][], directory: string, separator?: string): { result: number; entries: [string, string][] } {
  const collection = new Map(entries)
  const result = clearDirectoryPrefixedEntries(collection, directory, separator)
  return { result, entries: [...collection] }
}

export function clearDirectoryPrefixedSetEntriesReturningSet(values: string[], directory: string, separator?: string): { result: number; values: string[] } {
  const collection = new Set(values)
  const result = clearDirectoryPrefixedEntries(collection, directory, separator)
  return { result, values: [...collection] }
}
