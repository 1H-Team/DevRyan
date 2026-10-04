import { createHash } from 'node:crypto';
import path from 'node:path';

const fail = (code, status = 403) => Object.assign(new Error(code), { code, status, statusCode: status });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : record(value)
  ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
export const credentialMutationFingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

/** Mutation payloads contain identities and fingerprints, never credential values. */
export function parseCredentialMutationBinding(value) {
  const fields = new Set(['directory', 'controllerInstanceID', 'integrationID', 'operation', 'credentialID',
    'expectedFingerprint', 'requestedFingerprint', 'valueType', 'methodID', 'kind', 'server', 'configurationDigest', 'acquisitionID']);
  if (!record(value) || Object.keys(value).some(key => !fields.has(key)) || typeof value.directory !== 'string'
    || !path.isAbsolute(value.directory) || value.directory.length > 4096 || /[\u0000-\u001f]/.test(value.directory)
    || !id(value.controllerInstanceID) || !id(value.integrationID) || !digest(value.requestedFingerprint)
    || !['create', 'update', 'activate', 'remove'].includes(value.operation)
    || !['key', 'oauth'].includes(value.valueType) || !['openai', 'mcp', 'cursor', 'provider'].includes(value.kind)
    || value.kind === 'cursor' && value.valueType !== 'key'
    || value.kind === 'provider' && (!['xai', 'opencode', 'opencode-go'].includes(value.integrationID)
      || value.valueType === 'oauth' && (value.integrationID !== 'xai' || value.methodID !== 'device'))
    || (value.valueType === 'oauth' ? !id(value.methodID) : value.methodID !== undefined)
    || (value.credentialID !== undefined && !id(value.credentialID))
    || (value.expectedFingerprint !== undefined && !digest(value.expectedFingerprint))
    || (value.operation === 'create' ? value.credentialID !== undefined || value.expectedFingerprint !== undefined
      : !id(value.credentialID) || !digest(value.expectedFingerprint))
    || (value.kind === 'mcp' ? typeof value.server !== 'string' || !value.server || value.server.length > 256
      || /[\u0000-\u001f]/.test(value.server) || !digest(value.configurationDigest) || !id(value.acquisitionID)
      : value.kind !== 'provider' && value.integrationID !== (value.kind === 'cursor' ? 'cursor-acp' : 'openai') || value.server !== undefined || value.configurationDigest !== undefined || value.acquisitionID !== undefined))
    throw fail('native_credential_mutation_binding_invalid');
  return Object.freeze({ ...value });
}

export function parseCredentialResolutionBinding(value) {
  const fields = ['kind', 'integrationID', 'methodID', 'controllerInstanceID', 'directory', 'acquisitionID',
    'configurationDigest', 'sessionID', 'permit', 'credentialID', 'expectedFingerprint', 'valueType'];
  if (!record(value) || Object.keys(value).some(key => !fields.includes(key))
    || value.kind !== 'provider' || !['xai','opencode','opencode-go'].includes(value.integrationID)
    || !['key','oauth'].includes(value.valueType)
    || (value.valueType === 'key' ? value.methodID !== undefined : value.integrationID !== 'xai' || value.methodID !== 'device')
    || !id(value.controllerInstanceID) || !id(value.acquisitionID) || !id(value.credentialID)
    || !/^ses[A-Za-z0-9_-]{1,128}$/.test(value.sessionID ?? '')
    || typeof value.directory !== 'string' || !path.isAbsolute(value.directory) || /[\u0000-\u001f]/.test(value.directory) || value.directory.length > 4096
    || !digest(value.configurationDigest) || !digest(value.expectedFingerprint)
    || !record(value.permit) || Object.keys(value.permit).some(key => !['token', 'sessionID', 'revision'].includes(key))
    || !digest(value.permit.token) || value.permit.sessionID !== value.sessionID
    || !Number.isSafeInteger(value.permit.revision) || value.permit.revision < 0)
    throw fail('native_credential_resolution_binding_invalid');
  return Object.freeze({ ...value, permit: Object.freeze({ ...value.permit }) });
}

/** Join the existing OAuth coordinator queue for the COMPLETE native action.
 * Reverse control settles before this span releases, even if its HTTP caller aborts. */
export function createNativeCredentialMutationOwner({ controllerInstanceID, withMutationQueue, resolveAuthorization, verifyBinding, commitOwned, withResolution }) {
  if (!id(controllerInstanceID) || [withMutationQueue, resolveAuthorization, verifyBinding, commitOwned].some(value => typeof value !== 'function'))
    throw fail('native_credential_mutation_owner_invalid');
  let closed = false;
  const activeCalls = new Set(), recentCalls = new Set(), pending = new Set();
  const assertLive = signal => { if (closed || signal?.aborted) throw fail('native_credential_mutation_closed', 503); };
  const handleRpc = (method, input, context = {}) => {
    if (!['credential.mutation.commit', 'credential.resolution.commit'].includes(method)) return Promise.reject(fail('native_credential_mutation_operation_invalid'));
    try {
      assertLive(context.signal);
      if (!record(input) || Object.keys(input).some(key => !['callID', 'controllerInstanceID', 'binding', 'bindingFingerprint', 'authorizationID'].includes(key))
        || !id(input.callID) || !id(input.authorizationID) || input.controllerInstanceID !== controllerInstanceID)
        throw fail('native_credential_mutation_request_invalid');
      const resolution = method === 'credential.resolution.commit';
      const binding = resolution ? parseCredentialResolutionBinding(input.binding) : parseCredentialMutationBinding(input.binding);
      if (binding.controllerInstanceID !== controllerInstanceID || input.bindingFingerprint !== credentialMutationFingerprint(binding))
        throw fail('native_credential_mutation_binding_invalid');
      if (activeCalls.has(input.callID) || recentCalls.has(input.callID)) throw fail('native_credential_mutation_replayed');
      if (activeCalls.size >= 4096) throw fail('native_credential_mutation_capacity', 503);
      activeCalls.add(input.callID);
      const settled = () => {
        activeCalls.delete(input.callID);
        recentCalls.add(input.callID);
        if (recentCalls.size > 4096) recentCalls.delete(recentCalls.values().next().value);
      };
      let work;
      try { work = withMutationQueue(async () => {
        assertLive(context.signal);
        if (resolution) {
          if (typeof withResolution !== 'function' || input.authorizationID !== input.callID) throw fail('native_credential_resolution_authorization_required');
          return withResolution(binding, async () => {
            assertLive(context.signal);
            await commitOwned({ callID: input.callID, controllerInstanceID, bindingFingerprint: input.bindingFingerprint });
            assertLive(context.signal); return null;
          });
        }
        const grant = await resolveAuthorization({ authorizationID: input.authorizationID, binding });
        if (!grant || typeof grant.reauthorize !== 'function') throw fail('native_credential_mutation_authorization_required');
        await grant.reauthorize(); assertLive(context.signal);
        await verifyBinding(binding); assertLive(context.signal);
        await grant.reauthorize(); assertLive(context.signal);
        // Deliberately no Promise.race(signal): a started reverse action owns the
        // queue until its native Effect AND finalizers have actually settled.
        await commitOwned({ callID: input.callID, controllerInstanceID, bindingFingerprint: input.bindingFingerprint });
        assertLive(context.signal);
        return null;
      }); } catch (error) { settled(); throw error; }
      pending.add(work);
      // Evict only settled replay receipts. Native reverse actions themselves
      // remain single-use in the bridge pending map, even after this eviction.
      void work.finally(() => { pending.delete(work); settled(); }).catch(() => {});
      return work;
    } catch (error) { return Promise.reject(error); }
  };
  const invalidate = async () => {
    closed = true;
    await Promise.allSettled([...pending]);
  };
  return { handleRpc, invalidate, close: invalidate };
}
