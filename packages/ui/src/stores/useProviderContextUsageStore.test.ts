import { beforeEach, describe, expect, test } from 'bun:test';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { RuntimeAPIs } from '@/lib/api/types';
import {
  getProviderContextUsageStoreKey,
  invalidateProviderContextUsageForCompaction,
  refreshProviderContextUsage,
  useProviderContextUsageStore,
} from './useProviderContextUsageStore';

const SESSION_ID = 'ses_provider_context_test';
const DIRECTORY = '/repo';

describe('provider context usage store', () => {
  beforeEach(() => {
    registerRuntimeAPIs(null);
    useProviderContextUsageStore.setState({ entries: new Map(), compactionRevisions: new Map() });
  });

  test('coalesces identical refreshes and stores the provider snapshot', async () => {
    let calls = 0;
    let resolveRequest!: (value: Awaited<ReturnType<NonNullable<RuntimeAPIs['contextUsage']>['getSessionUsage']>>) => void;
    const pending = new Promise<Awaited<ReturnType<NonNullable<RuntimeAPIs['contextUsage']>['getSessionUsage']>>>((resolve) => {
      resolveRequest = resolve;
    });
    registerRuntimeAPIs({
      contextUsage: {
        getSessionUsage: async () => {
          calls += 1;
          return pending;
        },
      },
    } as unknown as RuntimeAPIs);

    const first = refreshProviderContextUsage({ sessionID: SESSION_ID, directory: DIRECTORY, requestKey: 'message:1' });
    const second = refreshProviderContextUsage({ sessionID: SESSION_ID, directory: DIRECTORY, requestKey: 'message:1' });
    expect(calls).toBe(1);
    resolveRequest({
      sessionID: SESSION_ID,
      status: 'available',
      source: 'meridian',
      inputTokens: 2,
      cacheReadTokens: 125_220,
      cacheWriteTokens: 1_818,
      activeInputTokens: 127_040,
      lastOutputTokens: 1_464,
      fetchedAt: 10,
    });
    await Promise.all([first, second]);

    const entry = useProviderContextUsageStore.getState().entries.get(
      getProviderContextUsageStoreKey(SESSION_ID, DIRECTORY),
    );
    expect(entry?.snapshot?.activeInputTokens).toBe(127_040);
  });

  test('clears the old high-water mark immediately at a compaction boundary', async () => {
    const key = getProviderContextUsageStoreKey(SESSION_ID, DIRECTORY);
    let resolveCompaction!: (value: Awaited<ReturnType<NonNullable<RuntimeAPIs['contextUsage']>['getSessionUsage']>>) => void;
    let refreshOptions: { directory?: string; refreshSession?: boolean } | undefined;
    registerRuntimeAPIs({
      contextUsage: {
        getSessionUsage: (
          _sessionID: string,
          options?: { directory?: string; refreshSession?: boolean },
        ) => new Promise((resolve) => {
          refreshOptions = options;
          resolveCompaction = resolve;
        }),
      },
    } as unknown as RuntimeAPIs);
    useProviderContextUsageStore.setState({
      entries: new Map([[key, {
        requestKey: 'message:old',
        status: 'available',
        snapshot: {
          sessionID: SESSION_ID,
          status: 'available',
          source: 'meridian',
          inputTokens: 190_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          activeInputTokens: 190_000,
          lastOutputTokens: 0,
          fetchedAt: 1,
        },
      }]]),
      compactionRevisions: new Map(),
    });

    const revision = invalidateProviderContextUsageForCompaction(SESSION_ID, DIRECTORY);
    expect(revision).toBe(1);
    expect(refreshOptions).toEqual({ directory: DIRECTORY, refreshSession: true });
    expect(useProviderContextUsageStore.getState().entries.get(key)).toEqual({
      requestKey: 'compaction:1',
      status: 'loading',
      snapshot: null,
    });
    resolveCompaction({
      sessionID: SESSION_ID,
      status: 'available',
      source: 'meridian',
      inputTokens: 24_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      activeInputTokens: 24_000,
      lastOutputTokens: 300,
      fetchedAt: 2,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(useProviderContextUsageStore.getState().entries.get(key)?.snapshot?.activeInputTokens).toBe(24_000);
  });
});
