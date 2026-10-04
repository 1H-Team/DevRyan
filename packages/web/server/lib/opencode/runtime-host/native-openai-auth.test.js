import { describe, expect, it, vi } from 'vitest';
import { createOpenAiOAuthCoordinator } from '../openai-oauth-coordinator.js';
import { createNativeOpenAiAuth } from './native-openai-auth.js';

const directory = '/fixture/project', now = 1000000;
const oauth = (overrides = {}) => ({ type: 'oauth', methodID: 'chatgpt-browser', access: 'fixture-access', refresh: 'fixture-refresh',
  expires: now + 120000, metadata: { accountID: 'fixture-account', retained: 'fixture' }, ...overrides });
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
  it('uses current native account and controller generation while legacy inspectors remain synchronous', async () => {
    const f = fixture();
    expect(f.coordinator.usesOAuth()).toBe(false);
    expect(await f.coordinator.usesOAuthAsync()).toBe(true);
    const first = await f.adapter.access(f.coordinator, { directory });
    expect(first).toMatchObject({ credentialID: 'fixture-credential-1', methodID: 'chatgpt-browser', accountId: 'fixture-account', accessToken: 'fixture-access' });
    expect(f.fetchImpl).not.toHaveBeenCalled();
    f.rotate('fixture-controller-2'); f.set({ ...f.get(), controllerInstanceID: 'fixture-controller-2' });
    const second = await f.adapter.access(f.coordinator, { directory });
    expect(second.generation).not.toBe(first.generation);
  });
  it('refreshes once under the existing queue, preserving method and all native metadata', async () => {
    const f = fixture(oauth({ expires: now - 1 }));
    const [first, second] = await Promise.all([f.adapter.access(f.coordinator, { directory }), f.adapter.access(f.coordinator, { directory })]);
    expect(first).toEqual(second);
    expect(first.accessToken).toBe('fixture-rotated-access');
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(f.compareAndSwapSelected).toHaveBeenCalledTimes(1);
    expect(f.get().value).toMatchObject({ methodID: 'chatgpt-browser', metadata: { accountID: 'fixture-account', retained: 'fixture' }, refresh: 'fixture-rotated-refresh' });
  });
  it('does not accept a forged or modified normalized CAS record', async () => {
    const f = fixture();
    const original = await f.adapter.asyncStorage.readAuth();
    expect(await f.adapter.asyncStorage.compareAndSwap({ ...original }, { ...original, access: 'forged' })).toBe(false);
    await expect(f.adapter.asyncStorage.compareAndSwap(original, { ...original, methodID: 'chatgpt-headless' })).rejects.toMatchObject({ code: 'native_openai_owner_unavailable' });
    expect(f.compareAndSwapSelected).not.toHaveBeenCalled();
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
  it('rejects unsupported token-sharing instead of invoking native refresh', async () => {
    const f = fixture(oauth({ methodID: 'chatgpt-token-sharing' }));
    await expect(f.adapter.access(f.coordinator, { directory })).rejects.toMatchObject({ code: 'native_openai_method_unsupported' });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('returns API-key mode without sending it to the OAuth endpoint', async () => {
    const f = fixture({ type: 'key', key: 'fixture-native-key' });
    expect(await f.adapter.access(f.coordinator, { directory })).toBeUndefined();
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('does not release a token after a same-account selected-credential switch', async () => {
    const f = fixture();
    const coordinator = { access: async () => {
      f.set({ ...f.get(), credentialID: 'fixture-credential-2' });
      return { accountId: 'fixture-account', accessToken: 'fixture-access', expiresAt: now + 120000, generation: 'fixture' };
    } };
    await expect(f.adapter.access(coordinator, { directory })).rejects.toMatchObject({ code: 'native_openai_owner_unavailable' });
  });
});
