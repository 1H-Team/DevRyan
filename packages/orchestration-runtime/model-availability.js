const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const text = (value) => (typeof value === 'string' ? value.trim() : '');

export const isManagedModelAvailableInCatalog = (payload, providerId, modelId) => {
  const provider = text(providerId);
  const model = text(modelId);
  if (!provider || !model) return false;
  const unwrapped = isRecord(payload) && 'data' in payload ? payload.data : payload;
  if (!isRecord(unwrapped) || !Array.isArray(unwrapped.providers)) return null;
  const providerEntry = unwrapped.providers.find((entry) => (
    isRecord(entry) && text(entry.id ?? entry.providerID ?? entry.providerId) === provider
  ));
  if (!providerEntry) return false;
  const models = providerEntry.models;
  if (Array.isArray(models)) {
    return models.some((entry) => (
      isRecord(entry)
      && text(entry.id ?? entry.modelID ?? entry.modelId) === model
      && entry.available !== false
    ));
  }
  if (isRecord(models)) {
    const entry = models[model];
    return entry !== undefined && (!isRecord(entry) || entry.available !== false);
  }
  return null;
};
