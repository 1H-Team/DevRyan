import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  handleConfigApplyBridgeMessage,
  markVsCodeConfigChange,
} from './configApplyRuntime';
import type { OpenCodeManager } from './opencode';

const originalFetch = globalThis.fetch;

const createManager = (mode: 'managed' | 'external' = 'managed') => ({
  getApiUrl: () => 'http://127.0.0.1:4096',
  getWorkingDirectory: () => '/tmp/project',
  getOpenCodeAuthHeaders: () => ({}),
  getDebugInfo: () => ({ mode }),
  getActiveSessionCount: () => 0,
  restart: vi.fn(async () => {}),
}) as unknown as OpenCodeManager;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('VS Code configuration apply bridge', () => {
  it('exposes the same pending status and apply contract as web', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({})) as typeof fetch;
    const manager = createManager();
    const ctx = { manager };
    const mutation = await markVsCodeConfigChange(ctx, 'command update');

    expect(mutation).toMatchObject({
      requiresApply: true,
      applyRevision: 1,
      applyScopes: ['commands'],
      requiresReload: false,
      applyStatus: { state: 'pending', runtimeMode: 'managed' },
    });

    const response = await handleConfigApplyBridgeMessage({
      id: 'apply',
      type: 'api:config/apply',
      payload: { expectedRevision: mutation.applyRevision, mode: 'when-idle' },
    }, ctx);

    expect(response).toMatchObject({
      success: true,
      data: { appliedRevision: 1, appliedScopes: ['commands'], status: { state: 'clean' } },
    });
    expect(manager.restart).toHaveBeenCalledWith({ force: true });
  });

  it('returns a revision conflict with fresh status', async () => {
    const manager = createManager();
    const ctx = { manager };
    await markVsCodeConfigChange(ctx, 'skill update');

    const response = await handleConfigApplyBridgeMessage({
      id: 'stale',
      type: 'api:config/apply',
      payload: { expectedRevision: 0, mode: 'when-idle' },
    }, ctx);

    expect(response).toMatchObject({
      success: false,
      errorData: {
        code: 'CONFIG_APPLY_REVISION_CONFLICT',
        applyStatus: { revision: 1, state: 'pending' },
      },
    });
    expect(manager.restart).not.toHaveBeenCalled();
  });

  it('uses explicit user acknowledgment for an external runtime', async () => {
    const manager = createManager('external');
    const ctx = { manager };
    const mutation = await markVsCodeConfigChange(ctx, 'provider disconnect');

    expect(mutation.applyStatus.state).toBe('external_restart_required');
    const response = await handleConfigApplyBridgeMessage({
      id: 'ack',
      type: 'api:config/apply/acknowledge-external',
      payload: { expectedRevision: mutation.applyRevision },
    }, ctx);

    expect(response).toMatchObject({
      success: true,
      data: { userConfirmed: true, appliedScopes: ['providers'], status: { state: 'clean' } },
    });
    expect(manager.restart).not.toHaveBeenCalled();
  });
});
