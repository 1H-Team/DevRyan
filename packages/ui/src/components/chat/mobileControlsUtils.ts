import { getChatThinkingState } from '@/lib/providers/chatThinking';
import type { Agent } from '@opencode-ai/sdk/v2';
import { getModelDisplayName as getSharedModelDisplayName } from '@/lib/providers/antigravity';
import { getModelDefaultThinkingLevel, resolveThinkingVariant, type ProviderModelLike } from '@/lib/providers/variantControls';

import { parseCursorAcpVariantKey, type CursorAcpVariantState } from '@/lib/providers/cursorThinking';
export { getCursorAcpVariantState, resolveCursorAcpVariantSelection, normalizeCursorAcpVariantKey } from '@/lib/providers/cursorThinking';
export type { CursorAcpVariantState } from '@/lib/providers/cursorThinking';

export { shouldHideCursorAcpFastModel } from '@/lib/providers/cursorAcp';

export type MobileControlsPanel = 'model' | 'agent' | 'variant' | null;

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

export const getDefaultThinkingDescription = (level?: string, providerId?: string) => level
    ? `Uses this model's default thinking level: ${formatEffortLabel(level, { providerId })}.`
    : 'The provider controls the thinking level and does not report a fixed default.';

export const getDefaultThinkingLabel = (
    provider: { id?: string; models?: ProviderModel[] } | undefined,
    modelId: string | undefined,
) => {
    const level = getModelDefaultThinkingLevel(provider, modelId);
    return level ? formatEffortLabel(level, { providerId: provider?.id }) : 'Provider-controlled';
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

export const DEFAULT_EFFORT_KEY = 'default';

export const serializeEffortVariant = (variant?: string | null) => {
    const trimmed = typeof variant === 'string' ? variant.trim() : '';
    return trimmed.length > 0 ? trimmed : DEFAULT_EFFORT_KEY;
};

export const parseEffortVariant = (variant: string) => {
    return variant === DEFAULT_EFFORT_KEY ? undefined : variant;
};

const EFFORT_RANKS: Record<string, number> = {
    max: 6,
    maximum: 6,
    xhigh: 5,
    high: 4,
    medium: 3,
    default: 2,
    low: 1,
    min: 0,
    minimal: 0,
};

export const getEffortRank = (variant?: string | null) => {
    if (!variant || variant.trim().length === 0) {
        return EFFORT_RANKS.default;
    }
    const normalized = variant.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(EFFORT_RANKS, normalized)) {
        return EFFORT_RANKS[normalized];
    }
    const numeric = Number.parseFloat(normalized);
    return Number.isFinite(numeric) ? numeric : 0;
};

export const getQuickEffortOptions = (variants: string[]) => {
    const options = new Map<string, string>();
    for (const variant of variants) {
        options.set(variant, variant);
    }

    const ordered = Array.from(options.values()).sort((a, b) => getEffortRank(b) - getEffortRank(a));
    if (ordered.length <= 4) {
        return ordered;
    }

    const top = ordered.slice(0, 3);
    const lowest = ordered[ordered.length - 1];
    if (top.some((item) => item === lowest)) {
        return top;
    }
    return [...top, lowest];
};
