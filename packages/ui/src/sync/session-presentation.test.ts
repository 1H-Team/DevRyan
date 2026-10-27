import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  hydrateSessionPresentations,
  isAssistantFinalizing,
  useSessionPresentationStore,
  type SessionPresentationEnvelope,
} from "./session-presentation"

const directory = "/repo"
const sessionID = "session"
const originalFetch = globalThis.fetch
const envelope = (revision = 1, generation = "generation"): SessionPresentationEnvelope => ({
  presentationEpoch: "epoch",
  presentationRevision: revision,
  presentation: { provider: "native", phase: "finalizing", generation,
    objectiveID: "user", assistantID: "assistant", stepID: "step", attemptID: "attempt", progress: 1 },
})
const read = () => useSessionPresentationStore.getState().directories[directory]?.[sessionID]
const accept = (value: unknown) => useSessionPresentationStore.getState().accept(directory, sessionID, value)
const hydrate = (isCurrent = () => true, isBusy = () => true) => hydrateSessionPresentations({
  directory, baseURL: "http://fixture.invalid/api", sessionIDs: [sessionID], isCurrent, isBusy,
})

beforeEach(() => useSessionPresentationStore.setState({ directories: {} }))
afterEach(() => { globalThis.fetch = originalFetch })

describe("owned session presentation", () => {
  test("busy physical model/tool activity alone never creates Finalizing", () => {
    expect(isAssistantFinalizing(undefined, "busy", "user")).toBe(false)
    expect(isAssistantFinalizing(null, "busy", "user")).toBe(false)
    accept({ type: "busy", phase: "busy" })
    expect(read()).toBeUndefined()
  })

  test("requires exact current objective and busy authority", () => {
    accept(envelope())
    expect(isAssistantFinalizing(read(), "busy", "user")).toBe(true)
    for (const status of [undefined, "idle", "retry"]) {
      expect(isAssistantFinalizing(read(), status, "user")).toBe(false)
    }
    expect(isAssistantFinalizing(read(), "busy", "new-optimistic-user")).toBe(false)
    expect(isAssistantFinalizing(read(), "busy", undefined)).toBe(false)
  })

  test("rejects stale fences/revisions and preserves unrelated references", () => {
    accept(envelope(5, "new-generation"))
    const current = read()
    accept(envelope(4, "old-generation"))
    accept(envelope(5, "old-generation"))
    accept({ ...envelope(100), presentationEpoch: "old-epoch" })
    expect(read()).toBe(current)
    useSessionPresentationStore.getState().accept(directory, "other", envelope(6))
    expect(read()).toBe(current)
  })

  test("validates native step/attempt and allows the explicit Cursor contract", () => {
    const value = envelope()
    accept({ ...value, presentation: { ...value.presentation, stepID: null } })
    expect(read()).toBeUndefined()
    accept({ ...value, presentation: { ...value.presentation, provider: "cursor", stepID: null, attemptID: null } })
    expect(read()?.presentation?.provider).toBe("cursor")
  })

  test("clear retains revision fence; repeated clears are no-ops; disposal releases scope", () => {
    accept(envelope(5))
    useSessionPresentationStore.getState().clear(directory, sessionID)
    const cleared = read()
    expect(cleared?.presentation).toBeNull()
    accept(envelope(4))
    accept(envelope(5))
    useSessionPresentationStore.getState().clear(directory, sessionID)
    expect(read()).toBe(cleared)
    useSessionPresentationStore.getState().removeSession(directory, sessionID)
    expect(read()).toBeUndefined()
    useSessionPresentationStore.getState().clearDirectory(directory)
    expect(useSessionPresentationStore.getState().directories[directory]).toBeUndefined()
  })

  test("bounds long-lived directory entries while retaining the newest observation", () => {
    accept(envelope())
    const current = read()
    const store = useSessionPresentationStore.getState()
    for (let index = 0; index < 300; index++) store.clear(directory, `old-${index}`)
    expect(Object.keys(useSessionPresentationStore.getState().directories[directory])).toHaveLength(256)
    expect(read()).toBe(current)
  })
})

describe("presentation snapshot recovery", () => {
  test("hydrates the matching busy session without establishing activity authority", async () => {
    globalThis.fetch = async () => Response.json({ [sessionID]: envelope() })
    await hydrate()
    expect(isAssistantFinalizing(read(), "busy", "user")).toBe(true)
    expect(isAssistantFinalizing(read(), "idle", "user")).toBe(false)
  })

  test("live updates and idle/new-turn clears beat an older in-flight snapshot", async () => {
    for (const action of ["live", "idle", "new-turn"] as const) {
      useSessionPresentationStore.setState({ directories: {} })
      let release!: (response: Response) => void
      globalThis.fetch = () => new Promise(resolve => { release = resolve })
      const request = hydrate()
      if (action === "live") accept({ ...envelope(2), presentation: null })
      else useSessionPresentationStore.getState().clear(directory, sessionID)
      const current = read()
      release(Response.json({ [sessionID]: envelope(1) }))
      await request
      expect(read()).toBe(current)
      expect(isAssistantFinalizing(read(), "busy", "user")).toBe(false)
    }
  })

  test("a fenced snapshot can replace a retired server epoch", async () => {
    accept(envelope(10))
    globalThis.fetch = async () => Response.json({ [sessionID]: { ...envelope(), presentationEpoch: "new-epoch" } })
    await hydrate()
    expect(read()?.presentationEpoch).toBe("new-epoch")
    accept(envelope(100))
    expect(read()?.presentationEpoch).toBe("new-epoch")
  })

  test("scope retirement/deletion blocks stale hydration; idle and missing phases clear copy", async () => {
    accept(envelope())
    globalThis.fetch = async () => Response.json({ [sessionID]: envelope(2) })
    await hydrate(() => false)
    expect(read()?.presentationRevision).toBe(1)
    await hydrate(() => true, () => false)
    expect(read()?.presentation).toBeNull()
    accept(envelope(3))
    globalThis.fetch = async () => Response.json({})
    await hydrate()
    expect(read()?.presentation).toBeNull()
  })
})
