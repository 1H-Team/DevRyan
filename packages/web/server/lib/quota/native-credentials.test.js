import { describe, expect, it, vi } from 'vitest';

import { credentialMutationFingerprint } from '../opencode/runtime-host/native-credential-mutation-owner.js';
import { createNativeQuotaCredentials } from './native-credentials.js';

const directory = '/default/location';
const providers = { xai: { a: 1 }, 'opencode-go': { b: 2 }, openai: { c: 3 } };
const snapshot = () => ({ locations: [{ directory, configuration: { providers } }, { directory: '/other', configuration: { providers: {} } }] });

const createOwner = (overrides = {}) => ({
  isReady: () => true,
  getConfigurationSnapshot: snapshot,
  credentialMetadata: vi.fn(async () => []),
  readProviderSelected: vi.fn(async () => undefined),
  ...overrides,
});

const create = (owner, { external = false, readOpenAiSelection } = {}) => createNativeQuotaCredentials({
  getNativeRuntimeOwner: () => owner,
  isExternalOpenCode: () => external,
  ...(readOpenAiSelection ? { readOpenAiSelection } : {}),
});

describe('native quota credentials', () => {
  it('reports legacy, pending and ready modes', () => {
    expect(create(createOwner(), { external: true }).mode()).toBe('legacy');
    expect(create(null).mode()).toBe('legacy');
    expect(create(createOwner({ isReady: () => false })).mode()).toBe('native-pending');
    expect(create(createOwner({ getConfigurationSnapshot: () => ({ locations: [] }) })).mode()).toBe('native-pending');
    expect(create(createOwner()).mode()).toBe('native-ready');
  });

  it('scopes metadata lookups to the default location with per-integration digests', async () => {
    const owner = createOwner();
    await create(owner).listConfigured();
    const scopes = owner.credentialMetadata.mock.calls.map(([scope]) => scope);
    expect(scopes).toEqual([
      { kind: 'openai', directory, integrationID: 'openai', configurationDigest: credentialMutationFingerprint(providers.openai), operation: 'openai.integration', method: 'GET', path: '/api/integration/openai' },
      { kind: 'provider', directory, integrationID: 'xai', configurationDigest: credentialMutationFingerprint(providers.xai), operation: 'provider.integration', method: 'GET', path: '/api/integration/xai' },
      { kind: 'provider', directory, integrationID: 'opencode-go', configurationDigest: credentialMutationFingerprint(providers['opencode-go']), operation: 'provider.integration', method: 'GET', path: '/api/integration/opencode-go' },
    ]);
  });

  it('lists active rows of the expected type and keeps a provider whose lookup failed as unknown', async () => {
    const owner = createOwner({
      credentialMetadata: vi.fn(async (scope) => {
        if (scope.integrationID === 'openai') return [{ id: 'a', integrationID: 'openai', valueType: 'oauth', active: true }];
        if (scope.integrationID === 'xai') throw new Error('lookup failed');
        return [{ id: 'k', integrationID: 'opencode-go', valueType: 'key', active: false }];
      }),
    });
    expect([...await create(owner).listConfigured()]).toEqual(['codex', 'xai']);
    const wrongType = createOwner({
      credentialMetadata: vi.fn(async (scope) => [{ id: 'x', integrationID: scope.integrationID, valueType: scope.integrationID === 'opencode-go' ? 'oauth' : 'key', active: true }]),
    });
    expect([...await create(wrongType).listConfigured()]).toEqual([]);
    const all = createOwner({
      credentialMetadata: vi.fn(async (scope) => [{ id: 'x', integrationID: scope.integrationID, valueType: scope.integrationID === 'opencode-go' ? 'key' : 'oauth', active: true }]),
    });
    expect([...await create(all).listConfigured()].sort()).toEqual(['codex', 'opencode-go', 'xai']);
  });

  it('reads only OpenAI metadata and returns no token for quota', async () => {
    const readOpenAiSelection = vi.fn(async () => ({ type: 'oauth', methodID: 'chatgpt-token-sharing', credentialID: 'c' }));
    const credentials = create(createOwner(), { readOpenAiSelection });
    expect(await credentials.readAuth('codex')).toEqual({ openai: { type: 'oauth', methodID: 'chatgpt-token-sharing', connectionId: 'c' } });
    expect(readOpenAiSelection).toHaveBeenCalledWith(expect.any(Function), directory);
    readOpenAiSelection.mockResolvedValue({ type: 'key', credentialID: 'k' });
    expect(await credentials.readAuth('codex')).toBeNull();
  });
  it('maps xAI without its refresh token and OpenCode Go to an api key', async () => {
    const readProviderSelected = vi.fn(async (scope) => scope.integrationID === 'xai'
      ? { directory, controllerInstanceID: 'i', integrationID: 'xai', credentialID: 'c', value: { type: 'oauth', methodID: 'device', access: 'xa', refresh: 'xr', expires: 99 } }
      : { directory, controllerInstanceID: 'i', integrationID: 'opencode-go', credentialID: 'c', value: { type: 'key', key: 'gk' } });
    const credentials = create(createOwner({ readProviderSelected }));
    const xai = await credentials.readAuth('xai');
    expect(xai).toEqual({ xai: { type: 'oauth', access: 'xa', expires: 99 } });
    expect(JSON.stringify(xai)).not.toContain('xr');
    expect(await credentials.readAuth('opencode-go')).toEqual({ 'opencode-go': { type: 'api', key: 'gk' } });
    expect(readProviderSelected.mock.calls[0][0]).toMatchObject({ kind: 'provider', directory, operation: 'provider.integration', integrationID: 'xai' });
  });

  it('reads the selected Codex access token and account ID without forwarding refresh credentials', async () => {
    const selection = vi.fn(async () => ({ type: 'oauth', methodID: 'chatgpt-browser', credentialID: 'c' }));
    const owner = createOwner({ readOpenAiSelected: vi.fn(async () => ({ directory, integrationID: 'openai', credentialID: 'c',
      value: { type: 'oauth', methodID: 'chatgpt-browser', access: 'native-access', refresh: 'never-forward', metadata: { accountID: 'native-account' } } })) });
    expect(await create(owner, { readOpenAiSelection: selection }).readAuth('codex')).toEqual({ openai: {
      type: 'oauth', methodID: 'chatgpt-browser', access: 'native-access', accountId: 'native-account', connectionId: 'c' } });
    expect(owner.readOpenAiSelected.mock.calls[0][0]).toMatchObject({ directory, kind: 'openai', operation: 'openai.integration' });
    owner.readOpenAiSelected.mockResolvedValue({ directory, integrationID: 'openai', credentialID: 'changed', value: { type: 'oauth', methodID: 'chatgpt-browser', access: 'other' } });
    await expect(create(owner, { readOpenAiSelection: selection }).readAuth('codex')).rejects.toMatchObject({ code: 'native_credential_invalid' });
  });

  it('returns null with no active credential and validates replies', async () => {
    expect(await create(createOwner()).readAuth('xai')).toBeNull();
    const reply = (patch) => create(createOwner({ readProviderSelected: async () => ({ directory, integrationID: 'xai', credentialID: 'c', value: { type: 'oauth', access: 'a' }, ...patch }) })).readAuth('xai');
    await expect(reply({ integrationID: 'opencode-go' })).rejects.toMatchObject({ code: 'native_credential_invalid' });
    await expect(reply({ directory: '/other' })).rejects.toMatchObject({ code: 'native_credential_invalid' });
    await expect(reply({ value: { type: 'oauth', access: 5 } })).rejects.toMatchObject({ code: 'native_credential_invalid' });
    await expect(reply({ value: 'nope' })).rejects.toMatchObject({ code: 'native_credential_invalid' });
    await expect(create(createOwner({ readProviderSelected: undefined })).readAuth('xai')).rejects.toMatchObject({ code: 'native_credential_update_required' });
    await expect(create(createOwner({ isReady: () => false })).readAuth('xai')).rejects.toMatchObject({ code: 'native_runtime_not_ready' });
  });
});
