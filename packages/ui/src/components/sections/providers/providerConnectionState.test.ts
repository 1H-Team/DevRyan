import { describe, expect, test } from 'bun:test';

import {
  disconnectProvider,
  getProviderConnectionState,
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
});
