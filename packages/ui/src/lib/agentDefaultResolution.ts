import type { AgentModelSelection } from '@/lib/agentModelSelection';
import { isProviderModelAvailable, type ProviderModelAvailability } from '@/lib/providers/modelAvailability';
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
    unavailableReason?: ProviderModelAvailability['unavailableReason'];
  }>;
};

export type ResolvedAgentDefault = Omit<AgentModelSelection, "variant"> & {
  variant: string | null;
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
  const candidate = personal ? { ...personal, variant: clean(personal.variant) || null, source: 'personal' as const } : {
    providerId: hostProviderId,
    modelId: hostModelId,
    variant: clean(agent.variant) || null,
    source: isSingleModelAgentDefault(agent) ? 'inherited' as const : 'host-managed' as const,
  };
  const provider = providers.find(entry => entry.id === candidate.providerId);
  const candidateModel = provider?.models?.find((model) => model.id === candidate.modelId);
  // Only a model the signed-in account type cannot use is replaced, and only within
  // its provider. Retired models and account-lookup outages keep the saved choice.
  if (candidateModel?.unavailableReason === 'auth_type_unsupported') {
    const fallbackModel = provider?.models?.find(isProviderModelAvailable);
    if (fallbackModel) {
      return {
        providerId: candidate.providerId,
        modelId: fallbackModel.id,
        variant: resolveProviderModelVariant(provider, fallbackModel.id, candidate.variant) ?? null,
        source: 'availability-fallback',
        agentName: agent.name,
      };
    }
  }
  return { ...candidate, variant: resolveProviderModelVariant(provider, candidate.modelId, candidate.variant) ?? null,
    agentName: agent.name };
};
