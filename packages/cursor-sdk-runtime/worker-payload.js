export const WORKER_PAYLOAD_LIMIT = 16 * 1024 * 1024;
export function assertWorkerPayloadBytes(bytes) {
  if (bytes > WORKER_PAYLOAD_LIMIT) throw Object.assign(new Error('payload_too_large'), { code: 'payload_too_large', status: 413 });
}
export function serializeWorkerPayload(payload) {
  const wire = JSON.stringify(payload);
  assertWorkerPayloadBytes(Buffer.byteLength(wire, 'utf8'));
  return wire;
}

export function cursorReadOnlyOptions(readOnly) {
  if (readOnly !== undefined && typeof readOnly !== 'boolean') throw new Error('cursor_worker_readonly_invalid');
  return readOnly === true ? { tools: ['read', 'grep', 'glob', 'ls'], disallowedTools: ['task', 'mcp'] } : {};
}

export function cursorCatalogModels(models) {
  if (!Array.isArray(models)) throw new Error('cursor_model_catalog_invalid');
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = value => typeof value === 'string' ? value : '';
  const projected = models.filter(model => record(model) && text(model.id).trim()).map(model => ({
    id: model.id, displayName: text(model.displayName), name: text(model.name), description: text(model.description),
    variants: (Array.isArray(model.variants) ? model.variants : []).filter(record).map(variant => ({
      isDefault: variant.isDefault === true,
      params: (Array.isArray(variant.params) ? variant.params : []).filter(param => record(param)
        && typeof param.id === 'string' && typeof param.value === 'string').map(({ id, value }) => ({ id, value })),
    })),
  }));
  serializeWorkerPayload(projected);
  return projected;
}
