import {
  findProviderModel,
  resolveModelVariantSelection,
  resolveProviderModelVariant,
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
    variant: selection.variant,
  };
};

export const resolveAgentVariantForModel = (
  provider: ProviderLike<ProviderModelLike> | undefined,
  modelRef: string,
  variant: string | undefined,
): string | undefined => {
  const parsed = parseModelRef(modelRef);
  if (!parsed) {
    return undefined;
  }

  return resolveProviderModelVariant(provider, parsed.modelId, variant);
};

export const resolveAgentVariantForSave = (
  provider: ProviderLike<ProviderModelLike> | undefined,
  modelRef: string,
  variant: string | undefined,
): string | undefined => {
  const cleanedVariant = typeof variant === 'string' && variant.trim().length > 0
    ? variant.trim()
    : undefined;
  if (!cleanedVariant) {
    return undefined;
  }

  const parsed = parseModelRef(modelRef);
  if (!parsed || !provider) {
    return cleanedVariant;
  }

  const model = findProviderModel(provider, parsed.modelId);
  if (!model?.variants) {
    return cleanedVariant;
  }

  return findVariantKey(model.variants, cleanedVariant);
};
