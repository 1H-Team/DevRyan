import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

const contextPanel = read('./ContextPanel.tsx');
const mainLayout = read('./MainLayout.tsx');
const header = read('./Header.tsx');
const filesView = read('../views/FilesView.tsx');
const uiStore = read('../../stores/useUIStore.ts');
const routerTypes = read('../../lib/router/types.ts');
const menuActions = read('../../hooks/useMenuActions.ts');
const tabsStore = read('../../stores/useFilesViewTabsStore.ts');

describe('context panel tabs', () => {
  test('renders the soft-pill tab strip', () => {
    expect(contextPanel).toContain('variant="soft-pill"');
    expect(contextPanel).not.toContain('variant="default"');
  });

  test('drops the underline spacer border from the header', () => {
    expect(contextPanel).toContain('<header className="flex h-8 items-stretch pl-1.5">');
  });

  test('still owns the file editor mount', () => {
    expect(contextPanel).toContain('<LazyFilesView />');
  });
});

describe('removed files main tab', () => {
  test('is gone from the MainTab union and the URL router', () => {
    expect(uiStore).toContain("export type MainTab = 'chat' | 'plan' | 'git' | 'diff' | 'terminal';");
    expect(routerTypes).toContain("export const VALID_TABS: readonly MainTab[] = ['chat', 'git', 'diff', 'terminal'] as const;");
  });

  test('migrates a stale persisted value so it cannot render a blank view', () => {
    expect(uiStore).toContain('version: 19,');
    expect(uiStore).toContain("if (state.activeMainTab === 'files') {");
  });

  test('keeps Browser out of the shared context-panel tab model', () => {
    expect(uiStore).toContain("export type ContextPanelMode = 'diff' | 'file' | 'context' | 'plan' | 'chat' | 'preview';");
    expect(contextPanel).not.toContain("mode === 'browser'");
    expect(contextPanel).not.toContain('<ManualBrowserWorkspacePane');
  });

  test('has no route or reset-effect entry left', () => {
    expect(mainLayout).not.toContain('LazyFilesView');
    expect(header).not.toContain("activeMainTab === 'files'");
    expect(menuActions).not.toContain("activeMainTab === 'files'");
  });

  test('repoints the desktop Files menu item at the right-sidebar tree', () => {
    // main.rs still ships a View -> Files item that dispatches 'open-files-tab';
    // it must reveal the sidebar tree, not restore the removed main tab.
    expect(menuActions).toContain("case 'open-files-tab':");
    expect(menuActions).toContain("setRightSidebarTab('files')");
  });

  test('leaves FilesView as a single-mode editor with no orphaned tab strip', () => {
    expect(filesView).not.toContain('FilesViewProps');
    expect(filesView).not.toContain("mode === 'editor-only'");
    expect(filesView).not.toContain('SortableTabsStrip');
    expect(filesView).not.toContain('fullscreenViewer');
    expect(filesView).not.toContain('isFullscreen');
    expect(tabsStore).not.toContain('reorderOpenPaths');
  });

  test('keeps the mobile tree and filename dropdown reachable', () => {
    expect(filesView).toContain('const showEditorTabsRow = isMobile;');
    expect(filesView).toContain('treePanel');
    expect(filesView).toContain("aria-label={t('filesView.editor.openFilesAria')}");
  });
});
