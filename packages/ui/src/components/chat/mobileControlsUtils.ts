import { getChatThinkingState } from '@/lib/providers/chatThinking';
import type { Agent } from '@opencode-ai/sdk/v2';
import { getModelDisplayName as getSharedModelDisplayName } from '@/lib/providers/modelIdentity';
import { resolveThinkingVariant, type ProviderModelLike } from '@/lib/providers/variantControls';

import { parseCursorAcpVariantKey, type CursorAcpVariantState } from '@/lib/providers/cursorThinking';
export { getCursorAcpVariantState, resolveCursorAcpVariantSelection, normalizeCursorAcpVariantKey } from '@/lib/providers/cursorThinking';
export type { CursorAcpVariantState } from '@/lib/providers/cursorThinking';

export { shouldHideCursorAcpFastModel } from '@/lib/providers/cursorAcp';

export type MobileControlsPanel = 'model' | 'agent' | null;

export const isPrimaryMode = (mode?: string) => mode === 'primary' || mode === 'all';

export const getCyclablePrimaryAgents = (agents: Agent[]) => agents.filter((agent) => isPrimaryMode(agent.mode));

export const getCycledPrimaryAgentName = (
    agents: Agent[],
    currentAgentName: string | undefined,
    direction: 1 | -1 = 1,
) => {
    const primaryAgents = getCyclablePrimaryAgents(agents);
    if (primaryAgents.length <= 1) {
        return null;
    }

    const currentIndex = primaryAgents.findIndex((agent) => agent.name === currentAgentName);
    const safeCurrentIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (safeCurrentIndex + direction + primaryAgents.length) % primaryAgents.length;
    return primaryAgents[nextIndex]?.name ?? null;
};

export const capitalizeLabel = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

const isBuilderAgentName = (name?: string | null) => {
    const normalized = name?.trim().toLowerCase() ?? '';
    return normalized === 'build' || normalized === 'builder';
};

export const formatAgentLabel = (name: string) => isBuilderAgentName(name) ? 'Builder' : capitalizeLabel(name);

export const getAgentDisplayName = (agents: Agent[], agentName?: string) => {
    if (agentName) {
        const agent = agents.find((entry) => entry.name === agentName);
        return agent ? formatAgentLabel(agent.name) : formatAgentLabel(agentName);
    }

    const primaryAgents = agents.filter((agent) => isPrimaryMode(agent.mode));
    const canonicalBuilderAgent = primaryAgents.find((agent) => agent.name?.trim().toLowerCase() === 'builder');
    const builderAgent = canonicalBuilderAgent ?? primaryAgents.find((agent) => isBuilderAgentName(agent.name));
    const fallbackAgent = builderAgent || primaryAgents[0] || agents[0];
    return fallbackAgent ? formatAgentLabel(fallbackAgent.name) : 'Select agent';
};

type ProviderModel = ProviderModelLike;

export const getModelDisplayName = (
    provider: { models?: ProviderModel[] } | undefined,
    modelId: string | undefined,
) => {
    if (!provider || !modelId) {
        return 'Not selected';
    }
    const models = Array.isArray(provider.models) ? provider.models : [];
    const model = models.find((entry) => entry.id === modelId);
    const displayName = getSharedModelDisplayName(model ?? {});
    if (displayName.trim().length > 0) {
        return displayName;
    }
    return modelId;
};

export type EffortLabelContext = {
    providerId?: string | null;
    defaultThinkingLevel?: string;
};

const shouldUseLightLabel = (context?: EffortLabelContext) => (
    context?.providerId?.trim().toLowerCase() === 'openai'
);

export const formatEffortLabel = (variant?: string | null, context?: EffortLabelContext) => {
    if (!variant || variant.trim().length === 0) {
        return 'Default';
    }
    const trimmed = variant.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
        return trimmed;
    }
    const cursorVariant = parseCursorAcpVariantKey(trimmed);
    if (cursorVariant?.effort) {
        return cursorVariant.effort
            .split('-')
            .filter(Boolean)
            .map((part) => part.toLowerCase() === 'low' && shouldUseLightLabel(context) ? 'Light' : capitalizeLabel(part))
            .join(' ');
    }
    return trimmed
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => {
            const normalized = part.toLowerCase();
            if (normalized === 'xhigh') {
                return 'Extra High';
            }
            if (normalized === 'low' && shouldUseLightLabel(context)) {
                return 'Light';
            }
            return capitalizeLabel(normalized);
        })
        .join(' ');
};

export const getCursorAcpVariantDisplayLabel = (
    state: CursorAcpVariantState | null | undefined,
    context?: EffortLabelContext,
) => {
    if (!state) {
        return null;
    }
    if (state.selectedEffort) {
        return formatEffortLabel(state.selectedEffort, context);
    }
    if (state.canToggleFast && !state.fastEnabled && !state.canToggleThinking && state.visibleVariantOptions.length === 0) {
        return formatEffortLabel(undefined, context);
    }
    return null;
};

export const resolveVisibleEffortVariant = (
    variant: string | null | undefined,
    variants: string[],
) => {
    return resolveThinkingVariant(variant, variants) ?? null;
};

export const formatVisibleEffortLabel = (
    variant: string | null | undefined,
    variants: string[],
    context?: EffortLabelContext,
) => {
    const visibleVariant = resolveVisibleEffortVariant(variant, variants);
    if (visibleVariant) return formatEffortLabel(visibleVariant, context);
    if (context?.defaultThinkingLevel) return formatEffortLabel(context.defaultThinkingLevel, context);
    return variants.length > 0 ? 'Provider-controlled' : null;
};

export const getModelThinkingLevelLabel = (
    provider: { id?: string; models?: ProviderModel[] } | undefined,
    modelId: string | undefined,
    variant?: string | null,
) => {
    if (!provider || !modelId) {
        return null;
    }

    const { selected } = getChatThinkingState(provider, modelId, variant);
    return selected ? formatEffortLabel(selected, { providerId: provider.id }) : null;
};
