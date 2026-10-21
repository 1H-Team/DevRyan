import fs from 'node:fs/promises';
import path from 'node:path';

export const runStartupPhase = async (phase, operation, log, now = () => performance.now()) => {
  const startedAt = now();
  try {
    const result = await operation();
    log?.info?.('[electron] startup phase', { phase, outcome: 'completed', elapsedMs: Math.round(now() - startedAt) });
    return result;
  } catch (error) {
    log?.warn?.('[electron] startup phase', {
      phase, outcome: 'failed', elapsedMs: Math.round(now() - startedAt),
      code: diagnosticCode(error?.code) || 'startup_phase_failed',
    });
    throw error;
  }
};

// The background runtime service existed only for Bots, which are retired. An
// earlier version may have left it registered with launchd (SMAppService or a
// legacy LaunchAgent), so it would start at login and claim the data root.
// Withdraw that registration once, prove its owner stopped, and record a
// marker so later launches skip the registration query entirely. A failure is
// logged and retried at the next launch; it never blocks startup, because the
// app-bound owner acquisition that follows still refuses a live owner.
export const retireRuntimeServiceRegistration = async ({
  platform, isPackaged, markerPath, registration, waitForStopped, clearSettings, log, fsPromises = fs,
} = {}) => {
  if (platform !== 'darwin' || isPackaged !== true) return Object.freeze({ state: 'skipped' });
  try {
    await fsPromises.access(markerPath);
    return Object.freeze({ state: 'retired' });
  } catch (error) {
    if (error?.code !== 'ENOENT') return Object.freeze({ state: 'skipped' });
  }
  try {
    const control = registration();
    const current = await control.status();
    // `not_found` means the bundle carries no service definition (QA packages
    // strip it), so nothing can be registered and nothing stray needs removing.
    if (current?.ok !== true || !['not_registered', 'not_found', 'enabled', 'requires_approval'].includes(current.state)) {
      throw Object.assign(new Error('Background runtime registration could not be read'), {
        code: 'runtime_service_registration_unavailable',
      });
    }
    if (current.state === 'enabled' || current.state === 'requires_approval') {
      const removed = await control.unregister();
      if (removed?.ok !== true) {
        throw Object.assign(new Error('Background runtime registration could not be removed'), { code: 'runtime_service_unregister_failed' });
      }
      if (await waitForStopped() !== true) {
        throw Object.assign(new Error('The background runtime is still active'), { code: 'runtime_service_owner_active' });
      }
      log?.warn?.('[runtime-service] retired the background runtime registration', {
        phase: 'retire', code: 'runtime_service_retired', registrationState: current.state,
      });
    }
    await clearSettings?.();
    await fsPromises.mkdir(path.dirname(markerPath), { recursive: true, mode: 0o700 });
    await fsPromises.writeFile(markerPath, `${JSON.stringify({ version: 1, retiredAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    return Object.freeze({ state: 'retired' });
  } catch (error) {
    log?.warn?.('[runtime-service] background runtime retirement deferred', {
      phase: 'retire', code: diagnosticCode(error?.code) || 'runtime_service_retire_failed',
    });
    return Object.freeze({ state: 'deferred' });
  }
};

// Publish only acquired coordinators. A rejected attempt must not make Retry
// believe it already owns the server, and simultaneous callers share one claim.
export const acquireRuntimeServiceOwnership = async ({ acquire, onWaiting, timeoutMs = 45_000,
  now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) => {
  const deadline = now() + timeoutMs;
  onWaiting?.();
  for (;;) {
    try { return await acquire({ timeoutMs: Math.max(0, deadline - now()) }); }
    catch (error) {
      if (error?.code !== 'runtime_service_owner_busy' || now() >= deadline) throw error;
      await wait(Math.min(25, deadline - now()));
      if (now() >= deadline) throw error;
    }
  }
};

export const createRuntimeOwnerAcquirer = ({ getCoordinator, setCoordinator, createCoordinator, onWaiting }) => {
  let pending = null;
  return async (mode) => {
    const existing = getCoordinator();
    if (existing?.getOwner()) return existing;
    if (pending) return pending;
    pending = (async () => {
      const coordinator = await createCoordinator();
      await acquireRuntimeServiceOwnership({ acquire: options => coordinator.acquire({ mode, ...options }), onWaiting });
      setCoordinator(coordinator);
      return coordinator;
    })();
    try {
      return await pending;
    } finally {
      pending = null;
    }
  };
};

const diagnosticCode = (code) => typeof code === 'string'
  && /^(?:runtime_service_|smappservice_)[a-z_]{1,100}$/.test(code) ? code : null;
