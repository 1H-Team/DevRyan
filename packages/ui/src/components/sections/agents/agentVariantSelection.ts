import {
  findProviderModel,
  resolveModelVariantSelection,
  type ProviderLike,
  type ProviderModelLike,
} from '@/lib/providers/variantControls';

type VariantSelectionUpdate = {
  fastEnabled?: boolean;
  variant?: string;
};

type ParsedModelRef = {
  providerId: string;
  modelId: string;
};

const parseModelRef = (modelRef: string): ParsedModelRef | null => {
  const trimmed = modelRef.trim();
  if (!trimmed) {
    return null;
  }

  const [providerId, ...modelParts] = trimmed.split('/');
  const modelId = modelParts.join('/');
  if (!providerId || !modelId) {
    return null;
  }

  return { providerId, modelId };
};

const normalizeVariantKey = (variant: string) => variant.trim().toLowerCase();

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

export const resolveAgentVariantSelection = (
  provider: ProviderLike | undefined,
  modelRef: string,
  variant: string | undefined,
  updates: VariantSelectionUpdate,
): { modelRef: string; variant?: string } => {
  const parsed = parseModelRef(modelRef);
  if (!parsed) {
    return { modelRef, variant };
  }

  const selection = resolveModelVariantSelection(provider, parsed.modelId, variant, updates);
  return {
    modelRef: `${parsed.providerId}/${selection.modelId}`,
    // A fast-model toggle must not discard an effort the destination lacks.
    // Keep it visible so the user can choose a supported effort or default.
    variant: updates.fastEnabled !== undefined && selection.modelId !== parsed.modelId
      && variant && normalizeVariantKey(variant) !== 'fast'
      ? resolveAgentVariantForModel(provider, `${parsed.providerId}/${selection.modelId}`, variant)
      : selection.variant,
  };
};

export const resolveAgentVariantForModel = (
  provider: ProviderLike<ProviderModelLike> | undefined,
  modelRef: string,
  variant: string | undefined,
): string | undefined => {
  const parsed = parseModelRef(modelRef);
  if (!parsed) {
    return variant?.trim() || undefined;
  }

  const cleanedVariant = variant?.trim() || undefined;
  if (cleanedVariant === 'default') return undefined;
  return findVariantKey(findProviderModel(provider, parsed.modelId)?.variants, cleanedVariant) ?? cleanedVariant;
};

export const getAgentVariantSelectionError = (
  provider: ProviderLike<ProviderModelLike> | undefined,
  modelRef: string,
  variant: string | undefined,
): string | undefined => {
  const parsed = parseModelRef(modelRef);
  const model = parsed && provider?.id === parsed.providerId ? findProviderModel(provider, parsed.modelId) : undefined;
  if (!parsed || !model || ('available' in model && model.available === false)) {
    return 'Model availability is not confirmed. Refresh the model catalog or choose an available model before saving.';
  }
  const cleanedVariant = variant?.trim();
  if (cleanedVariant && cleanedVariant !== 'default' && !findVariantKey(model.variants, cleanedVariant)) {
    return `Thinking level “${cleanedVariant}” is unavailable for this model. Choose a supported thinking level or Provider default before saving.`;
  }
  return undefined;
};

export const resolveAgentVariantForSave = (
  provider: ProviderLike<ProviderModelLike> | undefined,
  modelRef: string,
  variant: string | undefined,
): string | undefined => {
  const error = getAgentVariantSelectionError(provider, modelRef, variant);
  if (error) throw new Error(error);
  return resolveAgentVariantForModel(provider, modelRef, variant);
};
