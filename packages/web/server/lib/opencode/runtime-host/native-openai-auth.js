import crypto from 'node:crypto';
import path from 'node:path';
import { OpenAiOAuthError, openAiAccountId } from '../openai-oauth-coordinator.js';
import { CHATGPT_SIWC_METHOD_ID, isSupportedOpenAiOAuthMethodId } from '../chatgpt-siwc.js';

const ordered = value => Array.isArray(value) ? value.map(ordered)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
const unavailable = () => new OpenAiOAuthError('native_openai_owner_unavailable');

/** The original Credential record stays private; no auth.json mirror is made. */
export function createNativeOpenAiAuth({ directory, readSelected, compareAndSwapSelected, controllerIdentity }) {
  if (!path.isAbsolute(directory)) throw unavailable();
  const evidence = new WeakMap();
  const imageEvidence = new WeakMap();
  const identity = () => {
    const id = controllerIdentity();
    if (typeof id !== 'string' || !id) throw unavailable();
    return id;
  };
  const read = async selectedDirectory => {
    if (!path.isAbsolute(selectedDirectory)) throw unavailable();
    const id = identity(), selected = await readSelected({ directory: selectedDirectory });
    if (identity() !== id) throw unavailable();
    if (!selected) return undefined;
    if (selected.controllerInstanceID !== id || selected.directory !== selectedDirectory
      || selected.integrationID !== 'openai' || typeof selected.credentialID !== 'string' || !selected.credentialID) throw unavailable();
    const copy = structuredClone(selected), value = copy.value;
    if (value?.type === 'key') {
      if (typeof value.key !== 'string' || !value.key) throw unavailable();
      return copy;
    }
    if (value?.type !== 'oauth' || !isSupportedOpenAiOAuthMethodId(value.methodID)) {
      throw new OpenAiOAuthError('native_openai_method_unsupported', 401);
    }
    if (typeof value.access !== 'string' || typeof value.refresh !== 'string'
      || !Number.isSafeInteger(value.expires)) throw unavailable();
    return copy;
  };
  const normalize = selected => {
    if (!selected) return undefined;
    const value = selected.value;
    const auth = value.type === 'key' ? { type: 'api', key: value.key }
      : { type: 'oauth', access: value.access, refresh: value.refresh, expires: value.expires,
        accountId: typeof value.metadata?.accountID === 'string' ? value.metadata.accountID : undefined,
        clientId: typeof value.metadata?.clientId === 'string' ? value.metadata.clientId : undefined,
        scopes: Array.isArray(value.metadata?.scopes) ? value.metadata.scopes : undefined,
        idToken: typeof value.metadata?.idToken === 'string' ? value.metadata.idToken : undefined,
        metadata: value.metadata,
        credentialID: selected.credentialID, methodID: value.methodID };
    const sealed = Object.freeze(auth);
    evidence.set(sealed, selected);
    return sealed;
  };
  const asyncStorage = Object.freeze({
    isActive: () => Boolean(controllerIdentity()),
    readAuth: async () => normalize(await read(directory)),
    compareAndSwap: async (expected, next) => {
      const selected = evidence.get(expected);
      if (!selected || selected.value.type !== 'oauth' || identity() !== selected.controllerInstanceID) return false;
      // The coordinator invokes CAS while it owns its existing mutation queue.
      // The controller callback uses captured Credential directly, never gates
      // itself back through that same queue.
      const current = await read(selected.directory);
      if (!current || digest(current) !== digest(selected) || identity() !== selected.controllerInstanceID) return false;
      if (next?.type !== 'oauth' || next.credentialID !== expected.credentialID || next.methodID !== expected.methodID
        || next.accountId !== expected.accountId || typeof next.access !== 'string' || !next.access
        || typeof next.refresh !== 'string' || !next.refresh || !Number.isSafeInteger(next.expires)) throw unavailable();
      const metadata = {
        ...(selected.value.metadata && typeof selected.value.metadata === 'object' ? selected.value.metadata : {}),
        ...(next.metadata && typeof next.metadata === 'object' ? next.metadata : {}),
        ...(next.clientId ? { clientId: next.clientId } : {}),
        ...(next.idToken ? { idToken: next.idToken } : {}),
        ...(Array.isArray(next.scopes) ? { scopes: next.scopes } : {}),
      };
      const value = { ...selected.value, access: next.access, refresh: next.refresh, expires: next.expires,
        ...(Object.keys(metadata).length ? { metadata } : {}) };
      const saved = await compareAndSwapSelected({ directory: selected.directory, expected: selected, next: value });
      if (identity() !== selected.controllerInstanceID) throw unavailable();
      return saved === true;
    },
  });
  return Object.freeze({ asyncStorage,
    async imageAccess(input) {
      const selected = await read(input.directory);
      if (!selected) return undefined;
      if (selected.value.type === 'oauth') {
        // Images must refuse SIWC before entering the refresh coordinator.
        throw new OpenAiOAuthError('native_image_generation_siwc_unsupported', 409);
      }
      const access = Object.freeze({ valueType: 'key', methodID: 'api-key',
        credentialID: selected.credentialID, accessToken: selected.value.key,
        generation: digest(selected) });
      imageEvidence.set(access, selected);
      return access;
    },
    async recheckImageAccess(access, input) {
      const expected = imageEvidence.get(access);
      if (!expected || expected.directory !== input.directory || identity() !== expected.controllerInstanceID) throw unavailable();
      const current = await read(input.directory);
      if (!current || digest(current) !== digest(expected)) {
        throw new OpenAiOAuthError('native_image_generation_credential_changed', 409);
      }
    },
    async access(coordinator, input) {
      // Native credential selection is global. The location remains explicit so
      // the controller can prove the integration under the exact project scope.
      const before = await read(input.directory);
      if (!before || before.value.type === 'key') return undefined;
      if (input.credentialID && before.credentialID !== input.credentialID) throw unavailable();
      const accountId = openAiAccountId(normalize(before));
      if (!accountId) throw new OpenAiOAuthError('bot_opencode_provider_authentication', 401);
      const attempt = await coordinator.access({ expectedAccountId: accountId, credentialId: before.credentialID });
      const after = await read(input.directory);
      if (!after || after.value.type !== 'oauth' || after.controllerInstanceID !== before.controllerInstanceID
        || after.credentialID !== before.credentialID || after.value.methodID !== before.value.methodID
        || openAiAccountId(normalize(after)) !== attempt.accountId || after.value.access !== attempt.accessToken
        || after.value.expires !== attempt.expiresAt) throw unavailable();
      return Object.freeze({ ...attempt, credentialID: after.credentialID, methodID: after.value.methodID,
        generation: digest([after.controllerInstanceID, after.credentialID, after.value.methodID, attempt.generation]) });
    },
  });
}

export { CHATGPT_SIWC_METHOD_ID };
