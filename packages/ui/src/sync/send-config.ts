import { useConfigStore } from "@/stores/useConfigStore"
import { useContextStore } from "@/stores/contextStore"
import { useSelectionStore } from "./selection-store"
import {
  findSelectableAgentByName,
  resolveDefaultAgentName,
  resolveSelectableAgentOptions,
} from "@/lib/agentSelection"
import { resolveProviderModelVariant } from "@/lib/providers/variantControls"

export type SendConfig = {
  providerID?: string
  modelID?: string
  agent?: string
  variant?: string
  planMode?: boolean
}

export type SendConfigProviderModel = {
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
}

type StoreModelSelection = { providerId: string; modelId: string } | null

export type SendConfigResolverSnapshot = {
  currentAgentName?: string | null
  currentProviderId?: string
  currentModelId?: string
  currentVariant?: string
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
  sessionAgentModelVariant?: string
  contextSessionAgentModelVariant?: string
  planMode: boolean
}

function clean(value?: string | null): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed.length > 0 ? trimmed : undefined
}

function findProviderModel(providers: SendConfigProvider[], providerID?: string, modelID?: string) {
  if (!providerID || !modelID) return null
  const provider = providers.find((entry) => entry.id === providerID)
  const model = provider?.models?.find((entry) => entry.id === modelID)
  return model ? { provider, model } : null
}

function resolveVariantForModel(
  providers: SendConfigProvider[],
  providerID?: string,
  modelID?: string,
  variant?: string | null,
): string | undefined {
  const cleanedVariant = clean(variant)
  const providerModel = findProviderModel(providers, providerID, modelID)
  if (!providerModel) return undefined

  return resolveProviderModelVariant(providerModel.provider, modelID, cleanedVariant)
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
  inputVariant?: string
  currentProviderID?: string
  currentModelID?: string
  currentVariant?: string
  draftAgentSelection?: string | null
  draftModelSelection?: StoreModelSelection
  draftAgentModelSelection?: StoreModelSelection
  draftAgentModelVariant?: string
  draftSendConfig?: SendConfig | null
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

  const explicitModel = findProviderModel(params.providers, params.draftSendConfig?.providerID, params.draftSendConfig?.modelID)
  const draftAgentModel = agent
    ? findProviderModel(params.providers, params.draftAgentModelSelection?.providerId, params.draftAgentModelSelection?.modelId)
    : null
  const draftModel = findProviderModel(params.providers, params.draftModelSelection?.providerId, params.draftModelSelection?.modelId)
  const agentModel = findProviderModel(params.providers, agent?.model?.providerID, agent?.model?.modelID)
  const inputModel = findProviderModel(params.providers, params.inputProviderID, params.inputModelID)
  const currentModel = findProviderModel(params.providers, params.currentProviderID, params.currentModelID)

  // Precedence: persisted explicit draft config, explicit per-draft selections,
  // the selected agent's configured model, then the retained current model.
  let providerID: string | undefined
  let modelID: string | undefined
  let variant: string | undefined
  let selectedModel: SendConfigProviderModel | null = null

  if (explicitModel) {
    providerID = params.draftSendConfig?.providerID
    modelID = params.draftSendConfig?.modelID
    variant = hasOwn(params.draftSendConfig, "variant") ? clean(params.draftSendConfig?.variant) : undefined
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
    providerID = agent?.model?.providerID
    modelID = agent?.model?.modelID
    variant = clean(agent?.variant)
    selectedModel = agentModel.model
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

  if (!variant && !explicitModel) {
    variant = resolveAgentVariantForModel(agent, selectedModel, providerID, modelID)
  }

  return {
    agent: agent?.name,
    providerID: providerID ?? "",
    modelID: modelID ?? "",
    variant: resolveVariantForModel(params.providers, providerID, modelID, variant),
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

  const providerID = requestedProviderID
    ?? agentModel?.providerId
    ?? sessionModel?.providerId
    ?? clean(snapshot.currentProviderId)
    ?? snapshot.lastUsedProvider?.providerID
  const modelID = requestedModelID
    ?? agentModel?.modelId
    ?? sessionModel?.modelId
    ?? clean(snapshot.currentModelId)
    ?? snapshot.lastUsedProvider?.modelID

  const requestedOrStoredVariant = Object.prototype.hasOwnProperty.call(requested, "variant")
    ? requested.variant
    : (agent && providerID && modelID
      ? (snapshot.sessionAgentModelVariant ?? snapshot.contextSessionAgentModelVariant)
      : undefined) ?? clean(snapshot.currentVariant)
  const variant = resolveVariantForModel(snapshot.providers, providerID, modelID, requestedOrStoredVariant)

  return {
    providerID,
    modelID,
    agent,
    variant,
    planMode: requested.planMode ?? snapshot.planMode,
  }
}

export function resolveSessionSendConfig(sessionId: string, requested: SendConfig = {}): SendConfig {
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
      variant: config.currentVariant ?? undefined,
      planMode: selection.getPlanModeSelection(sessionId),
    })
  }

  return {
    providerID: config.currentProviderId,
    modelID: config.currentModelId,
    agent: config.currentAgentName ?? undefined,
    variant: resolveVariantForModel(config.providers, config.currentProviderId, config.currentModelId, config.currentVariant),
    planMode: selection.getPlanModeSelection(null),
  }
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
    inputVariant: config.currentVariant ?? undefined,
    currentProviderID: config.currentProviderId,
    currentModelID: config.currentModelId,
    currentVariant: config.currentVariant ?? undefined,
    draftAgentSelection: draftAgent,
    draftModelSelection: draftModel,
    draftAgentModelSelection: draftAgentModel,
    draftAgentModelVariant: draftAgentVariant,
    draftSendConfig,
  })

  return {
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    agent: resolved.agent,
    variant: resolved.variant,
    planMode: hasOwn(draftSendConfig, "planMode")
      ? draftSendConfig?.planMode === true
      : selection.getPlanModeSelection(null),
  }
}
