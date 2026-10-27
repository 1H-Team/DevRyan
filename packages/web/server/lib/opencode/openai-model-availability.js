import { credentialMutationFingerprint } from './runtime-host/native-credential-mutation-owner.js';

/** Catalog/status reads observe metadata and never resolve or refresh a credential. */
export async function readNativeOpenAiMetadata(getNativeRuntimeOwner, directory) {
  const owner = getNativeRuntimeOwner();
  const snapshot = owner?.getConfigurationSnapshot?.();
  const location = snapshot?.locations?.find(row => row.directory === directory) ?? snapshot?.locations?.[0];
  if (!owner?.isReady?.() || !location) throw Object.assign(new Error('native_runtime_not_ready'), { code: 'native_runtime_not_ready' });
  const rows = await owner.credentialMetadata({ kind: 'openai', directory: location.directory, integrationID: 'openai',
    configurationDigest: credentialMutationFingerprint(location.configuration?.providers?.openai ?? {}),
    operation: 'openai.integration', method: 'GET', path: '/api/integration/openai' });
  if (!Array.isArray(rows)) throw Object.assign(new Error('native_credential_invalid'), { code: 'native_credential_invalid' });
  const active = rows.filter(row => row.active === true);
  if (active.length > 1) throw Object.assign(new Error('native_credential_invalid'), { code: 'native_credential_invalid' });
  const row = active[0];
  if (!row) return null;
  if (row.integrationID !== 'openai' || !['key', 'oauth'].includes(row.valueType)
    || row.valueType === 'oauth' && typeof row.methodID !== 'string') throw Object.assign(new Error('native_credential_invalid'), { code: 'native_credential_invalid' });
  return { type: row.valueType, methodID: row.methodID, credentialID: row.id };
}

/** The built-in sign-in supplies OpenCode's usable model catalog. */
export const annotateOpenAIModelAvailability = (payload, authEntry, options = {}) => {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.providers)) return payload;
  const authType = ['api', 'key'].includes(authEntry?.type) ? 'api' : authEntry?.type === 'oauth' ? 'oauth' : undefined;
  if (!authType && !options.unavailable) return payload;
  return { ...payload, providers: payload.providers.map(provider => {
    if (provider?.id !== 'openai') return provider;
    if (authType === 'api' || ['chatgpt-token-sharing', 'chatgpt-browser'].includes(authEntry?.methodID)) return { ...provider, authType };
    const models = provider.models && typeof provider.models === 'object' ? provider.models : {};
    return { ...provider, authType, accountModelsStatus: 'unavailable', models: Object.fromEntries(Object.entries(models)
      .map(([id, model]) => [id, { ...model, available: false, unavailableReason: authType ? 'reauthorization_required' : 'account_models_unavailable' }])) };
  }) };
};
