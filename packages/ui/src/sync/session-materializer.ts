import type { SessionHistory } from "./session-history"

export {
  ARCHIVED_OFFLOAD_TTL_MS,
  type SessionMaterializationLevel,
  type SessionMaterializationState,
} from "./session-history"

// Module entry points for session actions and live events, which run outside
// React. They dispatch to the provider-owned SessionHistory for any managed
// directory and do nothing while no provider is mounted or the directory is
// unknown.
let owner: SessionHistory | null = null

export function setSessionMaterializer(history: SessionHistory): void {
  owner = history
}

export function clearSessionMaterializer(history: SessionHistory): void {
  if (owner === history) owner = null
}

export function markArchived(sessionID: string, directory?: string): void {
  if (directory) owner?.markArchived({ directory, sessionID })
}

export function markUnarchived(sessionID: string, directory?: string): void {
  if (directory) owner?.markUnarchived({ directory, sessionID })
}

export function retireSessionHistory(sessionID: string, directory?: string): void {
  if (directory) owner?.retireSession({ directory, sessionID })
}
