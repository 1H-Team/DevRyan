import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { finishConfigUpdate, getConfigUpdateSnapshot } from '@/lib/configUpdate';
import { getConfigApplyStatusText } from '@/components/views/config-apply/configApplyPresentation';
import {
  parseConfigApplyStatus,
  recordConfigMutationResponse,
  shouldPollConfigApplyStatus,
  useConfigApplyStore,
  type ConfigApplyStatus,
} from './useConfigApplyStore';

const status = (overrides: Partial<ConfigApplyStatus> = {}): ConfigApplyStatus => ({
  revision: 3,
  appliedRevision: 1,
  state: 'pending',
  pending: true,
  scopes: ['agents', 'skills'],
  reasonCodes: ['CONFIG_AGENTS_CHANGED', 'CONFIG_SKILLS_CHANGED'],
  activeSessionCount: 0,
  runtimeMode: 'managed',
  canApplyWhenIdle: true,
  canForceRestart: true,
  ...overrides,
});

const originalFetch = globalThis.fetch;

beforeEach(() => {
  while (getConfigUpdateSnapshot().isUpdating) finishConfigUpdate();
  useConfigApplyStore.setState({
    status: null,
    hydrated: false,
    isRequesting: false,
    requestError: null,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('configuration apply UI projection', () => {
  test('parses the fixed status contract and rejects unknown scopes', () => {
    expect(parseConfigApplyStatus(status())).toEqual(status());
    expect(parseConfigApplyStatus({ ...status(), scopes: ['secret-provider-name'] })).toBeNull();
  });

  test('merges mutation status without showing the restart overlay for an ordinary save', () => {
    recordConfigMutationResponse({
      requiresApply: true,
      applyRevision: 3,
      applyScopes: ['agents', 'skills'],
      applyStatus: status(),
      requiresReload: false,
    });

    expect(useConfigApplyStore.getState().status).toEqual(status());
    expect(getConfigUpdateSnapshot().isUpdating).toBe(false);
  });

  test('shows the overlay only for applying and clears it at the next stable status', () => {
    recordConfigMutationResponse({ applyStatus: status({ state: 'applying' }) });
    expect(getConfigUpdateSnapshot().isUpdating).toBe(true);

    recordConfigMutationResponse({ applyStatus: status({ state: 'waiting_for_idle', activeSessionCount: 2 }) });
    expect(getConfigUpdateSnapshot().isUpdating).toBe(false);
  });

  test('waits for authoritative applying status before showing the restart overlay', async () => {
    const pending = status({
      scopes: ['behavior'],
      reasonCodes: ['CONFIG_BEHAVIOR_CHANGED'],
    });
    useConfigApplyStore.setState({ status: pending, hydrated: true });

    let resolveResponse: (response: Response) => void = () => {};
    const responsePromise = new Promise<Response>((resolve) => { resolveResponse = resolve; });
    globalThis.fetch = (() => responsePromise) as typeof fetch;

    const request = useConfigApplyStore.getState().forceRestart();
    expect(getConfigUpdateSnapshot().isUpdating).toBe(false);
    expect(useConfigApplyStore.getState().status?.state).toBe('pending');

    recordConfigMutationResponse({ applyStatus: status({
      state: 'applying',
      scopes: ['behavior'],
      reasonCodes: ['CONFIG_BEHAVIOR_CHANGED'],
    }) });
    expect(getConfigUpdateSnapshot().isUpdating).toBe(true);

    const clean = status({
      state: 'clean',
      pending: false,
      appliedRevision: 3,
      scopes: [],
      reasonCodes: [],
    });
    resolveResponse(new Response(JSON.stringify({
      status: clean,
      appliedRevision: 3,
      appliedScopes: ['behavior'],
      userConfirmed: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await request;
    expect(getConfigUpdateSnapshot().isUpdating).toBe(false);
    expect(useConfigApplyStore.getState().status?.state).toBe('clean');
  });

  test('polls only pending, waiting, and applying states', () => {
    expect(shouldPollConfigApplyStatus(status())).toBe(true);
    expect(shouldPollConfigApplyStatus(status({ state: 'waiting_for_idle' }))).toBe(true);
    expect(shouldPollConfigApplyStatus(status({ state: 'applying' }))).toBe(true);
    expect(shouldPollConfigApplyStatus(status({ state: 'failed' }))).toBe(false);
    expect(shouldPollConfigApplyStatus(status({ state: 'external_restart_required' }))).toBe(false);
    expect(shouldPollConfigApplyStatus(status({ state: 'clean', pending: false }))).toBe(false);
  });

  test('presents active-chat and external-runtime states explicitly', () => {
    expect(getConfigApplyStatusText(status({ state: 'waiting_for_idle', activeSessionCount: 1 })))
      .toBe('Waiting for 1 active chat to finish.');
    expect(getConfigApplyStatusText(status({ state: 'waiting_for_idle', activeSessionCount: 4 })))
      .toBe('Waiting for 4 active chats to finish.');
    expect(getConfigApplyStatusText(status({ state: 'external_restart_required', runtimeMode: 'external' })))
      .toContain('restart the external OpenCode runtime');
  });
});
