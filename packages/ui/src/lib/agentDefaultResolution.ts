import type { AgentModelSelection } from '@/lib/agentModelSelection';
import { resolveAvailableProviderModel, isProviderModelAvailable } from '@/lib/providers/modelAvailability';
import { resolveProviderModelVariant } from '@/lib/providers/variantControls';

export type AgentDefaultSource = 'personal' | 'inherited' | 'host-managed' | 'availability-fallback';

export type AgentDefaultAgent = {
  name: string;
  model?: { providerID?: string; modelID?: string };
  variant?: string | null;
  modelRefs?: string[];
  councillors?: unknown[];
};

export type AgentDefaultProvider = {
  id: string;
  models?: Array<{
    id: string;
    variants?: Record<string, unknown>;
    available?: boolean;
  }>;
};

export type ResolvedAgentDefault = AgentModelSelection & {
  agentName: string;
  source: AgentDefaultSource;
};

const clean = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export const findAgentDefaultOverride = (
  selections: Record<string, AgentModelSelection> | undefined,
  agentName: string,
): AgentModelSelection | null => {
  const normalized = clean(agentName).toLowerCase();
  const match = Object.entries(selections ?? {}).find(([name]) => clean(name).toLowerCase() === normalized);
  return match?.[1] ?? null;
};

export const isSingleModelAgentDefault = (agent: AgentDefaultAgent | undefined): boolean => {
  if (!agent?.model?.providerID || !agent.model.modelID) return false;
  if (clean(agent.name).toLowerCase() === 'council') return false;
  if (Array.isArray(agent.councillors) && agent.councillors.length > 0) return false;
  return !Array.isArray(agent.modelRefs) || agent.modelRefs.length <= 1;
};

const findAvailableModel = (
  providers: AgentDefaultProvider[],
  providerId: string,
  modelId: string,
) => {
  const provider = providers.find((entry) => entry.id === providerId);
  const model = provider?.models?.find((entry) => entry.id === modelId);
  return provider && model && isProviderModelAvailable(model) ? { provider, model } : null;
};

const findCatalogModel = (providers: AgentDefaultProvider[], providerId: string, modelId: string) => {
  const provider = providers.find((entry) => entry.id === providerId);
  const model = provider?.models?.find((entry) => entry.id === modelId);
  return { provider, model };
};

export const resolveAgentDefaultSelection = ({
  agentName,
  agents,
  providers,
  personalSelections,
}: {
  agentName: string | null | undefined;
  agents: AgentDefaultAgent[];
  providers: AgentDefaultProvider[];
  personalSelections?: Record<string, AgentModelSelection>;
}): ResolvedAgentDefault | null => {
  const normalizedName = clean(agentName).toLowerCase();
  const agent = agents.find((entry) => clean(entry.name).toLowerCase() === normalizedName);
  if (!agent) return null;

  const hostProviderId = clean(agent.model?.providerID);
  const hostModelId = clean(agent.model?.modelID);
  if (!hostProviderId || !hostModelId) return null;

  const personal = isSingleModelAgentDefault(agent)
    ? findAgentDefaultOverride(personalSelections, agent.name)
    : null;
  const candidates = [
    ...(personal ? [{ ...personal, source: 'personal' as const }] : []),
    {
      providerId: hostProviderId,
      modelId: hostModelId,
      ...(clean(agent.variant) ? { variant: clean(agent.variant) } : {}),
      source: isSingleModelAgentDefault(agent) ? 'inherited' as const : 'host-managed' as const,
    },
  ];

  for (const candidate of candidates) {
    if (providers.length === 0) return { ...candidate, agentName: agent.name };
    const available = findAvailableModel(providers, candidate.providerId, candidate.modelId);
    if (available) {
      const variant = resolveProviderModelVariant(available.provider, candidate.modelId, candidate.variant);
      return {
        providerId: candidate.providerId,
        modelId: candidate.modelId,
        ...(variant ? { variant } : {}),
        agentName: agent.name,
        source: candidate.source,
      };
    }

    const catalog = findCatalogModel(providers, candidate.providerId, candidate.modelId);
    if (candidate.source === 'personal') {
      // A known provider without this model, or an explicitly unavailable row,
      // invalidates only the personal override. A missing provider can be a
      // bootstrap race, so keep the captured account default until hydration.
      if (catalog.provider) continue;
      return { ...candidate, agentName: agent.name };
    }
    // Host agent config remains authoritative when the provider snapshot is
    // incomplete. Only an explicit unavailable marker triggers fallback.
    if (!catalog.model || isProviderModelAvailable(catalog.model)) {
      return { ...candidate, agentName: agent.name };
    }
  }

  const fallback = resolveAvailableProviderModel(providers, personal?.providerId ?? hostProviderId, personal?.modelId ?? hostModelId);
  if (!fallback) return null;
  const available = findAvailableModel(providers, fallback.providerId, fallback.modelId);
  const variant = available
    ? resolveProviderModelVariant(available.provider, fallback.modelId, undefined)
    : undefined;
  return {
    ...fallback,
    ...(variant ? { variant } : {}),
    agentName: agent.name,
    source: 'availability-fallback',
  };
};
