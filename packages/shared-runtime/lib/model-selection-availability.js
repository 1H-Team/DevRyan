const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const unknown = () => ({ status: 'unknown', reason: 'catalog_unavailable' });
const unavailable = reason => ({ status: 'unavailable', reason });

/** Inspect capability evidence without changing the requested selection or asserting credentials. */
export function inspectModelSelection(selection, catalog, { variantsComplete = true } = {}) {
  if (!record(catalog) || !Array.isArray(catalog.providers)) return unknown();
  const provider = catalog.providers.find(row => record(row)
    && (row.id ?? row.providerID ?? row.providerId) === selection.providerID);
  if (!provider) return unavailable('provider_missing');
  const models = provider.models;
  let model;
  if (Array.isArray(models)) model = models.find(row => record(row)
    && (row.id ?? row.modelID ?? row.modelId) === selection.modelID);
  else if (record(models)) model = models[selection.modelID];
  else return unknown();
  if (!record(model) || model.available === false) return unavailable('model_missing');
  const variant = selection.variant;
  if (variant === undefined || variant === null || variant === '' || variant === 'default') {
    return { status: 'available', reason: null };
  }
  const variants = model.variants;
  const present = Array.isArray(variants)
    ? variants.some(row => typeof row === 'string' ? row === variant : record(row) && row.id === variant)
    : record(variants) && Object.hasOwn(variants, variant);
  if (present) return { status: 'available', reason: null };
  return variantsComplete ? unavailable('variant_missing') : unknown();
}
