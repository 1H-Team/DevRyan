import { useConfigStore } from "@/stores/useConfigStore"
import { useContextStore } from "@/stores/contextStore"
import { useSelectionStore } from "./selection-store"
import { assertSessionPlanSelectionReady } from "./sync-refs"
import {
  findSelectableAgentByName,
  resolveDefaultAgentName,
  resolveSelectableAgentOptions,
} from "@/lib/agentSelection"
import { resolveProviderModelVariant } from "@/lib/providers/variantControls"
import { isProviderModelAvailable, type ProviderModelAvailability } from "@/lib/providers/modelAvailability"
import { resolveAgentDefaultSelection } from "@/lib/agentDefaultResolution"
import type { AgentModelSelection } from "@/lib/agentModelSelection"

/** Internal draft intent: user-chosen vs agent-configured default. Not sent to OpenCode. */
export type SendConfigModelProvenance = "explicit" | "agent-default"

export type SendConfig = {
  providerID?: string
  modelID?: string
  agent?: string
  /** Missing inherits; null captures provider default; a string captures explicit effort. */
  variant?: string | null
  planMode?: boolean
  modelProvenance?: SendConfigModelProvenance
}

export type SendConfigProviderModel = ProviderModelAvailability & {
  id: string
  variants?: Record<string, unknown>
}

export type SendConfigProvider = {
  id: string
  models?: SendConfigProviderModel[]
}

export type SendConfigAgent = {
  name: string
  mode?: string
  model?: {
    providerID?: string
    modelID?: string
  }
  variant?: string | null
  modelRefs?: string[]
  councillors?: unknown[]
}

type StoreModelSelection = { providerId: string; modelId: string } | null

export type SendConfigResolverSnapshot = {
  currentAgentName?: string | null
  currentProviderId?: string
  currentModelId?: string
  currentVariant?: string | null
  settingsDefaultAgent?: string | null
  lastUsedProvider?: { providerID: string; modelID: string } | null
  agents: SendConfigAgent[]
  providers: SendConfigProvider[]
  sessionAgentSelection?: string | null
  contextSessionAgentSelection?: string | null
  contextCurrentAgent?: string
  sessionModelSelection?: StoreModelSelection
  contextSessionModelSelection?: StoreModelSelection
  sessionAgentModelSelection?: StoreModelSelection
  contextSessionAgentModelSelection?: StoreModelSelection
  sessionAgentModelVariant?: string | null
  contextSessionAgentModelVariant?: string | null
  planMode: boolean
}

function clean(value?: string | null): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed.length > 0 ? trimmed : undefined
}

export function normalizeSendConfigModelProvenance(value: unknown): SendConfigModelProvenance | undefined {
  return value === "explicit" || value === "agent-default" ? value : undefined
}

/**
 * True when a draft model should survive agent/default re-application.
 * Legacy drafts with provider+model but no provenance count as explicit.
 */
export function hasExplicitDraftModelIntent(sendConfig?: SendConfig | null): boolean {
  const providerID = clean(sendConfig?.providerID)
  const modelID = clean(sendConfig?.modelID)
  if (!providerID || !modelID) return false
  const provenance = normalizeSendConfigModelProvenance(sendConfig?.modelProvenance)
  return provenance !== "agent-default"
}

function findProviderModel(providers: SendConfigProvider[], providerID?: string, modelID?: string) {
  if (!providerID || !modelID) return null
  const provider = providers.find((entry) => entry.id === providerID)
  const model = provider?.models?.find((entry) => entry.id === modelID)
  return provider && model && isProviderModelAvailable(model) ? { provider, model } : null
}

function resolveVariantForModel(
  providers: SendConfigProvider[],
  providerID?: string,
  modelID?: string,
  variant?: string | null,
): string | null {
  const cleanedVariant = clean(variant)
  const providerModel = findProviderModel(providers, providerID, modelID)
  if (!providerModel) return null

  return resolveProviderModelVariant(providerModel.provider, modelID, cleanedVariant) ?? null
}

function hasOwn(object: object | null | undefined, key: keyof SendConfig): boolean {
  return !!object && Object.prototype.hasOwnProperty.call(object, key)
}

function resolveAgentVariantForModel(
  agent: SendConfigAgent | undefined,
  model: SendConfigProviderModel | null | undefined,
  providerID?: string,
  modelID?: string,
): string | undefined {
  if (!agent || !model || !providerID || !modelID) return undefined
  if (agent.model?.providerID !== providerID || agent.model?.modelID !== modelID) return undefined
  const agentVariant = clean(agent.variant)
  if (!agentVariant) return undefined
  return model.variants && Object.prototype.hasOwnProperty.call(model.variants, agentVariant)
    ? agentVariant
    : undefined
}

export function resolveDraftSendSelection(params: {
  requestedAgent?: string
  currentAgent?: string | null
  settingsDefaultAgent?: string | null
  agents: SendConfigAgent[]
  providers: SendConfigProvider[]
  inputProviderID: string
  inputModelID: string
  inputVariant?: string | null
  currentProviderID?: string
  currentModelID?: string
  currentVariant?: string | null
  draftAgentSelection?: string | null
  draftModelSelection?: StoreModelSelection
  draftAgentModelSelection?: StoreModelSelection
  draftAgentModelVariant?: string | null
  draftSendConfig?: SendConfig | null
  agentModelSelections?: Record<string, AgentModelSelection>
}): Required<Pick<SendConfig, "providerID" | "modelID">> & Pick<SendConfig, "agent" | "variant"> {
  const selectableAgents = resolveSelectableAgentOptions(params.agents, [])
  const explicitAgent = findSelectableAgentByName(selectableAgents, clean(params.draftSendConfig?.agent))
  const requested = explicitAgent ? undefined : findSelectableAgentByName(selectableAgents, clean(params.requestedAgent))
  const draft = requested ? undefined : findSelectableAgentByName(selectableAgents, clean(params.draftAgentSelection))
  const current = explicitAgent || requested || draft ? undefined : findSelectableAgentByName(selectableAgents, clean(params.currentAgent))
  const defaultAgentName = explicitAgent || requested || draft || current
    ? undefined
    : resolveDefaultAgentName(clean(params.settingsDefaultAgent), selectableAgents)
  const defaultAgent = findSelectableAgentByName(selectableAgents, defaultAgentName)
  const agent = explicitAgent ?? requested ?? draft ?? current ?? defaultAgent

  // agent-default means the account's personal-or-inherited agent default wins
  // over persisted draft maps. Explicit and legacy drafts retain their picks.
  const honorPersistedDraftModel = normalizeSendConfigModelProvenance(params.draftSendConfig?.modelProvenance) !== "agent-default"
  const explicitModel = honorPersistedDraftModel
    ? findProviderModel(params.providers, params.draftSendConfig?.providerID, params.draftSendConfig?.modelID)
    : null
  const draftAgentModel = honorPersistedDraftModel && agent
    ? findProviderModel(params.providers, params.draftAgentModelSelection?.providerId, params.draftAgentModelSelection?.modelId)
    : null
  const draftModel = honorPersistedDraftModel
    ? findProviderModel(params.providers, params.draftModelSelection?.providerId, params.draftModelSelection?.modelId)
    : null
  const accountAgentDefault = agent ? resolveAgentDefaultSelection({
    agentName: agent.name,
    agents: params.agents,
    providers: params.providers,
    personalSelections: params.agentModelSelections,
  }) : null
  const agentModel = findProviderModel(
    params.providers,
    accountAgentDefault?.providerId,
    accountAgentDefault?.modelId,
  )
  const inputModel = findProviderModel(params.providers, params.inputProviderID, params.inputModelID)
  const currentModel = findProviderModel(params.providers, params.currentProviderID, params.currentModelID)

  // Precedence: persisted explicit draft config, explicit per-draft selections,
  // the selected agent's personal-or-inherited default, then retained current input.
  let providerID: string | undefined
  let modelID: string | undefined
  let variant: string | null | undefined
  let selectedModel: SendConfigProviderModel | null = null

  if (explicitModel) {
    providerID = params.draftSendConfig?.providerID
    modelID = params.draftSendConfig?.modelID
    variant = params.draftSendConfig?.variant
    selectedModel = explicitModel.model
  } else if (draftAgentModel) {
    providerID = params.draftAgentModelSelection?.providerId
    modelID = params.draftAgentModelSelection?.modelId
    variant = params.draftAgentModelVariant
    selectedModel = draftAgentModel.model
  } else if (draftModel) {
    providerID = params.draftModelSelection?.providerId
    modelID = params.draftModelSelection?.modelId
    selectedModel = draftModel.model
  } else if (agentModel) {
    providerID = accountAgentDefault?.providerId
    modelID = accountAgentDefault?.modelId
    variant = accountAgentDefault?.variant
    selectedModel = agentModel.model
  } else if (accountAgentDefault) {
    providerID = accountAgentDefault.providerId
    modelID = accountAgentDefault.modelId
    variant = accountAgentDefault.variant
  } else if (inputModel) {
    providerID = params.inputProviderID
    modelID = params.inputModelID
    selectedModel = inputModel.model
  } else if (currentModel) {
    providerID = params.currentProviderID
    modelID = params.currentModelID
    selectedModel = currentModel.model
  } else {
    providerID = params.inputProviderID
    modelID = params.inputModelID
  }

  if (variant === undefined) {
    variant = resolveAgentVariantForModel(agent, selectedModel, providerID, modelID)
  }

  return {
    agent: agent?.name,
    providerID: providerID ?? "",
    modelID: modelID ?? "",
    variant: findProviderModel(params.providers, providerID, modelID)
      ? resolveVariantForModel(params.providers, providerID, modelID, variant)
      : clean(variant) ?? null,
  }
}

export function resolveSessionSendConfigSnapshot(
  snapshot: SendConfigResolverSnapshot,
  requested: SendConfig = {},
): SendConfig {
  const requestedProviderID = clean(requested.providerID)
  const requestedModelID = clean(requested.modelID)
  const requestedAgent = clean(requested.agent)

  const agent = requestedAgent
    ?? clean(snapshot.sessionAgentSelection)
    ?? clean(snapshot.contextSessionAgentSelection)
    ?? clean(snapshot.contextCurrentAgent)
    ?? clean(snapshot.currentAgentName)

  const agentModel = agent
    ? (snapshot.sessionAgentModelSelection ?? snapshot.contextSessionAgentModelSelection)
    : null
  const sessionModel = snapshot.sessionModelSelection ?? snapshot.contextSessionModelSelection

  if (snapshot.providers.length === 0) {
    return {
      providerID: requestedProviderID
        ?? agentModel?.providerId
        ?? sessionModel?.providerId
        ?? clean(snapshot.currentProviderId)
        ?? snapshot.lastUsedProvider?.providerID,
      modelID: requestedModelID
        ?? agentModel?.modelId
        ?? sessionModel?.modelId
        ?? clean(snapshot.currentModelId)
        ?? snapshot.lastUsedProvider?.modelID,
      agent,
      variant: requested.variant === null ? null : clean(requested.variant),
      planMode: requested.planMode ?? snapshot.planMode,
    }
  }

  const requestedModel = findProviderModel(snapshot.providers, requestedProviderID, requestedModelID)
  const storedAgentModel = findProviderModel(snapshot.providers, agentModel?.providerId, agentModel?.modelId)
  const storedSessionModel = findProviderModel(snapshot.providers, sessionModel?.providerId, sessionModel?.modelId)
  const currentModel = findProviderModel(
    snapshot.providers,
    clean(snapshot.currentProviderId),
    clean(snapshot.currentModelId),
  )
  const lastUsedModel = findProviderModel(
    snapshot.providers,
    snapshot.lastUsedProvider?.providerID,
    snapshot.lastUsedProvider?.modelID,
  )

  if ((requestedProviderID || requestedModelID) && !requestedModel) {
    return {
      providerID: undefined,
      modelID: undefined,
      agent,
      variant: undefined,
      planMode: requested.planMode ?? snapshot.planMode,
    }
  }

  const selected = requestedModel
    ?? storedAgentModel
    ?? storedSessionModel
    ?? currentModel
    ?? lastUsedModel
  const providerID = selected?.provider.id
  const modelID = selected?.model.id

  if (!providerID || !modelID) {
    return {
      providerID: undefined,
      modelID: undefined,
      agent,
      variant: undefined,
      planMode: requested.planMode ?? snapshot.planMode,
    }
  }

  // Null is an intentional provider default; only missing values inherit.
  const requestedOrStoredVariant = [
    requested.variant,
    ...(agent ? [snapshot.sessionAgentModelVariant, snapshot.contextSessionAgentModelVariant] : []),
    snapshot.currentVariant,
  ].find((value) => value !== undefined)
  const selectedAgent = snapshot.agents.find((entry) => entry.name === agent)
  const inheritedVariant = resolveAgentVariantForModel(selectedAgent, selected?.model, providerID, modelID)
  const variant = resolveVariantForModel(snapshot.providers, providerID, modelID,
    requestedOrStoredVariant === undefined ? inheritedVariant : requestedOrStoredVariant)

  return {
    providerID,
    modelID,
    agent,
    variant,
    planMode: requested.planMode ?? snapshot.planMode,
  }
}

export function resolveSessionSendConfig(sessionId: string, requested: SendConfig = {}): SendConfig {
  if (requested.planMode === undefined) assertSessionPlanSelectionReady(sessionId)
  const context = useContextStore.getState()
  const config = useConfigStore.getState()
  const selection = useSelectionStore.getState()
  const requestedAgent = clean(requested.agent)
  const selectedAgent = requestedAgent
    ?? selection.getSessionAgentSelection(sessionId)
    ?? context.getSessionAgentSelection(sessionId)
    ?? context.getCurrentAgent(sessionId)
    ?? config.currentAgentName
    ?? undefined

  const requestedProviderID = clean(requested.providerID)
  const requestedModelID = clean(requested.modelID)
  const selectedAgentModel = selectedAgent && !requestedProviderID && !requestedModelID
    && typeof selection.getAgentModelForSession === "function"
    ? selection.getAgentModelForSession(sessionId, selectedAgent)
    : null
  const contextAgentModel = selectedAgent && !requestedProviderID && !requestedModelID && !selectedAgentModel
    ? context.getAgentModelForSession(sessionId, selectedAgent)
    : null
  const selectedSessionModel = !requestedProviderID && !requestedModelID
    && typeof selection.getSessionModelSelection === "function"
    ? selection.getSessionModelSelection(sessionId)
    : null
  const contextSessionModel = !requestedProviderID && !requestedModelID && !selectedSessionModel
    ? context.getSessionModelSelection(sessionId)
    : null
  const agentModel = selectedAgentModel ?? contextAgentModel
  const sessionModel = selectedSessionModel ?? contextSessionModel
  const providerID = requestedProviderID
    ?? agentModel?.providerId
    ?? sessionModel?.providerId
    ?? clean(config.currentProviderId)
    ?? selection.lastUsedProvider?.providerID
  const modelID = requestedModelID
    ?? agentModel?.modelId
    ?? sessionModel?.modelId
    ?? clean(config.currentModelId)
    ?? selection.lastUsedProvider?.modelID
  const selectedAgentVariant = selectedAgent && providerID && modelID
    && typeof selection.getAgentModelVariantForSession === "function"
    ? selection.getAgentModelVariantForSession(sessionId, selectedAgent, providerID, modelID)
    : undefined
  const contextAgentVariant = selectedAgent && providerID && modelID && selectedAgentVariant === undefined
    ? context.getAgentModelVariantForSession(sessionId, selectedAgent, providerID, modelID)
    : undefined

  return resolveSessionSendConfigSnapshot({
    currentAgentName: config.currentAgentName,
    currentProviderId: config.currentProviderId,
    currentModelId: config.currentModelId,
    currentVariant: config.currentVariant,
    settingsDefaultAgent: undefined,
    lastUsedProvider: selection.lastUsedProvider,
    agents: config.agents,
    providers: config.providers,
    sessionAgentSelection: selection.getSessionAgentSelection(sessionId),
    contextSessionAgentSelection: context.getSessionAgentSelection(sessionId),
    contextCurrentAgent: context.getCurrentAgent(sessionId),
    sessionModelSelection: selectedSessionModel,
    contextSessionModelSelection: contextSessionModel,
    sessionAgentModelSelection: selectedAgentModel,
    contextSessionAgentModelSelection: contextAgentModel,
    sessionAgentModelVariant: selectedAgentVariant,
    contextSessionAgentModelVariant: contextAgentVariant,
    planMode: selection.getPlanModeSelection(sessionId),
  }, requested)
}

export function resolveCurrentSendConfig(sessionId: string | null | undefined): SendConfig {
  const config = useConfigStore.getState()
  const selection = useSelectionStore.getState()
  if (sessionId) {
    return resolveSessionSendConfig(sessionId, {
      providerID: config.currentProviderId,
      modelID: config.currentModelId,
      agent: config.currentAgentName ?? undefined,
      variant: config.currentVariant,
      planMode: selection.getPlanModeSelection(sessionId),
    })
  }

  return resolveSessionSendConfigSnapshot({
    currentProviderId: config.currentProviderId,
    currentModelId: config.currentModelId,
    currentAgentName: config.currentAgentName,
    currentVariant: config.currentVariant,
    agents: config.agents,
    providers: config.providers,
    planMode: selection.getPlanModeSelection(null),
  })
}

/** New user/queue captures must not turn missing historical Plan authority into OFF. */
export function captureCurrentSendConfig(sessionId: string | null | undefined): SendConfig {
  if (sessionId) assertSessionPlanSelectionReady(sessionId)
  return resolveCurrentSendConfig(sessionId)
}

export function resolveCurrentDraftSendConfig(draftId: string | null | undefined, draftSendConfig?: SendConfig | null): SendConfig {
  const config = useConfigStore.getState()
  const selection = useSelectionStore.getState()
  if (!draftId) {
    return resolveCurrentSendConfig(null)
  }

  const draftAgent = selection.getDraftAgentSelection(draftId)
  const draftModel = selection.getDraftModelSelection(draftId)
  const agent = draftAgent ?? config.currentAgentName ?? undefined
  const draftAgentModel = agent ? selection.getDraftAgentModelForSelection(draftId, agent) : null
  const variantProviderID = draftAgentModel?.providerId ?? draftModel?.providerId ?? config.currentProviderId
  const variantModelID = draftAgentModel?.modelId ?? draftModel?.modelId ?? config.currentModelId
  const draftAgentVariant = agent && variantProviderID && variantModelID
    ? selection.getDraftAgentModelVariantForSelection(draftId, agent, variantProviderID, variantModelID)
    : undefined

  const resolved = resolveDraftSendSelection({
    requestedAgent: undefined,
    currentAgent: config.currentAgentName,
    settingsDefaultAgent: config.settingsDefaultAgent,
    agents: config.agents,
    providers: config.providers,
    inputProviderID: config.currentProviderId,
    inputModelID: config.currentModelId,
    inputVariant: config.currentVariant,
    currentProviderID: config.currentProviderId,
    currentModelID: config.currentModelId,
    currentVariant: config.currentVariant,
    draftAgentSelection: draftAgent,
    draftModelSelection: draftModel,
    draftAgentModelSelection: draftAgentModel,
    draftAgentModelVariant: draftAgentVariant,
    draftSendConfig,
    agentModelSelections: config.agentModelSelections,
  })

  return {
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    agent: resolved.agent,
    variant: resolved.variant,
    planMode: hasOwn(draftSendConfig, "planMode")
      ? draftSendConfig?.planMode === true
      : selection.getPlanModeSelection(null, draftId),
  }
}
