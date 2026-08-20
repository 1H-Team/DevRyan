import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { useCallback } from "react"
import { clearAbortGuard } from "./abort-retry-guard"
import { useProviderRecoveryStore } from "@/stores/useProviderRecoveryStore"
import { useSyncSDK } from "./sync-context"
import { useDirectoryStore } from "./sync-context"
import { useSync } from "./use-sync"
import { resolveProviderPromptTools } from "@/lib/opencode/provider-prompt-tools"
import { opencodeClient } from "@/lib/opencode/client"

// ---------------------------------------------------------------------------
// Ascending ID generator — monotonic timestamp + sequence counter
// ---------------------------------------------------------------------------

let counter = 0

function ascending(prefix: string): string {
  const now = Date.now()
  const seq = (counter++ % 1000).toString().padStart(3, "0")
  return `${prefix}_${now}${seq}`
}

// ---------------------------------------------------------------------------
// Prompt submission with optimistic updates
// Prompt submission with optimistic message insertion
// ---------------------------------------------------------------------------

export type SubmitInput = {
  sessionID: string
  text: string
  parts?: Part[]
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
  planMode?: boolean
  command?: { name: string; arguments: string }
  images?: Array<{ id?: string; type: "file"; mime: string; url: string; filename: string }>
}

export const resolveSubmitPromptTools = (
  input: Pick<SubmitInput, "agent" | "model" | "planMode">,
  contextModeAvailable = opencodeClient.getContextModeAvailable(),
) => resolveProviderPromptTools(input.model.providerID, input.agent, {
  planMode: input.planMode === true,
  contextModeAvailable,
})

export function usePromptSubmit() {
  const sdk = useSyncSDK()
  const store = useDirectoryStore()
  const sync = useSync()

  const submit = useCallback(
    async (input: SubmitInput) => {
      const messageID = ascending("message")

      // Build optimistic user message
      const message: Message = {
        id: messageID,
        sessionID: input.sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: input.agent,
        model: input.model,
        variant: input.variant,
      } as Message

      // Build optimistic parts
      const textPart: Part = {
        id: ascending("part"),
        sessionID: input.sessionID,
        messageID,
        type: "text",
        text: input.text,
      } as Part

      const optimisticParts: Part[] = [textPart, ...(input.parts ?? [])]

      // A new user-initiated turn supersedes any pending stop-during-retry guard.
      clearAbortGuard(input.sessionID)
      useProviderRecoveryStore.getState().clearRecovery(input.sessionID)

      // Set busy status optimistically
      store.setState((prev) => ({
        ...prev,
        session_status: {
          ...prev.session_status,
          [input.sessionID]: { type: "busy" },
        },
      }))

      // Add optimistic message immediately
      sync.optimistic.add({
        sessionID: input.sessionID,
        message,
        parts: optimisticParts,
      })

      try {
        if (input.command) {
          // Slash command
          await sdk.session.command({
            sessionID: input.sessionID,
            command: input.command.name,
            arguments: input.command.arguments,
            agent: input.agent,
            model: `${input.model.providerID}/${input.model.modelID}`,
            variant: input.variant,
            parts: input.images,
          })
        } else {
          // Regular prompt
          const requestParts: Array<{ id: string; type: "text"; text: string }
            | { id: string; type: "file"; mime: string; url: string; filename?: string }> = [
            { id: textPart.id, type: "text" as const, text: input.text },
          ]
          if (input.images) {
            for (const img of input.images) {
              requestParts.push({
                id: img.id ?? ascending("part"),
                type: "file" as const,
                mime: img.mime,
                url: img.url,
                filename: img.filename,
              })
            }
          }

          await sdk.session.promptAsync({
            sessionID: input.sessionID,
            agent: input.agent,
            model: input.model,
            messageID,
            parts: requestParts,
            variant: input.variant,
            tools: resolveSubmitPromptTools(input),
          })
        }
        return true
      } catch (error) {
        // Revert optimistic on failure
        sync.optimistic.remove({
          sessionID: input.sessionID,
          messageID,
        })
        // Reset status
        store.setState((prev) => ({
          ...prev,
          session_status: {
            ...prev.session_status,
            [input.sessionID]: { type: "idle" },
          },
        }))
        throw error
      }
    },
    [sdk, store, sync],
  )

  return submit
}
