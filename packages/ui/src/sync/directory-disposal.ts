import type { State } from "./types"

type OwnershipCleanupScheduler = (cleanup: () => void) => void

const scheduleOwnershipCleanup: OwnershipCleanupScheduler = (cleanup) => {
  queueMicrotask(cleanup)
}

export function createRestartSafeOwnershipCleanup(
  cleanup: () => void,
  schedule: OwnershipCleanupScheduler = scheduleOwnershipCleanup,
): () => () => void {
  let generation = 0
  return () => {
    generation += 1
    const activeGeneration = generation
    let requested = false
    return () => {
      if (requested) return
      requested = true
      schedule(() => {
        if (generation === activeGeneration) {
          cleanup()
        }
      })
    }
  }
}

export type DirectoryRoutingIndex = {
  sessionDirectoryById: Map<string, string>
  messageSessionById: Map<string, string>
  sessionMessageIdsById: Map<string, Set<string>>
}

export type DirectoryMaterialization = {
  directory: string
  retryTimer?: ReturnType<typeof setTimeout>
}

const removeRoutingSession = (routingIndex: DirectoryRoutingIndex, sessionID: string) => {
  routingIndex.sessionDirectoryById.delete(sessionID)
  const messageIDs = routingIndex.sessionMessageIdsById.get(sessionID)
  if (messageIDs) {
    for (const messageID of messageIDs) {
      routingIndex.messageSessionById.delete(messageID)
    }
  }
  routingIndex.sessionMessageIdsById.delete(sessionID)
}

export function releaseDirectoryRoutingIndex(
  routingIndex: DirectoryRoutingIndex,
  directory: string,
  snapshot: State,
): Set<string> {
  const sessionIDs = new Set<string>([
    ...snapshot.session.map((session) => session.id),
    ...Object.keys(snapshot.message),
  ])

  for (const [sessionID, indexedDirectory] of routingIndex.sessionDirectoryById) {
    if (indexedDirectory === directory) {
      sessionIDs.add(sessionID)
    }
  }

  for (const sessionID of sessionIDs) {
    removeRoutingSession(routingIndex, sessionID)
  }
  for (const messageID of Object.keys(snapshot.part)) {
    routingIndex.messageSessionById.delete(messageID)
  }

  return sessionIDs
}

export function clearDirectoryMaterializations<T extends DirectoryMaterialization>(
  pending: Map<string, T>,
  directory: string,
): number {
  let cleared = 0
  for (const [key, entry] of pending) {
    if (entry.directory !== directory) continue
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer)
    }
    pending.delete(key)
    cleared += 1
  }
  return cleared
}

export function clearDirectoryPrefixedEntries<T>(
  collection: Map<string, T> | Set<string>,
  directory: string,
  separator = "\n",
): number {
  const prefix = `${directory}${separator}`
  let cleared = 0
  for (const key of collection.keys()) {
    if (!key.startsWith(prefix)) continue
    collection.delete(key)
    cleared += 1
  }
  return cleared
}
