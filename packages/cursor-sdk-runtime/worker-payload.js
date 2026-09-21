export const WORKER_PAYLOAD_LIMIT = 16 * 1024 * 1024;
export function assertWorkerPayloadBytes(bytes) {
  if (bytes > WORKER_PAYLOAD_LIMIT) throw Object.assign(new Error('payload_too_large'), { code: 'payload_too_large', status: 413 });
}
export function serializeWorkerPayload(payload) {
  const wire = JSON.stringify(payload);
  assertWorkerPayloadBytes(Buffer.byteLength(wire, 'utf8'));
  return wire;
}
