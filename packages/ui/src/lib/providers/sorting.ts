import { getProviderDisplayName } from './display';

interface ProviderLike {
  id: string;
  name?: string;
}

interface ModelLike {
  id?: string;
  name?: string;
}

interface ProviderWithModels<M> extends ProviderLike {
  models?: readonly M[];
}

const PICKER_COLLATOR = new Intl.Collator(undefined, {
  sensitivity: 'base',
  numeric: true,
});

export const comparePickerLabels = (a: string, b: string): number => (
  PICKER_COLLATOR.compare(a.trim(), b.trim())
);

const getModelSortLabel = (model: ModelLike): string => (
  String(model?.name ?? model?.id ?? '')
);

export const sortProvidersByDisplayName = <T extends ProviderLike>(
  providers: readonly T[],
): T[] => (
  [...providers].sort((a, b) => {
    const labelA = getProviderDisplayName(a);
    const labelB = getProviderDisplayName(b);
    const labelComparison = comparePickerLabels(labelA, labelB);
    if (labelComparison !== 0) {
      return labelComparison;
    }
    return a.id.localeCompare(b.id);
  })
);

export const sortModelsByDisplayName = <M extends ModelLike>(
  models: readonly M[]
): M[] => (
  [...models].sort((a, b) => {
    const labelComparison = comparePickerLabels(getModelSortLabel(a), getModelSortLabel(b));
    if (labelComparison !== 0) {
      return labelComparison;
    }
    return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
  })
);

export const sortProviderTreeForPicker = <
  M extends ModelLike,
  T extends ProviderWithModels<M>,
>(
  providers: readonly T[],
): T[] => {
  const withSortedModels = providers.map((provider) => {
    const models = Array.isArray(provider.models) ? provider.models : [];
    return { ...provider, models: sortModelsByDisplayName(models) } as T;
  });
  return sortProvidersByDisplayName(withSortedModels);
};
