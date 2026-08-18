import { useManualBrowserTabsStore } from '@/stores/useManualBrowserTabsStore';
import { useUIStore } from '@/stores/useUIStore';

const normalizeDirectoryKey = (value: string): string => {
  if (!value) return '';
  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');
  let normalized = raw.replace(/\/+$/g, '').replace(/\/+/g, '/');
  if (hadUncPrefix && !normalized.startsWith('//')) normalized = `/${normalized}`;
  if (!normalized) return raw.startsWith('/') ? '/' : '';
  return normalized;
};

const syncBrowserPanelAfterStripChange = (directory: string): void => {
  const normalizedDirectory = normalizeDirectoryKey(directory);
  if (!normalizedDirectory) return;

  const workspace = useManualBrowserTabsStore.getState().byDirectory[normalizedDirectory];
  const manualCount = workspace?.tabs.length ?? 0;
  const leases = useUIStore.getState().browserLeaseTabsByDirectory[normalizedDirectory] ?? [];

  if (manualCount === 0 && leases.length === 0) {
    useUIStore.getState().closeBrowserPanel(normalizedDirectory);
    return;
  }

  if (manualCount === 0) {
    const activeLeaseId = useUIStore.getState().activeBrowserLeaseIdByDirectory[normalizedDirectory] ?? null;
    if (!activeLeaseId || !leases.some((tab) => tab.leaseId === activeLeaseId)) {
      useUIStore.getState().setActiveBrowserLease(normalizedDirectory, leases[0]?.leaseId ?? null);
    }
  }
};

/** Close a manual Browser tab; dismiss the pane when the strip becomes empty. */
export const closeManualBrowserStripTab = (directory: string, tabId: string): void => {
  const normalizedDirectory = normalizeDirectoryKey(directory);
  if (!normalizedDirectory || !tabId.trim()) return;
  useManualBrowserTabsStore.getState().closeTab(normalizedDirectory, tabId);
  syncBrowserPanelAfterStripChange(normalizedDirectory);
};

/** Close a lease presentation tab; dismiss the pane when the strip becomes empty. */
export const closeBrowserLeaseStripTab = (directory: string, leaseId: string): void => {
  const normalizedDirectory = normalizeDirectoryKey(directory);
  if (!normalizedDirectory || !leaseId.trim()) return;
  useUIStore.getState().closeBrowserLease(normalizedDirectory, leaseId);
  syncBrowserPanelAfterStripChange(normalizedDirectory);
};
