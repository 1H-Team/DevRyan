import { beforeEach, describe, expect, test } from 'bun:test';
import { useProviderConnectionStore, waitForProviderCatalogReady } from './providerCatalogConnection';

describe('post-auth provider catalog readiness', () => {
  beforeEach(() => useProviderConnectionStore.setState({ pending: {} }));

  test('returns immediately for ready catalogs without applying config', async () => {
    let refreshes = 0;
    let reloads = 0;
    expect(await waitForProviderCatalogReady({
      refresh: async () => { refreshes += 1; },
      isReady: () => true,
      onStalled: async () => { reloads += 1; return true; },
    })).toBe(true);
    expect(refreshes).toBe(1);
    expect(reloads).toBe(0);
  });

  test('retries unavailable catalogs and escalates once before models arrive', async () => {
    let refreshes = 0;
    let reloads = 0;
    expect(await waitForProviderCatalogReady({
      refresh: async () => { if (++refreshes === 1) throw new Error('restarting'); },
      isReady: () => refreshes === 5,
      onStalled: async () => { reloads += 1; return true; },
      sleep: async () => {},
    })).toBe(true);
    expect(refreshes).toBe(5);
    expect(reloads).toBe(1);
  });

  test('stops polling when apply is deferred and exhausts retries without looping forever', async () => {
    let refreshes = 0;
    const options = {
      refresh: async () => { refreshes += 1; },
      isReady: () => false,
      sleep: async () => {},
    };
    expect(await waitForProviderCatalogReady({ ...options, onStalled: async () => false })).toBe(false);
    expect(refreshes).toBe(3);
    refreshes = 0;
    expect(await waitForProviderCatalogReady(options)).toBe(false);
    expect(refreshes).toBe(8);
  });

  test('keeps only credential-free pending state, isolated from Zen, until Go is ready', () => {
    const store = useProviderConnectionStore.getState();
    store.markPending({ id: 'opencode-go', name: 'OpenCode Go', lastAttemptRevision: 3 });
    expect(useProviderConnectionStore.getState().pending['opencode']).toBeUndefined();
    // A settings remount reads the same transient state; applied revisions allow a new attempt.
    expect(useProviderConnectionStore.getState().pending['opencode-go']?.lastAttemptRevision).toBe(3);
    store.clear('opencode-go');
    expect(useProviderConnectionStore.getState().pending).toEqual({});
  });
});
