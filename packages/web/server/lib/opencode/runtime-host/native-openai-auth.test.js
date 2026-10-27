import { describe, expect, it, vi } from 'vitest';
import { createOpenAiOAuthCoordinator } from '../openai-oauth-coordinator.js';
import { createNativeOpenAiAuth } from './native-openai-auth.js';

const directory = '/fixture/project', now = 1000000;
const oauth = (overrides = {}) => ({ type: 'oauth', methodID: 'chatgpt-siwc', access: 'fixture-access', refresh: 'fixture-refresh',
  expires: now + 120000, metadata: {
    accountID: 'fixture-account',
    clientId: 'oaiapp_fixture_client',
    scopes: ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'],
    subject: 'fixture-account',
    extAgentHostId: 'urn:uuid:00000000-0000-4000-8000-000000000001',
    planUsage: true,
    retained: 'fixture',
  }, ...overrides });
function fixture(value = oauth()) {
  let instanceID = 'fixture-controller-1';
  let record = { directory, controllerInstanceID: instanceID, credentialID: 'fixture-credential-1', integrationID: 'openai', value };
  const compareAndSwapSelected = vi.fn(async input => {
    if (JSON.stringify(input.expected) !== JSON.stringify(record)) return false;
    record = { ...record, value: structuredClone(input.next) }; return true;
  });
  const adapter = createNativeOpenAiAuth({ directory, controllerIdentity: () => instanceID,
    readSelected: async () => structuredClone(record), compareAndSwapSelected });
  const fetchImpl = vi.fn(async () => Response.json({ access_token: 'fixture-rotated-access', refresh_token: 'fixture-rotated-refresh', expires_in: 3600 }));
  const coordinator = createOpenAiOAuthCoordinator({ now: () => now, asyncStorage: adapter.asyncStorage,
    readAuth: () => ({ type: 'api', key: 'legacy-fixture-key' }), fetchImpl });
  coordinator.markReady();
  return { adapter, coordinator, fetchImpl, compareAndSwapSelected, get: () => record,
    set: next => { record = next; }, rotate: id => { instanceID = id; } };
}
describe('native OpenAI canonical credential adapter', () => {
  it.each(['chatgpt-token-sharing','chatgpt-siwc','chatgpt-browser','chatgpt-headless'])('refuses %s for managed users without refresh or mutation', async methodID => {
    const f = fixture(oauth({ methodID, expires: 1 }));
    const before = structuredClone(f.get());
    await expect(f.coordinator.getBindingAsync()).rejects.toMatchObject({ code: 'bot_opencode_provider_authentication', statusCode: 401 });
    await expect(f.adapter.access(f.coordinator, { directory })).rejects.toMatchObject({ code: 'bot_opencode_provider_authentication' });
    await expect(f.adapter.imageAccess({ directory })).rejects.toMatchObject({ code: 'bot_opencode_provider_authentication' });
    expect(f.get()).toEqual(before); expect(f.fetchImpl).not.toHaveBeenCalled(); expect(f.compareAndSwapSelected).not.toHaveBeenCalled();
    expect(await f.adapter.asyncStorage.compareAndSwap({}, {})).toBe(false);
  });
  it('refuses account/controller switches during asynchronous selection reads', async () => {
    const f = fixture();
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const adapter = createNativeOpenAiAuth({ directory, controllerIdentity: () => f.get().controllerInstanceID,
      readSelected: async () => { const old = structuredClone(f.get()); await waiting; return old; }, compareAndSwapSelected: f.compareAndSwapSelected });
    const access = adapter.asyncStorage.readAuth();
    f.set({ ...f.get(), controllerInstanceID: 'fixture-controller-2' }); release();
    await expect(access).rejects.toMatchObject({ code: 'native_openai_owner_unavailable' });
  });
  it('returns API-key mode without sending it to the OAuth endpoint', async () => {
    const f = fixture({ type: 'key', key: 'fixture-native-key' });
    expect(await f.adapter.access(f.coordinator, { directory })).toBeUndefined();
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('projects only the exact selected key for image access and refuses forged, changed or replaced proofs', async () => {
    const f = fixture({ type: 'key', key: 'fixture-native-key' });
    const access = await f.adapter.imageAccess({ directory });
    expect(access).toMatchObject({ valueType: 'key', methodID: 'api-key', credentialID: 'fixture-credential-1', accessToken: 'fixture-native-key' });
    expect(access).not.toHaveProperty('accountId');
    await f.adapter.recheckImageAccess(access, { directory });
    await expect(f.adapter.recheckImageAccess({ ...access }, { directory })).rejects.toMatchObject({ code: 'native_openai_owner_unavailable' });
    await expect(f.adapter.recheckImageAccess(access, { directory: '/fixture/foreign' })).rejects.toMatchObject({ code: 'native_openai_owner_unavailable' });
    const selected = f.get();
    for (const change of [{ credentialID: 'fixture-other-key' }, { value: { type: 'key', key: 'fixture-changed-key' } }]) {
      f.set({ ...selected, ...change });
      await expect(f.adapter.recheckImageAccess(access, { directory })).rejects.toMatchObject({ code: 'native_image_generation_credential_changed' });
    }
    f.set(selected); f.rotate('fixture-controller-2');
    await expect(f.adapter.recheckImageAccess(access, { directory })).rejects.toMatchObject({ code: 'native_openai_owner_unavailable' });
    expect(f.fetchImpl).not.toHaveBeenCalled(); expect(f.compareAndSwapSelected).not.toHaveBeenCalled();
  });
});
