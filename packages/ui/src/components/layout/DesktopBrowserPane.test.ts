import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./DesktopBrowserPane.tsx', import.meta.url), 'utf8');
const storeSource = readFileSync(new URL('../../stores/useBrowserSurfaceStore.ts', import.meta.url), 'utf8');
const viteSource = readFileSync(new URL('../../../../web/vite.config.ts', import.meta.url), 'utf8');
const projectActionsSource = readFileSync(new URL('./ProjectActionsButton.tsx', import.meta.url), 'utf8');
const headerSource = readFileSync(new URL('./Header.tsx', import.meta.url), 'utf8');
const desktopRuntimeSource = readFileSync(new URL('../../lib/desktop.ts', import.meta.url), 'utf8');
const browserRuntimeSource = readFileSync(new URL('./browserRuntime.ts', import.meta.url), 'utf8');
const diagnosticsSource = readFileSync(new URL('./previewDiagnostics.tsx', import.meta.url), 'utf8');
const diagnosticsStateSource = readFileSync(new URL('./previewDiagnosticsState.ts', import.meta.url), 'utf8');
const contextPanelSource = readFileSync(new URL('./ContextPanel.tsx', import.meta.url), 'utf8');
const browserPanelSource = readFileSync(new URL('./BrowserPanel.tsx', import.meta.url), 'utf8');
const browserTabStripSource = readFileSync(new URL('./BrowserTabStrip.tsx', import.meta.url), 'utf8');

describe('shared browser surface shell', () => {
  test('gates the browser on a normalized directory rather than a project record', () => {
    expect(projectActionsSource).toContain('const canOpenBlankBrowser = canUseBrowser && Boolean(normalizedDirectory);');
    expect(projectActionsSource).toContain("hasAuthCapability(principal, 'browser')");
    expect(projectActionsSource).toContain('if (browserOnly) {');
    expect(headerSource).toContain('{canUseTerminal || canUseBrowser ? (');
    expect(headerSource).toContain('browserOnly={!canUseTerminal}');
    expect(projectActionsSource).not.toContain('Boolean(stableProjectRef && normalizedDirectory)');
    expect(headerSource).toContain("if (!actionDirectory) {");
    expect(headerSource).toContain('return { projectRef: activeProjectRef, directory: actionDirectory };');
    expect(headerSource).toContain('directory={actionDirectory}');
  });
  test('keeps browser state outside the broad UI store and uses surface snapshots', () => {
    expect(storeSource).toContain('export type BrowserSurfaceSnapshot');
    expect(storeSource).toContain("placement: 'inline' | 'popout' | 'parked'");
    expect(storeSource).toContain('surfaceIdByTabId');
    expect(source).toContain('useBrowserSurfaceStore((state) => surfaceId');
  });

  test('renders navigation, pop-out, inspect, DevTools, and viewport actions', () => {
    expect(source).toContain('onFocus={(event) => event.currentTarget.select()}');
    expect(source).toContain("aria-label={popped ? 'Dock Browser' : 'Pop Out Browser'}");
    expect(source).toContain("{ value: 'responsive', label: 'Responsive'");
    expect(source).toContain("{ value: 'desktop', label: 'Desktop'");
    expect(source).toContain("{ value: 'mobile', label: 'Mobile'");
    expect(source).not.toContain('title="Open in Regular Browser"');
    expect(source).toContain("'desktop_browser_surface_inspect'");
    expect(source).toContain("'desktop_browser_devtools_set_open'");
  });

  test('publishes and clears native surface occupancy for renderer overlays', () => {
    expect(source).toContain('setNativeSurfaceOccupancy(surfaceId, visible ? {');
    expect(source).toContain('setNativeSurfaceOccupancy(surfaceId, null);');
  });

  test('aligns toolbar controls and uses picture-in-picture placement icons', () => {
    expect(source).toContain("const BROWSER_TOOLBAR_BUTTON_CLASS = 'size-7 p-0 leading-none';");
    expect(source).toContain("const BROWSER_TOOLBAR_ICON_CLASS = 'size-3.5';");
    expect(source).toContain('<RiPictureInPicture2Line');
    expect(source).toContain('<RiPictureInPictureExitLine');
    expect(source).not.toContain('RiFullscreenLine');
    expect(source).not.toContain('RiFullscreenExitLine');
  });

  test('uses configured interface typography in the address field and pop-out root', () => {
    expect(source).toContain('font-sans typography-ui-label font-normal leading-none tracking-normal');
    expect(source).toContain("import { useAppFontEffects } from '@/apps/useAppFontEffects';");
    expect(source).toContain('export const BrowserPopoutApp: React.FC = () => {\n  useAppFontEffects();');
  });

  test('keeps the blank surface detachable', () => {
    expect(source).toContain("currentUrl === 'about:blank'");
    expect(source).toContain("const commandName = popped ? 'desktop_browser_surface_dock' : 'desktop_browser_surface_popout'");
    expect(source).not.toContain('disabled={!currentUrl}');
  });

  test('offers confirmed local preview instances in the empty state', () => {
    expect(source).toContain('useProjectPreviewInstances(');
    expect(source).toContain('reachable.map((instance, index) => (');
    expect(source).toContain('onClick={() => onNavigate(instance.url)}');
    expect(source).toContain('role="list"');
    expect(source).toContain('<RiServerLine');
  });

  test('renders one dedicated Browser strip outside the shared context panel', () => {
    expect(source).toContain('data-browser-tabs-strip="true"');
    expect(source).toContain('tabs={workspace.tabs}');
    expect(browserTabStripSource).toContain('aria-label="New Browser Tab"');
    expect(source).toContain('onReorder={(tabId, overTabId) => reorderTabs(directory, tabId, overTabId)}');
    expect(source).toContain('onClose={(tabId) => closeManualBrowserStripTab(directory, tabId)}');
    expect(browserPanelSource).toContain('<ManualBrowserWorkspacePane');
    expect(browserPanelSource).toContain('leaseTabs={leaseTabs}');
    expect(browserPanelSource).toContain('closeManualBrowserStripTab(directoryKey, tabId)');
    expect(contextPanelSource).not.toContain('<ManualBrowserWorkspacePane');
    expect(contextPanelSource).not.toContain('BrowserLeasePane');
    expect(source).toContain('updateManualBrowserTabTitle(directory, tabID, snapshot.title);');
    expect(source).toContain('updateManualBrowserTabFavicon(directory, tabID, snapshot.faviconUrl ?? null);');
  });

  test('keeps native page components mounted behind the detached-workspace placeholder', () => {
    expect(source).toContain("className={cn('absolute inset-0', (!isActive || popped) && 'invisible pointer-events-none')}");
    expect(source).toContain('popped={popped}');
    expect(source).toContain("<div className=\"absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center\">");
    expect(source).not.toContain('if (popped) {\n    return (');
  });
  test('dismisses the detached web workspace when the last tab is closed', () => {
    expect(source).toContain("if (index !== -1 && current.tabs.length === 1)");
    expect(source).toContain("send({ type: 'close-tab', tabId });");
    expect(source).toContain('window.close();');
    expect(source).toContain('return current;');
  });
});

describe('Electron browser surface', () => {
  test('creates and lays out a main-owned view without a renderer webview', () => {
    expect(source).toContain('createDesktopBrowserSurface(tabID');
    expect(source).toContain("'desktop_browser_surface_layout'");
    expect(source).toContain("const surfaceId = leaseId ? (lease?.surfaceId ?? '') : manualSurfaceId;");
    expect(source).not.toContain('<webview');
    expect(source).not.toContain('webContentsId');
    expect(source).toContain('CONTEXT_PANEL_RESIZE_GUTTER_PX');
    expect(browserPanelSource).toContain('data-panel-resize-handle="browser-panel"');
  });

  test('retains annotation capture and resizable native DevTools by surface id', () => {
    expect(source).toContain("'desktop_browser_surface_inspect', { surfaceId }");
    expect(source).toContain('const capture = result?.capture;');
    expect(source).not.toContain("'desktop_browser_capture_page', { surfaceId }");
    expect(source).toContain('desktopAnnotationToFile(');
    expect(source).toContain('role="separator"');
    expect(source).toContain("window.addEventListener('pointermove', onMove)");
    expect(source).toContain('snapshot?.devToolsOpen');
  });

  test('shows Focus and Dock controls while the live view is popped out', () => {
    expect(source).toContain('Browser is open in another window');
    expect(source).toContain("'desktop_browser_surface_focus_popout'");
    expect(source).toContain('onClick={togglePopout}>Dock</Button>');
  });
});

describe('standalone web browser surface', () => {
  test('uses native Electron browsing for every Browser-capable account', () => {
    expect(source).toContain('const useNativeBrowser = isElectronShell();');
    expect(source).toContain("transport: useNativeBrowser ? 'native' : 'host'");
    expect(source).toContain('if (isElectronShell()) return <ElectronBrowserPane {...props} />;');
    expect(source).not.toContain('shouldRouteManualBrowserThroughHost');
  });

  test('supports local, managed, and tunneled standalone web origins', () => {
    expect(desktopRuntimeSource).toContain('export const isStandaloneWebRuntime');
    expect(browserRuntimeSource).toContain('isElectronShell() || isStandaloneWebRuntime()');
    expect(source).toContain('if (isStandaloneWebRuntime()) return <WebBrowserPane {...props} />;');
    expect(projectActionsSource).toContain('openBrowserPanel(targetDirectory, url);');
  });

  test('has a dedicated Vite entry and a sandboxed iframe with Browser proxy registration', () => {
    expect(viteSource).toContain("browser: path.resolve(__dirname, 'browser.html')");
    expect(source).toContain("fetch('/api/browser/targets'");
    expect(source).toContain('body: JSON.stringify({ url: target, directory })');
    expect(source).toContain('sandbox="allow-downloads allow-forms allow-modals allow-pointer-lock allow-popups allow-same-origin allow-scripts"');
    expect(source).not.toContain("'allow-forms allow-modals allow-popups allow-scripts'");
    expect(source).toContain('data-browser-viewport={viewportMode}');
    expect(source).toContain('transform: `scale(${viewportLayout.scale})`');
  });

  test('opens non-loopback pages on the viewer while keeping project apps host-routed', () => {
    expect(source).toContain('const hostRouted = isBrowserHostRoutedUrl(url);');
    expect(source).toContain('if (!hostRouted) {');
    expect(source).toContain("if (state.origin !== origin || !state.base || !parsed) return { ...state, src: '', routed: true };");
    expect(source).toContain('if (parsed && !isBrowserHostRoutedUrl(next)) openExternal(next);');
    expect(source).toContain('Your browser blocked the new tab.');
    expect(source).toContain("This site opens in your regular browser using this device's connection.");
    expect(source).toContain('onExternalNavigate: handleHandoffNavigate');
    expect(diagnosticsSource).toContain('onExternalNavigate?: (url: string) => void;');
  });

  test('bounds page-driven redirect handoffs and target invalidation instead of looping', () => {
    expect(source).toContain('const BROWSER_HANDOFF_LOOP_LIMIT');
    expect(source).toContain('const BROWSER_TARGET_INVALIDATE_LIMIT');
    expect(source).toContain('onTargetNavigate: handleHandoffNavigate');
    expect(source).toContain('if (attempts.length > BROWSER_HANDOFF_LOOP_LIMIT)');
    expect(source).toContain('if (attempts.length > BROWSER_TARGET_INVALIDATE_LIMIT)');
    expect(source).toContain('setLoopError(BROWSER_HANDOFF_LOOP_MESSAGE)');
    expect(source).toContain('setLoopError(BROWSER_TARGET_LOOP_MESSAGE)');
    // Deliberate user actions clear the guard so the surface is never stuck.
    expect(source).toContain('resetLoopGuards();');
  });

  test('keeps the inspection bridge alive across same-document navigations', () => {
    expect(source).toContain('frameKey: renderedFrame.key');
    expect(source).not.toContain('bumpNavigationKey');
    expect(source).not.toContain('navigationKey');
  });

  test('keeps loading visually stable and never reuses a proxy id across origins', () => {
    expect(source).toContain("type ProxyState = { origin: string; base: string; loading: boolean; error: string; external: boolean };");
    expect(source).toContain("if (state.origin !== origin || !state.base || !parsed)");
    expect(source).toContain('const [renderedFrame, setRenderedFrame]');
    expect(source).toContain('enabled: frame.routed && frameActive');
    expect(source).toContain('const handleRenderReady = React.useCallback(() => setFrameLoaded(true), [])');
    expect(source).toContain('const handleNavigationStart = React.useCallback(() => setFrameLoaded(false), [])');
    expect(source).toContain('onRenderReady: handleRenderReady');
    expect(source).toContain('onNavigationStart: handleNavigationStart');
    expect(diagnosticsSource).toContain("data.type === 'render-ready'");
    expect(source).toContain('currentUrl !== \'about:blank\' && (loading || frame.error || loopError)');
    expect(source).toContain('aria-live="polite"');
  });

  test('automatically re-registers stale proxy ids after a server restart or lease expiry', () => {
    expect(source).toContain("'preview_target_expired'");
    expect(source).toContain("'preview_target_not_found'");
    expect(source).toContain('isRecoverablePreviewTargetDocument(iframe)');
    expect(source).toContain('delete next[staleOrigin]');
    expect(source).toContain('onLoad={handleFrameLoad}');
  });

  test('keeps the console action without a numeric error badge', () => {
    expect(source).toContain('aria-label="Console"');
    expect(source).not.toContain('consoleErrorCount');
    expect(source).not.toContain('Math.min(consoleErrorCount, 99)');
  });

  test('shows shared console and element tools only for host-routed project apps', () => {
    expect(source).toContain('showWebDiagnostics');
    expect(source).toContain('webDiagnosticsEnabled={diagnosticsEnabled}');
    expect(source).toContain('Console and Select Element are available only for project apps routed through DevRyan.');
    expect(source).toContain('<PreviewConsolePanel {...diagnostics} />');
    expect(diagnosticsStateSource).toContain('export const PREVIEW_CONSOLE_EVENT_LIMIT = 200;');
    expect(diagnosticsSource).toContain("type: 'set-inspect-mode'");
    expect(diagnosticsSource).toContain('renderPreviewScreenshot');
  });

  test('opens synchronously, transfers versioned state by random id, and handles popup blocking and close', () => {
    expect(source).toContain('window.open(`/browser.html?surfaceId=${encodeURIComponent(surfaceId)}`');
    expect(source).toContain('new BroadcastChannel(`devryan-browser-surface:${surfaceId}`)');
    expect(source).toContain("source: 'devryan-browser-surface', version: 1, surfaceId");
    expect(source).toContain("event.origin !== window.location.origin");
    expect(source).toContain('popup.postMessage(envelope, window.location.origin)');
    expect(source).toContain("message.type === 'ready'");
    expect(source).toContain("message.type === 'dock' || message.type === 'closed'");
    expect(source).toContain("message.type === 'ping'");
    expect(source).toContain("sendToPopup({ type: 'pong' })");
    expect(source).toContain("Date.now() - lastOpenerPongAtRef.current > 12_000");
    expect(source).not.toContain('placement === \'popout\', directory');
    expect(source).toContain('The browser pop-out was blocked');
    expect(source).toContain('crypto.getRandomValues(bytes)');
    expect(source).not.toContain('/browser.html?url=');
    expect(source).not.toContain('/browser.html?directory=');
  });

  test('moves the complete versioned manual-browser workspace through an opaque pop-out URL', () => {
    expect(source).toContain('type BrowserWorkspaceRuntimeState = {');
    expect(source).toContain('version: 2;');
    expect(source).toContain('tabs: BrowserWorkspaceRuntimeTab[];');
    expect(source).toContain('/browser.html?workspaceId=${encodeURIComponent(workspace.workspaceId)}');
    expect(source).toContain('new BroadcastChannel(`devryan-browser-workspace:${workspace.workspaceId}`)');
    expect(source).toContain("type: 'add-tab'");
    expect(source).toContain("type: 'reorder-tabs'");
    expect(source).toContain("tabId: state.activeTabId");
    expect(source).toContain('useBrowserSurfaceStore.getState().applySnapshot(value, state.activeTabId)');
    expect(source).not.toContain('/browser.html?workspaceId=${encodeURIComponent(directory)}');
  });

  test('preserves serializable history and diagnostics across detach and dock', () => {
    expect(source).toContain('export type WebBrowserSessionState');
    expect(source).toContain('historyIndex: number;');
    expect(source).toContain('diagnostics: PreviewDiagnosticsState;');
    expect(source).toContain("send({ type: 'dock', state: stateRef.current ?? undefined })");
    expect(source).toContain("send({ type: 'closed', state: stateRef.current ?? undefined })");
    expect(source).toContain("type: 'attach-console'");
    expect(source).toContain("type: 'attach-annotation'");
    expect(source).toContain("message.type === 'attach-annotation' && message.attachment && isPreviewElementMetadata(message.attachment.target)");
    expect(source).toContain('pendingNavigationRef.current');
    expect(source).toContain('reconcileWebBrowserDisplayUrl(value, currentUrl)');
  });

  test('keeps the internal reload cache key out of the displayed project URL', () => {
    expect(source).toContain('sanitizeWebBrowserDisplayUrl(initialUrl)');
    expect(source).not.toContain("params.set('ocPreview'");
    expect(source).not.toContain("params.set('ocBrowser'");
  });

  test('retries only pending project approval and distinguishes expired authentication', () => {
    expect(source).toContain("body.code === 'project_preview_not_approved'");
    expect(source).toContain('Your DevRyan session has expired. Sign in again to use Browser.');
    expect(source).toContain('if (!approvalPending || attempt === 11) break;');
  });

  test('invalidates a popup when logout or a user switch changes authentication identity', () => {
    expect(source).toContain('getAuthenticatedBrowserIdentity');
    expect(source).toContain('session.authenticated !== true');
    expect(source).toContain('policy?.browser !== true');
    expect(source).toContain('authIdentityRef.current !== identity');
    expect(source).toContain('!authVerified || initialState === null');
  });
});
