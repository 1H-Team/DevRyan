// Historical request parsing only; no runtime launch.
const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings)
  : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const objects = value => Array.isArray(value) ? value.flatMap(objects) : value && typeof value === 'object'
  ? [value, ...Object.values(value).flatMap(objects)] : [];
export const inspectDuplicateRequest = (body, raw) => {
  const values = strings(body);
  const outputs = objects(body).filter(value => value.type === 'function_call_output');
  const calls = new Set(objects(body).filter(value => value.type === 'function_call').map(value => value.call_id));
  const references = values.filter(value => value.startsWith('{') && value.includes('"observation":"identical-managed-result"'))
    .map(value => { const parsed = JSON.parse(value); return { taskId: parsed.taskId, envelopeId: parsed.envelopeId, reference: parsed.reference }; });
  return { bytes: Buffer.byteLength(raw), skillReferences: values.filter(value => value.includes('<devryan_skill_reuse>')).length,
    managedReferences: values.filter(value => value.includes('"observation":"identical-managed-result"')).length,
    skillEvidence: values.some(value => value.includes('SKILL_UNIQUE_SENTINEL')),
    managedEvidence: values.some(value => value.includes('MANAGED_UNIQUE_SENTINEL')),
    uniqueEvidence: values.some(value => value.includes('UNIQUE_EVIDENCE_RETAINED')),
    callPairsIntact: outputs.every(value => calls.has(value.call_id)),
    referencesResolve: references.every(ref => outputs.some(value => value.call_id === ref.reference?.callID && strings(value.output).some(text => {
      try { const source = JSON.parse(text); return source.task?.taskId === ref.taskId && source.resultHeader?.envelopeId === ref.envelopeId && text.includes('MANAGED_UNIQUE_SENTINEL'); }
      catch { return false; }
    }))), references };
};

export async function runDuplicateSerializerProbe() {
  throw Object.assign(new Error('The v1 duplicate serializer runtime probe is retired; use native v2 qualification'),
    { code: 'qa_native_diagnostic_unavailable' });
}
