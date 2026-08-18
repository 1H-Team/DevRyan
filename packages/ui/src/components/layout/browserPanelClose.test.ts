import { beforeEach, describe, expect, test } from 'bun:test';

import { setAuthPrincipal } from '@/lib/authSession';
import { closeBrowserLeaseStripTab, closeManualBrowserStripTab } from '@/components/layout/browserPanelClose';
import { useManualBrowserTabsStore } from '@/stores/useManualBrowserTabsStore';
import { useUIStore } from '@/stores/useUIStore';

const DIRECTORY = '/repo/Test';

describe('browserPanelClose', () => {
  beforeEach(() => {
    setAuthPrincipal(null);
    useUIStore.setState({
      contextPanelByDirectory: {},
      browserPanelByDirectory: {},
      browserLeaseTabsByDirectory: {},
      activeBrowserLeaseIdByDirectory: {},
    });
    useManualBrowserTabsStore.setState({ byDirectory: {} });
  });

  test('closing the sole manual tab closes the browser panel', () => {
    useUIStore.getState().openBrowserPanel(DIRECTORY, 'https://example.com/');
    const tabId = useManualBrowserTabsStore.getState().byDirectory[DIRECTORY]!.tabs[0]!.id;

    closeManualBrowserStripTab(DIRECTORY, tabId);

    expect(useManualBrowserTabsStore.getState().byDirectory[DIRECTORY]).toBe(undefined);
    expect(useUIStore.getState().browserPanelByDirectory[DIRECTORY]?.isOpen).toBe(false);
  });

  test('closing the last manual tab keeps the panel when lease tabs remain', () => {
    useUIStore.getState().openBrowserPanel(DIRECTORY, 'https://manual.example.com/');
    useUIStore.getState().openBrowserLease(DIRECTORY, {
      leaseId: 'lease-a',
      rootSessionId: 'root-a',
      url: 'http://localhost:3000/',
      title: 'Home',
    });
    useUIStore.getState().setActiveBrowserLease(DIRECTORY, null);
    const tabId = useManualBrowserTabsStore.getState().byDirectory[DIRECTORY]!.tabs[0]!.id;

    closeManualBrowserStripTab(DIRECTORY, tabId);

    expect(useManualBrowserTabsStore.getState().byDirectory[DIRECTORY]).toBe(undefined);
    expect(useUIStore.getState().browserPanelByDirectory[DIRECTORY]?.isOpen).toBe(true);
    expect(useUIStore.getState().activeBrowserLeaseIdByDirectory[DIRECTORY]).toBe('lease-a');
  });

  test('closing the last lease tab closes the panel when no manuals remain', () => {
    useUIStore.getState().openBrowserLease(DIRECTORY, {
      leaseId: 'lease-a',
      rootSessionId: 'root-a',
      url: 'http://localhost:3000/',
    });
    useManualBrowserTabsStore.getState().clearWorkspace(DIRECTORY);

    closeBrowserLeaseStripTab(DIRECTORY, 'lease-a');

    expect(useUIStore.getState().browserLeaseTabsByDirectory[DIRECTORY]).toEqual([]);
    expect(useUIStore.getState().browserPanelByDirectory[DIRECTORY]?.isOpen).toBe(false);
  });

  test('closing a lease while manuals remain leaves the panel open', () => {
    useUIStore.getState().openBrowserPanel(DIRECTORY);
    useUIStore.getState().openBrowserLease(DIRECTORY, { leaseId: 'lease-a', rootSessionId: 'root-a' });

    closeBrowserLeaseStripTab(DIRECTORY, 'lease-a');

    expect(useUIStore.getState().browserLeaseTabsByDirectory[DIRECTORY]).toEqual([]);
    expect(useUIStore.getState().browserPanelByDirectory[DIRECTORY]?.isOpen).toBe(true);
    expect(useManualBrowserTabsStore.getState().byDirectory[DIRECTORY]).toBeTruthy();
  });
});
