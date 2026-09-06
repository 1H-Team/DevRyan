import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Message, TextPart } from "@opencode-ai/sdk/v2/client"
import { opencodeClient } from "@/lib/opencode/client"
import { useFeatureFlagsStore } from "@/stores/useFeatureFlagsStore"
import { ChildStoreManager } from "./child-store"
import { SessionMessageLoader, type SessionMessageTarget } from "./session-message-loader"
import { useSelectionStore } from "./selection-store"
import { captureCurrentSendConfig, resolveSessionSendConfig } from "./send-config"
import { clearSyncRefs, setSyncRefs } from "./sync-refs"

const originalGetScopedSdkClient = opencodeClient.getScopedSdkClient
const maintenance = "[devryan-open-todo-continuation:v1]\nContinue the existing work."
const plan = "User has requested to enter plan mode.\nProduce an implementation plan only."
type PageRequest = { sessionID: string; limit: number; before?: string }
type Record = { info: Message; parts: TextPart[] }
const record = (target: SessionMessageTarget, id: string, text = maintenance): Record => ({
  info: { id, sessionID: target.sessionID, role: "user", time: { created: 1 } } as Message,
  parts: [{ id: `${id}-part`, sessionID: target.sessionID, messageID: id, type: "text", text, synthetic: true }],
})
const response = (data: Record[], cursor?: string) => ({
  data,
  response: { headers: { get: (name: string) => name === "x-next-cursor" ? cursor ?? null : null } },
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe("selected-session Plan history authority", () => {
  const disposals: Array<() => void> = []
  beforeEach(() => useFeatureFlagsStore.getState().setSessionFastLoadEnabled(true))
  afterEach(() => {
    Object.defineProperty(opencodeClient, "getScopedSdkClient", { configurable: true, value: originalGetScopedSdkClient })
    for (const dispose of disposals.splice(0)) dispose()
  })

  const setup = (suffix: string, fetch: (request: PageRequest) => Promise<ReturnType<typeof response>>) => {
    const target = { directory: `/repo/plan-authority-${suffix}`, sessionID: `session-plan-authority-${suffix}` }
    const sdk = originalGetScopedSdkClient.call(opencodeClient, target.directory)
    Object.defineProperty(opencodeClient, "getScopedSdkClient", {
      configurable: true,
      value: () => ({ session: { messages: fetch } }),
    })
    const stores = new ChildStoreManager()
    const loader = new SessionMessageLoader(stores)
    useSelectionStore.getState().clearSessionSelection(target.sessionID)
    setSyncRefs(sdk, stores, target.directory, undefined, loader)
    disposals.push(() => {
      clearSyncRefs(stores)
      useSelectionStore.getState().clearSessionSelection(target.sessionID)
      loader.dispose()
      stores.disposeDirectory(target.directory)
    })
    return { target, stores, loader }
  }
  const maintenancePage = (target: SessionMessageTarget, count: number, prefix = "msg_z") => (
    Array.from({ length: count }, (_, index) => record(target, `${prefix}_${String(index).padStart(4, "0")}`))
  )

  test("promotes and deduplicates an in-flight prefetch using the server's opaque older cursor", async () => {
    const firstPage = deferred<ReturnType<typeof response>>()
    const calls: PageRequest[] = []
    const { target, loader } = setup("inflight", async request => {
      calls.push(request)
      if (!request.before) return firstPage.promise
      expect(request.before).toBe("opaque:older/+?=v1")
      return response([record(target, "msg_a_plan", plan)])
    })
    loader.setActivePrefetchDirectory(target.directory)
    const prefetch = loader.prefetch(target)
    await Promise.resolve()
    const selected = loader.ensure(target, { reason: "selected" })
    const selectedAgain = loader.ensure(target, { reason: "selected" })
    expect(loader.getSnapshot(target).loadingKind).toBe("initial")
    expect(() => captureCurrentSendConfig(target.sessionID)).toThrow("Plan choice is still loading")
    firstPage.resolve(response(maintenancePage(target, 50), "opaque:older/+?=v1"))
    await Promise.all([prefetch, selected, selectedAgain])
    expect(calls.map(({ limit, before }) => ({ limit, before }))).toEqual([
      { limit: 50, before: undefined }, { limit: 200, before: "opaque:older/+?=v1" },
    ])
    expect(loader.getSnapshot(target).planSelectionStatus).toBe("ready")
    expect(captureCurrentSendConfig(target.sessionID).planMode).toBe(true)
  })

  test("retrieval failure blocks new captures, preserves captured OFF, and explicit retry recovers", async () => {
    let fail = true
    let olderCalls = 0
    const { target, loader } = setup("retry", async request => {
      if (!request.before) return response(maintenancePage(target, 50), "opaque:retry")
      olderCalls += 1
      if (fail) throw new Error("fixture page rejected")
      return response([record(target, "msg_a_plan", plan)])
    })
    await loader.ensure(target, { reason: "selected" })
    expect(loader.getSnapshot(target).planSelectionStatus).toBe("error")
    expect(() => captureCurrentSendConfig(target.sessionID)).toThrow("Retry or choose Plan explicitly")
    expect(() => resolveSessionSendConfig(target.sessionID, { providerID: "fixture", modelID: "fixture" })).toThrow("Retry")
    const captured = { providerID: "fixture", modelID: "fixture", planMode: false, variant: null }
    expect(resolveSessionSendConfig(target.sessionID, captured).planMode).toBe(false)
    expect(captured).toEqual({ providerID: "fixture", modelID: "fixture", planMode: false, variant: null })
    fail = false
    await loader.ensure(target, { reason: "selected" })
    expect(olderCalls).toBe(2)
    expect(loader.getSnapshot(target).planSelectionStatus).toBe("ready")
    expect(captureCurrentSendConfig(target.sessionID).planMode).toBe(true)
  })

  for (const noProgress of ["same-cursor", "same-records"] as const) {
    test(`rejects ${noProgress} without silently restoring OFF`, async () => {
      let calls = 0
      const { target, loader } = setup(noProgress, async request => {
        calls += 1
        if (!request.before) return response(maintenancePage(target, 50), "opaque:first")
        const page = noProgress === "same-cursor"
          ? maintenancePage(target, 200, "msg_y")
          : Array.from({ length: 200 }, (_, index) => record(target, `msg_z_${String(index % 50).padStart(4, "0")}`))
        return response(page, noProgress === "same-cursor" ? "opaque:first" : "opaque:second")
      })
      await loader.ensure(target, { reason: "selected" })
      expect(calls).toBe(2)
      expect(loader.getSnapshot(target).planSelectionStatus).toBe("error")
      expect(useSelectionStore.getState().sessionPlanModeSelections.get(target.sessionID)).toBe(undefined)
      expect(() => captureCurrentSendConfig(target.sessionID)).toThrow("Retry")
    })
  }

  test("caps retained authority search at 1,000 records", async () => {
    const calls: PageRequest[] = []
    const { target, stores, loader } = setup("record-cap", async request => {
      calls.push(request)
      return response(maintenancePage(target, request.limit, `msg_${String(100 - calls.length).padStart(3, "0")}`), `opaque:${calls.length}`)
    })
    await loader.ensure(target, { reason: "selected" })
    expect(calls.map(request => request.limit)).toEqual([50, 200, 200, 200, 200, 150])
    expect(stores.getChild(target.directory)?.getState().message[target.sessionID]).toHaveLength(1_000)
    expect(loader.getSnapshot(target).planSelectionStatus).toBe("error")
    expect(() => captureCurrentSendConfig(target.sessionID)).toThrow("Retry")
  })

  test("rejects an oversized authority page before materializing it", async () => {
    const { target, stores, loader } = setup("byte-cap", async request => {
      if (!request.before) return response(maintenancePage(target, 50), "opaque:large")
      return response([record(target, "msg_a_huge", `${plan}${"x".repeat(8 * 1024 * 1024)}`)])
    })
    await loader.ensure(target, { reason: "selected" })
    expect(stores.getChild(target.directory)?.getState().message[target.sessionID]).toHaveLength(50)
    expect(loader.getSnapshot(target).planSelectionStatus).toBe("error")
    expect(() => captureCurrentSendConfig(target.sessionID)).toThrow("Retry")
  })

  test("exhausted maintenance-only history remains unresolved until an explicit local choice", async () => {
    const { target, loader } = setup("exhausted", async () => response([record(target, "msg_wake")]))
    await loader.ensure(target, { reason: "selected" })
    expect(loader.getSnapshot(target).planSelectionStatus).toBe("error")
    expect(() => captureCurrentSendConfig(target.sessionID)).toThrow("Retry")
    useSelectionStore.getState().setSessionPlanMode(target.sessionID, false)
    expect(captureCurrentSendConfig(target.sessionID).planMode).toBe(false)
  })

  test("complete empty history is an authoritative fresh-session OFF choice", async () => {
    const { target, loader } = setup("empty", async () => response([]))
    await loader.ensure(target, { reason: "selected" })
    expect(loader.getSnapshot(target).planSelectionStatus).toBe("ready")
    expect(captureCurrentSendConfig(target.sessionID).planMode).toBe(false)
  })

  for (const oldResult of ["success", "error"] as const) {
  test(`a forced selected reload replaces the older-page owner before its stale ${oldResult}`, async () => {
    const olderPage = deferred<ReturnType<typeof response>>()
    const olderStarted = deferred<void>()
    const forcedStarted = deferred<void>()
    let initialCalls = 0
    const { target, loader } = setup("force", async request => {
      if (!request.before) {
        initialCalls += 1
        if (initialCalls === 1) return response(maintenancePage(target, 50), "opaque:force")
        forcedStarted.resolve()
        return response([record(target, "msg_zz_new_plan", plan)])
      }
      olderStarted.resolve()
      return olderPage.promise
    })
    const selected = loader.ensure(target, { reason: "selected" })
    await olderStarted.promise
    const forced = loader.ensure(target, { reason: "selected", force: true })
    await forcedStarted.promise
    if (oldResult === "success") olderPage.resolve(response([record(target, "msg_a_old_plan", plan)]))
    else olderPage.reject(new Error("stale older page rejected"))
    await Promise.all([selected, forced])
    expect(loader.getSnapshot(target).planSelectionStatus).toBe("ready")
    expect(captureCurrentSendConfig(target.sessionID).planMode).toBe(true)
  })
  }

  for (const invalidation of ["session", "directory", "selection"] as const) {
    test(`discarded ${invalidation} ownership cannot commit history or errors to another selection`, async () => {
      const olderPage = deferred<ReturnType<typeof response>>()
      const olderStarted = deferred<void>()
      const { target, stores, loader } = setup(`cancel-${invalidation}`, async request => {
        if (request.sessionID !== target.sessionID) return response([])
        if (!request.before) return response(maintenancePage(target, 50), "opaque:cancel")
        olderStarted.resolve()
        return olderPage.promise
      })
      const selected = loader.ensure(target, { reason: "selected" })
      await olderStarted.promise
      if (invalidation === "session") loader.invalidateSession(target)
      if (invalidation === "directory") {
        loader.invalidateDirectory(target.directory)
        stores.disposeDirectory(target.directory)
      }
      const other = { ...target, sessionID: `${target.sessionID}-other` }
      await loader.ensure(other, { reason: "selected" })
      olderPage.resolve(response([record(target, "msg_a_old_plan", plan)]))
      await selected
      expect(stores.getChild(target.directory)?.getState().message[target.sessionID]?.some(info => info.id === "msg_a_old_plan")).not.toBe(true)
      expect(useSelectionStore.getState().sessionPlanModeSelections.get(target.sessionID)).toBe(undefined)
      expect(loader.getSnapshot(other).planSelectionStatus).toBe("ready")
      expect(loader.getSnapshot(other).planSelectionError).toBe(null)
      useSelectionStore.getState().clearSessionSelection(other.sessionID)
    })
  }
})
