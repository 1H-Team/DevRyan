type RuntimeWindowLike = {
  __OPENCHAMBER_DESKTOP_SERVER__?: unknown;
  __OPENCHAMBER_ELECTRON__?: unknown;
  __OPENCHAMBER_RUNTIME_APIS__?: {
    runtime?: {
      isDesktop?: boolean;

    };
  };
};

export type PwaServiceWorkerStartupAction = 'register' | 'unregister';

export function isDesktopRuntimeWindow(candidate: RuntimeWindowLike | undefined): boolean {
  if (!candidate) return false;
  if (candidate.__OPENCHAMBER_DESKTOP_SERVER__) return true;
  if (candidate.__OPENCHAMBER_ELECTRON__) return true;
  return candidate.__OPENCHAMBER_RUNTIME_APIS__?.runtime?.isDesktop === true;
}

export function getPwaServiceWorkerStartupAction({
  isProduction,
  isDesktopRuntime,
}: {
  isProduction: boolean;
  isDesktopRuntime: boolean;
}): PwaServiceWorkerStartupAction {
  return isProduction && !isDesktopRuntime ? 'register' : 'unregister';
}
