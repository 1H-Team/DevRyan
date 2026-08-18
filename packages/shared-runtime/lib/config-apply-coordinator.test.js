import { describe, expect, test } from 'bun:test';

import {
  ConfigApplyError,
  classifyConfigChange,
  createConfigApplyCoordinator,
} from './config-apply-coordinator.js';

const change = (coordinator, scope = 'agents', reasonCode = 'CONFIG_AGENTS_CHANGED') => (
  coordinator.markChanged({ scope, reasonCode })
);

describe('ConfigApplyCoordinator', () => {
  test('classifies global AGENTS.md writes as behavior changes before generic agent changes', () => {
    expect(classifyConfigChange('global behavior (AGENTS.md) updated')).toEqual({
      scope: 'behavior',
      reasonCode: 'CONFIG_BEHAVIOR_CHANGED',
    });
    expect(classifyConfigChange('agent model override')).toEqual({
      scope: 'agents',
      reasonCode: 'CONFIG_AGENTS_CHANGED',
    });
  });

  test('does not increment for unchanged writes and combines changed scopes', () => {
    const coordinator = createConfigApplyCoordinator({ applyChanges: async () => {} });
    const unchanged = coordinator.markChanged({
      scope: 'agents', reasonCode: 'CONFIG_AGENTS_CHANGED', changed: false,
    });
    expect(unchanged.applyRevision).toBe(0);
    change(coordinator);
    change(coordinator, 'mcp', 'CONFIG_MCP_CHANGED');
    expect(coordinator.getStatus()).toMatchObject({
      revision: 2,
      scopes: ['agents', 'mcp'],
      reasonCodes: ['CONFIG_AGENTS_CHANGED', 'CONFIG_MCP_CHANGED'],
    });
  });

  test('applies immediately only after authoritative idleness is confirmed', async () => {
    let applied = 0;
    let authoritativeChecks = 0;
    const coordinator = createConfigApplyCoordinator({
      getActiveSessionCount: () => 0,
      getAuthoritativeActiveSessionCount: async () => { authoritativeChecks += 1; return 0; },
      applyChanges: async () => { applied += 1; },
    });
    const mutation = change(coordinator);
    const result = await coordinator.apply(mutation.applyRevision, 'when-idle');
    expect(authoritativeChecks).toBe(1);
    expect(applied).toBe(1);
    expect(result.status.state).toBe('clean');
  });

  test('waits on the cheap count and confirms authoritatively before applying', async () => {
    let local = 1;
    let applyResolve;
    const applied = new Promise((resolve) => { applyResolve = resolve; });
    let authoritativeChecks = 0;
    const coordinator = createConfigApplyCoordinator({
      getActiveSessionCount: () => local,
      getAuthoritativeActiveSessionCount: async () => { authoritativeChecks += 1; return 0; },
      applyChanges: async () => { applyResolve(); },
      pollIntervalMs: 2,
    });
    const mutation = change(coordinator);
    const waiting = await coordinator.apply(mutation.applyRevision, 'when-idle');
    expect(waiting.status.state).toBe('waiting_for_idle');
    expect(authoritativeChecks).toBe(0);
    local = 0;
    await applied;
    while (coordinator.getStatus().state === 'applying') await Promise.resolve();
    expect(authoritativeChecks).toBe(1);
    expect(coordinator.getStatus().state).toBe('clean');
  });

  test('retains a newer mutation that arrives during apply', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const coordinator = createConfigApplyCoordinator({ applyChanges: async () => gate });
    const first = change(coordinator);
    const applying = coordinator.apply(first.applyRevision, 'when-idle');
    await Promise.resolve();
    change(coordinator, 'skills', 'CONFIG_SKILLS_CHANGED');
    release();
    await applying;
    expect(coordinator.getStatus()).toMatchObject({
      state: 'pending', revision: 2, appliedRevision: 1, scopes: ['skills'],
    });
  });

  test('rejects stale revisions and coalesces an in-flight apply', async () => {
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const coordinator = createConfigApplyCoordinator({ applyChanges: async () => { calls += 1; await gate; } });
    const mutation = change(coordinator);
    await expect(coordinator.apply(0, 'when-idle')).rejects.toMatchObject({
      code: 'CONFIG_APPLY_REVISION_CONFLICT', statusCode: 409,
    });
    const first = coordinator.apply(mutation.applyRevision, 'when-idle');
    const second = coordinator.apply(mutation.applyRevision, 'when-idle');
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });

  test('retains pending changes and exposes a sanitized retryable failure', async () => {
    const coordinator = createConfigApplyCoordinator({
      applyChanges: async () => { throw new Error('/Users/private token=secret'); },
    });
    const mutation = change(coordinator);
    await expect(coordinator.apply(mutation.applyRevision, 'when-idle')).rejects.toBeInstanceOf(ConfigApplyError);
    const status = coordinator.getStatus();
    expect(status.state).toBe('failed');
    expect(status.pending).toBe(true);
    expect(JSON.stringify(status)).not.toContain('private');
    expect(JSON.stringify(status)).not.toContain('secret');
  });

  test('clears in-flight state when an apply implementation throws synchronously', async () => {
    const coordinator = createConfigApplyCoordinator({
      applyChanges: () => { throw new Error('synchronous failure'); },
    });
    const mutation = change(coordinator);
    await expect(coordinator.apply(mutation.applyRevision, 'when-idle')).rejects.toMatchObject({
      code: 'CONFIG_APPLY_RESTART_FAILED',
    });
    expect(coordinator.getStatus()).toMatchObject({ state: 'failed', pending: true });
  });

  test('requires force authorization and rechecks active sessions before aborting', async () => {
    const events = [];
    const coordinator = createConfigApplyCoordinator({
      getActiveSessionCount: () => 0,
      getAuthoritativeActiveSessionCount: async () => 2,
      applyChanges: async ({ force }) => events.push(`apply:${force}`),
      forceAbortTimeoutMs: 1,
    });
    const mutation = change(coordinator);
    await expect(coordinator.apply(mutation.applyRevision, 'force')).rejects.toMatchObject({
      code: 'CONFIG_APPLY_FORCE_FORBIDDEN',
    });
    await coordinator.apply(mutation.applyRevision, 'force', {
      canForceRestart: true,
      onForceRestart: ({ activeSessionCount }) => events.push(`audit:${activeSessionCount}`),
      abortActiveSessions: ({ activeSessionCount }) => events.push(`abort:${activeSessionCount}`),
    });
    expect(events).toEqual(['audit:2', 'abort:2', 'apply:true']);
  });

  test('uses explicit acknowledgment for external runtimes', async () => {
    let refreshed = [];
    const coordinator = createConfigApplyCoordinator({
      getRuntimeMode: () => 'external',
      applyChanges: async () => { throw new Error('must not run'); },
      refreshExternalCatalogs: async ({ scopes }) => { refreshed = scopes; },
    });
    const mutation = change(coordinator, 'providers', 'CONFIG_PROVIDERS_CHANGED');
    expect(mutation.applyStatus.state).toBe('external_restart_required');
    const result = await coordinator.acknowledgeExternal(mutation.applyRevision);
    expect(result.userConfirmed).toBe(true);
    expect(refreshed).toEqual(['providers']);
    expect(result.status.state).toBe('clean');
  });
});
