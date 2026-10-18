import { inspectModelSelection } from '../shared-runtime/lib/model-selection-availability.js';

const identifier = input => typeof input === 'string' ? input.slice(0, 180).replace(/[\x00-\x1f\x7f]/g, '').trim() : null;
const supportedVariants = value => Array.isArray(value)
  ? [...new Set(value.filter(row => typeof row === 'string').map(identifier).filter(Boolean))].slice(0, 16) : [];

export const inspectManagedModelInCatalog = (payload, providerId, modelId, variant) => {
  if (typeof providerId !== 'string' || !providerId.trim() || typeof modelId !== 'string' || !modelId.trim()) {
    return { status: 'unavailable', reason: 'model_missing' };
  }
  const catalog = payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;
  const result = inspectModelSelection({ providerID: providerId.trim(), modelID: modelId.trim(), variant }, catalog);
  if (result.reason !== 'variant_missing') return result;
  const provider = catalog.providers.find(row => (row?.id ?? row?.providerID ?? row?.providerId) === providerId.trim());
  const model = Array.isArray(provider.models)
    ? provider.models.find(row => (row?.id ?? row?.modelID ?? row?.modelId) === modelId.trim()) : provider.models[modelId.trim()];
  const variants = Array.isArray(model.variants)
    ? model.variants.map(row => typeof row === 'string' ? row : row?.id) : Object.keys(model.variants ?? {});
  return { ...result, supportedVariants: supportedVariants(variants),
    ...(identifier(model.name) ? { modelName: identifier(model.name) } : {}) };
};

export const isManagedModelAvailableInCatalog = (payload, providerId, modelId, variant) => {
  const result = inspectManagedModelInCatalog(payload, providerId, modelId, variant);
  return result.status === 'unknown' ? null : result.status === 'available';
};

/** Only these model-admission details may cross private tool transports. */
export const projectManagedModelValidationFailure = (value) => {
  if (!['managed_agent_model_unavailable', 'managed_agent_model_availability_unknown'].includes(value?.code)
    || !['provider_missing', 'model_missing', 'variant_missing', 'selection_unavailable', 'catalog_unavailable'].includes(value?.details?.reason)) return null;
  const details = { reason: value.details.reason, providerId: identifier(value.details.providerId),
    modelId: identifier(value.details.modelId), variant: identifier(value.details.variant),
    ...(identifier(value.details.agent) ? { agent: identifier(value.details.agent) } : {}),
    ...(identifier(value.details.modelName) ? { modelName: identifier(value.details.modelName) } : {}),
    ...(Array.isArray(value.details.supportedVariants) ? { supportedVariants: supportedVariants(value.details.supportedVariants) } : {}) };
  const model = details.modelName ?? `${details.providerId}/${details.modelId}`;
  const message = details.reason === 'variant_missing'
    ? `${details.agent ?? 'Managed agent'} cannot start: ${details.variant} is unsupported for ${model}. Choose ${details.supportedVariants?.length ? details.supportedVariants.join(', ') : 'a supported variant'} or Provider default in Agents settings.`
    : `Managed selection could not be verified: ${details.providerId}/${details.modelId}${details.variant ? ` (${details.variant})` : ''}.`;
  return { code: value.code, details,
    message };
};
