export const prepareAutomaticRuntimeService = async ({
  currentMode,
  platform,
  isPackaged,
  registration,
  setMode,
  log,
} = {}) => {
  if (currentMode === 'disabled' || currentMode === 'service'
    || platform !== 'darwin' || isPackaged !== true) {
    return Object.freeze({ mode: currentMode || 'app_bound', state: 'skipped', code: null });
  }

  const useAppBoundMode = async (state, code) => {
    if (currentMode !== 'app_bound') await setMode('app_bound');
    return Object.freeze({ mode: 'app_bound', state, code });
  };

  const current = await registration.status();
  if (current.state === 'requires_approval') {
    return useAppBoundMode(current.state, current.code);
  }
  if (current.state === 'not_found' || current.state === 'unavailable' || current.ok === false) {
    log?.warn?.('[runtime-service] automatic registration preflight unavailable', {
      state: current.state,
      code: current.code,
    });
    return useAppBoundMode(current.state, current.code);
  }

  let registered = current;
  if (current.state === 'not_registered') {
    try {
      registered = await registration.register({ allowLegacy: true });
    } catch (error) {
      const code = error?.code || 'runtime_service_registration_failed';
      log?.warn?.('[runtime-service] automatic registration failed', { code });
      return useAppBoundMode('registration_failed', code);
    }
  }
  if (registered.state !== 'enabled') {
    return useAppBoundMode(registered.state, registered.code);
  }
  await setMode('service');
  return Object.freeze({ mode: 'service', state: 'enabled', code: null });
};

// Publish only acquired coordinators. A rejected attempt must not make Retry
// believe it already owns the server, and simultaneous callers share one claim.
export const createRuntimeOwnerAcquirer = ({ getCoordinator, setCoordinator, createCoordinator }) => {
  let pending = null;
  return async (mode) => {
    const existing = getCoordinator();
    if (existing?.getOwner()) return existing;
    if (pending) return pending;
    pending = (async () => {
      const coordinator = await createCoordinator();
      await coordinator.acquire({ mode });
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
const diagnosticState = (state) => [
  'enabled', 'requires_approval', 'not_registered', 'not_found',
  'unknown', 'unavailable', 'legacy_required', 'invalid',
].includes(state) ? state : null;

export const recoverAppBoundRuntime = async ({
  connectionError, unregister, waitForStopped, acquire, setMode, release, log,
}) => {
  let acquired = false;
  let phase = 'unregister';
  let registrationState = null;
  let registrationCode = null;
  try {
    const result = await unregister();
    registrationState = diagnosticState(result?.state);
    registrationCode = diagnosticCode(result?.code);
    if (result?.ok !== true) {
      throw Object.assign(new Error('Background runtime could not be unregistered'), {
        code: 'runtime_service_unregister_failed',
      });
    }
    phase = 'wait_for_owner';
    if (!await waitForStopped()) {
      throw Object.assign(new Error('Background runtime is still active. Wait for it to stop and retry.'), {
        code: 'runtime_service_owner_active',
      });
    }
    phase = 'acquire_app_bound';
    await acquire();
    acquired = true;
    phase = 'persist_app_bound';
    await setMode();
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
