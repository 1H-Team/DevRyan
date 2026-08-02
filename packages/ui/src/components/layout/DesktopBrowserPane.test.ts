import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./DesktopBrowserPane.tsx', import.meta.url), 'utf8');

describe('DesktopBrowserPane address bar', () => {
  test('selects the full address when the field receives focus', () => {
    expect(source).toContain('onFocus={(event) => event.currentTarget.select()}');
  });

  test('does not render the browser trust notice', () => {
    expect(source).not.toContain('contextPanel.browser.trustNotice');
  });

  test('does not render a proxy connection message while loading websites', () => {
    expect(source).not.toContain('contextPanel.preview.loading');
  });

  test('loads a selected local instance in the existing webview', () => {
    expect(source).toContain('onClick={() => loadUrl(instance.url)}');
    expect(source).toContain("setIsLoading(nextUrl !== 'about:blank')");
    expect(source).toContain("webview.addEventListener('did-fail-load', onFailLoading)");
    expect(source).toContain("webview.removeEventListener('did-fail-load', onFailLoading)");
  });
});

describe('DesktopBrowserPane local instance launcher', () => {
  test('shows confirmed local previews only in the active blank state', () => {
    expect(source).toContain('useLocalPreviewInstances(');
    expect(source).toContain('useReachableLocalPreviewInstances(');
    expect(source).toContain('!leaseId && active && isBlankPage && !isLoading');
    expect(source).toContain('reachableLocalPreviews.length > 0');
  });

  test('renders the screenshot-inspired grouped server rows accessibly', () => {
    expect(source).toContain('role="list"');
    expect(source).toContain("aria-label={t('contextPanel.browser.localInstancesAria')}");
    expect(source).toContain('<RiServerLine');
    expect(source).toContain('<RiPlayLine');
    expect(source).toContain("t('contextPanel.browser.openLocalInstance'");
  });
});

describe('DesktopBrowserPane lease binding', () => {
  test('binds only an explicitly leased guest after Electron attaches it', () => {
    expect(source).toContain('leaseId?: string;');
    expect(source).toContain("webview.addEventListener('did-attach', bindLeaseGuest)");
    expect(source).toContain("webview.addEventListener('dom-ready', bindLeaseGuest)");
    expect(source).toContain("invokeDesktop('desktop_browser_lease_bind_guest', { leaseId, webContentsId })");
    expect(source).toContain('data-browser-lease-id={leaseId ?? undefined}');
  });

  test('uses the lease leaf for observed cursor presentation without global status listeners', () => {
    expect(source).toContain('const isAgentDriving = Boolean(leaseId && lease?.clientAttached);');
    expect(source).toContain('<BrowserAgentCursor active={active && isAgentDriving} leaseId={leaseId} />');
    expect(source).not.toContain("window.addEventListener('browser-agent-status'");
    expect(source).not.toContain("desktop_browser_cdp_start");
  });
});

describe('DesktopBrowserPane native DevTools', () => {
  test('places Inspect Element between the address field and chat selector', () => {
    const addressEnd = source.indexOf('</form>');
    const devToolsButton = source.indexOf('data-browser-devtools-toggle="true"');
    const chatSelector = source.indexOf('<RiCursorLine');

    expect(addressEnd).toBeGreaterThan(-1);
    expect(devToolsButton).toBeGreaterThan(addressEnd);
    expect(chatSelector).toBeGreaterThan(devToolsButton);
  });

  test('tracks native lifecycle and exposes an accessible pressed state', () => {
    expect(source).toContain("webview.addEventListener('devtools-opened', onDevToolsOpened)");
    expect(source).toContain("webview.addEventListener('devtools-closed', onDevToolsClosed)");
    expect(source).toContain("webview.addEventListener('devtools-open-url', onDevToolsOpenUrl)");
    expect(source).toContain('aria-pressed={isDevToolsOpen}');
    expect(source).toContain("variant={isDevToolsOpen ? 'secondary' : 'ghost'}");
  });

  test('reserves a resizable bottom dock and synchronizes native bounds', () => {
    expect(source).toContain('getDevToolsDockBounds');
    expect(source).toContain('new ResizeObserver(syncBounds)');
    expect(source).toContain('role="separator"');
    expect(source).toContain("aria-label={t('contextPanel.browser.devtoolsResize')}");
    expect(source).toContain('onPointerDown={handleDevToolsDockResizeStart}');
    expect(source).toContain('height: isDevToolsOpen ? `calc(100% - ${devToolsDockHeight}px)`');
  });

  test('closes the dock for inactive tabs and preserves the chat annotation cursor', () => {
    expect(source).toContain('if (active || !isDevToolsOpen) return;');
    expect(source).toContain('void requestDevToolsOpen(false).catch(() => {});');
    expect(source).toContain("title={t('contextPanel.browser.selectForChat')}");
    expect(source).toContain('onClick={handleInspect}');
  });

  test('surfaces unavailable and agent-disconnect outcomes', () => {
    expect(source).toContain("toast.error(t('contextPanel.browser.devtoolsUnavailable'))");
    expect(source).toContain('!agentDisconnectToastShownRef.current');
    expect(source).toContain("toast.info(t('contextPanel.browser.devtoolsAgentDisconnected'))");
  });
});
