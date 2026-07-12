import type { Agent } from '@opencode-ai/sdk/v2';
import { getModelDisplayName as getSharedModelDisplayName } from '@/lib/providers/antigravity';
import {
    CURSOR_ACP_FAST_SUFFIX,
    findCursorAcpModel,
    getCursorAcpBaseModelId,
    getCursorAcpFastModelId,
    isCursorAcpProvider,
} from '@/lib/providers/cursorAcp';
import { resolveThinkingVariant } from '@/lib/providers/variantControls';

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

type ProviderModel = { id?: string; name?: string; variants?: Record<string, unknown> };

const CURSOR_ACP_THINKING_KEY = 'thinking';
const CURSOR_ACP_EFFORT_ORDER = ['low', 'medium', 'high', 'extra-high', 'max', 'ultra', 'minimal', 'none'];
const CURSOR_ACP_EFFORT_ALIASES = new Map<string, string>([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'extra-high'],
    ['max', 'max'],
    ['ultra', 'ultra'],
    ['minimal', 'minimal'],
    ['min', 'minimal'],
    ['none', 'none'],
]);

type CursorAcpVariantParts = {
    effort?: string;
    thinking: boolean;
    canonical?: string;
};

export type CursorAcpVariantState = {
    modelId: string;
    baseModelId: string;
    fastModelId?: string;
    fastEnabled: boolean;
    canToggleFast: boolean;
    thinkingEnabled: boolean;
    canToggleThinking: boolean;
    selectedEffort?: string;
    normalizedVariant?: string;
    effortOptions: string[];
    visibleVariantOptions: string[];
};

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

const normalizeCursorAcpEffort = (tokens: string[]) => {
    if (tokens.length === 2 && tokens[0] === 'extra' && tokens[1] === 'high') {
        return 'extra-high';
    }
    if (tokens.length !== 1) {
        return undefined;
    }
    return CURSOR_ACP_EFFORT_ALIASES.get(tokens[0]);
};

const parseCursorAcpVariantKey = (variant?: string): CursorAcpVariantParts | null => {
    const trimmed = typeof variant === 'string' ? variant.trim().toLowerCase() : '';
    if (!trimmed) {
        return null;
    }

    const tokens = trimmed.split(/[-_\s]+/).filter(Boolean);
    const effortTokens: string[] = [];
    let thinking = false;
    for (const token of tokens) {
        if (token === CURSOR_ACP_THINKING_KEY) {
            thinking = true;
        } else if (token !== 'fast') {
            effortTokens.push(token);
        }
    }

    const effort = normalizeCursorAcpEffort(effortTokens);
    if (!thinking && !effort) {
        return null;
    }

    const canonical = thinking
        ? effort ? `${CURSOR_ACP_THINKING_KEY}-${effort}` : CURSOR_ACP_THINKING_KEY
        : effort;
    return { effort, thinking, canonical };
};

export const normalizeCursorAcpVariantKey = (variant?: string) => parseCursorAcpVariantKey(variant)?.canonical;

const getCursorAcpVariantRecord = (model: ProviderModel | undefined) => (
    model?.variants && typeof model.variants === 'object' ? model.variants : undefined
);

const getOrderedCursorAcpEfforts = (variants: Record<string, unknown>) => {
    const efforts = new Set<string>();
    for (const variantKey of Object.keys(variants)) {
        const parsed = parseCursorAcpVariantKey(variantKey);
        if (parsed?.effort) {
            efforts.add(parsed.effort);
        }
    }

    const ordered = CURSOR_ACP_EFFORT_ORDER.filter((effort) => efforts.has(effort));
    const extras = Array.from(efforts).filter((effort) => !CURSOR_ACP_EFFORT_ORDER.includes(effort)).sort();
    return [...ordered, ...extras];
};

const resolveCursorAcpVariantKey = (variants: Record<string, unknown>, variant?: string) => {
    const parsed = parseCursorAcpVariantKey(variant);
    if (!parsed?.canonical) {
        return undefined;
    }
    if (Object.prototype.hasOwnProperty.call(variants, parsed.canonical)) {
        return parsed.canonical;
    }
    const matchingVariant = Object.keys(variants).find((variantKey) => parseCursorAcpVariantKey(variantKey)?.canonical === parsed.canonical);
    return matchingVariant;
};

const getPreferredCursorAcpEffort = (efforts: string[]) => (
    efforts.includes('medium') ? 'medium' : efforts[0]
);

const selectCursorAcpVariantForDimensions = (
    variants: Record<string, unknown>,
    effort: string | undefined,
    thinkingEnabled: boolean,
) => {
    if (thinkingEnabled) {
        const thinkingEffort = effort ? resolveCursorAcpVariantKey(variants, `${CURSOR_ACP_THINKING_KEY}-${effort}`) : undefined;
        if (thinkingEffort) {
            return thinkingEffort;
        }
        const thinkingDefault = resolveCursorAcpVariantKey(variants, CURSOR_ACP_THINKING_KEY);
        if (thinkingDefault) {
            return thinkingDefault;
        }
    }

    if (effort) {
        return resolveCursorAcpVariantKey(variants, effort);
    }
    return undefined;
};

export const getCursorAcpVariantState = (
    provider: { id?: string; models?: ProviderModel[] } | undefined,
    modelId: string | undefined,
    variant?: string,
): CursorAcpVariantState | null => {
    if (!isCursorAcpProvider(provider) || !modelId) {
        return null;
    }

    const model = findCursorAcpModel(provider, modelId);
    const baseModelId = getCursorAcpBaseModelId(modelId);
    const pairedFastModelId = getCursorAcpFastModelId(baseModelId);
    const fastModel = findCursorAcpModel(provider, pairedFastModelId);
    const baseModel = findCursorAcpModel(provider, baseModelId);
    const fastEnabled = modelId.endsWith(CURSOR_ACP_FAST_SUFFIX);
    const canToggleFast = Boolean(fastEnabled ? baseModel : fastModel);
    const variants = getCursorAcpVariantRecord(model) ?? {};
    const effortOptions = getOrderedCursorAcpEfforts(variants);
    const hasThinking = Object.keys(variants).some((variantKey) => Boolean(parseCursorAcpVariantKey(variantKey)?.thinking));
    if (effortOptions.length === 0 && !hasThinking && !canToggleFast) {
        return null;
    }

    const normalizedVariant = resolveCursorAcpVariantKey(variants, variant);
    const canInterpretRawVariant = effortOptions.length > 0 || hasThinking;
    const parsedVariant = normalizedVariant
        ? parseCursorAcpVariantKey(normalizedVariant)
        : canInterpretRawVariant
            ? parseCursorAcpVariantKey(variant)
            : null;
    const selectedEffort = parsedVariant?.effort ?? getPreferredCursorAcpEffort(effortOptions);

    return {
        modelId,
        baseModelId,
        fastModelId: fastModel ? pairedFastModelId : undefined,
        fastEnabled,
        canToggleFast,
        thinkingEnabled: Boolean(parsedVariant?.thinking),
        canToggleThinking: hasThinking,
        selectedEffort,
        normalizedVariant,
        effortOptions,
        visibleVariantOptions: effortOptions,
    };
};

export const resolveCursorAcpVariantSelection = (
    provider: { id?: string; models?: ProviderModel[] } | undefined,
    modelId: string,
    variant: string | undefined,
    updates: { fastEnabled?: boolean; thinkingEnabled?: boolean; effort?: string },
) => {
    const currentState = getCursorAcpVariantState(provider, modelId, variant);
    if (!currentState) {
        return { modelId, variant };
    }

    const targetModelId = updates.fastEnabled === undefined
        ? modelId
        : updates.fastEnabled
            ? currentState.fastModelId ?? modelId
            : currentState.baseModelId;
    const targetModel = findCursorAcpModel(provider, targetModelId);
    const targetVariants = getCursorAcpVariantRecord(targetModel);
    if (!targetVariants) {
        return { modelId: targetModelId, variant: undefined };
    }

    const targetEfforts = getOrderedCursorAcpEfforts(targetVariants);
    const effort = updates.effort
        ?? (currentState.selectedEffort && targetEfforts.includes(currentState.selectedEffort) ? currentState.selectedEffort : undefined)
        ?? getPreferredCursorAcpEffort(targetEfforts);
    const thinkingEnabled = updates.thinkingEnabled ?? currentState.thinkingEnabled;

    return {
        modelId: targetModelId,
        variant: selectCursorAcpVariantForDimensions(targetVariants, effort, thinkingEnabled),
    };
};

export type EffortLabelContext = {
    providerId?: string | null;
};

const shouldUseLightLabel = (context?: EffortLabelContext) => (
    context?.providerId?.trim().toLowerCase() === 'openai'
);

export const formatEffortLabel = (variant?: string, context?: EffortLabelContext) => {
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
    variant: string | undefined,
    variants: string[],
) => {
    return resolveThinkingVariant(variant, variants) ?? null;
};

export const formatVisibleEffortLabel = (
    variant: string | undefined,
    variants: string[],
    context?: EffortLabelContext,
) => {
    const visibleVariant = resolveVisibleEffortVariant(variant, variants);
    return visibleVariant ? formatEffortLabel(visibleVariant, context) : null;
};

export const DEFAULT_EFFORT_KEY = 'default';

export const serializeEffortVariant = (variant?: string) => {
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

export const getEffortRank = (variant?: string) => {
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
