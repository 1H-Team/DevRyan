export const CONFIG_APPLY_SCOPES = Object.freeze([
  'agents', 'providers', 'commands', 'skills', 'mcp', 'behavior', 'runtime',
]);

export const CONFIG_APPLY_REASON_CODES = Object.freeze([
  'CONFIG_AGENTS_CHANGED',
  'CONFIG_PROVIDERS_CHANGED',
  'CONFIG_COMMANDS_CHANGED',
  'CONFIG_SKILLS_CHANGED',
  'CONFIG_MCP_CHANGED',
  'CONFIG_BEHAVIOR_CHANGED',
  'CONFIG_RUNTIME_CHANGED',
]);

const CONFIG_CHANGE_CLASSIFIERS = [
  { pattern: /behavior|agents\.md/i, scope: 'behavior', reasonCode: 'CONFIG_BEHAVIOR_CHANGED' },
  { pattern: /agent/i, scope: 'agents', reasonCode: 'CONFIG_AGENTS_CHANGED' },
  { pattern: /provider|anthropic oauth/i, scope: 'providers', reasonCode: 'CONFIG_PROVIDERS_CHANGED' },
  { pattern: /command/i, scope: 'commands', reasonCode: 'CONFIG_COMMANDS_CHANGED' },
  { pattern: /skill/i, scope: 'skills', reasonCode: 'CONFIG_SKILLS_CHANGED' },
  { pattern: /mcp/i, scope: 'mcp', reasonCode: 'CONFIG_MCP_CHANGED' },
];

export const classifyConfigChange = (reason) => {
  const normalized = typeof reason === 'string' ? reason : '';
  const match = CONFIG_CHANGE_CLASSIFIERS.find(({ pattern }) => pattern.test(normalized));
  if (!match) {
    return {
      scope: 'runtime',
      reasonCode: 'CONFIG_RUNTIME_CHANGED',
    };
  }
  return { scope: match.scope, reasonCode: match.reasonCode };
};

const SCOPE_SET = new Set(CONFIG_APPLY_SCOPES);
const REASON_CODE_SET = new Set(CONFIG_APPLY_REASON_CODES);

export class ConfigApplyError extends Error {
  constructor(code, message, statusCode = 400, status = null) {
    super(message);
    this.name = 'ConfigApplyError';
    this.code = code;
    this.statusCode = statusCode;
    this.status = status;
  }
}

const normalizeCount = (value) => (
  Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
);

const uniqueOrdered = (entries, field, order) => {
  const values = new Set(entries.map((entry) => entry[field]));
  return order.filter((value) => values.has(value));
};

const fixedFailure = () => ({
  code: 'CONFIG_APPLY_RESTART_FAILED',
  message: 'OpenCode could not restart. The saved changes are still pending and can be retried.',
});

export const createConfigApplyCoordinator = ({
  getRuntimeMode = () => 'managed',
  getActiveSessionCount = () => 0,
  getAuthoritativeActiveSessionCount = async () => getActiveSessionCount(),
  applyChanges,
  refreshExternalCatalogs = async () => {},
  pollIntervalMs = 1000,
  forceAbortTimeoutMs = 5000,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) => {
  if (typeof applyChanges !== 'function') {
    throw new TypeError('applyChanges is required');
  }

  let revision = 0;
  let appliedRevision = 0;
  let changes = [];
  let waitingRevision = null;
  let waitingTimer = null;
  let inFlight = null;
  let lastError = null;
  let changedAt = null;

  const runtimeMode = () => getRuntimeMode() === 'external' ? 'external' : 'managed';
  const hasPending = () => changes.length > 0;

  const cancelIdleWatcher = () => {
    waitingRevision = null;
    if (waitingTimer !== null) {
      clearTimer(waitingTimer);
      waitingTimer = null;
    }
  };

  const getStatus = ({ canForceRestart = false } = {}) => {
    const pending = hasPending();
    const mode = runtimeMode();
    let state = 'clean';
    if (pending && mode === 'external') state = 'external_restart_required';
    else if (inFlight) state = 'applying';
    else if (pending && lastError) state = 'failed';
    else if (pending && waitingRevision !== null) state = 'waiting_for_idle';
    else if (pending) state = 'pending';

    return {
      revision,
      appliedRevision,
      state,
      pending,
      scopes: uniqueOrdered(changes, 'scope', CONFIG_APPLY_SCOPES),
      reasonCodes: uniqueOrdered(changes, 'reasonCode', CONFIG_APPLY_REASON_CODES),
      ...(changedAt ? { changedAt: new Date(changedAt).toISOString() } : {}),
      activeSessionCount: normalizeCount(getActiveSessionCount()),
      runtimeMode: mode,
      canApplyWhenIdle: mode === 'managed',
      canForceRestart: mode === 'managed' && canForceRestart === true,
      ...(lastError ? { lastError: { ...lastError } } : {}),
    };
  };

  const mutationResponse = (status) => ({
    requiresApply: status.pending,
    applyRevision: status.revision,
    applyScopes: status.scopes,
    applyStatus: status,
    requiresReload: false,
  });

  const markChanged = ({ scope, reasonCode, changed = true, metadata = null, canForceRestart = false } = {}) => {
    if (!SCOPE_SET.has(scope)) {
      throw new TypeError(`Unsupported configuration apply scope: ${String(scope)}`);
    }
    if (!REASON_CODE_SET.has(reasonCode)) {
      throw new TypeError(`Unsupported configuration apply reason code: ${String(reasonCode)}`);
    }

    if (changed !== true) {
      return mutationResponse(getStatus({ canForceRestart }));
    }

    if (waitingRevision !== null) cancelIdleWatcher();
    revision += 1;
    changedAt = now();
    lastError = null;
    changes.push({ revision, scope, reasonCode, metadata });
    return mutationResponse(getStatus({ canForceRestart }));
  };

  const assertExpectedRevision = (expectedRevision, canForceRestart) => {
    if (!Number.isInteger(expectedRevision) || expectedRevision !== revision) {
      const status = getStatus({ canForceRestart });
      throw new ConfigApplyError(
        'CONFIG_APPLY_REVISION_CONFLICT',
        'Configuration changed since this apply request was prepared.',
        409,
        status,
      );
    }
  };

  const waitForGracefulAbort = async () => {
    const deadline = now() + forceAbortTimeoutMs;
    while (normalizeCount(getActiveSessionCount()) > 0 && now() < deadline) {
      await new Promise((resolve) => {
        const timer = setTimer(resolve, Math.min(100, Math.max(1, deadline - now())));
        timer?.unref?.();
      });
    }
  };

  const runCapturedApply = (capturedRevision, options = {}) => {
    if (inFlight?.revision === capturedRevision) return inFlight.promise;

    const capturedChanges = changes.filter((entry) => entry.revision <= capturedRevision);
    const capturedScopes = uniqueOrdered(capturedChanges, 'scope', CONFIG_APPLY_SCOPES);
    cancelIdleWatcher();
    lastError = null;

    const promise = Promise.resolve().then(async () => {
      try {
        if (options.force === true) {
          let activeSessionCount;
          try {
            activeSessionCount = normalizeCount(await getAuthoritativeActiveSessionCount());
          } catch {
            throw new ConfigApplyError(
              'CONFIG_APPLY_ACTIVE_COUNT_UNAVAILABLE',
              'The active-chat count could not be verified. Try again before restarting.',
              503,
              getStatus({ canForceRestart: options.canForceRestart }),
            );
          }
          await options.onForceRestart?.({ revision: capturedRevision, activeSessionCount });
          await options.abortActiveSessions?.({ revision: capturedRevision, activeSessionCount });
          await waitForGracefulAbort();
        }

        await applyChanges({
          revision: capturedRevision,
          scopes: capturedScopes,
          changes: capturedChanges.map((entry) => ({ ...entry })),
          force: options.force === true,
        });
        changes = changes.filter((entry) => entry.revision > capturedRevision);
        appliedRevision = Math.max(appliedRevision, capturedRevision);
        lastError = null;
        if (inFlight?.revision === capturedRevision) inFlight = null;
        return {
          status: getStatus({ canForceRestart: options.canForceRestart }),
          appliedRevision: capturedRevision,
          appliedScopes: capturedScopes,
          userConfirmed: false,
        };
      } catch (error) {
        if (error instanceof ConfigApplyError) throw error;
        lastError = fixedFailure();
        if (inFlight?.revision === capturedRevision) inFlight = null;
        throw new ConfigApplyError(
          lastError.code,
          lastError.message,
          500,
          getStatus({ canForceRestart: options.canForceRestart }),
        );
      } finally {
        if (inFlight?.revision === capturedRevision) inFlight = null;
      }
    });

    inFlight = { revision: capturedRevision, promise };
    return promise;
  };

  const scheduleIdleCheck = (capturedRevision, options) => {
    if (waitingTimer !== null || waitingRevision !== capturedRevision) return;
    waitingTimer = setTimer(async () => {
      waitingTimer = null;
      if (waitingRevision !== capturedRevision || revision !== capturedRevision || !hasPending()) return;
      if (normalizeCount(getActiveSessionCount()) > 0 || inFlight) {
        scheduleIdleCheck(capturedRevision, options);
        return;
      }

      try {
        const authoritativeCount = normalizeCount(await getAuthoritativeActiveSessionCount());
        if (authoritativeCount > 0) {
          scheduleIdleCheck(capturedRevision, options);
          return;
        }
        await runCapturedApply(capturedRevision, options);
      } catch (error) {
        if (error instanceof ConfigApplyError && error.code === 'CONFIG_APPLY_RESTART_FAILED') return;
        if (waitingRevision === capturedRevision) scheduleIdleCheck(capturedRevision, options);
      }
    }, pollIntervalMs);
    waitingTimer?.unref?.();
  };

  const apply = async (expectedRevision, mode, options = {}) => {
    if (mode !== 'when-idle' && mode !== 'force') {
      throw new ConfigApplyError('CONFIG_APPLY_MODE_INVALID', 'Apply mode must be when-idle or force.', 400);
    }
    if (inFlight?.revision === expectedRevision) return inFlight.promise;
    assertExpectedRevision(expectedRevision, options.canForceRestart);

    if (!hasPending()) {
      return {
        status: getStatus({ canForceRestart: options.canForceRestart }),
        appliedRevision,
        appliedScopes: [],
        userConfirmed: false,
      };
    }
    if (runtimeMode() === 'external') {
      return {
        status: getStatus({ canForceRestart: options.canForceRestart }),
        appliedRevision,
        appliedScopes: [],
        userConfirmed: false,
      };
    }

    if (mode === 'force') {
      if (options.canForceRestart !== true) {
        throw new ConfigApplyError(
          'CONFIG_APPLY_FORCE_FORBIDDEN',
          'Administrator access is required to restart while chats may be active.',
          403,
          getStatus({ canForceRestart: false }),
        );
      }
      return runCapturedApply(expectedRevision, { ...options, force: true });
    }

    if (normalizeCount(getActiveSessionCount()) === 0) {
      try {
        const authoritativeCount = normalizeCount(await getAuthoritativeActiveSessionCount());
        if (authoritativeCount === 0) {
          return runCapturedApply(expectedRevision, options);
        }
      } catch {
        // An unavailable authoritative source is not proof of idleness.
      }
    }

    waitingRevision = expectedRevision;
    scheduleIdleCheck(expectedRevision, options);
    return {
      status: getStatus({ canForceRestart: options.canForceRestart }),
      appliedRevision,
      appliedScopes: [],
      userConfirmed: false,
    };
  };

  const acknowledgeExternal = async (expectedRevision, options = {}) => {
    assertExpectedRevision(expectedRevision, options.canForceRestart);
    if (runtimeMode() !== 'external') {
      throw new ConfigApplyError(
        'CONFIG_APPLY_NOT_EXTERNAL',
        'External restart acknowledgment is available only for an external runtime.',
        409,
        getStatus({ canForceRestart: options.canForceRestart }),
      );
    }
    const capturedChanges = changes.filter((entry) => entry.revision <= expectedRevision);
    const capturedScopes = uniqueOrdered(capturedChanges, 'scope', CONFIG_APPLY_SCOPES);
    await refreshExternalCatalogs({ revision: expectedRevision, scopes: capturedScopes });
    changes = changes.filter((entry) => entry.revision > expectedRevision);
    appliedRevision = Math.max(appliedRevision, expectedRevision);
    lastError = null;
    cancelIdleWatcher();
    return {
      status: getStatus({ canForceRestart: options.canForceRestart }),
      appliedRevision: expectedRevision,
      appliedScopes: capturedScopes,
      userConfirmed: true,
    };
  };

  return {
    getStatus,
    markChanged,
    apply,
    acknowledgeExternal,
    dispose: cancelIdleWatcher,
  };
};

export const createConfigChangeMarker = ({ coordinator, getCanForceRestart = () => false }) => {
  if (!coordinator || typeof coordinator.markChanged !== 'function') {
    throw new TypeError('configuration apply coordinator is required');
  }

  return async (reason, metadata = {}, changed = true) => {
    const response = coordinator.markChanged({
      ...classifyConfigChange(reason),
      metadata,
      changed,
      canForceRestart: getCanForceRestart(),
    });
    const external = response.applyStatus.runtimeMode === 'external';
    return {
      runtimeApplied: false,
      runtimeMessage: external
        ? 'Configuration saved. Restart the external OpenCode runtime, then acknowledge the restart in DevRyan.'
        : 'Configuration saved. Apply the pending changes when it is safe to restart OpenCode.',
      ...response,
    };
  };
};
