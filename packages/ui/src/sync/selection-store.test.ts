import { beforeEach, describe, expect, test } from "bun:test"
import { useSelectionStore, type SelectionState } from "./selection-store"

const resetSelectionStore = () => {
  useSelectionStore.setState({
    sessionModelSelections: new Map(),
    sessionAgentSelections: new Map(),
    sessionPlanModeSelections: new Map(),
    defaultPlanModeSelection: false,
    draftPlanModeSelection: false,
    sessionAgentModelSelections: new Map(),
    draftAgentSelections: new Map(),
    draftModelSelections: new Map(),
    draftAgentModelSelections: new Map(),
    draftAgentModelVariantSelections: new Map(),
    lastUsedProvider: null,
  })
}

describe("selection-store plan mode defaults", () => {
  beforeEach(() => {
    resetSelectionStore()
  })

  test("uses the configured default for draft plan mode after clearing draft overrides", () => {
    const store = useSelectionStore.getState() as SelectionState & {
      setDefaultPlanModeSelection: (enabled: boolean) => void
    }

    store.setDefaultPlanModeSelection(true)

    expect(useSelectionStore.getState().getPlanModeSelection(null)).toBe(true)

    useSelectionStore.getState().setDraftPlanMode(false)
    expect(useSelectionStore.getState().getPlanModeSelection(undefined)).toBe(false)

    useSelectionStore.getState().clearDraftPlanMode()
    expect(useSelectionStore.getState().getPlanModeSelection(null)).toBe(true)
  })

  test("clears draft plan mode back to a disabled default", () => {
    const store = useSelectionStore.getState() as SelectionState & {
      setDefaultPlanModeSelection: (enabled: boolean) => void
    }

    store.setDefaultPlanModeSelection(false)
    useSelectionStore.getState().setDraftPlanMode(true)
    expect(useSelectionStore.getState().getPlanModeSelection(null)).toBe(true)

    useSelectionStore.getState().clearDraftPlanMode()
    expect(useSelectionStore.getState().getPlanModeSelection(null)).toBe(false)
  })
})

describe("selection-store agent model selections", () => {
  beforeEach(() => {
    resetSelectionStore()
  })

  test("clears stale per-session model and variant selections for a saved agent default", () => {
    const store = useSelectionStore.getState()

    store.saveAgentModelVariantForSession("session-1", "builder", "anthropic", "claude", "low")
    store.saveAgentModelForSession("session-1", "builder", "anthropic", "claude")
    store.saveAgentModelForSession("session-1", "reviewer", "openai", "gpt-5.5")
    store.saveAgentModelForSession("session-2", "builder", "anthropic", "claude")

    store.clearAgentModelSelections("builder")

    expect(useSelectionStore.getState().getAgentModelForSession("session-1", "builder")).toBe(null)
    expect(useSelectionStore.getState().getAgentModelForSession("session-2", "builder")).toBe(null)
    expect(useSelectionStore.getState().getAgentModelVariantForSession("session-1", "builder", "anthropic", "claude")).toBe(undefined)
    expect(useSelectionStore.getState().getAgentModelForSession("session-1", "reviewer")).toEqual({
      providerId: "openai",
      modelId: "gpt-5.5",
    })
  })

  test("clears every selection owned by one permanently deleted session", () => {
    const targetSession = "session-delete"
    const retainedSession = "session-keep"
    const store = useSelectionStore.getState() as SelectionState & {
      clearSessionSelection?: (sessionId: string) => void
    }

    store.saveSessionModelSelection(targetSession, "openai", "gpt-5.5")
    store.saveSessionAgentSelection(targetSession, "builder")
    store.setSessionPlanMode(targetSession, true)
    store.saveAgentModelForSession(targetSession, "builder", "anthropic", "claude")
    store.saveAgentModelVariantForSession(targetSession, "builder", "anthropic", "claude", "high")

    store.saveSessionModelSelection(retainedSession, "openai", "gpt-5.6")
    store.saveSessionAgentSelection(retainedSession, "reviewer")
    store.setSessionPlanMode(retainedSession, true)
    store.saveAgentModelForSession(retainedSession, "reviewer", "openai", "gpt-5.6")
    store.saveAgentModelVariantForSession(retainedSession, "reviewer", "openai", "gpt-5.6", "medium")

    expect(typeof store.clearSessionSelection).toBe("function")
    store.clearSessionSelection?.(targetSession)

    const next = useSelectionStore.getState()
    expect(next.getSessionModelSelection(targetSession)).toBe(null)
    expect(next.getSessionAgentSelection(targetSession)).toBe(null)
    expect(next.getSessionPlanMode(targetSession)).toBe(false)
    expect(next.getAgentModelForSession(targetSession, "builder")).toBe(null)
    expect(next.getAgentModelVariantForSession(targetSession, "builder", "anthropic", "claude")).toBe(undefined)

    expect(next.getSessionModelSelection(retainedSession)).toEqual({ providerId: "openai", modelId: "gpt-5.6" })
    expect(next.getSessionAgentSelection(retainedSession)).toBe("reviewer")
    expect(next.getSessionPlanMode(retainedSession)).toBe(true)
    expect(next.getAgentModelForSession(retainedSession, "reviewer")).toEqual({ providerId: "openai", modelId: "gpt-5.6" })
    expect(next.getAgentModelVariantForSession(retainedSession, "reviewer", "openai", "gpt-5.6")).toBe("medium")
  })

  test("promotes draft selections into a real session and clears the draft", () => {
    const store = useSelectionStore.getState() as SelectionState & {
      saveDraftAgentSelection?: (draftId: string, agentName: string) => void
      getDraftAgentSelection?: (draftId: string) => string | null
      saveDraftModelSelection?: (draftId: string, providerId: string, modelId: string) => void
      getDraftModelSelection?: (draftId: string) => { providerId: string; modelId: string } | null
      saveDraftAgentModelForSelection?: (draftId: string, agentName: string, providerId: string, modelId: string) => void
      getDraftAgentModelForSelection?: (draftId: string, agentName: string) => { providerId: string; modelId: string } | null
      saveDraftAgentModelVariantForSelection?: (draftId: string, agentName: string, providerId: string, modelId: string, variant: string | undefined) => void
      getDraftAgentModelVariantForSelection?: (draftId: string, agentName: string, providerId: string, modelId: string) => string | undefined
      promoteDraftSelectionToSession?: (draftId: string, sessionId: string) => void
    }

    expect(typeof store.saveDraftAgentSelection).toBe("function")
    expect(typeof store.promoteDraftSelectionToSession).toBe("function")

    store.saveDraftAgentSelection?.("draft-1", "builder")
    store.saveDraftModelSelection?.("draft-1", "openai", "gpt-5.5")
    store.saveDraftAgentModelForSelection?.("draft-1", "builder", "anthropic", "claude")
    store.saveDraftAgentModelVariantForSelection?.("draft-1", "builder", "anthropic", "claude", "high")

    expect(store.getDraftAgentSelection?.("draft-1")).toBe("builder")
    expect(store.getDraftModelSelection?.("draft-1")).toEqual({ providerId: "openai", modelId: "gpt-5.5" })
    expect(store.getDraftAgentModelForSelection?.("draft-1", "builder")).toEqual({ providerId: "anthropic", modelId: "claude" })
    expect(store.getDraftAgentModelVariantForSelection?.("draft-1", "builder", "anthropic", "claude")).toBe("high")

    store.promoteDraftSelectionToSession?.("draft-1", "session-1")

    expect(useSelectionStore.getState().getSessionAgentSelection("session-1")).toBe("builder")
    expect(useSelectionStore.getState().getSessionModelSelection("session-1")).toEqual({ providerId: "openai", modelId: "gpt-5.5" })
    expect(useSelectionStore.getState().getAgentModelForSession("session-1", "builder")).toEqual({ providerId: "anthropic", modelId: "claude" })
    expect(useSelectionStore.getState().getAgentModelVariantForSession("session-1", "builder", "anthropic", "claude")).toBe("high")
    expect(store.getDraftAgentSelection?.("draft-1")).toBe(null)
    expect(store.getDraftModelSelection?.("draft-1")).toBe(null)
  })
})
