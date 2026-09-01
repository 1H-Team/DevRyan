import { beforeEach, describe, expect, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import {
  getAuthPrincipal,
  setAuthPrincipal,
  type AuthAssignment,
  type AuthPrincipal,
} from '@/lib/authSession';
import type { ProviderResult, QuotaProviderId } from '@/types';
import {
  BASELINE_QUOTA_REFRESH_MS,
  getQuotaProviderRefreshStatus,
  useQuotaStore,
} from './useQuotaStore';

const originalFetch = globalThis.fetch;

const managedPrincipal = (
  assignments: AuthAssignment[],
  role: AuthPrincipal['role'] = 'developer',
): AuthPrincipal => ({
  ...getAuthPrincipal(),
  id: `${role}-1`,
  email: `${role}-1@example.com`,
  displayName: role,
  role,
  scope: 'managed',
  assignments,
});

const assignment = (
  projectId: string,
  publicDirectory: string,
  isDefault = false,
): AuthAssignment => ({
  projectId,
  label: projectId,
  branchName: 'main',
  publicDirectory,
  githubAccountId: null,
  isDefault,
});

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
    setAuthPrincipal(null);
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

  test('uses the active managed assignment for discovery and provider refresh', async () => {
    const first = assignment('project-1', '/projects/project-1/main', true);
    const active = assignment('project-2', '/projects/project-2/main');
    setAuthPrincipal(managedPrincipal([first, active]));
    opencodeClient.setDirectory(active.publicDirectory);

    const requests: Array<{ url: string; directory: string | null }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        directory: new Headers(init?.headers).get('x-opencode-directory'),
      });
      if (url === '/api/quota/providers') {
        return Response.json({ providers: ['codex'] });
      }
      return Response.json(providerResult('codex'));
    }) as typeof fetch;

    await useQuotaStore.getState().fetchAllQuotas({ rediscover: true });

    expect(requests).toEqual([
      { url: '/api/quota/providers', directory: active.publicDirectory },
      { url: '/api/quota/codex', directory: active.publicDirectory },
    ]);
  });

  test('falls back from a stale directory to the default managed assignment for forced refreshes', async () => {
    const first = assignment('project-1', '/projects/project-1/main');
    const fallback = assignment('project-2', '/projects/project-2/main', true);
    setAuthPrincipal(managedPrincipal([first, fallback]));
    opencodeClient.setDirectory('/projects/revoked/main');

    const requests: Array<{ url: string; directory: string | null }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        directory: new Headers(init?.headers).get('x-opencode-directory'),
      });
      if (url === '/api/quota/providers') {
        return Response.json({ providers: ['codex'] });
      }
      return Response.json(providerResult('codex'));
    }) as typeof fetch;

    await useQuotaStore.getState().fetchAllQuotas({ rediscover: true, forceRefresh: true });

    expect(requests).toEqual([
      { url: '/api/quota/providers', directory: fallback.publicDirectory },
      { url: '/api/quota/codex?refresh=true', directory: fallback.publicDirectory },
    ]);
  });

  test('uses the first managed assignment when none is marked as default', async () => {
    const first = assignment('project-1', '/projects/project-1/main');
    const second = assignment('project-2', '/projects/project-2/main');
    setAuthPrincipal(managedPrincipal([first, second]));
    opencodeClient.setDirectory('/projects/revoked/main');

    let directory: string | null = null;
    globalThis.fetch = (async (_input, init) => {
      directory = new Headers(init?.headers).get('x-opencode-directory');
      return Response.json(providerResult('codex'));
    }) as typeof fetch;

    await useQuotaStore.getState().fetchProviderQuota('codex');

    expect(directory).toBe(first.publicDirectory);
  });

  test('omits the directory header for a managed developer without assignments', async () => {
    setAuthPrincipal(managedPrincipal([]));

    let directory: string | null = 'not-requested';
    globalThis.fetch = (async (_input, init) => {
      directory = new Headers(init?.headers).get('x-opencode-directory');
      return Response.json(providerResult('codex'));
    }) as typeof fetch;

    await useQuotaStore.getState().fetchProviderQuota('codex');

    expect(directory).toBeNull();
  });

  test('preserves the current directory for local and managed administrators', async () => {
    const directories: Array<string | null> = [];
    globalThis.fetch = (async (_input, init) => {
      directories.push(new Headers(init?.headers).get('x-opencode-directory'));
      return Response.json(providerResult('codex'));
    }) as typeof fetch;

    opencodeClient.setDirectory('/local/admin/workspace');
    await useQuotaStore.getState().fetchProviderQuota('codex');

    setAuthPrincipal(managedPrincipal([], 'admin'));
    opencodeClient.setDirectory('/managed/admin/workspace');
    await useQuotaStore.getState().fetchProviderQuota('codex', { forceRefresh: true });

    expect(directories).toEqual(['/local/admin/workspace', '/managed/admin/workspace']);
  });

  test('discovers and refreshes only configured known providers', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === '/api/quota/providers') {
        return Response.json({ providers: ['cursor-acp', 'unsupported', 'deepseek', 'xai', 'codex'] });
      }
      const providerId = decodeURIComponent(url.split('/').at(-1) ?? '') as QuotaProviderId;
      return Response.json(providerResult(providerId));
    }) as typeof fetch;

    await useQuotaStore.getState().fetchAllQuotas({ rediscover: true });

    expect(useQuotaStore.getState().configuredProviderIds).toEqual(['codex', 'xai', 'cursor-acp', 'deepseek']);
    expect(calls).toEqual([
      '/api/quota/providers',
      '/api/quota/codex',
      '/api/quota/xai',
      '/api/quota/cursor-acp',
      '/api/quota/deepseek',
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
