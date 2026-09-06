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

    // An explicit "off" beats an enabled default and survives restoration.
    useSelectionStore.getState().setDefaultPlanModeSelection(true)
    useSelectionStore.getState().setSessionPlanMode("session-2", true)
    useSelectionStore.getState().setPlanModeSelection(null, false, "draft-b")
    useSelectionStore.getState().promoteDraftSelectionToSession("draft-b", "session-2")
    expect(useSelectionStore.getState().getSessionPlanMode("session-2")).toBe(false)
    useSelectionStore.getState().restoreSessionPlanMode("session-2", true)
    expect(useSelectionStore.getState().getSessionPlanMode("session-2")).toBe(false)

    // An untoggled draft leaves the session untouched.
    useSelectionStore.getState().promoteDraftSelectionToSession("draft-c", "session-3")
    expect(useSelectionStore.getState().getSessionPlanMode("session-3")).toBe(false)
  })
})

describe("selection-store Plan restoration", () => {
  beforeEach(resetSelectionStore)

  test("restores a cold session once without overwriting a later explicit Plan toggle", () => {
    const store = useSelectionStore.getState()
    store.restoreSessionPlanMode("session", true)
    expect(store.getSessionPlanMode("session")).toBe(true)
    store.setSessionPlanMode("session", false)
    const selections = useSelectionStore.getState().sessionPlanModeSelections
    store.restoreSessionPlanMode("session", true)
    expect(store.getSessionPlanMode("session")).toBe(false)
    expect(useSelectionStore.getState().sessionPlanModeSelections).toBe(selections)
    store.restoreSessionPlanMode("other", true)
    expect(store.getSessionPlanMode("other")).toBe(true)
  })

  test("an explicit off before history loads cannot be replaced by the older Plan turn", () => {
    const store = useSelectionStore.getState()
    store.setSessionPlanMode("session", false)
    store.restoreSessionPlanMode("session", true)
    expect(store.getSessionPlanMode("session")).toBe(false)
    store.clearSessionSelection("session")
    store.restoreSessionPlanMode("session", true)
    expect(store.getSessionPlanMode("session")).toBe(true)
  })

  test("refines inferred Plan policy without notifying for an unchanged value", () => {
    const store = useSelectionStore.getState()
    store.restoreSessionPlanMode("session", false)
    const selections = useSelectionStore.getState().sessionPlanModeSelections
    store.restoreSessionPlanMode("session", false)
    expect(useSelectionStore.getState().sessionPlanModeSelections).toBe(selections)
    store.restoreSessionPlanMode("session", true)
    expect(store.getSessionPlanMode("session")).toBe(true)
    store.restoreSessionPlanMode("session", false)
    expect(store.getSessionPlanMode("session")).toBe(false)
  })

  test("explicitly selecting the inferred value protects it from later history", () => {
    const store = useSelectionStore.getState()
    store.restoreSessionPlanMode("session", false)
    const selections = useSelectionStore.getState().sessionPlanModeSelections
    store.setSessionPlanMode("session", false)
    store.restoreSessionPlanMode("session", true)
    expect(store.getSessionPlanMode("session")).toBe(false)
    expect(useSelectionStore.getState().sessionPlanModeSelections).toBe(selections)
  })

  test("promoted explicit draft OFF replaces and retires an inferred session choice", () => {
    const store = useSelectionStore.getState()
    store.restoreSessionPlanMode("session", true)
    store.setDraftPlanMode("draft", false)
    store.promoteDraftSelectionToSession("draft", "session")
    store.restoreSessionPlanMode("session", true)
    expect(store.getSessionPlanMode("session")).toBe(false)
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
  test("promotes explicit provider default and distinguishes clearing from default", () => {
    const store = useSelectionStore.getState()
    store.saveDraftAgentModelVariantForSelection("draft-default", "builder", "openai", "gpt", null)
    expect(store.getDraftAgentModelVariantForSelection("draft-default", "builder", "openai", "gpt")).toBeNull()
    store.promoteDraftSelectionToSession("draft-default", "session-default")
    expect(store.getAgentModelVariantForSession("session-default", "builder", "openai", "gpt")).toBeNull()
    store.saveAgentModelVariantForSession("session-default", "builder", "openai", "gpt", undefined)
    expect(store.getAgentModelVariantForSession("session-default", "builder", "openai", "gpt")).toBeUndefined()
  })

})


describe("selection-store canonical user-choice restoration", () => {
  beforeEach(() => {
    resetSelectionStore()
    for (const session of ["restore-a", "restore-b", "restore-empty"])
      useSelectionStore.getState().clearSessionSelection(session)
  })

  test("keeps each restored canonical choice after another session and a newer unsent effort", () => {
    const store = useSelectionStore.getState()
    store.saveAgentModelVariantForSession("restore-a", "builder", "fixture", "model", null)
    store.markSessionUserChoiceRestored("restore-a", "message-a|default")
    store.saveAgentModelVariantForSession("restore-a", "builder", "fixture", "model", "low")
    store.markSessionUserChoiceRestored("restore-b", "message-b|high")

    expect(store.hasRestoredSessionUserChoice("restore-a", "message-a|default")).toBe(true)
    expect(store.getAgentModelVariantForSession("restore-a", "builder", "fixture", "model")).toBe("low")
    expect(store.hasRestoredSessionUserChoice("restore-a", "message-b|high")).toBe(false)
    expect(store.hasRestoredSessionUserChoice("restore-b", "message-b|high")).toBe(true)
  })

  test("leaves new or refined canonical choices eligible and retains only the last successful key", () => {
    const store = useSelectionStore.getState()
    expect(store.hasRestoredSessionUserChoice("restore-a", "message-a|default")).toBe(false)
    store.markSessionUserChoiceRestored("restore-a", "message-a|default")
    expect(store.hasRestoredSessionUserChoice("restore-a", "message-a|high")).toBe(false)
    expect(store.hasRestoredSessionUserChoice("restore-a", "message-new|default")).toBe(false)
    store.markSessionUserChoiceRestored("restore-a", "message-a|high")
    expect(store.hasRestoredSessionUserChoice("restore-a", "message-a|high")).toBe(true)
    expect(store.hasRestoredSessionUserChoice("restore-a", "message-a|default")).toBe(false)
  })

  test("clears provenance even without other selections and never publishes a render update", () => {
    const state = useSelectionStore.getState()
    let notifications = 0
    const unsubscribe = useSelectionStore.subscribe(() => { notifications += 1 })
    try {
      state.markSessionUserChoiceRestored("restore-empty", "message|default")
      state.markSessionModelSelectionIntent("restore-empty", { providerID: "fixture", modelID: "model", variant: "low" })
      expect(useSelectionStore.getState()).toBe(state)
      state.clearSessionSelection("restore-empty")
      expect(state.hasRestoredSessionUserChoice("restore-empty", "message|default")).toBe(false)
      expect(state.getSessionModelSelectionIntent("restore-empty")).toBeUndefined()
      expect(useSelectionStore.getState()).toBe(state)
      expect(notifications).toBe(0)
    } finally { unsubscribe() }
  })
})
