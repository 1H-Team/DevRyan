import { beforeEach, describe, expect, test } from "bun:test"
import { useSelectionStore, type SelectionState } from "./selection-store"

const resetSelectionStore = () => {
  useSelectionStore.setState({
    sessionModelSelections: new Map(),
    sessionAgentSelections: new Map(),
    builderHandoffClearedSessionIds: new Set(),
    sessionPlanModeSelections: new Map(),
    defaultPlanModeSelection: false,
    draftPlanModeSelections: new Map(),
    sessionAgentModelSelections: new Map(),
    draftAgentSelections: new Map(),
    draftModelSelections: new Map(),
    draftAgentModelSelections: new Map(),
    draftAgentModelVariantSelections: new Map(),
    lastUsedProvider: null,
  })
}

describe("selection-store plan mode per draft", () => {
  beforeEach(() => {
    resetSelectionStore()
  })

  const planModeOf = (draftId: string) => useSelectionStore.getState().getPlanModeSelection(null, draftId)

  test("untoggled drafts fall through to the configured default; clearing a draft restores it", () => {
    useSelectionStore.getState().setDefaultPlanModeSelection(true)

    expect(useSelectionStore.getState().getPlanModeSelection(null)).toBe(true)
    expect(useSelectionStore.getState().getPlanModeSelection(undefined, null)).toBe(true)
    expect(planModeOf("draft-a")).toBe(true)
    expect(useSelectionStore.getState().getDraftPlanMode("draft-b")).toBe(true)

    useSelectionStore.getState().setPlanModeSelection(null, false, "draft-a")
    expect(planModeOf("draft-a")).toBe(false)
    expect(planModeOf("draft-b")).toBe(true)

    useSelectionStore.getState().clearDraftPlanMode("draft-a")
    expect(planModeOf("draft-a")).toBe(true)
  })

  test("two drafts toggle independently", () => {
    useSelectionStore.getState().setPlanModeSelection(null, true, "draft-a")
    useSelectionStore.getState().setPlanModeSelection(null, true, "draft-b")
    useSelectionStore.getState().setPlanModeSelection(null, false, "draft-a")

    expect(planModeOf("draft-a")).toBe(false)
    expect(planModeOf("draft-b")).toBe(true)
    expect(planModeOf("draft-c")).toBe(false)
    expect(useSelectionStore.getState().defaultPlanModeSelection).toBe(false)
  })

  test("sending draft A clears only A's plan mode", () => {
    useSelectionStore.getState().setPlanModeSelection(null, true, "draft-a")
    useSelectionStore.getState().setPlanModeSelection(null, true, "draft-b")

    useSelectionStore.getState().clearDraftPlanMode("draft-a")
    expect(planModeOf("draft-a")).toBe(false)
    expect(planModeOf("draft-b")).toBe(true)

    // Draft disposal drops the entry the same way.
    useSelectionStore.getState().setPlanModeSelection(null, true, "draft-a")
    useSelectionStore.getState().clearDraftSelection("draft-a")
    expect(planModeOf("draft-a")).toBe(false)
    expect(planModeOf("draft-b")).toBe(true)
    expect(useSelectionStore.getState().draftPlanModeSelections.has("draft-a")).toBe(false)
  })

  test("changing the default never overwrites an explicit draft toggle", () => {
    useSelectionStore.getState().setPlanModeSelection(null, false, "draft-a")
    useSelectionStore.getState().setDefaultPlanModeSelection(true)

    expect(planModeOf("draft-a")).toBe(false)
    expect(planModeOf("draft-b")).toBe(true)

    useSelectionStore.getState().setDefaultPlanModeSelection(false)
    expect(planModeOf("draft-a")).toBe(false)
    expect(planModeOf("draft-b")).toBe(false)
  })

  test("without a session or draft the toggle writes the default scope", () => {
    useSelectionStore.getState().setPlanModeSelection(null, true)
    expect(useSelectionStore.getState().getPlanModeSelection(null)).toBe(true)
    expect(useSelectionStore.getState().defaultPlanModeSelection).toBe(true)
    expect(useSelectionStore.getState().draftPlanModeSelections.size).toBe(0)
  })

  test("session scope wins over draft scope", () => {
    useSelectionStore.getState().setPlanModeSelection("session-1", true)
    useSelectionStore.getState().setPlanModeSelection(null, false, "draft-a")

    expect(useSelectionStore.getState().getPlanModeSelection("session-1", "draft-a")).toBe(true)
    expect(useSelectionStore.getState().getPlanModeSelection("session-2", "draft-a")).toBe(false)
  })

  test("promoting a draft copies only an explicit plan-mode toggle onto the session", () => {
    useSelectionStore.getState().setPlanModeSelection(null, true, "draft-a")
    useSelectionStore.getState().promoteDraftSelectionToSession("draft-a", "session-1")
    expect(useSelectionStore.getState().getSessionPlanMode("session-1")).toBe(true)
    expect(useSelectionStore.getState().draftPlanModeSelections.has("draft-a")).toBe(false)

    // An explicit "off" beats an enabled default and clears the session entry.
    useSelectionStore.getState().setDefaultPlanModeSelection(true)
    useSelectionStore.getState().setSessionPlanMode("session-2", true)
    useSelectionStore.getState().setPlanModeSelection(null, false, "draft-b")
    useSelectionStore.getState().promoteDraftSelectionToSession("draft-b", "session-2")
    expect(useSelectionStore.getState().getSessionPlanMode("session-2")).toBe(false)

    // An untoggled draft leaves the session untouched.
    useSelectionStore.getState().promoteDraftSelectionToSession("draft-c", "session-3")
    expect(useSelectionStore.getState().getSessionPlanMode("session-3")).toBe(false)
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
    store.markBuilderHandoffCleared(targetSession)
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
    expect(next.hasBuilderHandoffClearance(targetSession)).toBe(false)
    expect(next.getSessionPlanMode(targetSession)).toBe(false)
    expect(next.getAgentModelForSession(targetSession, "builder")).toBe(null)
    expect(next.getAgentModelVariantForSession(targetSession, "builder", "anthropic", "claude")).toBe(undefined)

    expect(next.getSessionModelSelection(retainedSession)).toEqual({ providerId: "openai", modelId: "gpt-5.6" })
    expect(next.getSessionAgentSelection(retainedSession)).toBe("reviewer")
    expect(next.getSessionPlanMode(retainedSession)).toBe(true)
    expect(next.getAgentModelForSession(retainedSession, "reviewer")).toEqual({ providerId: "openai", modelId: "gpt-5.6" })
    expect(next.getAgentModelVariantForSession(retainedSession, "reviewer", "openai", "gpt-5.6")).toBe("medium")
  })

  test("retains explicit Builder clearance until the session leaves Builder mode", () => {
    const store = useSelectionStore.getState()

    store.markBuilderHandoffCleared("session-builder")
    store.saveSessionAgentSelection("session-builder", "Builder")

    expect(useSelectionStore.getState().hasBuilderHandoffClearance("session-builder")).toBe(true)

    store.saveSessionAgentSelection("session-builder", "Orchestrator")

    expect(useSelectionStore.getState().hasBuilderHandoffClearance("session-builder")).toBe(false)
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
