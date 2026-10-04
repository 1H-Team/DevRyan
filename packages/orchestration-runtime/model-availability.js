import { inspectModelSelection } from '../shared-runtime/lib/model-selection-availability.js';

export const isManagedModelAvailableInCatalog = (payload, providerId, modelId, variant) => {
  if (typeof providerId !== 'string' || !providerId.trim() || typeof modelId !== 'string' || !modelId.trim()) return false;
  const catalog = payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;
  const result = inspectModelSelection({ providerID: providerId.trim(), modelID: modelId.trim(), variant }, catalog);
  return result.status === 'unknown' ? null : result.status === 'available';
};
