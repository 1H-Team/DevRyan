import { createWebAPIs } from './api';
import { registerSW } from 'virtual:pwa-register';
import {
  getPwaServiceWorkerStartupAction,
  isDesktopRuntimeWindow,
} from './pwa-service-worker';

import type { RuntimeAPIs } from '@devryan/ui/lib/api/types';
import '@devryan/ui/index.css';
import '@devryan/ui/styles/fonts';

declare global {
  interface Window {
    __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
    __OPENCHAMBER_DESKTOP_SERVER__?: {
      origin: string;
      opencodePort: number | null;
      apiPrefix: string;
      cliAvailable: boolean;
    };
    __OPENCHAMBER_ELECTRON__?: unknown;
  }
}

window.__OPENCHAMBER_RUNTIME_APIS__ = createWebAPIs();

type PrerenderingDocument = Document & {
  prerendering?: boolean;
};

const canUseServiceWorker = (): boolean => {
  if (!('serviceWorker' in navigator)) return false;
  if (!window.isSecureContext) return false;
  if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return false;

  const documentState = document as PrerenderingDocument;
  if (documentState.prerendering || String(document.visibilityState) === 'prerender') {
    return false;
  }

  return true;
};

const runWhenDocumentCanRegisterServiceWorker = (task: () => void): void => {
  let completed = false;
  const run = () => {
    if (completed) return;
    if (canUseServiceWorker()) {
      completed = true;
      task();
    }
  };

  const afterLoad = () => {
    setTimeout(run, 0);
  };

  if (document.readyState === 'complete') {
    afterLoad();
  } else {
    window.addEventListener('load', afterLoad, { once: true });
  }

  const documentState = document as PrerenderingDocument;
  if (documentState.prerendering || String(document.visibilityState) === 'prerender') {
    document.addEventListener('visibilitychange', run, { once: true });
  }
};

const registerPwaServiceWorker = (): void => {
  runWhenDocumentCanRegisterServiceWorker(() => {
    try {
      registerSW({
        onRegisterError(error: unknown) {
          console.warn('[PWA] service worker registration skipped:', error);
        },
      });
    } catch (error) {
      console.warn('[PWA] service worker registration skipped:', error);
    }
  });
};

const unregisterDevelopmentServiceWorkers = (): void => {
  runWhenDocumentCanRegisterServiceWorker(() => {
    void navigator.serviceWorker.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch(() => {});
  });
};

void import('@devryan/ui/main');

const serviceWorkerAction = getPwaServiceWorkerStartupAction({
  isProduction: import.meta.env.PROD,
  isDesktopRuntime: isDesktopRuntimeWindow(window),
});

if (serviceWorkerAction === 'register') {
  registerPwaServiceWorker();
} else {
  unregisterDevelopmentServiceWorkers();
}
