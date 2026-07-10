export type ProviderModelLike = {
    id?: string;
    name?: string;
    variants?: Record<string, unknown>;
};

export type ProviderLike<Model extends ProviderModelLike = ProviderModelLike> = {
    id?: string;
    models?: readonly Model[];
};

export type ModelVariantControlState = {
    modelId: string;
    baseModelId: string;
    fastModelId?: string;
    fastEnabled: boolean;
    canToggleFast: boolean;
    selectedVariant?: string;
    visibleVariantOptions: string[];
};

export type ModelVariantDisplayState = {
    displayModelId: string;
    fastEnabled: boolean;
    selectedVariant?: string;
    visibleVariantOptions: string[];
};

const FAST_VARIANT_KEY = 'fast';
const FAST_MODEL_SUFFIX = '-fast';

const THINKING_VARIANT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
const THINKING_VARIANT_RANK = new Map<string, number>(
    THINKING_VARIANT_ORDER.map((variant, index) => [variant, index]),
);

const normalizeVariantKey = (variant: string) => variant.trim().toLowerCase();

const getVariantKeys = (variants?: Record<string, unknown> | readonly string[]): string[] => {
    if (Array.isArray(variants)) {
        return variants;
    }
    if (!variants || typeof variants !== 'object') {
        return [];
    }
    return Object.keys(variants);
};

export const getOrderedThinkingVariants = (
    variants?: Record<string, unknown> | readonly string[],
): string[] => {
    const uniqueVariants = new Map<string, string>();
    for (const variant of getVariantKeys(variants)) {
        const trimmed = typeof variant === 'string' ? variant.trim() : '';
        if (!trimmed || normalizeVariantKey(trimmed) === FAST_VARIANT_KEY) {
            continue;
        }
        uniqueVariants.set(normalizeVariantKey(trimmed), trimmed);
    }

    return Array.from(uniqueVariants.values()).sort((left, right) => {
        const leftRank = THINKING_VARIANT_RANK.get(normalizeVariantKey(left));
        const rightRank = THINKING_VARIANT_RANK.get(normalizeVariantKey(right));
        if (leftRank !== undefined && rightRank !== undefined) {
            return leftRank - rightRank;
        }
        if (leftRank !== undefined) {
            return -1;
        }
        if (rightRank !== undefined) {
            return 1;
        }
        return left.localeCompare(right);
    });
};

export const resolveThinkingVariant = (
    variant: string | undefined,
    variants: readonly string[],
): string | undefined => {
    if (variants.length === 0) {
        return undefined;
    }

    const trimmed = typeof variant === 'string' ? variant.trim() : '';
    if (trimmed.length > 0) {
        const exactMatch = variants.find((entry) => entry === trimmed);
        if (exactMatch) {
            return exactMatch;
        }
        const normalizedMatch = variants.find((entry) => normalizeVariantKey(entry) === normalizeVariantKey(trimmed));
        if (normalizedMatch) {
            return normalizedMatch;
        }
    }

    return variants.find((entry) => normalizeVariantKey(entry) === 'medium') ?? variants[0];
};

export const getFastModelBaseId = (modelId: string): string => (
    modelId.endsWith(FAST_MODEL_SUFFIX)
        ? modelId.slice(0, -FAST_MODEL_SUFFIX.length)
        : modelId
);

const getPairedFastModelId = (modelId: string): string => `${getFastModelBaseId(modelId)}${FAST_MODEL_SUFFIX}`;

const hasFastVariant = (model: ProviderModelLike | undefined): boolean => (
    Boolean(model?.variants && Object.keys(model.variants).some((key) => normalizeVariantKey(key) === FAST_VARIANT_KEY))
);

const findVariantKey = (
    variants: Record<string, unknown> | undefined,
    variant: string | undefined,
): string | undefined => {
    const normalizedVariant = typeof variant === 'string' ? normalizeVariantKey(variant) : '';
    if (!variants || !normalizedVariant) {
        return undefined;
    }

    const exactMatch = Object.keys(variants).find((key) => key === variant);
    if (exactMatch) {
        return exactMatch;
    }

    return Object.keys(variants).find((key) => normalizeVariantKey(key) === normalizedVariant);
};

const getModelVariants = (model: ProviderModelLike | undefined): string[] => (
    getOrderedThinkingVariants(model?.variants)
);

export const findProviderModel = <Model extends ProviderModelLike>(
    provider: ProviderLike<Model> | undefined,
    modelId: string | undefined,
): Model | undefined => {
    if (!provider || !modelId || !Array.isArray(provider.models)) {
        return undefined;
    }
    return provider.models.find((model) => model.id === modelId);
};

export const shouldHidePairedFastModel = <Model extends ProviderModelLike>(
    provider: ProviderLike<Model> | undefined,
    modelId: string | undefined,
): boolean => {
    if (!provider || !modelId?.endsWith(FAST_MODEL_SUFFIX)) {
        return false;
    }
    return Boolean(findProviderModel(provider, getFastModelBaseId(modelId)));
};

export const getModelVariantControlState = (
    provider: ProviderLike | undefined,
    modelId: string | undefined,
    variant?: string,
): ModelVariantControlState | null => {
    if (!provider || !modelId) {
        return null;
    }

    const model = findProviderModel(provider, modelId);
    if (!model) {
        return null;
    }

    const baseModelId = getFastModelBaseId(modelId);
    const pairedFastModelId = getPairedFastModelId(modelId);
    const baseModel = baseModelId === modelId ? model : findProviderModel(provider, baseModelId);
    const pairedFastModel = pairedFastModelId === modelId ? model : findProviderModel(provider, pairedFastModelId);
    const fastEnabled = modelId.endsWith(FAST_MODEL_SUFFIX) || normalizeVariantKey(variant ?? '') === FAST_VARIANT_KEY;
    const canUsePairedFastModel = modelId.endsWith(FAST_MODEL_SUFFIX)
        ? Boolean(baseModel)
        : Boolean(pairedFastModel && pairedFastModel.id !== modelId);
    const canUseFastVariant = hasFastVariant(model);
    const visibleVariantOptions = getModelVariants(model);
    const selectedVariant = resolveThinkingVariant(
        normalizeVariantKey(variant ?? '') === FAST_VARIANT_KEY ? undefined : variant,
        visibleVariantOptions,
    );
    const canToggleFast = canUsePairedFastModel || canUseFastVariant;

    if (visibleVariantOptions.length === 0 && !canToggleFast) {
        return null;
    }

    return {
        modelId,
        baseModelId,
        fastModelId: canUsePairedFastModel ? pairedFastModelId : undefined,
        fastEnabled,
        canToggleFast,
        selectedVariant,
        visibleVariantOptions,
    };
};

export const resolveProviderModelVariant = (
    provider: ProviderLike | undefined,
    modelId: string | undefined,
    variant?: string | null,
): string | undefined => {
    const cleanedVariant = typeof variant === 'string' && variant.trim().length > 0
        ? variant.trim()
        : undefined;
    if (!provider || !modelId) {
        return cleanedVariant;
    }

    const model = findProviderModel(provider, modelId);
    if (!model) {
        return cleanedVariant;
    }

    const normalizedVariant = normalizeVariantKey(cleanedVariant ?? '');
    const thinkingVariants = getModelVariants(model);
    if (normalizedVariant === FAST_VARIANT_KEY) {
        const pairedFastModelId = getPairedFastModelId(modelId);
        const pairedFastModel = pairedFastModelId === modelId
            ? undefined
            : findProviderModel(provider, pairedFastModelId);
        if (pairedFastModel || modelId.endsWith(FAST_MODEL_SUFFIX)) {
            return resolveThinkingVariant(undefined, thinkingVariants);
        }

        const explicitFastVariant = findVariantKey(model.variants, cleanedVariant);
        if (explicitFastVariant && normalizeVariantKey(explicitFastVariant) === FAST_VARIANT_KEY) {
            return explicitFastVariant;
        }

        return resolveThinkingVariant(undefined, thinkingVariants);
    }

    const matchedVariant = findVariantKey(model.variants, cleanedVariant);
    if (matchedVariant) {
        return matchedVariant;
    }

    return resolveThinkingVariant(cleanedVariant, thinkingVariants);
};

export const getModelVariantDisplayState = (
    provider: ProviderLike | undefined,
    modelId: string | undefined,
    variant?: string,
): ModelVariantDisplayState | null => {
    if (!provider || !modelId) {
        return null;
    }

    const controlState = getModelVariantControlState(provider, modelId, variant);
    if (controlState) {
        const displayModelId = controlState.fastEnabled
            && modelId.endsWith(FAST_MODEL_SUFFIX)
            && findProviderModel(provider, controlState.baseModelId)
            ? controlState.baseModelId
            : modelId;
        return {
            displayModelId,
            fastEnabled: controlState.fastEnabled,
            selectedVariant: controlState.selectedVariant,
            visibleVariantOptions: controlState.visibleVariantOptions,
        };
    }

    const model = findProviderModel(provider, modelId);
    if (!model) {
        return null;
    }

    const visibleVariantOptions = getModelVariants(model);
    return {
        displayModelId: modelId,
        fastEnabled: normalizeVariantKey(variant ?? '') === FAST_VARIANT_KEY,
        selectedVariant: resolveThinkingVariant(variant, visibleVariantOptions),
        visibleVariantOptions,
    };
};

export const resolveModelVariantSelection = (
    provider: ProviderLike | undefined,
    modelId: string,
    variant: string | undefined,
    updates: { fastEnabled?: boolean; variant?: string },
): { modelId: string; variant?: string } => {
    const currentState = getModelVariantControlState(provider, modelId, variant);
    if (!currentState) {
        return { modelId, variant };
    }

    const pairedFastAvailable = Boolean(currentState.fastModelId);
    if (updates.fastEnabled !== undefined) {
        if (pairedFastAvailable) {
            const targetModelId = updates.fastEnabled
                ? currentState.fastModelId ?? modelId
                : currentState.baseModelId;
            const targetModel = findProviderModel(provider, targetModelId);
            const targetVariants = getModelVariants(targetModel);
            return {
                modelId: targetModelId,
                variant: resolveThinkingVariant(currentState.selectedVariant ?? variant, targetVariants),
            };
        }

        const targetVariants = currentState.visibleVariantOptions;
        return {
            modelId,
            variant: updates.fastEnabled
                ? FAST_VARIANT_KEY
                : resolveThinkingVariant(currentState.selectedVariant ?? variant, targetVariants),
        };
    }

    if (updates.variant !== undefined) {
        const resolvedVariant = resolveThinkingVariant(updates.variant, currentState.visibleVariantOptions);
        return { modelId, variant: resolvedVariant };
    }

    return {
        modelId,
        variant: resolveThinkingVariant(currentState.selectedVariant ?? variant, currentState.visibleVariantOptions),
    };
};
