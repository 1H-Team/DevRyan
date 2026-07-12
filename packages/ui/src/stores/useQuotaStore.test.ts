import { beforeEach, describe, expect, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import type { ProviderResult, QuotaProviderId } from '@/types';
import {
  BASELINE_QUOTA_REFRESH_MS,
  getQuotaProviderRefreshStatus,
  useQuotaStore,
} from './useQuotaStore';

const originalFetch = globalThis.fetch;

const providerResult = (
  providerId: QuotaProviderId,
  overrides: Partial<ProviderResult> = {},
): ProviderResult => ({
  providerId,
  providerName: providerId,
  ok: true,
  configured: true,
  usage: { windows: {} },
  fetchedAt: Date.now(),
  ...overrides,
});

const pendingResponse = () => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

describe('useQuotaStore refresh ownership', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
    opencodeClient.setDirectory(`/tmp/devryan-quota-store-${Date.now()}-${Math.random()}`);
    useQuotaStore.setState({
      results: [],
      trendHistory: {},
      configuredProviderIds: null,
      providerRefreshState: {},
      selectedProviderId: null,
      isLoading: false,
      isFetchingProvider: {},
      lastUpdated: null,
      error: null,
    });
  });

  test('discovers and refreshes only configured known providers', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === '/api/quota/providers') {
        return Response.json({ providers: ['cursor-acp', 'unsupported', 'codex'] });
      }
      const providerId = decodeURIComponent(url.split('/').at(-1) ?? '') as QuotaProviderId;
      return Response.json(providerResult(providerId));
    }) as typeof fetch;

    await useQuotaStore.getState().fetchAllQuotas({ rediscover: true });

    expect(useQuotaStore.getState().configuredProviderIds).toEqual(['codex', 'cursor-acp']);
    expect(calls).toEqual([
      '/api/quota/providers',
      '/api/quota/codex',
      '/api/quota/cursor-acp',
    ]);
  });

  test('returns the same promise for duplicate provider refreshes', async () => {
    const response = pendingResponse();
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return response.promise;
    }) as typeof fetch;

    const first = useQuotaStore.getState().fetchProviderQuota('codex');
    const second = useQuotaStore.getState().fetchProviderQuota('codex', { forceRefresh: true });

    expect(second).toBe(first);
    expect(calls).toBe(1);

    response.resolve(Response.json(providerResult('codex')));
    await first;
    expect(useQuotaStore.getState().isFetchingProvider.codex).toBe(false);
  });

  test('preserves the last valid result and records a transient refresh failure separately', async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) {
        return Response.json(providerResult('codex', {
          usage: {
            windows: {
              weekly: {
                usedPercent: 42,
                remainingPercent: 58,
                windowSeconds: 604_800,
                resetAfterSeconds: null,
                resetAt: null,
                resetAtFormatted: null,
                resetAfterFormatted: null,
              },
            },
          },
        }));
      }
      return Response.json({ error: 'temporary outage' }, { status: 503 });
    }) as typeof fetch;

    await useQuotaStore.getState().fetchProviderQuota('codex');
    const validResult = useQuotaStore.getState().results[0];
    const firstSuccessAt = useQuotaStore.getState().providerRefreshState.codex?.lastSuccessAt;

    await useQuotaStore.getState().fetchProviderQuota('codex', { forceRefresh: true });

    const state = useQuotaStore.getState();
    expect(state.results[0]).toBe(validResult);
    expect(state.results[0].usage?.windows.weekly?.usedPercent).toBe(42);
    expect(state.providerRefreshState.codex?.lastSuccessAt).toBe(firstSuccessAt);
    expect(state.providerRefreshState.codex?.refreshError).toBe('temporary outage');
  });

  test('keeps provider errors independent when another provider succeeds', async () => {
    globalThis.fetch = (async (input) => {
      const providerId = String(input).includes('codex') ? 'codex' : 'cursor-acp';
      if (providerId === 'codex') {
        return Response.json({ error: 'codex unavailable' }, { status: 502 });
      }
      return Response.json(providerResult('cursor-acp'));
    }) as typeof fetch;

    await useQuotaStore.getState().fetchProviderQuota('codex');
    await useQuotaStore.getState().fetchProviderQuota('cursor-acp');

    const refreshState = useQuotaStore.getState().providerRefreshState;
    expect(refreshState.codex?.refreshError).toBe('codex unavailable');
    expect(refreshState['cursor-acp']?.refreshError).toBeNull();
  });

  test('force rediscovery updates provider ownership and refresh URLs safely', async () => {
    let discoveryCount = 0;
    const calls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === '/api/quota/providers') {
        discoveryCount += 1;
        return Response.json({
          providers: discoveryCount === 1 ? ['codex'] : ['cursor-acp'],
        });
      }
      const providerId = url.includes('cursor-acp') ? 'cursor-acp' : 'codex';
      return Response.json(providerResult(providerId));
    }) as typeof fetch;

    await useQuotaStore.getState().fetchAllQuotas({ rediscover: true });
    await useQuotaStore.getState().fetchAllQuotas({ rediscover: true, forceRefresh: true });

    expect(useQuotaStore.getState().configuredProviderIds).toEqual(['cursor-acp']);
    expect(useQuotaStore.getState().results.map((result) => result.providerId)).toEqual(['cursor-acp']);
    expect(calls).toContain('/api/quota/cursor-acp?refresh=true');
  });

  test('derives stale state from the active cadence without a second timer', () => {
    const refreshedAt = 1_000;
    const refreshState = {
      lastAttemptAt: refreshedAt,
      lastSuccessAt: refreshedAt,
      refreshError: null,
    };

    expect(getQuotaProviderRefreshStatus(refreshState, BASELINE_QUOTA_REFRESH_MS, refreshedAt + BASELINE_QUOTA_REFRESH_MS - 1).isStale).toBe(false);
    expect(getQuotaProviderRefreshStatus(refreshState, BASELINE_QUOTA_REFRESH_MS, refreshedAt + BASELINE_QUOTA_REFRESH_MS).isStale).toBe(true);
  });
});
