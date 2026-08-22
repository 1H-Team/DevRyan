import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const panel = read('./BrowserPanel.tsx');
const contextPanel = read('./ContextPanel.tsx');
const layout = read('./MainLayout.tsx');
const store = read('../../stores/useUIStore.ts');

describe('dedicated Browser panel', () => {
  test('mounts after ContextPanel as its own in-flow sibling', () => {
    expect(layout.indexOf('<ContextPanel />')).toBeLessThan(layout.indexOf('<BrowserPanel />'));
    expect(contextPanel).not.toContain('<ManualBrowserWorkspacePane');
    expect(contextPanel).not.toContain('BrowserLeasePane');
  });

  test('owns width, resize, fullscreen, and lease presentation', () => {
    expect(panel).toContain('--oc-browser-panel-width');
    expect(panel).toContain('data-panel-resize-handle="browser-panel"');
    expect(panel).toContain('toggleBrowserPanelExpanded');
    expect(panel).toContain('{leaseTabs.map((tab) => (');
    expect(panel).toContain('showTabStrip={false}');
    expect(panel).toContain('const surfacesActive = isOpen && !contextPanelExpanded;');
    expect(panel).toContain('closeManualBrowserStripTab(directoryKey, tabId)');
    expect(panel).toContain('closeBrowserLeaseStripTab(directoryKey, leaseId)');
    expect(panel).toContain('workspace || leaseTabs.length > 0');
    expect(panel).toContain('resolveBrowserPanelWidth');
    expect(panel).toContain("window.addEventListener('pointermove', handleMove, true)");
    expect(panel).toContain('onLostPointerCapture');
  });

  test('persists panel state and carries the collision-safe v17 migration', () => {
    expect(store).toContain('browserPanelByDirectory: state.browserPanelByDirectory');
    expect(store).toContain('version: 19,');
    expect(store).toContain('// v16 -> v17: Browser becomes a dedicated sibling panel.');
    expect(store).toContain("return tab.mode === 'browser'");
  });
});
