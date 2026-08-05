import { isElectronShell, isStandaloneWebRuntime } from '@/lib/desktop';

export const isBrowserPanelRuntimeSupported = (): boolean => (
  isElectronShell() || isStandaloneWebRuntime()
);
