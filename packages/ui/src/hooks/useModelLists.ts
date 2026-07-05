import React from 'react';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { isHiddenProviderModelRef } from '@/lib/providers/modelVisibility';
import { shouldHidePairedFastModel } from '@/lib/providers/variantControls';
import type { Provider } from '@opencode-ai/sdk/v2';

type ProviderModel = Provider["models"][string];
export type ProviderWithModelList = Omit<Provider, "models"> & { models: ProviderModel[] };

export type ModelRef = {
  providerID: string;
  modelID: string;
};

export interface ModelListItem {
  provider: ProviderWithModelList;
  model: ProviderModel;
  providerID: string;
  modelID: string;
}

export const buildFavoriteModelsList = ({
  favoriteModels,
  hiddenModels,
  providers,
}: {
  favoriteModels: ModelRef[];
  hiddenModels: ModelRef[];
  providers: ProviderWithModelList[];
}): ModelListItem[] => favoriteModels
  .map(({ providerID, modelID }) => {
    const provider = providers.find((p) => p.id === providerID);
    if (!provider) return null;
    const providerModels = provider.models;
    const model = providerModels.find((m: ProviderModel) => m.id === modelID);
    if (!model) return null;
    if (isHiddenProviderModelRef(hiddenModels, providerID, model)) return null;
    if (shouldHidePairedFastModel(provider, modelID)) return null;
    return {
      provider,
      model,
      providerID,
      modelID,
    };
  })
  .filter((item): item is ModelListItem => item !== null);

export const getNextFavoriteModelRef = ({
  favoriteModels,
  currentProviderId,
  currentModelId,
  direction,
}: {
  favoriteModels: ModelRef[];
  currentProviderId: string | null | undefined;
  currentModelId: string | null | undefined;
  direction: 1 | -1;
}): ModelRef | null => {
  if (favoriteModels.length === 0) {
    return null;
  }

  const currentIndex = favoriteModels.findIndex(
    (favorite) => favorite.providerID === currentProviderId && favorite.modelID === currentModelId,
  );

  if (currentIndex === -1) {
    return direction === 1 ? favoriteModels[0] : favoriteModels[favoriteModels.length - 1];
  }

  const nextIndex = (currentIndex + direction + favoriteModels.length) % favoriteModels.length;
  return favoriteModels[nextIndex] ?? null;
};

export const useModelLists = () => {
  const providers = useConfigStore((state) => state.providers);
  const favoriteModels = useUIStore((state) => state.favoriteModels);
  const hiddenModels = useUIStore((state) => state.hiddenModels);

  const favoriteModelsList = React.useMemo(() => {
    return buildFavoriteModelsList({ favoriteModels, hiddenModels, providers });
  }, [favoriteModels, providers, hiddenModels]);

  return { favoriteModelsList };
};
