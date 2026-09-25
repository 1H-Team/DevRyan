type ProviderModelLike = Record<string, unknown> & {
  id?: string;
  providerID?: string;
  providerId?: string;
  name?: string;
};

const getModelProviderId = (model: ProviderModelLike): string => (
  typeof model.providerID === 'string'
    ? model.providerID
    : (typeof model.providerId === 'string' ? model.providerId : '')
);

export const getModelDisplayName = (model: ProviderModelLike): string => (
  typeof model.name === 'string' && model.name.length > 0
    ? model.name
    : (typeof model.id === 'string' ? model.id : '')
);

// A model may run under a different provider than the list it is shown in;
// its own provider id wins over the containing provider's.
export const getExecutionProviderId = (
  providerId: string,
  model: ProviderModelLike,
): string => getModelProviderId(model) || providerId;
