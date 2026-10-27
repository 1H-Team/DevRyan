import { createHash } from 'node:crypto';

const bytes = text => Buffer.byteLength(text);
const digest = text => createHash('sha256').update(text).digest('hex');
const MAX_HISTORY = 2048;

// Called only after canonical publication was verified. This measures delivered
// tool bytes, not provider tokens, model attention, or execution authority.
export function createNativeResultDeliveryObserver(onDiagnostic) {
  const publications = new Map(), sections = new Map();
  const remember = (map, key) => {
    map.delete(key); map.set(key, true);
    while (map.size > MAX_HISTORY) map.delete(map.keys().next().value);
  };
  return (scope, invocation, output) => {
    if (typeof onDiagnostic !== 'function') return;
    try {
      const serialized = typeof output === 'string' ? output : JSON.stringify(output), outputSha256 = digest(serialized);
      const publication = JSON.stringify([scope.rootSessionId, invocation.messageID, invocation.callID, outputSha256]);
      if (publications.has(publication)) return;
      if (typeof output === 'string') output = JSON.parse(output);
      const pending = [], rows = Array.isArray(output.results) ? output.results : [output];
      let reportBytes = 0, metadataBytes = 0, textSerializedBytes = 0, repeatedBytes = 0;
      for (const row of rows) {
        const taskId = row.task?.taskId ?? row.taskId ?? row.resultReference?.taskId ?? row.metadataReference?.taskId;
        const envelopeId = row.resultEnvelope?.envelopeId ?? row.resultReference?.envelopeId ?? row.metadataReference?.envelopeId;
        if (typeof taskId !== 'string' || typeof envelopeId !== 'string') continue;
        const add = (section, text, endBytes) => {
          if (typeof text !== 'string' || !text.length) return;
          const contentBytes = bytes(text), startBytes = endBytes - contentBytes;
          if (!Number.isSafeInteger(endBytes) || startBytes < 0) return;
          const contentSha256 = digest(text);
          const id = JSON.stringify([scope.rootSessionId, taskId, envelopeId, section, startBytes, endBytes, contentSha256]);
          const repeated = sections.has(id) || pending.some(value => value.id === id);
          if (section === 'report') reportBytes += contentBytes; else metadataBytes += contentBytes;
          textSerializedBytes += bytes(JSON.stringify(text)) - 2;
          if (repeated) repeatedBytes += contentBytes;
          pending.push({ id, payload: { taskId, envelopeId, section, startBytes, endBytes, contentBytes, contentSha256, repeated } });
        };
        for (const field of ['task', 'resultEnvelope']) {
          const text = row[field]?.recoverablePreview;
          if (typeof text === 'string') add('report', text, bytes(text));
        }
        for (const [field, section] of [['resultReference', 'report'], ['metadataReference', 'metadata']]) {
          const reference = row[field];
          if (reference) add(section, reference.text, reference.returnedBytes);
        }
      }
      // Identity-only history is bounded; eviction makes repeat counts a lower bound.
      remember(publications, publication);
      for (const item of pending) remember(sections, item.id);
      const base = { sessionID: scope.rootSessionId, messageID: invocation.messageID, callID: invocation.callID };
      onDiagnostic({ ...base, payload: { section: 'publication', outputSha256, serializedBytes: bytes(serialized), reportBytes, metadataBytes,
        framingBytes: bytes(serialized) - textSerializedBytes, repeatedBytes } });
      for (const item of pending) onDiagnostic({ ...base, payload: item.payload });
    } catch { /* Metrics never change publication, collection or recovery. */ }
  };
}
