import crypto from 'node:crypto';
import path from 'node:path';
import { OpenAiOAuthError } from '../openai-oauth-coordinator.js';


const ordered = value => Array.isArray(value) ? value.map(ordered)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
const unavailable = () => new OpenAiOAuthError('native_openai_owner_unavailable');

/** The original Credential record stays private; no auth.json mirror is made. */
export function createNativeOpenAiAuth({ directory, readSelected, controllerIdentity }) {
  if (!path.isAbsolute(directory)) throw unavailable();
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
    throw new OpenAiOAuthError('bot_opencode_provider_authentication', 401);
  };
  const asyncStorage = Object.freeze({
    isActive: () => Boolean(controllerIdentity()),
    readAuth: async () => { const selected = await read(directory); return selected ? Object.freeze({ type: 'api', key: selected.value.key }) : undefined; },
    compareAndSwap: async () => false,
  });
  return Object.freeze({ asyncStorage,
    async imageAccess(input) {
      const selected = await read(input.directory);
      if (!selected) return undefined;
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
    async access(_coordinator, input) { await read(input.directory); return undefined; },
  });
}
