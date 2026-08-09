import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

const contextPanel = read('./ContextPanel.tsx');
const browserPane = read('./DesktopBrowserPane.tsx');
const browserAgentStore = read('../../stores/useBrowserAgentStore.ts');
const uiStore = read('../../stores/useUIStore.ts');
const projectActions = read('./ProjectActionsButton.tsx');
const appEffects = read('../../apps/AppEffects.tsx');
const localPreviewInstances = read('./localPreviewInstances.ts');

describe('session-scoped browser lease lifecycle', () => {
  test('mounts the invariant lease fleet directly from live lease IDs', () => {
    expect(contextPanel).toContain('{leaseIds.map((leaseId) => (');
    expect(contextPanel).toContain('key={leaseId}');
    expect(contextPanel).toContain('<BrowserLeasePane');
    expect(contextPanel).toContain('leaseId={leaseId}');
    expect(contextPanel).toContain("? 'pointer-events-none fixed inset-0 -z-10 opacity-0'");
  });

  test('shows only the observed lease and keeps every other guest inert but paintable', () => {
    expect(contextPanel).toContain('active={activeLeaseId === leaseId && observedLeaseId === leaseId}');
    expect(contextPanel).toContain("active ? 'z-10 opacity-100' : 'z-0 pointer-events-none opacity-0'");
    expect(contextPanel).not.toContain("!active && 'invisible pointer-events-none'");
    expect(contextPanel).toContain('void setObservedBrowserAgentLease(activeLeaseId);');
    expect(contextPanel).toContain('void setObservedBrowserAgentLease(null);');
  });

  test('prunes every stale lease tab on a root switch without touching non-lease tabs', () => {
    const tabs = [
      { id: 'lease-stale-a', mode: 'browser', leaseId: 'lease-a', ownerSessionId: 'root-a' },
      { id: 'manual-browser', mode: 'browser', leaseId: null, ownerSessionId: null },
      { id: 'file-tab', mode: 'file', leaseId: null, ownerSessionId: null },
      { id: 'lease-current', mode: 'browser', leaseId: 'lease-b', ownerSessionId: 'root-b' },
      { id: 'lease-stale-c', mode: 'browser', leaseId: 'lease-c', ownerSessionId: 'root-c' },
    ] as const;
    const currentRootSessionId = 'root-b';
    const staleLeaseTabIDs = tabs
      .filter((tab) => (
        tab.mode === 'browser'
        && Boolean(tab.leaseId)
        && tab.ownerSessionId !== currentRootSessionId
      ))
      .map((tab) => tab.id);

    expect(staleLeaseTabIDs).toEqual([
      'lease-stale-a',
      'lease-stale-c',
    ]);
    expect(contextPanel).toContain("tab.mode === 'browser'");
    expect(contextPanel).toContain('&& Boolean(tab.leaseId)');
    expect(contextPanel).toContain('&& tab.ownerSessionId !== currentRootSessionId');
    expect(contextPanel).toContain(
      'const staleLeaseTabIDs = getStaleBrowserLeaseTabIDs(tabs, currentRootSessionId);',
    );
    expect(contextPanel).toContain('for (const staleTabID of staleLeaseTabIDs) {');
    expect(contextPanel).toContain('closeContextPanelTab(directoryKey, staleTabID);');
  });

  test('keeps manual browser pages on the dedicated active-or-retained workspace policy', () => {
    expect(contextPanel).toContain("tabs.find((tab) => tab.mode === 'browser' && !tab.leaseId)");
    expect(contextPanel).toContain('<ManualBrowserWorkspacePane');
    expect(browserPane).toContain('const isMounted = isActive || retainedTabIds.has(tab.id);');
    expect(browserPane).toContain('sleepDelayMs: BROWSER_PAGE_SLEEP_DELAY_MS');
    expect(contextPanel).not.toContain('agentDriving || retainedBrowserTabIDs');
    expect(uiStore).toContain("tab.mode === 'browser' && !tab.leaseId");
  });

  test('uses the main-owned lease surface and never starts the retired global bridge', () => {
    expect(browserPane).toContain("const surfaceId = leaseId ? (lease?.surfaceId ?? '') : manualSurfaceId;");
    expect(browserPane).toContain("invokeDesktop<unknown>('desktop_browser_surface_snapshot', { surfaceId })");
    expect(browserPane).not.toContain('<webview');
    expect(browserPane).not.toContain('webContentsId');
    expect(browserPane).not.toContain("invokeDesktop('desktop_browser_cdp_start')");
    expect(browserPane).not.toContain("window.addEventListener('browser-agent-status'");
  });

  test('accepts only local Electron lease snapshots and prunes removed tabs', () => {
    expect(browserAgentStore).toContain("window.addEventListener('browser-agent-leases'");
    expect(browserAgentStore).toContain("invokeDesktop<unknown>('desktop_browser_lease_snapshot')");
    expect(browserAgentStore).toContain('isElectronShell() && isDesktopLocalOriginActive()');
    expect(browserAgentStore).toContain('pruneBrowserLeaseTabs(after.leaseIds)');
    expect(browserAgentStore).not.toContain("window.addEventListener('browser-agent-status'");
    expect(browserAgentStore).not.toContain("window.addEventListener('browser-agent-wake-request'");
  });

  test('scopes the top-right activity dot and dropdown to the selected root', () => {
    expect(projectActions).toContain('resolveRootSessionID(currentSessionId, sessions)');
    expect(projectActions).toContain('claimBrowserAgentWindowContext(selectedRootSessionId, normalizedDirectory)');
    expect(projectActions).toContain('browserAgentLeaseSelectors.leaseIdsForRoot(selectedRootSessionId)');
    expect(projectActions).toContain('data-browser-lease-active="true"');
    expect(projectActions).toContain('absolute -right-1 -top-1 h-2 w-2');
    expect(projectActions).not.toContain('{rootLeaseCount > 99');
    expect(projectActions).toContain('rootLeaseIds.map((leaseId) => (');
  });

  test('claims authoritative background roots and worktree session families', () => {
    expect(appEffects).toContain('childStores.subscribeSessionLists');
    expect(appEffects).toContain('Object.values(useManagedOrchestrationStore.getState().tasksById)');
    expect(appEffects).toContain('collectBrowserAgentWindowContexts');
    expect(appEffects).toContain('claimBrowserAgentWindowContexts(contexts)');
    expect(browserAgentStore).toContain("invokeDesktop<unknown>('desktop_browser_lease_claim_contexts'");
  });

  test('registers terminal-discovered project apps independently of Browser presentation', () => {
    expect(appEffects).toContain('<ProjectPreviewGrantOwner />');
    expect(localPreviewInstances).toContain('useTerminalStore.subscribe((state, previous) => {');
    expect(localPreviewInstances).toContain('registerProjectPreviewInstance({');
    expect(localPreviewInstances).toContain("fetchImpl('/api/preview/instances/register'");
    expect(localPreviewInstances).not.toContain("hasAuthCapability(principal, 'browser')");
    expect(localPreviewInstances).toContain('PROJECT_PREVIEW_REGISTRATION_REFRESH_MS');
    expect(browserPane).not.toContain('registerProjectPreviewInstance({');
  });

  test('keeps Back non-destructive and the manual action after a separator', () => {
    const backIndex = projectActions.indexOf('data-browser-lease-back="true"');
    const separatorIndex = projectActions.indexOf('<DropdownMenuSeparator />', backIndex);
    const manualIndex = projectActions.indexOf("t('header.actions.browserLeases.manual')", separatorIndex);

    expect(backIndex).toBeGreaterThan(-1);
    expect(projectActions.slice(backIndex, separatorIndex)).not.toContain('stop');
    expect(separatorIndex).toBeGreaterThan(backIndex);
    expect(manualIndex).toBeGreaterThan(separatorIndex);
  });
});
