export type ProviderModelAvailability = {
  available?: boolean;
  unavailableReason?: 'auth_type_unsupported' | 'runtime_unsupported' | 'account_models_unavailable' | 'plan_usage_disabled' | 'reauthorization_required';
  requiredAuthType?: 'api';
};

/** Provider-level fields the server adds when it annotates ChatGPT account models. */
export type ProviderAccountModelFields = {
  authType?: string;
  accountModelsStatus?: 'available' | 'unavailable';
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

export const getProviderModelUnavailability = (
  model: unknown,
): { message: string; retryable: boolean } | undefined => {
  const message = getProviderModelUnavailableMessage(model);
  if (message === undefined) return undefined;
  const reason = (model as ProviderModelAvailability).unavailableReason;
  return { message, retryable: reason === 'account_models_unavailable' };
};

export const getProviderModelUnavailableMessage = (
  model: unknown,
): string | undefined => {
  if (isProviderModelAvailable(model)) return undefined;
  const availability = model as ProviderModelAvailability;
  if (availability.unavailableReason === 'account_models_unavailable') {
    return 'ChatGPT account models could not be loaded. Retry before choosing a model.';
  }
  if (availability.unavailableReason === 'plan_usage_disabled') {
    return 'You are signed in, but ChatGPT plan usage is disabled. Authorize plan usage or explicitly choose API-key authentication in Providers.';
  }
  if (availability.unavailableReason === 'reauthorization_required') {
    return 'Reconnect with Sign in with ChatGPT in Providers to use ChatGPT plan usage.';
  }
  if (availability.unavailableReason === 'auth_type_unsupported' && availability.requiredAuthType === 'api') {
    return 'This model is unavailable with Sign in with ChatGPT. Connect OpenAI with an API key to use it.';
  }
  return 'This model is unavailable for the connected provider.';
};
