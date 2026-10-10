import path from 'node:path';
import { createOpenAiOAuthCoordinator } from '../openai-oauth-coordinator.js';
import { createNativeOpenAiAuth } from './native-openai-auth.js';
import { createNativeIntegrationAuthorization } from './native-integration-authorization.js';
import { createNativeCredentialMutationOwner, credentialMutationFingerprint, parseCredentialResolutionBinding } from './native-credential-mutation-owner.js';
import { reviewedMcpConfiguration } from './reviewed-mcp-configuration.js';
import { hasSiwcPlanUsage } from '../chatgpt-siwc.js';
import { NativeCommandRefusal } from './native-command-refusal.js';

const fail = (code, status = 403) => Object.assign(new Error(code), { code, status, statusCode: status });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** One controller's integration grants and native credential storage join the
 * existing host OAuth queue. Credential values never enter diagnostics. */
export function createNativeIntegrationOwner({ instanceID, snapshot, stateDirectory, controller,
  isReady, withMutationQueue, captureWebAuthorization, admissionOwner, recordDiagnostic }) {
  if (!snapshot || !path.isAbsolute(stateDirectory ?? '') || typeof withMutationQueue !== 'function') {
    throw fail('native_integration_dependencies_required', 503);
  }
  const locations = new Map(snapshot.locations.map(location => [location.directory, location]));
  const mcp = reviewedMcpConfiguration(snapshot, [...locations.keys()]);
  let closed = false, settlement;
  const signingOut = new Set();
  const live = () => { if (closed) throw fail('native_integration_grant_expired'); };
  const verifyBinding = async binding => {
    live();
    const location = locations.get(binding?.directory);
    if (!location || binding.controllerInstanceID !== instanceID) throw fail('native_integration_binding_invalid');
    if (binding.kind === 'mcp') {
      const server = mcp.get(binding.directory)?.get(binding.server);
      if (!server || server.config.disabled || server.configurationDigest !== binding.configurationDigest) throw fail('native_mcp_server_unreviewed');
    } else if (binding.kind === 'provider') {
      if (!['xai','opencode','opencode-go'].includes(binding.integrationID) || binding.configurationDigest !== undefined && binding.configurationDigest !== credentialMutationFingerprint(location.configuration.providers?.[binding.integrationID] ?? {})) throw fail('native_integration_binding_invalid');
    } else if (!['openai', 'cursor'].includes(binding.kind) || binding.integrationID !== (binding.kind === 'cursor' ? 'cursor-acp' : 'openai')
      || binding.configurationDigest !== undefined && binding.configurationDigest !== credentialMutationFingerprint(location.configuration.providers?.[binding.integrationID] ?? {})) {
      throw fail('native_integration_binding_invalid');
    }
    live();
  };
  const grants = createNativeIntegrationAuthorization({ controllerIdentity: () => closed ? undefined : instanceID,
    verifyBinding, captureWebAuthorization: async input => {
      if (!isReady()) throw fail('native_runtime_not_ready', 503);
      const original = await captureWebAuthorization(input);
      return async () => {
        live(); if (!isReady()) throw fail('native_runtime_not_ready', 503); await original();
        if (input.expectedActiveFingerprint !== undefined) {
          const selected = await ownedCall({ action: 'openai-read-selected-owned', directory: input.directory });
          if (credentialMutationFingerprint(selected ?? null) !== input.expectedActiveFingerprint) throw fail('native_chatgpt_siwc_selection_changed', 409);
        }
        if (input.assertCurrent) await input.assertCurrent();
        live();
      };
    }, authorizeConfiguredConnection: verifyBinding });
  const ownedCall = async input => {
    live(); const target = controller();
    if (target.instanceID !== instanceID) throw fail('native_controller_unavailable', 503);
    try { return await target.call({ ...input, controllerInstanceID: instanceID }); }
    catch (cause) {
      if (cause instanceof NativeCommandRefusal) throw cause;
      // A timeout is not settlement: the shared queue remains held until the
      // real process has exited, even when its bounded recovery call times out.
      if (typeof target.killAndWaitForTermination === 'function') await target.killAndWaitForTermination();
      else await target.killAndWaitForExit();
      throw cause;
    }
  };
  const auth = createNativeOpenAiAuth({ directory: snapshot.locations[0].directory,
    controllerIdentity: () => closed ? undefined : instanceID,
    readSelected: input => ownedCall({ action: 'openai-read-selected-owned', ...input }),
    compareAndSwapSelected: input => ownedCall({ action: 'openai-cas-selected-owned', ...input }),
  });
  const coordinator = createOpenAiOAuthCoordinator({ asyncStorage: auth.asyncStorage, withMutationQueue,
    stateFile: path.join(stateDirectory, 'native-openai-oauth-state.json'), recordDiagnostic });
  const assertResolution = async input => {
    const binding = parseCredentialResolutionBinding(input);
    if (binding.controllerInstanceID !== instanceID || !isReady()) throw fail('native_provider_resolution_expired');
    await verifyBinding(binding);
    return admissionOwner.withProviderResolution({directory:binding.directory,sessionID:binding.sessionID,permit:binding.permit}, async recheck => { await recheck(); live(); });
  };
  const mutations = createNativeCredentialMutationOwner({ controllerInstanceID: instanceID, withMutationQueue,
    resolveAuthorization: input => grants.resolveMutation(input), verifyBinding,
    withResolution: async (binding,action) => {
      await assertResolution(binding);
      return admissionOwner.withProviderResolution({directory:binding.directory,sessionID:binding.sessionID,permit:binding.permit}, async recheck => { await recheck(); live(); const result=await action(); await recheck(); live(); return result; });
    },
    commitOwned: input => ownedCall({ action: 'credential-commit-owned', ...input }),
  });
  const handleRpc = async (method, input, context = {}) => {
    live();
    if (!record(input)) throw fail('native_integration_request_invalid');
    if (method === 'integration.capture') return grants.capture(input);
    if (method === 'integration.reauthorize') { await grants.reauthorize(input); return null; }
    if (method === 'integration.control') { await grants.authorizeControl(input); return null; }
    if (method === 'provider.credential.assert') { await assertResolution(input); return null; }
    if (method === 'credential.mutation.commit' || method === 'credential.resolution.commit') return mutations.handleRpc(method, input, context);
    if (method === 'provider.attempt') {
      if (!isReady() || input.controllerInstanceID !== instanceID || !locations.has(input.directory)
        || !['xai','opencode','opencode-go'].includes(input.integrationID)
        || Object.keys(input).some(key => !['controllerInstanceID','directory','sessionID','integrationID','kind','permit'].includes(key))) throw fail('native_provider_attempt_invalid');
      const {integrationID,...attempt}=input;void integrationID;
      return admissionOwner.withProviderAttempt(attempt,async()=>{context.signal?.throwIfAborted();live();return null;});
    }
    if (method === 'openai.attempt' || method === 'openai.access') {
      if (!isReady() || input.controllerInstanceID !== instanceID || !locations.has(input.directory)
        || Object.keys(input).some(key => !['directory', 'controllerInstanceID', 'sessionID', 'kind', 'permit', 'credentialID'].includes(key))) {
        throw fail('native_provider_attempt_invalid');
      }
      if (signingOut.has(input.credentialID)) throw fail('native_chatgpt_siwc_signed_out', 401);
      return admissionOwner.withProviderAttempt(input, async () => {
        context.signal?.throwIfAborted(); live();
        const result = method === 'openai.access' ? await auth.access(coordinator, input) : null;
        context.signal?.throwIfAborted(); live();
        if (signingOut.has(input.credentialID)) throw fail('native_chatgpt_siwc_signed_out', 401);
        return result;
      });
    }
    throw fail('native_integration_operation_invalid');
  };
  const requireSelectedAccess = async input => {
    live();
    const selected = await ownedCall({ action: 'openai-read-selected-owned', directory: snapshot.locations[0].directory });
    if (selected && signingOut.has(selected.credentialID)) throw fail('native_chatgpt_siwc_signed_out', 401);
    const result = await coordinator.access(input);
    if (selected && signingOut.has(selected.credentialID)) throw fail('native_chatgpt_siwc_signed_out', 401);
    return result;
  };
  const publicCoordinator = Object.freeze({ getBindingAsync: () => coordinator.getBindingAsync(),
    getAuthStateAsync: accountId => coordinator.getAuthStateAsync(accountId), access: requireSelectedAccess });
  return { getOpenAiOAuthCoordinator: () => { live(); return publicCoordinator; }, handleRpc, withCallerOperation: grants.withCallerOperation, requestHeaders: grants.requestHeaders,
    withImageGeneration:(invocation,action)=>admissionOwner.withImageGeneration(invocation,async recheck=>{
      let captured;
      const recheckAccess=async()=>{
        live();if(!isReady()||!locations.has(invocation.directory))throw fail('native_image_generation_unavailable');
        await recheck();
        if(captured)await auth.recheckImageAccess(captured,{directory:invocation.directory});
        await recheck();live();if(!isReady())throw fail('native_image_generation_unavailable');
      };
      const access=async()=>{
        await recheckAccess();
        captured=await auth.imageAccess({directory:invocation.directory});
        if(!captured)throw fail('native_image_generation_credential_required',401);
        await recheckAccess();return captured;
      };
      const result=await action({access,recheck:recheckAccess});
      await recheckAccess();return result;
    }),
    credentialOperation: (operation, mutation) => grants.withCallerOperation(operation, () => ownedCall({
      action: 'credential-operation-owned', directory: operation.directory, mutation,
      requestAuthorization: grants.requestHeaders()['x-devryan-native-integration-grant'],
    })),
    readOpenAiAccountSelection: operation => grants.withCallerOperation(operation, async () => {
      if (operation.operation !== 'openai.integration') throw fail('native_integration_scope_invalid');
      const selected = await ownedCall({ action: 'openai-read-selected-owned', directory: operation.directory });
      if (selected && signingOut.has(selected.credentialID)) throw fail('native_chatgpt_siwc_signed_out', 401);
      if (selected?.value?.methodID === 'chatgpt-siwc' && hasSiwcPlanUsage(selected.value.metadata?.scopes)) {
        await auth.access(coordinator, { directory: operation.directory, credentialID: selected.credentialID });
        const current = await ownedCall({ action: 'openai-read-selected-owned', directory: operation.directory });
        if (signingOut.has(selected.credentialID)) throw fail('native_chatgpt_siwc_signed_out', 401);
        if (current?.credentialID !== selected.credentialID) throw fail('native_chatgpt_siwc_selection_changed', 409);
        return current;
      }
      return selected;
    }),
    holdOpenAiSelection: operation => grants.withCallerOperation(operation, () => withMutationQueue(async () => {
      const selected = await ownedCall({ action: 'openai-read-selected-owned', directory: operation.directory });
      if (!selected || credentialMutationFingerprint(selected) !== operation.expectedActiveFingerprint) throw fail('native_chatgpt_siwc_selection_changed', 409);
      signingOut.add(selected.credentialID);
      return cleared => { if (cleared) signingOut.delete(selected.credentialID); };
    })),
    readOpenAiCredential: (operation, credentialID) => grants.withCallerOperation(operation, () => {
      if (operation.operation !== 'openai.integration' || typeof credentialID !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(credentialID)) throw fail('native_integration_scope_invalid');
      return ownedCall({ action: 'openai-read-credential-owned', directory: operation.directory, credentialID });
    }),
    readOpenAiSelected: operation => grants.withCallerOperation(operation, () => {
      if (operation.operation !== 'openai.integration') throw fail('native_integration_scope_invalid');
      return ownedCall({ action: 'openai-read-selected-owned', directory: operation.directory });
    }),
    readProviderSelected: operation => grants.withCallerOperation(operation, async () => {
      if (operation.operation !== 'provider.integration' || !['xai', 'opencode-go'].includes(operation.integrationID)) throw fail('native_integration_scope_invalid');
      const selected = await ownedCall({ action: 'provider-read-selected-owned', directory: operation.directory, integrationID: operation.integrationID });
      if (selected === undefined || selected === null) return undefined;
      if (typeof selected !== 'object' || Array.isArray(selected) || selected.directory !== operation.directory || selected.controllerInstanceID !== instanceID
        || selected.integrationID !== operation.integrationID || typeof selected.credentialID !== 'string' || !selected.value || typeof selected.value !== 'object') throw fail('native_integration_binding_invalid', 502);
      return selected;
    }),
    credentialMetadata: operation => grants.withCallerOperation(operation, () => {
      if (!['openai.integration', 'mcp.integration', 'cursor.integration', 'provider.integration'].includes(operation.operation)) throw fail('native_integration_scope_invalid');
      return ownedCall({ action: 'credential-metadata-owned', directory: operation.directory, integrationID: operation.integrationID });
    }),
    markReady: () => { live(); coordinator.markReady(); },
    invalidate: () => {
      closed = true; grants.close(); coordinator.markStopped();
      return settlement ??= mutations.invalidate();
    },
  };
}
