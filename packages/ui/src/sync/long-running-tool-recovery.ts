import type { SessionStatus } from "@opencode-ai/sdk/v2/client"

import type { LongRunningToolRecord } from "@/stores/useLongRunningToolStore"
import {
  getLongRunningToolFingerprint,
  haveSameLongRunningToolFingerprint,
} from "./reconnect-recovery"
import type { State } from "./types"

export type LongRunningToolStopOutcome = "stopped" | "stream-resumed"

type LongRunningToolStopDependencies = {
  resyncSession: (
    sessionID: string,
    options: { directory: string; reason: "manual" },
  ) => Promise<void>
  getState: () => State | undefined
  isCurrent: () => boolean
  abort: (sessionID: string, status?: SessionStatus) => Promise<boolean>
}

export async function stopLongRunningTool(
  record: LongRunningToolRecord,
  dependencies: LongRunningToolStopDependencies,
): Promise<LongRunningToolStopOutcome> {
  await dependencies.resyncSession(record.sessionID, {
    directory: record.directory,
    reason: "manual",
  })

  if (!dependencies.isCurrent()) return "stream-resumed"
  const state = dependencies.getState()
  if (!state) return "stream-resumed"

  const currentFingerprint = getLongRunningToolFingerprint({
    state,
    sessionID: record.sessionID,
  })
  if (!haveSameLongRunningToolFingerprint(record, currentFingerprint)) {
    return "stream-resumed"
  }

  if (!dependencies.isCurrent()) return "stream-resumed"
  const confirmed = await dependencies.abort(
    record.sessionID,
    state.session_status[record.sessionID],
  )
  if (!confirmed) {
    throw new Error("DevRyan could not confirm that the long-running tool stopped.")
  }

  return "stopped"
}
