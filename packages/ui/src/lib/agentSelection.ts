export type AgentSelectionOption = {
  name: string
  mode?: string | null
  hidden?: boolean
  options?: { hidden?: boolean }
  model?: {
    providerID?: string
    modelID?: string
  }
  variant?: string | null
}

const BUILTIN_AGENT_NAMES_HIDDEN_FROM_SELECTOR = new Set(["plan"])

export const normalizeAgentName = (name?: string | null) => name?.trim().toLowerCase() ?? ""

export const isPrimaryAgentMode = (mode?: string | null) => mode === "primary" || mode === "all"

export const isHiddenBuiltinAgentOption = (name?: string | null) => (
  BUILTIN_AGENT_NAMES_HIDDEN_FROM_SELECTOR.has(normalizeAgentName(name))
)

export const isBuilderAgentName = (name?: string | null) => {
  const normalized = normalizeAgentName(name)
  return normalized === "build" || normalized === "builder"
}

const getAgentSortLabel = (name: string) => (
  isBuilderAgentName(name) ? "builder" : normalizeAgentName(name)
)

export const isAgentHidden = (agent: AgentSelectionOption) => (
  agent.hidden === true || agent.options?.hidden === true
)

export const isSelectablePrimaryAgentOption = (agent: Pick<AgentSelectionOption, "name" | "mode" | "hidden" | "options">) => (
  isPrimaryAgentMode(agent.mode)
  && !isHiddenBuiltinAgentOption(agent.name)
  && !isAgentHidden(agent as AgentSelectionOption)
)

export const compareAgentOptions = (a: { name: string }, b: { name: string }) => {
  const labelComparison = getAgentSortLabel(a.name).localeCompare(getAgentSortLabel(b.name))
  if (labelComparison !== 0) return labelComparison

  return a.name.localeCompare(b.name)
}

export const getSelectablePrimaryAgents = <T extends AgentSelectionOption>(agents: T[]) => {
  const selectable = agents.filter(isSelectablePrimaryAgentOption)
  const hasBuilderAgent = selectable.some((agent) => normalizeAgentName(agent.name) === "builder")
  const canonical = hasBuilderAgent
    ? selectable.filter((agent) => !isBuilderAgentName(agent.name) || normalizeAgentName(agent.name) === "builder")
    : selectable

  return canonical.sort(compareAgentOptions)
}

export const resolveSelectableAgentOptions = <T extends AgentSelectionOption>(configAgents: T[], agentsStoreAgents: T[] = []) => {
  const fromConfig = getSelectablePrimaryAgents(configAgents)
  if (fromConfig.length > 0) {
    return fromConfig
  }

  return getSelectablePrimaryAgents(agentsStoreAgents)
}

export const findSelectableAgentByName = <T extends AgentSelectionOption>(agents: T[], agentName?: string | null) => {
  if (!agentName) {
    return undefined
  }
  const normalizedAgentName = normalizeAgentName(agentName)

  if (isBuilderAgentName(normalizedAgentName)) {
    return agents.find((agent) => (
      normalizeAgentName(agent.name) === "builder" && isSelectablePrimaryAgentOption(agent)
    )) ?? agents.find((agent) => (
      isBuilderAgentName(agent.name) && isSelectablePrimaryAgentOption(agent)
    ))
  }

  return agents.find((agent) => normalizeAgentName(agent.name) === normalizedAgentName && isSelectablePrimaryAgentOption(agent))
}

export const resolveDefaultAgentName = <T extends AgentSelectionOption>(savedAgent: string | undefined, selectableAgents: T[]) => {
  const saved = findSelectableAgentByName(selectableAgents, savedAgent)
  if (saved) {
    return saved.name
  }

  return selectableAgents.find((agent) => normalizeAgentName(agent.name) === "orchestrator")?.name
    ?? selectableAgents.find((agent) => normalizeAgentName(agent.name) === "builder")?.name
    ?? selectableAgents[0]?.name
    ?? ""
}
