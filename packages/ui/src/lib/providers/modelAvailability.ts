export type ProviderModelAvailability = {
  available?: boolean;
  unavailableReason?: 'auth_type_unsupported' | 'runtime_unsupported';
  requiredAuthType?: 'api';
};

export const isProviderModelAvailable = (
  model: unknown,
): boolean => !model || typeof model !== 'object' || (model as ProviderModelAvailability).available !== false;

type ProviderWithAvailabilityModels = {
  id: string;
  models?: Array<{ id: string } & ProviderModelAvailability>;
};

export const resolveAvailableProviderModel = (
  providers: readonly ProviderWithAvailabilityModels[],
  preferredProviderId?: string | null,
  preferredModelId?: string | null,
): { providerId: string; modelId: string } | null => {
  const preferredProvider = providers.find((provider) => provider.id === preferredProviderId);
  const preferredModel = preferredProvider?.models?.find(
    (model) => model.id === preferredModelId && isProviderModelAvailable(model),
  );
  if (preferredProvider && preferredModel) {
    return { providerId: preferredProvider.id, modelId: preferredModel.id };
  }

  const sameProviderFallback = preferredProvider?.models?.find(isProviderModelAvailable);
  if (preferredProvider && sameProviderFallback) {
    return { providerId: preferredProvider.id, modelId: sameProviderFallback.id };
  }

  for (const provider of providers) {
    const model = provider.models?.find(isProviderModelAvailable);
    if (model) {
      return { providerId: provider.id, modelId: model.id };
    }
  }

  return null;
};

export const getProviderModelUnavailableMessage = (
  model: unknown,
): string | undefined => {
  if (isProviderModelAvailable(model)) return undefined;
  const availability = model as ProviderModelAvailability;
  if (availability.unavailableReason === 'auth_type_unsupported' && availability.requiredAuthType === 'api') {
    return 'This model is unavailable with ChatGPT/Codex OAuth. Connect OpenAI with an API key to use it.';
  }
  return 'This model is unavailable for the connected provider.';
};
