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
