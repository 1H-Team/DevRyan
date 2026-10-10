import { describe, expect, test } from 'bun:test';
import { useQuotaStore } from '@/stores/useQuotaStore';
import type { ProviderResult } from '@/types';

import {
  disconnectProvider,
  getProviderConnectionState,
  getProviderDisconnectOutcome,
  hasActiveProviderSource,
  shouldShowConnectedProvider,
  useProviderDisconnectStore,
  type ProviderSources,
} from './providerConnectionState';

const sources = (overrides: Partial<ProviderSources> = {}): ProviderSources => ({
  auth: { exists: false },
  user: { exists: false },
  project: { exists: false },
  custom: { exists: false },
  anthropicOAuth: { exists: false },
  ...overrides,
});

describe('provider connection state', () => {
  test('uses source state instead of catalog presence for Google and Antigravity', () => {
    const empty = sources();
    expect(getProviderConnectionState('google', empty, false)).toBe('not_connected');
    expect(getProviderConnectionState('antigravity', empty, false)).toBe('not_connected');
    expect(shouldShowConnectedProvider('google', empty, false)).toBe(false);
    expect(shouldShowConnectedProvider('antigravity', empty, false)).toBe(false);
  });

  test('keeps authoritative providers visible while their disconnect is pending', () => {
    const empty = sources();
    expect(getProviderConnectionState('google', empty, true)).toBe('disconnect_pending');
    expect(shouldShowConnectedProvider('google', empty, true)).toBe(true);
  });

  test('recognizes auth, user, project, custom, and Claude proxy sources', () => {
    expect(hasActiveProviderSource(sources({ auth: { exists: true } }))).toBe(true);
    expect(hasActiveProviderSource(sources({ user: { exists: true } }))).toBe(true);
    expect(hasActiveProviderSource(sources({ project: { exists: true } }))).toBe(true);
    expect(hasActiveProviderSource(sources({ custom: { exists: true } }))).toBe(true);
    expect(hasActiveProviderSource(sources({ anthropicOAuth: { exists: true } }))).toBe(true);
  });

  test('preserves catalog-driven behavior for providers without authoritative source classification', () => {
    expect(getProviderConnectionState('openai', sources(), false)).toBe('connected');
    expect(shouldShowConnectedProvider('openai', sources(), false)).toBe(true);
  });

  test('keeps pending state until the requested provider revision is applied', () => {
    useProviderDisconnectStore.setState({
      pendingRevisionByProvider: {},
      sourceRefreshRevision: 0,
    });

    useProviderDisconnectStore.getState().markRequested('google', {
      success: true,
      removed: true,
      applyStatus: { revision: 9, appliedRevision: 8, pending: true },
    });
    expect(useProviderDisconnectStore.getState().pendingRevisionByProvider).toEqual({ google: 9 });

    useProviderDisconnectStore.getState().reconcileAppliedRevision(8);
    expect(useProviderDisconnectStore.getState().pendingRevisionByProvider).toEqual({ google: 9 });

    useProviderDisconnectStore.getState().reconcileAppliedRevision(9);
    expect(useProviderDisconnectStore.getState().pendingRevisionByProvider).toEqual({});
    expect(useProviderDisconnectStore.getState().sourceRefreshRevision).toBe(2);
  });

  test('clears a provider immediately when the apply envelope is already complete', () => {
    useProviderDisconnectStore.setState({
      pendingRevisionByProvider: { google: 4 },
      sourceRefreshRevision: 0,
    });

    useProviderDisconnectStore.getState().markRequested('google', {
      success: true,
      removed: true,
      requiresApply: true,
      applyStatus: { revision: 5, appliedRevision: 5, pending: false },
    });

    expect(useProviderDisconnectStore.getState().pendingRevisionByProvider).toEqual({});
  });

  test('keeps a provider connected when something still provides it after disconnect', () => {
    useProviderDisconnectStore.setState({
      pendingRevisionByProvider: {},
      sourceRefreshRevision: 0,
    });
    const response = {
      success: true,
      removed: false,
      stillProvidedBy: [
        { type: 'config' as const, path: '/home/.config/opencode/opencode.json' },
        { type: 'env' as const, name: 'GEMINI_API_KEY' },
        { type: 'auth' as const, path: null },
      ],
      applyStatus: { revision: 3, appliedRevision: 2, pending: true },
    };

    useProviderDisconnectStore.getState().markRequested('google', response);

    expect(useProviderDisconnectStore.getState().pendingRevisionByProvider).toEqual({});
    expect(useProviderDisconnectStore.getState().sourceRefreshRevision).toBe(1);
    expect(getProviderDisconnectOutcome(response)).toEqual({
      kind: 'still_provided',
      sources: ['/home/.config/opencode/opencode.json', 'GEMINI_API_KEY', 'auth.json'],
    });
    expect(getProviderDisconnectOutcome({ success: true, removed: false })).toEqual({ kind: 'disconnected' });
    expect(getProviderDisconnectOutcome({ success: true, removed: true, stillProvidedBy: [] }))
      .toEqual({ kind: 'disconnected' });
  });

  test('surfaces failed disconnect responses without creating pending UI state', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Unable to remove Google credentials' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
    useProviderDisconnectStore.setState({
      pendingRevisionByProvider: {},
      sourceRefreshRevision: 0,
    });

    try {
      let failure: unknown;
      try {
        await disconnectProvider('google', '/tmp/active-project');
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe('Unable to remove Google credentials');
      expect(useProviderDisconnectStore.getState().pendingRevisionByProvider).toEqual({});
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('clears OpenAI usage only after a successful disconnect', async () => {
    const originalFetch = globalThis.fetch;
    const originalQuota = useQuotaStore.getState();
    const previous: ProviderResult = { providerId: 'codex', providerName: 'Codex', configured: true, ok: true, usage: { windows: {} }, fetchedAt: 1,
      source: 'chatgpt-siwc', connectionId: 'old-account', account: { email: 'old@example.test', planType: 'plus' } };
    useQuotaStore.setState({ results: [previous] });
    try {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Unable to disconnect' }), { status: 500 });
      await expect(disconnectProvider('openai', null)).rejects.toThrow('Unable to disconnect');
      expect(useQuotaStore.getState().results[0]).toBe(previous);
      globalThis.fetch = async () => new Response(JSON.stringify({ success: true, removed: true }));
      await disconnectProvider('openai', null);
      expect(useQuotaStore.getState().results).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      useQuotaStore.setState(originalQuota, true);
    }
  });
});
