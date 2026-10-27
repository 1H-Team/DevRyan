import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';

// The Vite-only logo glob cannot load under bun; logos are irrelevant to the browser pane.
mock.module('@/hooks/useProviderLogo', () => ({ useProviderLogo: () => ({ src: null, onError() {}, hasLogo: false }) }));
const { BrowserTabsBar, DesktopBrowserPane } = await import('./DesktopBrowserPane');

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

const host = globalThis as unknown as Record<string, unknown>;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  for (const key of ['window', 'navigator']) savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      __DEVRYAN_ELECTRON__: { runtime: 'electron' },
      __TAURI__: { core: { invoke: async () => null } },
      location: { href: 'https://app.example/', origin: 'https://app.example', search: '', pathname: '/' },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    },
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { userAgent: 'test' } });
});
afterEach(() => {
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(host, key);
  }
});

const renderPane = (props: { popped?: boolean; initialUrl?: string } = {}) => renderToStaticMarkup(
  <I18nProvider>
    <DesktopBrowserPane initialUrl={props.initialUrl ?? 'about:blank'} directory="/repo" tabID="tab-1" active popped={props.popped} />
  </I18nProvider>,
);
const openingTagWith = (markup: string, needle: string) => {
  const index = markup.indexOf(needle);
  expect(index).toBeGreaterThan(-1);
  return markup.slice(markup.lastIndexOf('<', index), markup.indexOf('>', index) + 1);
};
const classOf = (tag: string) => / class="([^"]*)"/.exec(tag)?.[1] ?? '';

describe('rendered Electron browser pane', () => {
  test('renders navigation, DevTools, inspect, pop-out and viewport controls', () => {
    const markup = renderPane();

    for (const label of ['Go Back', 'Go Forward', 'Reload Preview', 'Open DevTools', 'Select Element for Chat', 'Pop Out Browser', 'Viewport: Responsive']) {
      expect(markup).toContain(`aria-label="${label}"`);
    }
    expect(markup).not.toContain('Open in Regular Browser');
    // Nothing to go back to yet.
    expect(/\sdisabled=""/.test(openingTagWith(markup, 'aria-label="Go Back"'))).toBe(true);
    expect(/\sdisabled=""/.test(openingTagWith(markup, 'aria-label="Reload Preview"'))).toBe(false);
  });

  test('keeps the blank surface detachable', () => {
    const markup = renderPane({ initialUrl: 'about:blank' });

    expect(/\sdisabled=""/.test(openingTagWith(markup, 'aria-label="Pop Out Browser"'))).toBe(false);
  });

  test('aligns toolbar controls and uses the configured interface typography in the address field', () => {
    const markup = renderPane();

    for (const label of ['Go Back', 'Reload Preview', 'Pop Out Browser']) {
      const classes = classOf(openingTagWith(markup, `aria-label="${label}"`)).split(/\s+/);
      for (const expected of ['size-7', 'p-0', 'leading-none']) expect(classes).toContain(expected);
    }
    expect(classOf(openingTagWith(markup, 'aria-label="Browser Address"')))
      .toContain('font-sans typography-ui-label font-normal leading-none tracking-normal');
  });

  test('swaps Pop Out for Dock while the live view is popped out and shows Focus and Dock controls', () => {
    const docked = renderPane({ popped: false });
    const popped = renderPane({ popped: true });

    expect(docked).toContain('aria-label="Pop Out Browser"');
    expect(docked).not.toContain('Dock Browser');
    expect(docked).not.toContain('Browser is open in another window');
    expect(popped).toContain('aria-label="Dock Browser"');
    expect(popped).not.toContain('aria-label="Pop Out Browser"');
    expect(popped).toContain('Browser is open in another window');
    expect(/<button[^>]*>Focus<\/button>/.test(popped)).toBe(true);
    expect(/<button[^>]*>Dock<\/button>/.test(popped)).toBe(true);
  });

  test('shows the empty state until an address is entered', () => {
    expect(renderPane()).toContain('Enter an address above to start browsing the web');
  });
});

describe('rendered browser tab strip', () => {
  const strip = (props: Partial<React.ComponentProps<typeof BrowserTabsBar>> = {}) => renderToStaticMarkup(
    <BrowserTabsBar
      tabs={[{ id: 'manual-1', label: 'Docs', url: 'https://example.test/', viewportMode: 'responsive' } as never]}
      activeTabId="manual-1"
      onAdd={() => {}}
      onSelect={() => {}}
      onClose={() => {}}
      onReorder={() => {}}
      {...props}
    />,
  );

  test('renders one dedicated strip with manual tabs and the add button', () => {
    const markup = strip();

    expect(markup).toContain('data-browser-tabs-strip="true"');
    expect(markup).toContain('data-browser-tab-id="manual-1"');
    expect(markup).toContain('aria-label="New Browser Tab"');
    expect(markup.match(/data-browser-tabs-strip/g)).toHaveLength(1);
  });

  test('lists agent lease tabs after manual tabs, marked with the lease dot and not draggable', () => {
    const markup = strip({
      leaseTabs: [{ id: 'browser:lease:lease-1', leaseId: 'lease-1', rootSessionId: 'root', url: 'https://agent.test/', label: 'Agent page', touchedAt: 1 }],
      activeLeaseId: null,
    });

    expect(markup.indexOf('data-browser-tab-id="browser:lease:lease-1"')).toBeGreaterThan(markup.indexOf('data-browser-tab-id="manual-1"'));
    expect(markup).toContain('ring-[var(--surface-background)]');
    const leaseWrapper = markup.slice(markup.indexOf('data-browser-tab-id="browser:lease:lease-1"'));
    expect(leaseWrapper.split('<button')[0]).not.toContain('aria-roledescription');
    expect(markup.slice(markup.indexOf('data-browser-tab-id="manual-1"')).split('<button')[0]).toContain('aria-roledescription="sortable"');
  });

  test('reserves macOS traffic-light space only for a native titlebar', () => {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' } });

    expect(strip({ nativeTitlebar: true })).toContain('pl-[78px]');
    expect(strip({ nativeTitlebar: false })).not.toContain('pl-[78px]');
  });
});

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

  test('publishes and clears native surface occupancy for renderer overlays', () => {
    expect(source).toContain('setNativeSurfaceOccupancy(surfaceId, visible ? {');
    expect(source).toContain('setNativeSurfaceOccupancy(surfaceId, null);');
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

});

describe('browser pane residual pins', () => {
  test('uses the picture-in-picture placement icons and not the retired fullscreen ones', () => {
    expect(source).toContain('<RiPictureInPicture2Line');
    expect(source).toContain('<RiPictureInPictureExitLine');
    expect(source).not.toContain('RiFullscreenLine');
    expect(source).not.toContain('RiFullscreenExitLine');
  });

  test('loads the configured interface fonts in the pop-out root and selects the address on focus', () => {
    expect(source).toContain("import { useAppFontEffects } from '@/apps/useAppFontEffects';");
    expect(source).toContain('export const BrowserPopoutApp: React.FC = () => {\n  useAppFontEffects();');
    expect(source).toContain('onFocus={(event) => event.currentTarget.select()}');
  });

  test('offers the three viewport modes and inspect/DevTools commands', () => {
    expect(source).toContain("{ value: 'responsive', label: 'Responsive'");
    expect(source).toContain("{ value: 'desktop', label: 'Desktop'");
    expect(source).toContain("{ value: 'mobile', label: 'Mobile'");
    expect(source).toContain("'desktop_browser_surface_inspect'");
    expect(source).toContain("'desktop_browser_devtools_set_open'");
  });

  test('docks and pops out through the surface commands', () => {
    expect(source).toContain("const commandName = popped ? 'desktop_browser_surface_dock' : 'desktop_browser_surface_popout'");
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
