import { credentialMutationFingerprint } from './native-credential-mutation-owner.js';

const fail = (code, status = 403) => Object.assign(new Error(code), { code, status, statusCode: status });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** GitHub Copilot model discovery for the controller's `provider.catalog` RPC.
 * Catalog reads have a constructor-owned capability, never an inference permit:
 * the selected device-OAuth credential is read through the controller before and
 * after the fetch, and a change between them refuses the result. */
export function createNativeCopilotCatalog({ instanceID, snapshot, registrationOrigin, controller, isReady, withMutationQueue, fetchImpl = globalThis.fetch }) {
  if (!snapshot || registrationOrigin?.kind !== 'plugin' || registrationOrigin.id !== 'devryan.provider-compat'
    || !/^[a-f0-9]{64}$/.test(registrationOrigin.manifestDigest) || typeof withMutationQueue !== 'function') throw fail('native_provider_dependencies_required', 503);
  const locations = new Map(structuredClone(snapshot.locations).map(location => [location.directory, location]));
  const catalogs = new Set(), controllers = new Set();
  let closed = false;
  const live = () => { if (closed || !isReady() || controller().instanceID !== instanceID) throw fail('native_provider_owner_expired'); };
  const binding = input => {
    live(); const location = locations.get(input?.directory);
    if (!record(input) || Object.keys(input).some(key => !['directory', 'controllerInstanceID', 'integrationID', 'acquisitionID', 'configurationDigest', 'origin'].includes(key))
      || !location || input.controllerInstanceID !== instanceID || input.integrationID !== 'github-copilot' || typeof input.acquisitionID !== 'string'
      || !input.acquisitionID || input.acquisitionID.length > 256
      || input.configurationDigest !== credentialMutationFingerprint(location.configuration.providers?.['github-copilot'] ?? {})
      || input.origin?.id !== registrationOrigin.id || input.origin?.manifestDigest !== registrationOrigin.manifestDigest
      || Object.keys(input.origin).some(key => !['id', 'manifestDigest'].includes(key))) throw fail('native_provider_catalog_binding_invalid');
    return input;
  };
  const read = async scope => {
    live(); const selected = await controller().call({ action: 'provider-catalog-selection-owned', ...scope }); live();
    if (selected === null || selected === undefined) return undefined;
    if (!record(selected) || selected.controllerInstanceID !== instanceID || selected.directory !== scope.directory || selected.integrationID !== 'github-copilot'
      || selected.acquisitionID !== scope.acquisitionID || selected.configurationDigest !== scope.configurationDigest || !record(selected.credential)
      || selected.credential.integrationID !== 'github-copilot' || typeof selected.credential.id !== 'string' || !record(selected.credential.value)) throw fail('native_provider_catalog_selection_invalid');
    return selected;
  };
  const catalog = async (input, { signal } = {}) => {
    const scope = binding(input), cancel = new AbortController(); controllers.add(cancel);
    const currentSignal = signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal;
    const work = withMutationQueue(async () => {
      binding(scope); currentSignal.throwIfAborted(); const before = await read(scope); if (!before) return null;
      const value = before.credential.value;
      // Native device OAuth stores the durable GitHub token as refresh (expires=0).
      // Access-only expired OAuth cannot be refreshed by a guessed issuer path.
      if (value.type !== 'oauth' || value.methodID !== 'device') throw fail('native_copilot_method_unsupported');
      const token = typeof value.refresh === 'string' && value.refresh.trim() ? value.refresh.trim() : typeof value.access === 'string' ? value.access.trim() : '';
      if (!token || (!value.refresh && (!Number.isSafeInteger(value.expires) || value.expires <= Date.now()))) throw fail('native_copilot_refresh_required', 401);
      const abort = AbortSignal.any([currentSignal, AbortSignal.timeout(5000)]);
      const response = await fetchImpl('https://api.githubcopilot.com/models', { method: 'GET', redirect: 'error', signal: abort,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'opencode/devryan', 'X-GitHub-Api-Version': '2026-06-01' } });
      if (!response.ok) throw fail('native_copilot_catalog_fetch_failed', 502);
      const chunks = []; let size = 0; const reader = response.body?.getReader(); if (!reader) throw fail('native_copilot_catalog_invalid', 502);
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength; if (size > 1024 * 1024) throw fail('native_copilot_catalog_overflow', 502);
          chunks.push(part.value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!record(payload) || !Array.isArray(payload.data) || payload.data.length > 4096) throw fail('native_copilot_catalog_invalid', 502);
      binding(scope); currentSignal.throwIfAborted(); const after = await read(scope);
      if (!after || credentialMutationFingerprint(before) !== credentialMutationFingerprint(after)) throw fail('native_provider_catalog_selection_changed');
      return payload.data;
    });
    catalogs.add(work); void work.finally(() => { catalogs.delete(work); controllers.delete(cancel); }).catch(() => {});
    return work;
  };
  return {
    handleRpc: (method, input, context) => {
      if (method === 'provider.catalog') return catalog(input, context);
      throw fail('native_provider_operation_invalid');
    },
    close: async () => {
      closed = true;
      for (const cancel of controllers) cancel.abort(fail('native_provider_owner_expired'));
      await Promise.allSettled([...catalogs]);
    },
  };
}
