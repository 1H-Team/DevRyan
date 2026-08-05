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

describe('shared browser surface shell', () => {
  test('gates the browser on a normalized directory rather than a project record', () => {
    expect(projectActionsSource).toContain('const canOpenBlankBrowser = Boolean(normalizedDirectory);');
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

  test('renders navigation, pop-out, inspect, DevTools, and regular-browser actions', () => {
    expect(source).toContain('onFocus={(event) => event.currentTarget.select()}');
    expect(source).toContain("aria-label={popped ? 'Dock Browser' : 'Pop Out Browser'}");
    expect(source).toContain("title=\"Open in Regular Browser\"");
    expect(source).toContain("'desktop_browser_surface_inspect'");
    expect(source).toContain("'desktop_browser_devtools_set_open'");
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
    expect(source).toContain('useLocalPreviewInstances(');
    expect(source).toContain('useReachableLocalPreviewInstances(');
    expect(source).toContain('reachable.map((instance, index) => (');
    expect(source).toContain('onClick={() => onNavigate(instance.url)}');
    expect(source).toContain('role="list"');
    expect(source).toContain('<RiServerLine');
  });
});

describe('Electron browser surface', () => {
  test('creates and lays out a main-owned view without a renderer webview', () => {
    expect(source).toContain('createDesktopBrowserSurface(tabID');
    expect(source).toContain("'desktop_browser_surface_layout'");
    expect(source).toContain("const surfaceId = leaseId ? (lease?.surfaceId ?? '') : manualSurfaceId;");
    expect(source).not.toContain('<webview');
    expect(source).not.toContain('webContentsId');
  });

  test('retains annotation capture and resizable native DevTools by surface id', () => {
    expect(source).toContain("'desktop_browser_capture_page', { surfaceId }");
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
  test('supports local, managed, and tunneled standalone web origins', () => {
    expect(desktopRuntimeSource).toContain('export const isStandaloneWebRuntime');
    expect(browserRuntimeSource).toContain('isElectronShell() || isStandaloneWebRuntime()');
    expect(source).toContain('if (isStandaloneWebRuntime()) return <WebBrowserPane {...props} />;');
    expect(projectActionsSource).toContain('openContextBrowser(targetDirectory, url);');
  });

  test('has a dedicated Vite entry and a sandboxed iframe with loopback proxy registration', () => {
    expect(viteSource).toContain("browser: path.resolve(__dirname, 'browser.html')");
    expect(source).toContain("fetch('/api/preview/targets'");
    expect(source).toContain('body: JSON.stringify({ url: target, directory })');
    expect(source).toContain("'allow-downloads allow-forms allow-modals allow-pointer-lock allow-popups allow-same-origin allow-scripts'");
    expect(source).toContain("'allow-forms allow-modals allow-popups allow-scripts'");
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
    expect(source).toContain("useReachableLocalPreviewInstances(previewCandidates, placement === 'popout', directory)");
    expect(source).toContain('The browser pop-out was blocked');
    expect(source).toContain('crypto.getRandomValues(bytes)');
    expect(source).not.toContain('/browser.html?url=');
    expect(source).not.toContain('/browser.html?directory=');
  });

  test('preserves serializable history and diagnostics across detach and dock', () => {
    expect(source).toContain('export type WebBrowserSessionState');
    expect(source).toContain('historyIndex: number;');
    expect(source).toContain('diagnostics: PreviewDiagnosticsState;');
    expect(source).toContain("send({ type: 'dock', state: stateRef.current ?? undefined })");
    expect(source).toContain("send({ type: 'closed', state: stateRef.current ?? undefined })");
    expect(source).toContain("type: 'attach-console'");
    expect(source).toContain("type: 'attach-annotation'");
    expect(source).toContain('pendingNavigationRef.current');
    expect(source).toContain('reconcileWebBrowserDisplayUrl(value, currentUrl)');
  });

  test('keeps the internal reload cache key out of the displayed project URL', () => {
    expect(source).toContain('sanitizeWebBrowserDisplayUrl(initialUrl)');
    expect(source).not.toContain("params.set('ocPreview'");
    expect(source).not.toContain("params.set('ocBrowser'");
  });

  test('invalidates a popup when logout or a user switch changes authentication identity', () => {
    expect(source).toContain('getAuthenticatedBrowserIdentity');
    expect(source).toContain('session.authenticated !== true');
    expect(source).toContain('authIdentityRef.current !== identity');
  });
});
