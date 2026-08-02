import type { SessionStatus } from "@opencode-ai/sdk/v2/client"

import { buildProviderRecoveryInput } from "@/lib/messages/providerRecovery"
import type { ProviderRecoveryInput } from "@/stores/useProviderRecoveryStore"
import type { ProviderStallRecord } from "@/stores/useProviderStallStore"
import {
  getProviderStallFingerprint,
  haveSameProviderStallFingerprint,
} from "./reconnect-recovery"
import type { State } from "./types"

export const PROVIDER_TOOL_INPUT_STALL_REASON = "The provider stopped responding while preparing a tool call."
export const PROVIDER_INFERENCE_STALL_REASON = "The provider stopped responding before producing a response."

export type ProviderStallResolution = "recovery-offered" | "stream-resumed"

type ProviderStallRecoveryDependencies = {
  resyncSession: (
    sessionID: string,
    options: { directory: string; reason: "manual" },
  ) => Promise<void>
  getState: () => State | undefined
  isCurrent: () => boolean
  abort: (sessionID: string, status?: SessionStatus) => Promise<boolean>
  offerRecovery: (recovery: ProviderRecoveryInput) => void
}

export async function stopStalledProviderAndOfferRecovery(
  record: ProviderStallRecord,
  dependencies: ProviderStallRecoveryDependencies,
): Promise<ProviderStallResolution> {
  await dependencies.resyncSession(record.sessionID, {
    directory: record.directory,
    reason: "manual",
  })

  if (!dependencies.isCurrent()) return "stream-resumed"
  const state = dependencies.getState()
  if (!state) return "stream-resumed"

  const currentFingerprint = getProviderStallFingerprint({
    state,
    sessionID: record.sessionID,
  })
  if (!haveSameProviderStallFingerprint(record, currentFingerprint)) {
    return "stream-resumed"
  }

  const recovery = buildProviderRecoveryInput({
    sessionId: record.sessionID,
    directory: record.directory,
    reason: record.kind === "tool-input"
      ? PROVIDER_TOOL_INPUT_STALL_REASON
      : PROVIDER_INFERENCE_STALL_REASON,
    messages: state.message[record.sessionID] ?? [],
  })
  if (!recovery) {
    throw new Error("DevRyan could not prepare a safe retry for the stalled response.")
  }
  if (recovery.anchorUserMessageId !== record.anchorUserMessageID) {
    return "stream-resumed"
  }

  // No await occurs between this last ownership check and starting the abort.
  // A semantic event clears the store record, so a just-resumed stream wins.
  if (!dependencies.isCurrent()) return "stream-resumed"
  const confirmed = await dependencies.abort(
    record.sessionID,
    state.session_status[record.sessionID],
  )
  if (!confirmed) {
    throw new Error("DevRyan could not confirm that the stalled response stopped.")
  }

  dependencies.offerRecovery(recovery)
  return "recovery-offered"
}
