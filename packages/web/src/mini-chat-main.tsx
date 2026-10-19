// First: copy pre-rename browser storage keys before any store hydrates.
import '@devryan/ui/lib/legacyStorageMigration.entry';
import { createWebAPIs } from './api';
import type { RuntimeAPIs } from '@devryan/ui/lib/api/types';
import '@devryan/ui/index.css';
import '@devryan/ui/styles/fonts';

declare global {
  interface Window {
    __DEVRYAN_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

window.__DEVRYAN_RUNTIME_APIS__ = createWebAPIs();

void import('@devryan/ui/apps/renderElectronMiniChatApp')
  .then(({ renderElectronMiniChatApp }) => {
    renderElectronMiniChatApp(window.__DEVRYAN_RUNTIME_APIS__ ?? createWebAPIs());
  });
