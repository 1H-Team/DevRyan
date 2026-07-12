import { getExecutionProviderId, getModelDisplayName } from '@/lib/providers/antigravity';
import { sortProviderTreeForPicker } from '@/lib/providers/sorting';
import { filterVisibleProviderModelsForPicker } from '@/lib/providers/modelVisibility';
import { shouldHidePairedFastModel } from '@/lib/providers/variantControls';

type ModelLike = Record<string, unknown> & { id?: string; name?: string };

export type ControlledModelPickerProvider = Record<string, unknown> & {
  id: string;
  name?: string;
  models?: ModelLike[];
};

export type ControlledModelOption = {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  model: ModelLike;
  provider: ControlledModelPickerProvider;
};

export function getControlledModelOptions(
  providers: ControlledModelPickerProvider[],
  hiddenModels: Array<{ providerID: string; modelID: string }>,
): ControlledModelOption[] {
  const visible = sortProviderTreeForPicker(filterVisibleProviderModelsForPicker(
    providers,
    hiddenModels,
    (provider, _model, modelId) => !shouldHidePairedFastModel(provider, modelId),
  ));
  return visible.flatMap((provider) => (
    (Array.isArray(provider.models) ? provider.models : []).map((model) => ({
      providerId: getExecutionProviderId(provider.id, model),
      providerName: provider.name || provider.id,
      modelId: String(model.id ?? ''),
      modelName: getModelDisplayName(model),
      model,
      provider,
    })).filter((option) => Boolean(option.modelId))
  ));
}
