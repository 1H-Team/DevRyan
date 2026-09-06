/**
 * Selection Store — per-session model, agent, and variant selections.
 * Extracted from session-ui-store for subscription isolation.
 */

import { create } from "zustand"

type SessionModelSelectionIntent = Readonly<{
  providerID: string
  modelID: string
  agent?: string
  variant?: string | null
}>

export type SelectionState = {
  sessionModelSelections: Map<string, { providerId: string; modelId: string }>
  sessionAgentSelections: Map<string, string>
  builderHandoffClearedSessionIds: Set<string>
  sessionPlanModeSelections: Map<string, boolean>
  defaultPlanModeSelection: boolean
  /** Explicit per-draft plan-mode toggles; a draft without an entry falls through to the default. */
  draftPlanModeSelections: Map<string, boolean>
  sessionAgentModelSelections: Map<string, Map<string, { providerId: string; modelId: string }>>
  draftModelSelections: Map<string, { providerId: string; modelId: string }>
  draftAgentSelections: Map<string, string>
  draftAgentModelSelections: Map<string, Map<string, { providerId: string; modelId: string }>>
  draftAgentModelVariantSelections: Map<string, Map<string, Map<string, string | null>>>
  lastUsedProvider: { providerID: string; modelID: string } | null

  hasRestoredSessionUserChoice: (sessionId: string, choiceKey: string) => boolean
  markSessionUserChoiceRestored: (sessionId: string, choiceKey: string) => void
  markSessionModelSelectionIntent: (sessionId: string, choice: SessionModelSelectionIntent) => void
  getSessionModelSelectionIntent: (sessionId: string) => SessionModelSelectionIntent | undefined
  consumeSessionModelSelectionIntent: (sessionId: string, expected: SessionModelSelectionIntent | undefined, sent: SessionModelSelectionIntent) => void
  saveSessionModelSelection: (sessionId: string, providerId: string, modelId: string) => void
  getSessionModelSelection: (sessionId: string) => { providerId: string; modelId: string } | null
  saveSessionAgentSelection: (sessionId: string, agentName: string) => void
  getSessionAgentSelection: (sessionId: string) => string | null
  markBuilderHandoffCleared: (sessionId: string) => void
  hasBuilderHandoffClearance: (sessionId: string) => boolean
  setSessionPlanMode: (sessionId: string, enabled: boolean) => void
  restoreSessionPlanMode: (sessionId: string, enabled: boolean) => void
  hasExplicitSessionPlanMode: (sessionId: string) => boolean
  getSessionPlanMode: (sessionId: string) => boolean
  setDefaultPlanModeSelection: (enabled: boolean) => void
  setDraftPlanMode: (draftId: string, enabled: boolean) => void
  getDraftPlanMode: (draftId: string) => boolean
  clearDraftPlanMode: (draftId: string) => void
  /** Writes the matching scope: the session when given, else the draft when given, else the default. */
  setPlanModeSelection: (sessionId: string | null | undefined, enabled: boolean, draftId?: string | null) => void
  /** Resolves session map → draft map → default. */
  getPlanModeSelection: (sessionId: string | null | undefined, draftId?: string | null) => boolean
  saveAgentModelForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => void
  getAgentModelForSession: (sessionId: string, agentName: string) => { providerId: string; modelId: string } | null
  saveAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string, variant: string | null | undefined) => void
  getAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => string | null | undefined
  saveDraftModelSelection: (draftId: string, providerId: string, modelId: string) => void
  getDraftModelSelection: (draftId: string) => { providerId: string; modelId: string } | null
  saveDraftAgentSelection: (draftId: string, agentName: string) => void
  getDraftAgentSelection: (draftId: string) => string | null
  saveDraftAgentModelForSelection: (draftId: string, agentName: string, providerId: string, modelId: string) => void
  getDraftAgentModelForSelection: (draftId: string, agentName: string) => { providerId: string; modelId: string } | null
  saveDraftAgentModelVariantForSelection: (draftId: string, agentName: string, providerId: string, modelId: string, variant: string | null | undefined) => void
  getDraftAgentModelVariantForSelection: (draftId: string, agentName: string, providerId: string, modelId: string) => string | null | undefined
  clearDraftSelection: (draftId: string) => void
  clearSessionSelection: (sessionId: string) => void
  promoteDraftSelectionToSession: (draftId: string, sessionId: string) => void
  clearAgentModelSelections: (agentName: string) => void
}

// In-memory variant storage (not persisted)
const agentModelVariantSelections = new Map<string, Map<string, Map<string, string | null>>>()

// Last successfully restored canonical choice, scoped to the same lifetime as
// in-memory session selections. It has no reactive consumers.
const restoredSessionUserChoices = new Map<string, string>()
// An inferred Plan value may be refined as canonical history arrives. Explicit
// choices remove this marker even when selecting the already displayed value.
const restoredSessionPlanModes = new Map<string, boolean>()
// Explicit composer choices outlive hydration and remounts, until a matching
// local send succeeds. Object identity protects a newer pick during transport.
const sessionModelSelectionIntents = new Map<string, SessionModelSelectionIntent>()

export const useSelectionStore = create<SelectionState>()((set, get) => ({
  sessionModelSelections: new Map(),
  sessionAgentSelections: new Map(),
  builderHandoffClearedSessionIds: new Set(),
  sessionPlanModeSelections: new Map(),
  defaultPlanModeSelection: false,
  draftPlanModeSelections: new Map(),
  sessionAgentModelSelections: new Map(),
  draftModelSelections: new Map(),
  draftAgentSelections: new Map(),
  draftAgentModelSelections: new Map(),
  draftAgentModelVariantSelections: new Map(),
  lastUsedProvider: null,

  hasRestoredSessionUserChoice: (sessionId, choiceKey) =>
    restoredSessionUserChoices.get(sessionId) === choiceKey,

  markSessionUserChoiceRestored: (sessionId, choiceKey) => {
    restoredSessionUserChoices.set(sessionId, choiceKey)
  },

  markSessionModelSelectionIntent: (sessionId, choice) => {
    sessionModelSelectionIntents.set(sessionId, { ...choice })
  },

  getSessionModelSelectionIntent: (sessionId) => sessionModelSelectionIntents.get(sessionId),

  consumeSessionModelSelectionIntent: (sessionId, expected, sent) => {
    if (!expected || sessionModelSelectionIntents.get(sessionId) !== expected) return
    if (expected.providerID !== sent.providerID || expected.modelID !== sent.modelID
      || expected.agent !== sent.agent || (expected.variant ?? null) !== (sent.variant ?? null)) return
    sessionModelSelectionIntents.delete(sessionId)
  },

  saveSessionModelSelection: (sessionId, providerId, modelId) =>
    set((s) => {
      const map = new Map(s.sessionModelSelections)
      map.set(sessionId, { providerId, modelId })
      return { sessionModelSelections: map, lastUsedProvider: { providerID: providerId, modelID: modelId } }
    }),

  getSessionModelSelection: (sessionId) => get().sessionModelSelections.get(sessionId) ?? null,

  saveSessionAgentSelection: (sessionId, agentName) =>
    set((s) => {
      const normalizedAgentName = agentName.trim().toLowerCase()
      const clearsBuilderHandoff = normalizedAgentName !== "builder"
        && s.builderHandoffClearedSessionIds.has(sessionId)
      if (s.sessionAgentSelections.get(sessionId) === agentName && !clearsBuilderHandoff) return s
      const map = new Map(s.sessionAgentSelections)
      map.set(sessionId, agentName)
      if (!clearsBuilderHandoff) return { sessionAgentSelections: map }
      const builderHandoffClearedSessionIds = new Set(s.builderHandoffClearedSessionIds)
      builderHandoffClearedSessionIds.delete(sessionId)
      return { sessionAgentSelections: map, builderHandoffClearedSessionIds }
    }),

  getSessionAgentSelection: (sessionId) => get().sessionAgentSelections.get(sessionId) ?? null,

  markBuilderHandoffCleared: (sessionId) =>
    set((s) => {
      const normalizedSessionId = sessionId.trim()
      if (!normalizedSessionId || s.builderHandoffClearedSessionIds.has(normalizedSessionId)) return s
      const builderHandoffClearedSessionIds = new Set(s.builderHandoffClearedSessionIds)
      builderHandoffClearedSessionIds.add(normalizedSessionId)
      return { builderHandoffClearedSessionIds }
    }),

  hasBuilderHandoffClearance: (sessionId) => (
    get().builderHandoffClearedSessionIds.has(sessionId.trim())
  ),

  setSessionPlanMode: (sessionId, enabled) => {
    restoredSessionPlanModes.delete(sessionId)
    set((s) => {
      if (s.sessionPlanModeSelections.get(sessionId) === enabled) return s
      const map = new Map(s.sessionPlanModeSelections)
      map.set(sessionId, enabled)
      return { sessionPlanModeSelections: map }
    })
  },

  restoreSessionPlanMode: (sessionId, enabled) =>
    set((s) => {
      // An explicit toggle, including off, wins over historical restoration.
      const current = s.sessionPlanModeSelections.get(sessionId)
      if (current !== undefined && restoredSessionPlanModes.get(sessionId) !== current) return s
      restoredSessionPlanModes.set(sessionId, enabled)
      if (current === enabled) return s
      const sessionPlanModeSelections = new Map(s.sessionPlanModeSelections)
      sessionPlanModeSelections.set(sessionId, enabled)
      return { sessionPlanModeSelections }
    }),

  getSessionPlanMode: (sessionId) => get().sessionPlanModeSelections.get(sessionId) ?? false,

  hasExplicitSessionPlanMode: (sessionId) => {
    const value = get().sessionPlanModeSelections.get(sessionId)
    return value !== undefined && restoredSessionPlanModes.get(sessionId) !== value
  },

  // Plan mode is scoped like model and agent selections: one entry per
  // session, one per draft. A draft that was never toggled follows the
  // default, so changing the default never overwrites an explicit toggle and
  // sending one draft never touches another draft's choice.
  setDefaultPlanModeSelection: (enabled) =>
    set((s) => (s.defaultPlanModeSelection === enabled ? s : { defaultPlanModeSelection: enabled })),

  setDraftPlanMode: (draftId, enabled) =>
    set((s) => {
      if (s.draftPlanModeSelections.get(draftId) === enabled) return s
      const map = new Map(s.draftPlanModeSelections)
      map.set(draftId, enabled)
      return { draftPlanModeSelections: map }
    }),

  getDraftPlanMode: (draftId) => get().draftPlanModeSelections.get(draftId) ?? get().defaultPlanModeSelection,

  clearDraftPlanMode: (draftId) =>
    set((s) => {
      if (!s.draftPlanModeSelections.has(draftId)) return s
      const map = new Map(s.draftPlanModeSelections)
      map.delete(draftId)
      return { draftPlanModeSelections: map }
    }),

  setPlanModeSelection: (sessionId, enabled, draftId) => {
    if (sessionId) {
      get().setSessionPlanMode(sessionId, enabled)
      return
    }
    if (draftId) {
      get().setDraftPlanMode(draftId, enabled)
      return
    }
    // Neither a session nor a draft to scope the toggle to: the only
    // remaining scope is the default that untoggled drafts fall through to.
    get().setDefaultPlanModeSelection(enabled)
  },

  getPlanModeSelection: (sessionId, draftId) => {
    if (sessionId) return get().getSessionPlanMode(sessionId)
    if (draftId) return get().getDraftPlanMode(draftId)
    return get().defaultPlanModeSelection
  },

  saveAgentModelForSession: (sessionId, agentName, providerId, modelId) =>
    set((s) => {
      const existing = s.sessionAgentModelSelections.get(sessionId)?.get(agentName)
      if (existing?.providerId === providerId && existing?.modelId === modelId) return s
      const outer = new Map(s.sessionAgentModelSelections)
      const inner = new Map(outer.get(sessionId) ?? new Map())
      inner.set(agentName, { providerId, modelId })
      outer.set(sessionId, inner)
      return { sessionAgentModelSelections: outer }
    }),

  getAgentModelForSession: (sessionId, agentName) =>
    get().sessionAgentModelSelections.get(sessionId)?.get(agentName) ?? null,

  saveAgentModelVariantForSession: (sessionId, agentName, providerId, modelId, variant) => {
    const key = `${providerId}/${modelId}`
    let agentMap = agentModelVariantSelections.get(sessionId)
    if (!agentMap && variant !== undefined) {
      agentMap = new Map()
      agentModelVariantSelections.set(sessionId, agentMap)
    }
    if (!agentMap) return
    let modelMap = agentMap.get(agentName)
    if (!modelMap && variant !== undefined) {
      modelMap = new Map()
      agentMap.set(agentName, modelMap)
    }
    if (!modelMap) return

    if (variant === undefined) {
      modelMap.delete(key)
      if (modelMap.size === 0) {
        agentMap.delete(agentName)
      }
      if (agentMap.size === 0) {
        agentModelVariantSelections.delete(sessionId)
      }
      return
    }

    modelMap.set(key, variant)
  },

  getAgentModelVariantForSession: (sessionId, agentName, providerId, modelId) => {
    const key = `${providerId}/${modelId}`
    return agentModelVariantSelections.get(sessionId)?.get(agentName)?.get(key)
  },

  saveDraftModelSelection: (draftId, providerId, modelId) =>
    set((s) => {
      const existing = s.draftModelSelections.get(draftId)
      if (existing?.providerId === providerId && existing?.modelId === modelId) return s
      const map = new Map(s.draftModelSelections)
      map.set(draftId, { providerId, modelId })
      return { draftModelSelections: map }
    }),

  getDraftModelSelection: (draftId) => get().draftModelSelections.get(draftId) ?? null,

  saveDraftAgentSelection: (draftId, agentName) =>
    set((s) => {
      if (s.draftAgentSelections.get(draftId) === agentName) return s
      const map = new Map(s.draftAgentSelections)
      map.set(draftId, agentName)
      return { draftAgentSelections: map }
    }),

  getDraftAgentSelection: (draftId) => get().draftAgentSelections.get(draftId) ?? null,

  saveDraftAgentModelForSelection: (draftId, agentName, providerId, modelId) =>
    set((s) => {
      const existing = s.draftAgentModelSelections.get(draftId)?.get(agentName)
      if (existing?.providerId === providerId && existing?.modelId === modelId) return s
      const outer = new Map(s.draftAgentModelSelections)
      const inner = new Map(outer.get(draftId) ?? new Map())
      inner.set(agentName, { providerId, modelId })
      outer.set(draftId, inner)
      return { draftAgentModelSelections: outer }
    }),

  getDraftAgentModelForSelection: (draftId, agentName) =>
    get().draftAgentModelSelections.get(draftId)?.get(agentName) ?? null,

  saveDraftAgentModelVariantForSelection: (draftId, agentName, providerId, modelId, variant) =>
    set((s) => {
      const key = `${providerId}/${modelId}`
      const existingDraftMap = s.draftAgentModelVariantSelections.get(draftId)
      const existingAgentMap = existingDraftMap?.get(agentName)
      const existing = existingAgentMap?.get(key)
      if (existing === variant) return s

      const outer = new Map(s.draftAgentModelVariantSelections)
      const draftMap = new Map(outer.get(draftId) ?? new Map())
      const agentMap = new Map(draftMap.get(agentName) ?? new Map())

      if (variant === undefined) {
        agentMap.delete(key)
      } else {
        agentMap.set(key, variant)
      }

      if (agentMap.size > 0) {
        draftMap.set(agentName, agentMap)
      } else {
        draftMap.delete(agentName)
      }

      if (draftMap.size > 0) {
        outer.set(draftId, draftMap)
      } else {
        outer.delete(draftId)
      }

      return { draftAgentModelVariantSelections: outer }
    }),

  getDraftAgentModelVariantForSelection: (draftId, agentName, providerId, modelId) => {
    const key = `${providerId}/${modelId}`
    return get().draftAgentModelVariantSelections.get(draftId)?.get(agentName)?.get(key)
  },

  clearDraftSelection: (draftId) =>
    set((s) => {
      const hasDraft =
        s.draftModelSelections.has(draftId)
        || s.draftAgentSelections.has(draftId)
        || s.draftAgentModelSelections.has(draftId)
        || s.draftAgentModelVariantSelections.has(draftId)
        || s.draftPlanModeSelections.has(draftId)
      if (!hasDraft) return s

      const draftModelSelections = new Map(s.draftModelSelections)
      const draftAgentSelections = new Map(s.draftAgentSelections)
      const draftAgentModelSelections = new Map(s.draftAgentModelSelections)
      const draftAgentModelVariantSelections = new Map(s.draftAgentModelVariantSelections)
      const draftPlanModeSelections = new Map(s.draftPlanModeSelections)
      draftModelSelections.delete(draftId)
      draftAgentSelections.delete(draftId)
      draftAgentModelSelections.delete(draftId)
      draftAgentModelVariantSelections.delete(draftId)
      draftPlanModeSelections.delete(draftId)
      return {
        draftModelSelections,
        draftAgentSelections,
        draftAgentModelSelections,
        draftAgentModelVariantSelections,
        draftPlanModeSelections,
      }
    }),

  clearSessionSelection: (sessionId) => {
    const normalizedSessionId = sessionId.trim()
    if (!normalizedSessionId) return

    agentModelVariantSelections.delete(normalizedSessionId)
    restoredSessionUserChoices.delete(normalizedSessionId)
    restoredSessionPlanModes.delete(normalizedSessionId)
    sessionModelSelectionIntents.delete(normalizedSessionId)
    set((s) => {
      const hasModel = s.sessionModelSelections.has(normalizedSessionId)
      const hasAgent = s.sessionAgentSelections.has(normalizedSessionId)
      const hasBuilderHandoffClearance = s.builderHandoffClearedSessionIds.has(normalizedSessionId)
      const hasPlanMode = s.sessionPlanModeSelections.has(normalizedSessionId)
      const hasAgentModels = s.sessionAgentModelSelections.has(normalizedSessionId)
      if (!hasModel && !hasAgent && !hasBuilderHandoffClearance && !hasPlanMode && !hasAgentModels) return s

      const sessionModelSelections = hasModel
        ? new Map(s.sessionModelSelections)
        : s.sessionModelSelections
      const sessionAgentSelections = hasAgent
        ? new Map(s.sessionAgentSelections)
        : s.sessionAgentSelections
      const sessionPlanModeSelections = hasPlanMode
        ? new Map(s.sessionPlanModeSelections)
        : s.sessionPlanModeSelections
      const builderHandoffClearedSessionIds = hasBuilderHandoffClearance
        ? new Set(s.builderHandoffClearedSessionIds)
        : s.builderHandoffClearedSessionIds
      const sessionAgentModelSelections = hasAgentModels
        ? new Map(s.sessionAgentModelSelections)
        : s.sessionAgentModelSelections

      sessionModelSelections.delete(normalizedSessionId)
      sessionAgentSelections.delete(normalizedSessionId)
      builderHandoffClearedSessionIds.delete(normalizedSessionId)
      sessionPlanModeSelections.delete(normalizedSessionId)
      sessionAgentModelSelections.delete(normalizedSessionId)

      return {
        sessionModelSelections,
        sessionAgentSelections,
        builderHandoffClearedSessionIds,
        sessionPlanModeSelections,
        sessionAgentModelSelections,
      }
    })
  },

  promoteDraftSelectionToSession: (draftId, sessionId) =>
    set((s) => {
      const draftAgent = s.draftAgentSelections.get(draftId)
      const draftModel = s.draftModelSelections.get(draftId)
      const draftAgentModels = s.draftAgentModelSelections.get(draftId)
      const draftAgentVariants = s.draftAgentModelVariantSelections.get(draftId)
      const draftPlanMode = s.draftPlanModeSelections.get(draftId)
      if (!draftAgent && !draftModel && !draftAgentModels && !draftAgentVariants && draftPlanMode === undefined) return s

      const sessionAgentSelections = new Map(s.sessionAgentSelections)
      const sessionModelSelections = new Map(s.sessionModelSelections)
      const sessionAgentModelSelections = new Map(s.sessionAgentModelSelections)
      const sessionPlanModeSelections = new Map(s.sessionPlanModeSelections)
      const draftModelSelections = new Map(s.draftModelSelections)
      const draftAgentSelections = new Map(s.draftAgentSelections)
      const draftAgentModelSelections = new Map(s.draftAgentModelSelections)
      const draftAgentModelVariantSelections = new Map(s.draftAgentModelVariantSelections)
      const draftPlanModeSelections = new Map(s.draftPlanModeSelections)

      if (draftAgent) {
        sessionAgentSelections.set(sessionId, draftAgent)
      }
      if (draftModel) {
        sessionModelSelections.set(sessionId, draftModel)
      }
      if (draftAgentModels) {
        sessionAgentModelSelections.set(sessionId, new Map(draftAgentModels))
      }
      // Preserve explicit off too, so hydration cannot undo a draft choice.
      if (draftPlanMode !== undefined) {
        restoredSessionPlanModes.delete(sessionId)
        sessionPlanModeSelections.set(sessionId, draftPlanMode)
      }
      if (draftAgentVariants) {
        let sessionVariantMap = agentModelVariantSelections.get(sessionId)
        if (!sessionVariantMap) {
          sessionVariantMap = new Map()
          agentModelVariantSelections.set(sessionId, sessionVariantMap)
        }
        for (const [agentName, modelMap] of draftAgentVariants.entries()) {
          sessionVariantMap.set(agentName, new Map(modelMap))
        }
      }

      draftModelSelections.delete(draftId)
      draftAgentSelections.delete(draftId)
      draftAgentModelSelections.delete(draftId)
      draftAgentModelVariantSelections.delete(draftId)
      draftPlanModeSelections.delete(draftId)

      return {
        sessionAgentSelections,
        sessionModelSelections,
        sessionAgentModelSelections,
        sessionPlanModeSelections,
        draftModelSelections,
        draftAgentSelections,
        draftAgentModelSelections,
        draftAgentModelVariantSelections,
        draftPlanModeSelections,
        lastUsedProvider: draftModel ? { providerID: draftModel.providerId, modelID: draftModel.modelId } : s.lastUsedProvider,
      }
    }),

  clearAgentModelSelections: (agentName) => {
    const normalizedAgentName = agentName.trim()
    if (!normalizedAgentName) return

    for (const [sessionId, agentMap] of agentModelVariantSelections.entries()) {
      agentMap.delete(normalizedAgentName)
      if (agentMap.size === 0) {
        agentModelVariantSelections.delete(sessionId)
      }
    }

    set((s) => {
      let changed = false
      const outer = new Map<string, Map<string, { providerId: string; modelId: string }>>()

      for (const [sessionId, agentMap] of s.sessionAgentModelSelections.entries()) {
        if (!agentMap.has(normalizedAgentName)) {
          outer.set(sessionId, agentMap)
          continue
        }

        changed = true
        const nextAgentMap = new Map(agentMap)
        nextAgentMap.delete(normalizedAgentName)
        if (nextAgentMap.size > 0) {
          outer.set(sessionId, nextAgentMap)
        }
      }

      if (!changed) return s
      return { sessionAgentModelSelections: outer }
    })
  },
}))
