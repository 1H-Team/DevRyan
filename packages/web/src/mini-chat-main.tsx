import { createWebAPIs } from './api';
import type { RuntimeAPIs } from '@devryan/ui/lib/api/types';
import '@devryan/ui/index.css';
import '@devryan/ui/styles/fonts';

declare global {
  interface Window {
    __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

window.__OPENCHAMBER_RUNTIME_APIS__ = createWebAPIs();

void import('@devryan/ui/apps/renderElectronMiniChatApp')
  .then(({ renderElectronMiniChatApp }) => {
    renderElectronMiniChatApp(window.__OPENCHAMBER_RUNTIME_APIS__ ?? createWebAPIs());
  });
