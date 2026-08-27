import type {
  BotCredentialMetadata,
  BotModelBinding,
  BotModelOption,
  BotModelOptions,
  BotProviderOption,
} from '@/lib/botsApi';

export const BOT_MODEL_UNSELECTED = '__unselected__';

const unavailableProvider = (binding: BotModelBinding): BotProviderOption => ({
  id: binding.providerId || BOT_MODEL_UNSELECTED,
  name: binding.providerId || 'Select provider',
  available: false,
  authType: null,
  connections: [],
  models: binding.modelId ? [{
    id: binding.modelId,
    name: binding.modelId,
    providerId: binding.providerId,
    available: false,
    variants: binding.variant ? [{ id: binding.variant, name: binding.variant, available: false }] : [],
    contextLimit: null,
    reviewedEgressHosts: binding.egressHosts,
    egressReviewed: binding.egressHosts.length > 0,
  }] : [],
});

export const botProviderOptionsFor = (
  modelOptions: BotModelOptions | null,
  binding: BotModelBinding,
): readonly BotProviderOption[] => {
  const providers = [...(modelOptions?.providers ?? [])];
  if (binding.providerId && !providers.some((provider) => provider.id === binding.providerId)) {
    providers.unshift(unavailableProvider(binding));
  }
  return providers;
};

export const botModelOptionsFor = (
  provider: BotProviderOption | undefined,
  binding: BotModelBinding,
): readonly BotModelOption[] => {
  const models = [...(provider?.models ?? [])];
  if (binding.modelId && !models.some((model) => model.id === binding.modelId)) {
    const unavailableModel = unavailableProvider(binding).models[0];
    if (unavailableModel) models.unshift(unavailableModel);
  }
  return models;
};

export const compatibleBotCredentials = (
  credentials: readonly BotCredentialMetadata[],
  providerId: string,
): readonly BotCredentialMetadata[] => credentials.filter((credential) => (
  credential.provider === providerId && credential.status === 'active'
));

export const updateBotModelProvider = ({
  binding,
  providerId,
  providers,
  credentials,
}: {
  binding: BotModelBinding;
  providerId: string;
  providers: readonly BotProviderOption[];
  credentials: readonly BotCredentialMetadata[];
}): BotModelBinding => {
  const provider = providers.find((candidate) => candidate.id === providerId);
  const currentModel = provider?.models.find((model) => model.id === binding.modelId);
  const currentCredential = credentials.find((credential) => (
    credential.id === binding.credentialId
    && credential.provider === providerId
    && credential.status === 'active'
  ));
  return {
    ...binding,
    providerId,
    modelId: currentModel?.id ?? '',
    credentialId: currentCredential?.id ?? '',
    egressHosts: currentModel?.reviewedEgressHosts ?? [],
    ...(currentModel?.variants.some((variant) => variant.id === binding.variant)
      ? { variant: binding.variant }
      : { variant: undefined }),
  };
};

export const updateBotModelSelection = (
  binding: BotModelBinding,
  modelId: string,
  models: readonly BotModelOption[],
): BotModelBinding => {
  const model = models.find((candidate) => candidate.id === modelId);
  return {
    ...binding,
    modelId,
    egressHosts: model?.reviewedEgressHosts ?? [],
    ...(model?.variants.some((variant) => variant.id === binding.variant)
      ? { variant: binding.variant }
      : { variant: undefined }),
  };
};

export const reorderBotModelFallbacks = (
  fallbacks: readonly BotModelBinding[],
  index: number,
  offset: -1 | 1,
): readonly BotModelBinding[] => {
  const target = index + offset;
  if (target < 0 || target >= fallbacks.length) return fallbacks;
  const next = [...fallbacks];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
};
