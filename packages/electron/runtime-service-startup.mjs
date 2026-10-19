export const describeRuntimeServiceStatus = ({ platform, configuredMode,
  registrationMode, registration, handshake, settingsUrl }) => {
  const supported = platform === 'darwin';
  const connected = supported && Boolean(handshake);
  return Object.freeze({
    configuredMode,
    serviceEnabled: supported && (connected || configuredMode === 'service'),
    registrationMode: registrationMode || 'unsupported',
    registration,
    connected,
    handshake: supported ? handshake : null,
    settingsUrl: supported ? settingsUrl : null,
    canEnable: supported && (registration.state === 'not_registered' || registration.state === 'enabled'),
  });
};

export const prepareAutomaticRuntimeService = async ({
  currentMode,
  platform,
  isPackaged,
  registration,
  waitForStopped,
} = {}) => {
  if (currentMode === 'service' || platform !== 'darwin' || isPackaged !== true) {
    return Object.freeze({ mode: currentMode || 'app_bound', state: 'skipped', code: null });
  }
  // Registration can survive a crash before enableBackgroundBots persists service mode.
  // `not_found` means the bundle carries no service definition (QA packages strip
  // it), so nothing can be registered and nothing stray needs removing.
  const current = await registration.status();
  if (current?.ok === true && current.state === 'not_found') {
    return Object.freeze({ mode: currentMode || 'app_bound', state: 'not_registered', code: null });
  }
  if (current?.ok !== true || !['not_registered', 'enabled', 'requires_approval'].includes(current.state)) {
    throw Object.assign(new Error('Background runtime registration could not be established'), {
      code: 'runtime_service_registration_unavailable',
    });
  }
  if (current.state !== 'not_registered') {
    const removed = await registration.unregister();
    if (removed?.ok !== true) {
      throw Object.assign(new Error('Stray background runtime registration could not be removed'), { code: 'runtime_service_unregister_failed' });
    }
    if (await waitForStopped() !== true) throw Object.assign(new Error('The previous background runtime is still active'), { code: 'runtime_service_owner_active' });
  }
  return Object.freeze({ mode: currentMode || 'app_bound', state: 'not_registered', code: null });
};

// Service mode relies on a launchd registration. Without one nothing will ever
// start the service, and waiting for its connection only delays startup (65 s
// before the fallback, observed on 2026-09-29). Register it first; when that
// is not possible, fail at once so startup falls back to the app-bound
// runtime. A state that cannot tell (`unknown`, `legacy_required`, a failed
// status read) keeps the ordinary wait.
const RUNTIME_SERVICE_UNSTARTABLE_STATES = new Set([
  'not_registered', 'requires_approval', 'not_found', 'unavailable', 'invalid',
]);
export const ensureRuntimeServiceRegistered = async ({ registration, log } = {}) => {
  let current;
  try { current = await registration.status(); }
  catch { return Object.freeze({ state: 'unknown', registered: false }); }
  if (current?.state === 'not_registered') {
    try {
      const registered = await registration.register({ allowLegacy: true });
      if (registered?.state === 'enabled') {
        log?.warn?.('[runtime-service] registered at startup', { phase: 'register', code: 'runtime_service_registered_at_startup' });
        return Object.freeze({ state: 'enabled', registered: true });
      }
      current = registered;
    } catch (error) {
      current = { state: 'not_registered', code: error?.code };
    }
  }
  if (!RUNTIME_SERVICE_UNSTARTABLE_STATES.has(current?.state)) {
    return Object.freeze({ state: current?.state ?? 'unknown', registered: false });
  }
  throw Object.assign(new Error('Background runtime is not registered, so it cannot start'), {
    code: 'runtime_service_not_registered', registrationState: current.state,
  });
};

// A drag-and-drop install bypasses the in-app update path, which unregisters
// the service before installing and registers it again afterwards. The
// registration left behind was made by the previous app (its executable path
// or code signature), so a stopped service is unregistered and registered for
// this version. A live service is left to the connection, which drains and
// retires another version's service before registering this one; a missing
// registration is left to ensureRuntimeServiceRegistered.
export const reregisterRuntimeServiceAfterUpgrade = async ({
  registeredAppVersion, appVersion, registration, isOwnerStopped, recordRegisteredAppVersion, log,
} = {}) => {
  if (registeredAppVersion === appVersion) return Object.freeze({ state: 'current' });
  let current;
  try { current = await registration.status(); } catch { return Object.freeze({ state: 'unknown' }); }
  if (current?.state !== 'enabled') return Object.freeze({ state: current?.state ?? 'unknown' });
  let stopped = false;
  try { stopped = await isOwnerStopped() === true; } catch { stopped = false; }
  if (!stopped) return Object.freeze({ state: 'deferred' });
  const removed = await registration.unregister();
  if (removed?.ok !== true) {
    throw Object.assign(new Error('The background runtime registration from the previous version could not be removed'), {
      code: 'runtime_service_unregister_failed',
    });
  }
  const registered = await registration.register({ allowLegacy: true });
  if (registered?.state !== 'enabled') {
    throw Object.assign(new Error('Background Bots require Login Items approval after the update'), {
      code: 'runtime_service_approval_required',
    });
  }
  await recordRegisteredAppVersion(appVersion);
  log?.warn?.('[runtime-service] registered again after a manual upgrade', {
    phase: 'register', code: 'runtime_service_reregistered_after_upgrade',
  });
  return Object.freeze({ state: 'reregistered' });
};

// A launchd start runs the service's whole Electron boot before it publishes a
// live descriptor, and cold boots were observed past 20 s. Only failures that
// mean the service is not up yet earn the longer budget; any other failure
// keeps the ordinary bound so a real rejection still falls back promptly.
const RUNTIME_SERVICE_STARTING_CODES = new Set([
  'ENOENT',
  'runtime_service_owner_stale',
  'runtime_service_unavailable',
]);

export const runtimeServiceRequestSignal = (deadline = Infinity, now = Date.now) => {
  const remainingMs = Math.min(5_000, deadline - now());
  if (remainingMs <= 0) {
    throw Object.assign(new Error('Background runtime connection timed out'), {
      code: 'runtime_service_connection_timeout', retryable: false,
    });
  }
  return AbortSignal.timeout(Math.ceil(remainingMs));
};

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

export const createDesktopHostLeaseHandler = ({ state, log }) => {
  let startupRequested = false;
  return (lease) => {
    state.desktopHostBrokerLease = Object.freeze({ ...lease });
    const handle = state.serverHandle;
    if (startupRequested || !handle) return;
    // Lease refreshes must not retry a terminal startup failure without user recovery.
    startupRequested = true;
    void Promise.resolve().then(() => runStartupPhase('service_opencode',
      () => handle.resumeDeferredOpenCodeStartup?.(), log)).catch(() => undefined);
  };
};

export const retryRuntimeServiceConnection = async ({
  connect,
  isOwnerStopped,
  timeoutMs = 20_000,
  startingTimeoutMs = 60_000,
  retryDelayMs = 250,
  now = Date.now,
  wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
}) => {
  const startedAt = now();
  let budgetMs = timeoutMs;
  for (;;) {
    try {
      return await connect({ deadline: startedAt + budgetMs });
    } catch (caught) {
      let error = caught;
      if (error?.code === 'runtime_service_owner_stale' && isOwnerStopped) {
        // Failed observation grants no takeover; recovery rechecks before claiming ownership.
        const stopped = await Promise.resolve().then(isOwnerStopped).catch(() => false);
        if (stopped === true) error.retryable = false;
      }
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        error = Object.assign(new Error('Background runtime connection timed out', { cause: error }), {
          code: 'runtime_service_connection_timeout',
        });
      }
      budgetMs = RUNTIME_SERVICE_STARTING_CODES.has(error?.code) ? startingTimeoutMs : timeoutMs;
      if (error?.retryable === false || now() - startedAt >= budgetMs) throw error;
    }
    await wait(Math.min(retryDelayMs, Math.max(1, startedAt + budgetMs - now())));
  }
};

// A live service started by another app version (1.x and 2.0.0 publish no
// appVersion) keeps serving its old in-memory server and holds the bundle open
// in Finder. It is drained through its own prepare-update route, unregistered
// and proved stopped, with a bounded signal fallback limited to the verified
// service process, then the current bundle's service is registered. Any
// failure is final for this connection wait, so startup falls back to the
// app-bound runtime instead of attaching to the mismatched version.
export const retireMismatchedRuntimeService = async ({
  descriptor, appVersion, drain, unregister, waitForStopped, terminate, register, log,
} = {}) => {
  log?.warn?.('[runtime-service] retiring a background runtime from another app version', {
    phase: 'retire', code: 'runtime_service_version_mismatch',
    serviceVersion: typeof descriptor?.appVersion === 'string' ? 'different' : 'missing', appVersion,
  });
  try {
    try { await drain(); } catch (error) {
      log?.warn?.('[runtime-service] stale runtime drain failed', {
        phase: 'drain', code: diagnosticCode(error?.code) || 'runtime_service_update_prepare_failed',
      });
    }
    const unregistered = await unregister();
    if (unregistered?.ok !== true) {
      throw Object.assign(new Error('Background runtime could not be unregistered'), { code: 'runtime_service_unregister_failed' });
    }
    let stopped = await waitForStopped(15_000);
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      if (stopped || !await terminate(signal)) break;
      log?.warn?.('[runtime-service] stale runtime signalled', { phase: 'terminate', code: 'runtime_service_owner_active', signal });
      stopped = await waitForStopped(5_000);
    }
    if (!stopped) {
      throw Object.assign(new Error('The background runtime from another app version is still running'), {
        code: 'runtime_service_owner_active',
      });
    }
    await register();
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { retryable: false });
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
  && (/^(?:runtime_service_|smappservice_)[a-z_]{1,100}$/.test(code)
    || code === 'desktop_host_registration_failed') ? code : null;
const diagnosticState = (state) => [
  'enabled', 'requires_approval', 'not_registered', 'not_found',
  'unknown', 'unavailable', 'legacy_required', 'invalid',
].includes(state) ? state : null;

export const recoverAppBoundRuntime = async ({
  connectionError, configuredMode, unregister, waitForStopped, acquire, setMode, release, log,
}) => {
  let acquired = false;
  let phase = 'unregister';
  let registrationState = null;
  let registrationCode = null;
  try {
    const result = await runStartupPhase('service_unregister', unregister, log);
    registrationState = diagnosticState(result?.state);
    registrationCode = diagnosticCode(result?.code);
    if (result?.ok !== true) {
      throw Object.assign(new Error('Background runtime could not be unregistered'), {
        code: 'runtime_service_unregister_failed',
      });
    }
    phase = 'wait_for_owner';
    if (!await runStartupPhase('service_wait_for_owner', waitForStopped, log)) {
      throw Object.assign(new Error('Background runtime is still active. Wait for it to stop and retry.'), {
        code: 'runtime_service_owner_active',
      });
    }
    phase = 'acquire_app_bound';
    await runStartupPhase('service_acquire_app_bound', acquire, log);
    acquired = true;
    if (configuredMode !== 'service') {
      phase = 'persist_app_bound';
      await runStartupPhase('service_persist_app_bound', setMode, log);
    }
    log?.warn?.('[runtime-service] startup recovered', {
      phase: 'app_bound_acquired', code: 'runtime_service_startup_recovered',
      registrationState, registrationCode,
      connectionCode: diagnosticCode(connectionError?.code) || 'runtime_service_connection_failed',
    });
  } catch (recoveryError) {
    if (acquired) await release().catch(() => {
      log?.warn?.('[runtime-service] rollback release failed', {
        phase: 'release_app_bound', code: 'runtime_service_release_failed',
      });
    });
    const code = typeof recoveryError?.code === 'string' && /^runtime_service_[a-z_]+$/.test(recoveryError.code)
      ? recoveryError.code : 'runtime_service_recovery_failed';
    log?.warn?.('[runtime-service] startup recovery failed', {
      phase, code,
      registrationState,
      registrationCode: registrationCode || (phase === 'unregister'
        && recoveryError?.code !== 'runtime_service_unregister_failed' ? diagnosticCode(recoveryError?.code) : null),
      connectionCode: diagnosticCode(connectionError?.code) || 'runtime_service_connection_failed',
    });
    const error = new Error(recoveryError.message, { cause: connectionError });
    error.code = code;
    throw error;
  }
};
