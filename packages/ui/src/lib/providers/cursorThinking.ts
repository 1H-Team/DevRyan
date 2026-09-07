import {
    CURSOR_ACP_FAST_SUFFIX,
    findCursorAcpModel,
    getCursorAcpBaseModelId,
    getCursorAcpFastModelId,
    isCursorAcpProvider,
} from '@/lib/providers/cursorAcp';
import { getOrderedThinkingVariants, type ProviderModelLike as ProviderModel } from './variantControls';

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

const normalizeCursorAcpEffort = (tokens: string[]) => {
    if (tokens.length === 2 && tokens[0] === 'extra' && tokens[1] === 'high') {
        return 'extra-high';
    }
    if (tokens.length !== 1) {
        return undefined;
    }
    return CURSOR_ACP_EFFORT_ALIASES.get(tokens[0]);
};

export const parseCursorAcpVariantKey = (variant?: string | null): CursorAcpVariantParts | null => {
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

export const normalizeCursorAcpVariantKey = (variant?: string | null) => parseCursorAcpVariantKey(variant)?.canonical;

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

const resolveCursorAcpVariantKey = (variants: Record<string, unknown>, variant?: string | null) => {
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

const getPreferredCursorAcpEffort = (efforts: string[]) => {
    const ordered = getOrderedThinkingVariants(efforts);
    return ordered.find((effort) => effort === 'medium') ?? ordered[Math.floor((ordered.length - 1) / 2)];
};

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
        return resolveCursorAcpVariantKey(variants, effort)
            ?? resolveCursorAcpVariantKey(variants, `${CURSOR_ACP_THINKING_KEY}-${effort}`);
    }
    return undefined;
};

export const getCursorAcpVariantState = (
    provider: { id?: string; models?: ProviderModel[] } | undefined,
    modelId: string | undefined,
    variant?: string | null,
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
    variant: string | null | undefined,
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

    let selectedVariant = selectCursorAcpVariantForDimensions(targetVariants, effort, thinkingEnabled);
    // A requested slider stop must not collapse to the unqualified "thinking"
    // variant when this model does not advertise that compound effort.
    if (updates.effort && parseCursorAcpVariantKey(selectedVariant)?.effort !== updates.effort) {
        selectedVariant = resolveCursorAcpVariantKey(targetVariants, updates.effort)
            ?? resolveCursorAcpVariantKey(targetVariants, `${CURSOR_ACP_THINKING_KEY}-${updates.effort}`);
    }
    return { modelId: targetModelId, variant: selectedVariant };
};
