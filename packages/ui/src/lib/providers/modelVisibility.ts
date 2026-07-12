import {
  getDisplayProviderId,
  splitAntigravityProviderForDisplay,
} from './antigravity';
import { isProviderModelAvailable } from './modelAvailability';

export type HiddenModelRef = {
  providerID: string;
  modelID: string;
};

type ProviderModelLike = Record<string, unknown> & {
  id?: string;
  providerID?: string;
  providerId?: string;
};

type ProviderLike<TModel extends ProviderModelLike = ProviderModelLike> = Record<string, unknown> & {
  id?: string;
  models?: TModel[];
};

export type HiddenModelRefs = {
  canonical: HiddenModelRef | null;
  aliases: HiddenModelRef[];
};

const normalizeID = (value: string | null | undefined): string => (
  typeof value === 'string' ? value.trim() : ''
);

const getModelProviderID = (model: ProviderModelLike): string => {
  const providerID = normalizeID(model.providerID);
  return providerID || normalizeID(model.providerId);
};

const addHiddenModelRef = (
  refs: HiddenModelRef[],
  seen: Set<string>,
  providerID: string,
  modelID: string,
) => {
  if (!providerID || !modelID) {
    return;
  }

  const key = `${providerID}/${modelID}`;
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  refs.push({ providerID, modelID });
};

export const getHiddenModelRefsForProviderModel = (
  providerID: string | null | undefined,
  model: ProviderModelLike | null | undefined,
): HiddenModelRefs => {
  if (!model) {
    return { canonical: null, aliases: [] };
  }

  const modelID = normalizeID(model.id);
  if (!modelID) {
    return { canonical: null, aliases: [] };
  }

  const requestedProviderID = normalizeID(providerID);
  const modelProviderID = getModelProviderID(model);
  const executionProviderID = modelProviderID || requestedProviderID;
  const displayProviderID = requestedProviderID
    ? getDisplayProviderId(requestedProviderID, model)
    : (executionProviderID ? getDisplayProviderId(executionProviderID, model) : '');
  const canonicalProviderID = displayProviderID || requestedProviderID || executionProviderID;

  const aliases: HiddenModelRef[] = [];
  const seen = new Set<string>();
  addHiddenModelRef(aliases, seen, canonicalProviderID, modelID);
  addHiddenModelRef(aliases, seen, requestedProviderID, modelID);
  addHiddenModelRef(aliases, seen, executionProviderID, modelID);
  addHiddenModelRef(aliases, seen, modelProviderID, modelID);
  addHiddenModelRef(aliases, seen, displayProviderID, modelID);

  return {
    canonical: canonicalProviderID ? { providerID: canonicalProviderID, modelID } : null,
    aliases,
  };
};

export const isHiddenModelRef = (
  hiddenModels: HiddenModelRef[],
  providerID: string | null | undefined,
  modelID: string | null | undefined,
): boolean => {
  const normalizedProviderID = typeof providerID === 'string' ? providerID.trim() : '';
  const normalizedModelID = typeof modelID === 'string' ? modelID.trim() : '';

  if (!normalizedProviderID || !normalizedModelID) {
    return false;
  }

  return hiddenModels.some(
    (hidden) => hidden.providerID === normalizedProviderID && hidden.modelID === normalizedModelID,
  );
};

export const isHiddenProviderModelRef = (
  hiddenModels: HiddenModelRef[],
  providerID: string | null | undefined,
  model: ProviderModelLike | null | undefined,
): boolean => {
  const { aliases } = getHiddenModelRefsForProviderModel(providerID, model);
  return aliases.some((ref) => isHiddenModelRef(hiddenModels, ref.providerID, ref.modelID));
};

export const filterHiddenProviderModels = <
  TModel extends ProviderModelLike,
  TProvider extends ProviderLike<TModel>,
>(
  providers: TProvider[],
  hiddenModels: HiddenModelRef[],
  shouldKeepModel?: (provider: TProvider, model: TModel, modelID: string) => boolean,
): TProvider[] => providers
  .map((provider) => {
    const providerID = typeof provider.id === 'string' ? provider.id : '';
    const providerModels = Array.isArray(provider.models) ? provider.models : [];
    const visibleModels = providerModels.filter((model) => {
      const modelID = typeof model?.id === 'string' ? model.id : '';
      return !isHiddenProviderModelRef(hiddenModels, providerID, model)
        && (shouldKeepModel ? shouldKeepModel(provider, model, modelID) : true);
    });

    return { ...provider, models: visibleModels };
  })
  .filter((provider) => provider.models.length > 0);

export const filterVisibleProviderModelsForPicker = <
  TModel extends ProviderModelLike,
  TProvider extends ProviderLike<TModel>,
>(
  providers: TProvider[],
  hiddenModels: HiddenModelRef[],
  shouldKeepModel?: (provider: TProvider, model: TModel, modelID: string) => boolean,
): TProvider[] => filterHiddenProviderModels<TModel, TProvider>(
  splitAntigravityProviderForDisplay<TModel, TProvider>(providers),
  hiddenModels,
  (provider, model, modelID) => (
    isProviderModelAvailable(model)
    && (shouldKeepModel ? shouldKeepModel(provider, model, modelID) : true)
  ),
);
