import { isProviderModelAvailable } from '@/lib/providers/modelAvailability';
import { sortModelsByDisplayName } from '@/lib/providers/sorting';
import { shouldHidePairedFastModel } from '@/lib/providers/variantControls';

export { sortProvidersByDisplayName } from '@/lib/providers/sorting';

interface ProviderModelLike {
  id?: string;
  name?: string;
}

interface ProviderWithModels<M> {
  id?: string;
  models?: readonly M[];
}

interface ProviderModelsDisplayOptions {
  hidePairedFastModels?: boolean;
  hideUnavailable?: boolean;
}

export const getProviderModelsForDisplay = <M extends ProviderModelLike>(
  provider: ProviderWithModels<M>,
  options: ProviderModelsDisplayOptions = {},
): M[] => {
  const models = Array.isArray(provider.models) ? provider.models : [];
  const availableModels = options.hideUnavailable
    ? models.filter(isProviderModelAvailable)
    : models;
  const visibleModels = options.hidePairedFastModels
    ? availableModels.filter((model) => !shouldHidePairedFastModel(provider, model.id))
    : availableModels;
  return sortModelsByDisplayName(visibleModels);
};
