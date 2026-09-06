import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Message, TextPart } from "@opencode-ai/sdk/v2/client"
import { opencodeClient } from "@/lib/opencode/client"
import { useFeatureFlagsStore } from "@/stores/useFeatureFlagsStore"
import { ChildStoreManager } from "./child-store"
import { SessionMessageLoader } from "./session-message-loader"
import { createSessionPlanSelectionSelector } from "./session-plan-selection"
import { useSelectionStore } from "./selection-store"
import { resolveCurrentSendConfig } from "./send-config"

const originalGetScopedSdkClient = opencodeClient.getScopedSdkClient

const message = (id: string, role: "user" | "assistant"): Message => ({
  id,
  sessionID: "session-1",
  role,
  time: { created: 1 },
} as Message)

const response = (messages: Message[], cursor?: string) => ({
  data: messages.map((info) => ({ info, parts: [] })),
  response: { headers: { get: (name: string) => name === "x-next-cursor" ? cursor ?? null : null } },
})

describe("SessionMessageLoader", () => {
  beforeEach(() => {
    useFeatureFlagsStore.getState().setSessionFastLoadEnabled(true)
  })

  afterEach(() => {
    Object.defineProperty(opencodeClient, "getScopedSdkClient", {
      configurable: true,
      value: originalGetScopedSdkClient,
    })
  })

  for (const mode of ["cold", "prefetched"] as const) {
  test(`selected ${mode} history retrieves human Plan authority beyond a maintenance-only first page`, async () => {
    const sessionID = `session-plan-page-${mode}`
    const target = { directory: "/repo/plan-page", sessionID }
    const calls: Array<{ limit: number; before?: string }> = []
    const record = (index: number, role: "user" | "assistant", text: string, synthetic = false) => {
      const id = `msg_plan_${String(index).padStart(4, "0")}`
      const info: Message = { ...message(id, role), sessionID, time: { created: index + 1 } }
      const part: TextPart = { id: `${id}-part`, sessionID, messageID: id, type: "text", text, synthetic }
      return { info, parts: [part] }
    }
    const records = [
      record(0, "user", "User has requested to enter plan mode.\nProduce an implementation plan only.", true),
      record(1, "assistant", "Saved Plan."),
      record(2, "user", "[devryan-provider-recovery:v1:task_fixture]\nCollect completed result.", true),
      ...Array.from({ length: 49 }, (_, index) => record(index + 3, "assistant", "Collected result.")),
    ]
    Object.defineProperty(opencodeClient, "getScopedSdkClient", {
      configurable: true,
      value: () => ({ session: { messages: async ({ limit, before }: { limit: number; before?: string }) => {
        calls.push({ limit, ...(before ? { before } : {}) })
        const end = before ? records.findIndex(row => row.info.id === before) : records.length
        const page = records.slice(Math.max(0, end - limit), end)
        const cursor = end > limit ? page[0].info.id : null
        return { data: page, response: { headers: { get: (name: string) => name === "x-next-cursor" ? cursor : null } } }
      } } }),
    })
    const stores = new ChildStoreManager()
    const loader = new SessionMessageLoader(stores)
    useSelectionStore.getState().clearSessionSelection(sessionID)
    const selectPlan = createSessionPlanSelectionSelector(sessionID, id => id === records[0].info.id)
    try {
      if (mode === "prefetched") {
        loader.setActivePrefetchDirectory(target.directory)
        await loader.prefetch(target)
        expect(calls).toEqual([{ limit: 50 }])
      }
      await loader.ensure(target, { reason: "selected" })
      const state = stores.getChild(target.directory)!.getState()
      const choice = selectPlan(state)
      if (choice) useSelectionStore.getState().restoreSessionPlanMode(sessionID, choice.enabled)

      // Uses the actual loader/materializer, Plan selection store and captured
      // send resolver. Only the local page transport is replaced in this test.
      expect(resolveCurrentSendConfig(sessionID).planMode).toBe(true)
      expect(choice).toEqual({ messageID: records[0].info.id, enabled: true })
      expect(state.message[sessionID].some(info => info.id === records[0].info.id)).toBe(true)
      const requestCount = calls.length
      await loader.ensure(target, { reason: "selected" })
      expect(calls).toHaveLength(requestCount)
    } finally {
      useSelectionStore.getState().clearSessionSelection(sessionID)
      loader.dispose()
      stores.disposeDirectory(target.directory)
    }
  })
  }

  test("deduplicates callers and adaptively expands until a user boundary", async () => {
    const limits: number[] = []
    Object.defineProperty(opencodeClient, "getScopedSdkClient", {
      configurable: true,
      value: () => ({
        session: {
          messages: async ({ limit }: { limit: number }) => {
            limits.push(limit)
            const records = Array.from({ length: limit }, (_, index) => (
              message(`msg-${String(index).padStart(3, "0")}`, index === 0 && limit >= 100 ? "user" : "assistant")
            ))
            return response(records, "older-cursor")
          },
        },
      }),
    })
    const stores = new ChildStoreManager()
    const loader = new SessionMessageLoader(stores)
    const target = { directory: "/repo", sessionID: "session-1" }

    const first = loader.ensure(target, { reason: "selected" })
    const second = loader.ensure(target, { reason: "reactive" })
    await Promise.all([first, second])

    expect(limits).toEqual([50, 100])
    expect(stores.getChild("/repo")?.getState().message["session-1"]).toHaveLength(100)
    const snapshot = loader.getSnapshot(target)
    expect(snapshot.status).toBe("ready")
    expect(snapshot.resolved).toBe(true)
    expect(snapshot.cursor).toBe("older-cursor")
    expect(snapshot.complete).toBe(false)
  })

  test("tail refresh preserves the established older-history cursor", async () => {
    const limits: number[] = []
    Object.defineProperty(opencodeClient, "getScopedSdkClient", {
      configurable: true,
      value: () => ({
        session: {
          messages: async ({ limit }: { limit: number }) => {
            limits.push(limit)
            if (limit === 30) return response([message("msg-999", "assistant")])
            const records = Array.from({ length: limit }, (_, index) => (
              message(`msg-${String(index).padStart(3, "0")}`, index === 0 ? "user" : "assistant")
            ))
            return response(records, "older-cursor")
          },
        },
      }),
    })
    const loader = new SessionMessageLoader(new ChildStoreManager())
    const target = { directory: "/repo", sessionID: "session-1" }

    await loader.ensure(target, { reason: "selected" })
    await loader.refreshTail(target)

    expect(limits).toEqual([50, 30])
    expect(loader.getSnapshot(target).cursor).toBe("older-cursor")
    expect(loader.getSnapshot(target).complete).toBe(false)
  })

  test("escape hatch restores a 200-message first page and disables prefetch", async () => {
    const limits: number[] = []
    Object.defineProperty(opencodeClient, "getScopedSdkClient", {
      configurable: true,
      value: () => ({
        session: {
          messages: async ({ limit }: { limit: number }) => {
            limits.push(limit)
            return response([message("msg-1", "user")])
          },
        },
      }),
    })
    useFeatureFlagsStore.getState().setSessionFastLoadEnabled(false)
    const loader = new SessionMessageLoader(new ChildStoreManager())
    loader.setActivePrefetchDirectory("/repo")
    const target = { directory: "/repo", sessionID: "session-1" }

    await loader.prefetch(target)
    await loader.ensure(target, { reason: "selected" })

    expect(limits).toEqual([200])
  })

  test("reconciles an echoed optimistic message without duplicating it", async () => {
    const echoed = message("msg-optimistic", "user")
    Object.defineProperty(opencodeClient, "getScopedSdkClient", {
      configurable: true,
      value: () => ({ session: { messages: async () => response([echoed]) } }),
    })
    const stores = new ChildStoreManager()
    const loader = new SessionMessageLoader(stores)
    const target = { directory: "/repo", sessionID: "session-1" }
    loader.optimisticAdd({ ...target, message: echoed, parts: [] })

    await loader.ensure(target, { reason: "selected" })

    expect(loader.hasOptimistic(target)).toBe(false)
    expect(stores.getChild("/repo")?.getState().message["session-1"]).toEqual([echoed])
  })

  test("discarded directory results cannot repopulate a replaced store", async () => {
    let resolveRequest: ((value: ReturnType<typeof response>) => void) | undefined
    Object.defineProperty(opencodeClient, "getScopedSdkClient", {
      configurable: true,
      value: () => ({
        session: {
          messages: () => new Promise<ReturnType<typeof response>>((resolve) => {
            resolveRequest = resolve
          }),
        },
      }),
    })
    const stores = new ChildStoreManager()
    const loader = new SessionMessageLoader(stores)
    const target = { directory: "/repo", sessionID: "session-1" }
    const pending = loader.ensure(target, { reason: "selected" })
    await Promise.resolve()

    loader.invalidateDirectory("/repo")
    stores.disposeDirectory("/repo")
    resolveRequest?.(response([message("msg-1", "user")]))
    await pending

    expect(stores.getChild("/repo")).toBe(undefined)
  })
})
