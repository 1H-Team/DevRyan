import {
  ConfigApplyError,
  createConfigApplyCoordinator,
  createConfigChangeMarker,
  type ConfigApplyMutationResponse,
} from '@openchamber/shared-runtime';

import type { BridgeContext, BridgeRequest, BridgeResponse } from './bridge';
import type { OpenCodeManager } from './opencode';

type RuntimeEntry = {
  coordinator: ReturnType<typeof createConfigApplyCoordinator>;
  markConfigChange: ReturnType<typeof createConfigChangeMarker>;
};

const runtimeByManager = new WeakMap<OpenCodeManager, RuntimeEntry>();

const listActiveSessions = async (manager: OpenCodeManager): Promise<string[]> => {
  const apiUrl = manager.getApiUrl();
  if (!apiUrl) return [];
  const target = new URL('/session/status', apiUrl);
  target.searchParams.set('directory', manager.getWorkingDirectory());
  const response = await fetch(target, {
    headers: { Accept: 'application/json', ...manager.getOpenCodeAuthHeaders() },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`OpenCode session status responded with ${response.status}`);
  const statuses = await response.json() as Record<string, { type?: string }>;
  if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) {
    throw new Error('OpenCode session status returned an invalid payload');
  }
  return Object.entries(statuses)
    .filter(([, status]) => status && typeof status === 'object' && status.type && status.type !== 'idle')
    .map(([sessionId]) => sessionId);
};

const abortActiveSessions = async (manager: OpenCodeManager): Promise<void> => {
  const apiUrl = manager.getApiUrl();
  if (!apiUrl) return;
  const sessionIds = await listActiveSessions(manager);
  await Promise.allSettled(sessionIds.map(async (sessionId) => {
    const target = new URL(`/session/${encodeURIComponent(sessionId)}/abort`, apiUrl);
    target.searchParams.set('directory', manager.getWorkingDirectory());
    await fetch(target, {
      method: 'POST',
      headers: { Accept: 'application/json', ...manager.getOpenCodeAuthHeaders() },
      signal: AbortSignal.timeout(5000),
    });
  }));
};

const getRuntime = (manager: OpenCodeManager): RuntimeEntry => {
  const existing = runtimeByManager.get(manager);
  if (existing) return existing;

  const coordinator = createConfigApplyCoordinator({
    getRuntimeMode: () => manager.getDebugInfo().mode,
    getActiveSessionCount: () => manager.getActiveSessionCount(),
    getAuthoritativeActiveSessionCount: async () => Math.max(
      manager.getActiveSessionCount(),
      (await listActiveSessions(manager)).length,
    ),
    applyChanges: async () => manager.restart({ force: true }),
  });
  const entry = {
    coordinator,
    markConfigChange: createConfigChangeMarker({
      coordinator,
      getCanForceRestart: () => true,
    }),
  };
  runtimeByManager.set(manager, entry);
  return entry;
};

export const markVsCodeConfigChange = async (
  ctx: BridgeContext | undefined,
  reason: string,
  metadata: unknown = {},
  changed = true,
): Promise<ConfigApplyMutationResponse & { runtimeApplied: false; runtimeMessage: string }> => {
  if (!ctx?.manager) throw new Error('OpenCode manager is unavailable');
  return getRuntime(ctx.manager).markConfigChange(reason, metadata, changed);
};

const errorResponse = (
  id: string,
  type: string,
  manager: OpenCodeManager,
  error: unknown,
): BridgeResponse => {
  const runtime = getRuntime(manager);
  if (error instanceof ConfigApplyError) {
    return {
      id,
      type,
      success: false,
      error: error.message,
      errorData: {
        code: error.code,
        applyStatus: error.status || runtime.coordinator.getStatus({ canForceRestart: true }),
      },
    };
  }
  return {
    id,
    type,
    success: false,
    error: 'Configuration apply failed. The saved changes remain pending.',
    errorData: {
      code: 'CONFIG_APPLY_FAILED',
      applyStatus: runtime.coordinator.getStatus({ canForceRestart: true }),
    },
  };
};

export async function handleConfigApplyBridgeMessage(
  message: BridgeRequest,
  ctx?: BridgeContext,
): Promise<BridgeResponse | null> {
  const supported = new Set([
    'api:config/apply-status',
    'api:config/apply',
    'api:config/apply/acknowledge-external',
    'api:config/reload',
  ]);
  if (!supported.has(message.type)) return null;
  if (!ctx?.manager) {
    return { id: message.id, type: message.type, success: false, error: 'OpenCode manager is unavailable' };
  }

  const manager = ctx.manager;
  const runtime = getRuntime(manager);
  try {
    if (message.type === 'api:config/apply-status') {
      return {
        id: message.id,
        type: message.type,
        success: true,
        data: runtime.coordinator.getStatus({ canForceRestart: true }),
      };
    }

    const payload = message.payload && typeof message.payload === 'object'
      ? message.payload as Record<string, unknown>
      : {};
    if (message.type === 'api:config/apply') {
      const result = await runtime.coordinator.apply(
        payload.expectedRevision as number,
        payload.mode as 'when-idle' | 'force',
        {
          canForceRestart: true,
          abortActiveSessions: () => abortActiveSessions(manager),
        },
      );
      return { id: message.id, type: message.type, success: true, data: result };
    }

    if (message.type === 'api:config/apply/acknowledge-external') {
      const result = await runtime.coordinator.acknowledgeExternal(
        payload.expectedRevision as number,
        { canForceRestart: true },
      );
      return { id: message.id, type: message.type, success: true, data: result };
    }

    const mutation = await runtime.markConfigChange('manual configuration reload');
    const result = await runtime.coordinator.apply(mutation.applyRevision, 'when-idle', {
      canForceRestart: true,
    });
    return {
      id: message.id,
      type: message.type,
      success: true,
      data: { success: true, ...mutation, applyStatus: result.status, requiresReload: false },
    };
  } catch (error) {
    return errorResponse(message.id, message.type, manager, error);
  }
}
