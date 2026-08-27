import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

const browserPanel = read('./BrowserPanel.tsx');
const browserPane = read('./DesktopBrowserPane.tsx');
const browserAgentStore = read('../../stores/useBrowserAgentStore.ts');
const uiStore = read('../../stores/useUIStore.ts');
const projectActions = read('./ProjectActionsButton.tsx');
const appEffects = read('../../apps/AppEffects.tsx');
const localPreviewInstances = read('./localPreviewInstances.ts');

describe('session-scoped browser lease lifecycle', () => {
  test('mounts the invariant lease fleet directly from live lease IDs', () => {
    expect(browserPanel).toContain('{leaseTabs.map((tab) => (');
    expect(browserPanel).toContain('key={tab.leaseId}');
    expect(browserPanel).toContain('<BrowserLeasePane');
    expect(browserPanel).toContain('leaseId={tab.leaseId}');
    expect(browserPanel).toContain("? 'pointer-events-none fixed inset-0 -z-10 opacity-0'");
  });

  test('shows only the observed lease and keeps every other guest inert but paintable', () => {
    expect(browserPanel).toContain('active={surfacesActive && observedLeaseId === tab.leaseId}');
    expect(browserPanel).toContain("active ? 'z-10 opacity-100' : 'z-0 pointer-events-none opacity-0'");
    expect(browserPanel).not.toContain("!active && 'invisible pointer-events-none'");
    expect(browserPanel).toContain('void setObservedBrowserAgentLease(observedLeaseId);');
    expect(browserPanel).toContain('void setObservedBrowserAgentLease(null);');
  });

  test('prunes every stale lease presentation on a root switch', () => {
    const tabs = [
      { id: 'lease-stale-a', leaseId: 'lease-a', rootSessionId: 'root-a' },
      { id: 'lease-current', leaseId: 'lease-b', rootSessionId: 'root-b' },
      { id: 'lease-stale-c', leaseId: 'lease-c', rootSessionId: 'root-c' },
    ] as const;
    const currentRootSessionId = 'root-b';
    const staleLeaseTabIDs = tabs
      .filter((tab) => tab.rootSessionId !== currentRootSessionId)
      .map((tab) => tab.id);

    expect(staleLeaseTabIDs).toEqual([
      'lease-stale-a',
      'lease-stale-c',
    ]);
    expect(browserPanel).toContain('if (tab.rootSessionId !== currentRootSessionId) closeBrowserLease(directory, tab.leaseId);');
  });

  test('keeps manual browser pages on the dedicated active-or-retained workspace policy', () => {
    expect(browserPanel).toContain('<ManualBrowserWorkspacePane');
    expect(browserPanel).toContain('showTabStrip={false}');
    expect(browserPane).toContain('const isMounted = isActive || retainedTabIds.has(tab.id);');
    expect(browserPane).toContain('sleepDelayMs: BROWSER_PAGE_SLEEP_DELAY_MS');
    expect(browserPanel).not.toContain('agentDriving || retainedBrowserTabIDs');
    expect(uiStore).toContain('browserLeaseTabsByDirectory');
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
    expect(appEffects).toContain('await claimBrowserAgentWindowContexts(claim.contexts)');
    expect(appEffects).toContain('const retryDelays = [250, 500, 1_000, 2_000]');
    expect(appEffects).toContain('if (claim.generation !== generation) continue');
    expect(appEffects).toContain('pending = { ...claim, retry: claim.retry + 1 }');
    expect(appEffects).toContain('committedClaimSignature = claim.signature');
    expect(appEffects).toContain("window.addEventListener('openchamber:connection-status', handleConnectionStatus)");
    expect(appEffects).toContain('if (retryTimer) clearTimeout(retryTimer)');
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
