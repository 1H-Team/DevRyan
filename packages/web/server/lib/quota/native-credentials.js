import { readNativeOpenAiSelection } from '../opencode/chatgpt-siwc-host.js';
import { credentialMutationFingerprint } from '../opencode/runtime-host/native-credential-mutation-owner.js';

/**
 * Quota credential source for the native runtime. Credentials live privately in
 * the native controller, so usage fetchers receive an injected, in-memory
 * legacy-shaped auth object. Values are never logged, cached or written.
 */

const QUOTA_INTEGRATIONS = Object.freeze([
  Object.freeze({ quotaId: 'codex', integrationID: 'openai', kind: 'openai', valueType: 'oauth' }),
  Object.freeze({ quotaId: 'xai', integrationID: 'xai', kind: 'provider', valueType: 'oauth' }),
  Object.freeze({ quotaId: 'opencode-go', integrationID: 'opencode-go', kind: 'provider', valueType: 'key' }),
]);

const fail = (code) => Object.assign(new Error(code), { code });
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.length > 0;

export function createNativeQuotaCredentials({
  getNativeRuntimeOwner,
  isExternalOpenCode,
  readOpenAiSelection = readNativeOpenAiSelection,
}) {
  const snapshotState = () => {
    if (isExternalOpenCode()) return { mode: 'legacy' };
    const owner = getNativeRuntimeOwner();
    if (!owner) return { mode: 'legacy' };
    let snapshot;
    try {
      snapshot = owner.isReady?.() ? owner.getConfigurationSnapshot?.() : undefined;
    } catch {
      snapshot = undefined;
    }
    // Credentials are global; the default (first) reviewed location is always the scope.
    const location = Array.isArray(snapshot?.locations) ? snapshot.locations[0] : undefined;
    if (!location || !isText(location.directory)) return { mode: 'native-pending' };
    return { mode: 'native-ready', owner, location };
  };

  const scopeFor = (location, entry) => ({
    kind: entry.kind,
    directory: location.directory,
    integrationID: entry.integrationID,
    configurationDigest: credentialMutationFingerprint(location.configuration?.providers?.[entry.integrationID] ?? {}),
    operation: `${entry.kind}.integration`,
    method: 'GET',
    path: `/api/integration/${entry.integrationID}`,
  });

  const entryFor = (quotaId) => QUOTA_INTEGRATIONS.find((row) => row.quotaId === quotaId);

  const requireReady = () => {
    const state = snapshotState();
    if (state.mode !== 'native-ready') throw fail('native_runtime_not_ready');
    return state;
  };

  const listConfigured = async () => {
    const state = snapshotState();
    const configured = new Set();
    if (state.mode !== 'native-ready' || typeof state.owner.credentialMetadata !== 'function') return configured;
    const settled = await Promise.allSettled(QUOTA_INTEGRATIONS.map(async (entry) => {
      const rows = await state.owner.credentialMetadata(scopeFor(state.location, entry));
      return Array.isArray(rows)
        && rows.some((row) => isRecord(row)
          && row.active === true
          && row.integrationID === entry.integrationID
          && row.valueType === entry.valueType);
    }));
    // A failed lookup is unknown, not absent: the provider stays listed so its fetch
    // reports either "not configured" or an explicit unreadable result.
    settled.forEach((result, index) => {
      if (result.status === 'rejected' || result.value) configured.add(QUOTA_INTEGRATIONS[index].quotaId);
    });
    return configured;
  };

  const readOpenAi = async (state) => {
    const selected = await readOpenAiSelection(getNativeRuntimeOwner, state.location.directory, { refresh: true });
    if (!selected) return null;
    if (!isRecord(selected) || !isRecord(selected.value)
      || (selected.directory !== undefined && selected.directory !== state.location.directory)
      || (selected.integrationID !== undefined && selected.integrationID !== 'openai')) {
      throw fail('native_credential_invalid');
    }
    const { value } = selected;
    if (value.type === 'key') return null;
    if (value.type !== 'oauth' || !isText(value.access) || !isText(value.methodID)) throw fail('native_credential_invalid');
    const accountId = typeof value.metadata?.accountID === 'string' ? value.metadata.accountID : undefined;
    return { openai: { type: 'oauth', access: value.access, accountId, methodID: value.methodID } };
  };

  const readProvider = async (state, entry) => {
    const { owner } = state;
    if (typeof owner.readProviderSelected !== 'function') throw fail('native_credential_update_required');
    const selected = await owner.readProviderSelected(scopeFor(state.location, entry));
    if (selected === undefined || selected === null) return null;
    if (!isRecord(selected) || selected.integrationID !== entry.integrationID
      || selected.directory !== state.location.directory || !isRecord(selected.value)) {
      throw fail('native_credential_invalid');
    }
    const { value } = selected;
    if (value.type !== entry.valueType) {
      // An active credential of the other type is not usable for usage; treat as none.
      if (value.type === 'key' || value.type === 'oauth') return null;
      throw fail('native_credential_invalid');
    }
    if (entry.quotaId === 'opencode-go') {
      if (!isText(value.key)) throw fail('native_credential_invalid');
      return { 'opencode-go': { type: 'api', key: value.key } };
    }
    if (!isText(value.access)) throw fail('native_credential_invalid');
    // The refresh token is deliberately not forwarded: only the native runtime may rotate it.
    return {
      xai: {
        type: 'oauth',
        access: value.access,
        ...(Number.isSafeInteger(value.expires) ? { expires: value.expires } : {}),
      },
    };
  };

  const readAuth = async (quotaId) => {
    const entry = entryFor(quotaId);
    if (!entry) throw fail('native_credential_unsupported');
    const state = requireReady();
    return entry.quotaId === 'codex' ? readOpenAi(state) : readProvider(state, entry);
  };

  return Object.freeze({
    mode: () => snapshotState().mode,
    listConfigured,
    readAuth,
  });
}
