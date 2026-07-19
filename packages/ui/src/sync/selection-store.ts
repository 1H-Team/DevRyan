/**
 * Selection Store — per-session model, agent, and variant selections.
 * Extracted from session-ui-store for subscription isolation.
 */

import { create } from "zustand"

export type SelectionState = {
  sessionModelSelections: Map<string, { providerId: string; modelId: string }>
  sessionAgentSelections: Map<string, string>
  sessionPlanModeSelections: Map<string, boolean>
  defaultPlanModeSelection: boolean
  draftPlanModeSelection: boolean
  sessionAgentModelSelections: Map<string, Map<string, { providerId: string; modelId: string }>>
  draftModelSelections: Map<string, { providerId: string; modelId: string }>
  draftAgentSelections: Map<string, string>
  draftAgentModelSelections: Map<string, Map<string, { providerId: string; modelId: string }>>
  draftAgentModelVariantSelections: Map<string, Map<string, Map<string, string>>>
  lastUsedProvider: { providerID: string; modelID: string } | null

  saveSessionModelSelection: (sessionId: string, providerId: string, modelId: string) => void
  getSessionModelSelection: (sessionId: string) => { providerId: string; modelId: string } | null
  saveSessionAgentSelection: (sessionId: string, agentName: string) => void
  getSessionAgentSelection: (sessionId: string) => string | null
  setSessionPlanMode: (sessionId: string, enabled: boolean) => void
  getSessionPlanMode: (sessionId: string) => boolean
  setDefaultPlanModeSelection: (enabled: boolean, options?: { syncDraft?: boolean }) => void
  setDraftPlanMode: (enabled: boolean) => void
  clearDraftPlanMode: () => void
  setPlanModeSelection: (sessionId: string | null | undefined, enabled: boolean) => void
  getPlanModeSelection: (sessionId: string | null | undefined) => boolean
  saveAgentModelForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => void
  getAgentModelForSession: (sessionId: string, agentName: string) => { providerId: string; modelId: string } | null
  saveAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string, variant: string | undefined) => void
  getAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => string | undefined
  saveDraftModelSelection: (draftId: string, providerId: string, modelId: string) => void
  getDraftModelSelection: (draftId: string) => { providerId: string; modelId: string } | null
  saveDraftAgentSelection: (draftId: string, agentName: string) => void
  getDraftAgentSelection: (draftId: string) => string | null
  saveDraftAgentModelForSelection: (draftId: string, agentName: string, providerId: string, modelId: string) => void
  getDraftAgentModelForSelection: (draftId: string, agentName: string) => { providerId: string; modelId: string } | null
  saveDraftAgentModelVariantForSelection: (draftId: string, agentName: string, providerId: string, modelId: string, variant: string | undefined) => void
  getDraftAgentModelVariantForSelection: (draftId: string, agentName: string, providerId: string, modelId: string) => string | undefined
  clearDraftSelection: (draftId: string) => void
  clearSessionSelection: (sessionId: string) => void
  promoteDraftSelectionToSession: (draftId: string, sessionId: string) => void
  clearAgentModelSelections: (agentName: string) => void
}

// In-memory variant storage (not persisted)
const agentModelVariantSelections = new Map<string, Map<string, Map<string, string>>>()

export const useSelectionStore = create<SelectionState>()((set, get) => ({
  sessionModelSelections: new Map(),
  sessionAgentSelections: new Map(),
  sessionPlanModeSelections: new Map(),
  defaultPlanModeSelection: false,
  draftPlanModeSelection: false,
  sessionAgentModelSelections: new Map(),
  draftModelSelections: new Map(),
  draftAgentSelections: new Map(),
  draftAgentModelSelections: new Map(),
  draftAgentModelVariantSelections: new Map(),
  lastUsedProvider: null,

  saveSessionModelSelection: (sessionId, providerId, modelId) =>
    set((s) => {
      const map = new Map(s.sessionModelSelections)
      map.set(sessionId, { providerId, modelId })
      return { sessionModelSelections: map, lastUsedProvider: { providerID: providerId, modelID: modelId } }
    }),

  getSessionModelSelection: (sessionId) => get().sessionModelSelections.get(sessionId) ?? null,

  saveSessionAgentSelection: (sessionId, agentName) =>
    set((s) => {
      if (s.sessionAgentSelections.get(sessionId) === agentName) return s
      const map = new Map(s.sessionAgentSelections)
      map.set(sessionId, agentName)
      return { sessionAgentSelections: map }
    }),

  getSessionAgentSelection: (sessionId) => get().sessionAgentSelections.get(sessionId) ?? null,

  setSessionPlanMode: (sessionId, enabled) =>
    set((s) => {
      if ((s.sessionPlanModeSelections.get(sessionId) ?? false) === enabled) return s
      const map = new Map(s.sessionPlanModeSelections)
      if (enabled) {
        map.set(sessionId, true)
      } else {
        map.delete(sessionId)
      }
      return { sessionPlanModeSelections: map }
    }),

  getSessionPlanMode: (sessionId) => get().sessionPlanModeSelections.get(sessionId) ?? false,

  setDefaultPlanModeSelection: (enabled, options) =>
    set((s) => {
      const shouldSyncDraft = options?.syncDraft ?? s.draftPlanModeSelection === s.defaultPlanModeSelection;
      if (s.defaultPlanModeSelection === enabled && (!shouldSyncDraft || s.draftPlanModeSelection === enabled)) {
        return s;
      }
      return {
        defaultPlanModeSelection: enabled,
        draftPlanModeSelection: shouldSyncDraft ? enabled : s.draftPlanModeSelection,
      }
    }),

  setDraftPlanMode: (enabled) =>
    set((s) => {
      if (s.draftPlanModeSelection === enabled) return s
      return { draftPlanModeSelection: enabled }
    }),

  clearDraftPlanMode: () =>
    set((s) => {
      if (s.draftPlanModeSelection === s.defaultPlanModeSelection) return s
      return { draftPlanModeSelection: s.defaultPlanModeSelection }
    }),

  setPlanModeSelection: (sessionId, enabled) => {
    if (sessionId) {
      get().setSessionPlanMode(sessionId, enabled)
      return
    }
    get().setDraftPlanMode(enabled)
  },

  getPlanModeSelection: (sessionId) => {
    if (sessionId) return get().getSessionPlanMode(sessionId)
    return get().draftPlanModeSelection
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
    if (!agentMap && variant) {
      agentMap = new Map()
      agentModelVariantSelections.set(sessionId, agentMap)
    }
    if (!agentMap) return
    let modelMap = agentMap.get(agentName)
    if (!modelMap && variant) {
      modelMap = new Map()
      agentMap.set(agentName, modelMap)
    }
    if (!modelMap) return

    if (!variant) {
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

      if (!variant) {
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
      if (!hasDraft) return s

      const draftModelSelections = new Map(s.draftModelSelections)
      const draftAgentSelections = new Map(s.draftAgentSelections)
      const draftAgentModelSelections = new Map(s.draftAgentModelSelections)
      const draftAgentModelVariantSelections = new Map(s.draftAgentModelVariantSelections)
      draftModelSelections.delete(draftId)
      draftAgentSelections.delete(draftId)
      draftAgentModelSelections.delete(draftId)
      draftAgentModelVariantSelections.delete(draftId)
      return {
        draftModelSelections,
        draftAgentSelections,
        draftAgentModelSelections,
        draftAgentModelVariantSelections,
      }
    }),

  clearSessionSelection: (sessionId) => {
    const normalizedSessionId = sessionId.trim()
    if (!normalizedSessionId) return

    agentModelVariantSelections.delete(normalizedSessionId)
    set((s) => {
      const hasModel = s.sessionModelSelections.has(normalizedSessionId)
      const hasAgent = s.sessionAgentSelections.has(normalizedSessionId)
      const hasPlanMode = s.sessionPlanModeSelections.has(normalizedSessionId)
      const hasAgentModels = s.sessionAgentModelSelections.has(normalizedSessionId)
      if (!hasModel && !hasAgent && !hasPlanMode && !hasAgentModels) return s

      const sessionModelSelections = hasModel
        ? new Map(s.sessionModelSelections)
        : s.sessionModelSelections
      const sessionAgentSelections = hasAgent
        ? new Map(s.sessionAgentSelections)
        : s.sessionAgentSelections
      const sessionPlanModeSelections = hasPlanMode
        ? new Map(s.sessionPlanModeSelections)
        : s.sessionPlanModeSelections
      const sessionAgentModelSelections = hasAgentModels
        ? new Map(s.sessionAgentModelSelections)
        : s.sessionAgentModelSelections

      sessionModelSelections.delete(normalizedSessionId)
      sessionAgentSelections.delete(normalizedSessionId)
      sessionPlanModeSelections.delete(normalizedSessionId)
      sessionAgentModelSelections.delete(normalizedSessionId)

      return {
        sessionModelSelections,
        sessionAgentSelections,
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
      if (!draftAgent && !draftModel && !draftAgentModels && !draftAgentVariants) return s

      const sessionAgentSelections = new Map(s.sessionAgentSelections)
      const sessionModelSelections = new Map(s.sessionModelSelections)
      const sessionAgentModelSelections = new Map(s.sessionAgentModelSelections)
      const draftModelSelections = new Map(s.draftModelSelections)
      const draftAgentSelections = new Map(s.draftAgentSelections)
      const draftAgentModelSelections = new Map(s.draftAgentModelSelections)
      const draftAgentModelVariantSelections = new Map(s.draftAgentModelVariantSelections)

      if (draftAgent) {
        sessionAgentSelections.set(sessionId, draftAgent)
      }
      if (draftModel) {
        sessionModelSelections.set(sessionId, draftModel)
      }
      if (draftAgentModels) {
        sessionAgentModelSelections.set(sessionId, new Map(draftAgentModels))
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

      return {
        sessionAgentSelections,
        sessionModelSelections,
        sessionAgentModelSelections,
        draftModelSelections,
        draftAgentSelections,
        draftAgentModelSelections,
        draftAgentModelVariantSelections,
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
