import { createChatgptSiwcEnrollmentOwner } from './chatgpt-siwc-enrollment.js';
import { createNativeIntegrationFacade } from './v2/native-integration-facade.js';
import { CHATGPT_SIWC_METHOD_ID, failSiwc, hasSiwcPlanUsage, isLegacyCodexChatgptMethodId, revokeSiwcSession } from './chatgpt-siwc.js';
import { credentialMutationFingerprint } from './runtime-host/native-credential-mutation-owner.js';

function nativeScope(getNativeRuntimeOwner, directory) {
  const owner = getNativeRuntimeOwner();
  const snapshot = owner?.getConfigurationSnapshot?.();
  const target = typeof directory === 'string' && directory ? directory : snapshot?.locations?.[0]?.directory;
  const location = snapshot?.locations?.find(row => row.directory === target);
  if (!owner?.isReady?.() || !location) throw failSiwc('native_chatgpt_siwc_location_required');
  return { owner, scope: { kind: 'openai', directory: target, integrationID: 'openai',
    configurationDigest: credentialMutationFingerprint(location.configuration?.providers?.openai ?? {}),
    operation: 'openai.integration', method: 'GET', path: '/api/integration/openai' } };
}

/** Private scoped read: the browser receives a redacted status, never this value. */
export async function readNativeOpenAiSelection(getNativeRuntimeOwner, directory, { refresh = false } = {}) {
  const { owner, scope } = nativeScope(getNativeRuntimeOwner, directory);
  if (typeof owner.readOpenAiSelected !== 'function') throw failSiwc('native_chatgpt_siwc_update_required');
  return await (refresh && typeof owner.readOpenAiAccountSelection === 'function' ? owner.readOpenAiAccountSelection(scope) : owner.readOpenAiSelected(scope)) ?? null;
}

export function createHostChatgptSiwcEnrollment({ dataDirectory, getNativeRuntimeOwner, getOpenCodeRuntime, fetchImpl = fetch, jwksImpl }) {
  const facadeFor = () => createNativeIntegrationFacade({ getNativeRuntimeOwner, getOpenCodeRuntime });
  const readCredential = async (directory, credentialID) => {
    const { owner, scope } = nativeScope(getNativeRuntimeOwner, directory);
    if (typeof owner.readOpenAiCredential !== 'function') throw failSiwc('native_chatgpt_siwc_update_required');
    return await owner.readOpenAiCredential(scope, credentialID);
  };
  const mutate = async ({ directory, credentialID, operation, expectedFingerprint, expectedActiveFingerprint, assertCurrent, requireInactive }) => {
    const { owner, scope } = nativeScope(getNativeRuntimeOwner, directory);
    const row = await readCredential(directory, credentialID);
    if (!row || row.expectedFingerprint !== expectedFingerprint) throw failSiwc('native_chatgpt_siwc_credential_changed');
    const guard = async () => {
      if (assertCurrent) await assertCurrent();
      if (requireInactive && (await readNativeOpenAiSelection(getNativeRuntimeOwner, directory))?.credentialID === credentialID) throw failSiwc('native_chatgpt_siwc_selection_changed');
    };
    const spec = { ...scope, operation: `openai.credential.${operation}`,
      method: operation === 'remove' ? 'DELETE' : 'POST',
      path: `/api/credential/${encodeURIComponent(credentialID)}${operation === 'activate' ? '/activate' : ''}`,
      credentialID, valueType: row.value.type, ...(row.value.type === 'oauth' ? { methodID: row.value.methodID } : {}),
      expectedFingerprint, requestedFingerprint: credentialMutationFingerprint({ id: credentialID }),
      ...(expectedActiveFingerprint === undefined ? {} : { expectedActiveFingerprint }), ...(assertCurrent || requireInactive ? { assertCurrent: guard } : {}) };
    await owner.credentialOperation(spec, { operation, id: credentialID });
  };
  const readConnected = async ({ directory } = {}) => {
    const selected = await readNativeOpenAiSelection(getNativeRuntimeOwner, directory);
    if (!selected) return null;
    const value = selected.value;
    return { credentialID: selected.credentialID, fingerprint: credentialMutationFingerprint(selected),
      methodID: value.methodID ?? null, legacy: isLegacyCodexChatgptMethodId(value.methodID),
      planUsage: value.methodID === CHATGPT_SIWC_METHOD_ID && hasSiwcPlanUsage(value.metadata?.scopes),
      subject: value.metadata?.subject ?? null, email: value.metadata?.email ?? null };
  };
  return createChatgptSiwcEnrollmentOwner({ dataDirectory, fetchImpl, jwksImpl, readConnected,
    readRegistrationCredential: async ({ directory, registration }) => {
      if (!registration.credentialID) return null;
      const row = await readCredential(directory, registration.credentialID);
      if (!row) return null;
      if (row.value?.methodID !== CHATGPT_SIWC_METHOD_ID || row.value.metadata?.subject !== registration.subject
        || row.value.metadata?.clientId !== registration.clientId) throw failSiwc('native_chatgpt_siwc_registration_changed');
      return row;
    },
    persistCredential: async ({ directory, credentialID, value, expectedActiveFingerprint, assertCurrent }) => {
      const { scope } = nativeScope(getNativeRuntimeOwner, directory);
      const result = await facadeFor().saveOAuthCredential('openai', value, { directory: scope.directory, credentialID, expectedActiveFingerprint, assertCurrent });
      const row = await readCredential(scope.directory, result.credentialID);
      if (!row) throw failSiwc('native_chatgpt_siwc_credential_missing');
      return { credentialID: result.credentialID, expectedFingerprint: row.expectedFingerprint };
    },
    selectCredential: async ({ directory, credentialID, expectedFingerprint, expectedActiveFingerprint, assertCurrent }) => {
      await mutate({ directory, credentialID, operation: 'activate', expectedFingerprint, expectedActiveFingerprint, assertCurrent });
      return readConnected({ directory });
    },
    removeCredential: input => mutate({ ...input, operation: 'remove' }),
    disconnectCredential: async ({ directory, expectedActiveCredentialID }) => {
      const selected = await readNativeOpenAiSelection(getNativeRuntimeOwner, directory);
      if ((selected?.credentialID ?? null) !== expectedActiveCredentialID) throw failSiwc('native_chatgpt_siwc_selection_changed');
      if (!selected) return { success: true, remoteRevocation: 'not_applicable', localCleanup: 'complete' };
      const { owner, scope } = nativeScope(getNativeRuntimeOwner, directory);
      const expectedActiveFingerprint = credentialMutationFingerprint(selected);
      const row = await readCredential(directory, selected.credentialID);
      if (!row) throw failSiwc('native_chatgpt_siwc_credential_missing');
      // Held native session owners settle active requests before any revocation.
      if (typeof owner.stopOpenAiRequests !== 'function') throw failSiwc('native_chatgpt_siwc_update_required');
      const release = await owner.stopOpenAiRequests({ ...scope, expectedActiveFingerprint });
      let remoteRevocation = 'unconfirmed', cleared = false;
      try {
        remoteRevocation = await revokeSiwcSession(selected.value, { fetchImpl });
        await mutate({ directory, credentialID: selected.credentialID, operation: 'remove', expectedFingerprint: row.expectedFingerprint, expectedActiveFingerprint });
        cleared = true;
      } catch {
        throw Object.assign(failSiwc('native_chatgpt_siwc_cleanup_failed', 503), { remoteRevocation, localCleanup: 'failed' });
      } finally { await release(cleared); }
      return { success: true, remoteRevocation, localCleanup: 'complete' };
    },
  });
}
