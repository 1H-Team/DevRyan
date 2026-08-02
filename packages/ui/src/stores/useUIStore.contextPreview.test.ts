import { beforeEach, describe, expect, test } from 'bun:test';

import { useUIStore } from './useUIStore';

const DIRECTORY = '/repo/Test';

describe('useUIStore context preview navigation', () => {
  beforeEach(() => {
    useUIStore.setState({ contextPanelByDirectory: {} });
  });

  test('keeps bridge navigation as display state on the existing target tab', () => {
    useUIStore.getState().openContextPreview(DIRECTORY, 'http://127.0.0.1:3000/');
    const before = useUIStore.getState().contextPanelByDirectory[DIRECTORY];
    const tab = before?.tabs[0];
    expect(tab).toBeTruthy();

    useUIStore.getState().setContextPreviewDisplayUrl(
      DIRECTORY,
      tab?.id ?? '',
      'http://127.0.0.1:3000/docs',
    );

    const after = useUIStore.getState().contextPanelByDirectory[DIRECTORY];
    const updated = after?.tabs[0];
    expect(after?.tabs).toHaveLength(1);
    expect(updated?.id).toBe(tab?.id);
    expect(updated?.targetPath).toBe('http://127.0.0.1:3000/');
    expect(updated?.dedupeKey).toBe('http://127.0.0.1:3000/');
    expect(updated?.displayUrl).toBe('http://127.0.0.1:3000/docs');
  });

  test('returns the original store references for duplicate display reports', () => {
    useUIStore.getState().openContextPreview(DIRECTORY, 'http://127.0.0.1:3000/');
    const tab = useUIStore.getState().contextPanelByDirectory[DIRECTORY]?.tabs[0];
    useUIStore.getState().setContextPreviewDisplayUrl(DIRECTORY, tab?.id ?? '', 'http://127.0.0.1:3000/docs');

    const beforeStore = useUIStore.getState().contextPanelByDirectory;
    const beforePanel = beforeStore[DIRECTORY];
    useUIStore.getState().setContextPreviewDisplayUrl(DIRECTORY, tab?.id ?? '', 'http://127.0.0.1:3000/docs');

    expect(useUIStore.getState().contextPanelByDirectory).toBe(beforeStore);
    expect(useUIStore.getState().contextPanelByDirectory[DIRECTORY]).toBe(beforePanel);
  });

  test('keeps an explicit different target as a separate registered tab', () => {
    useUIStore.getState().openContextPreview(DIRECTORY, 'http://127.0.0.1:3000/');
    useUIStore.getState().openContextPreview(DIRECTORY, 'http://127.0.0.1:4000/');

    const panel = useUIStore.getState().contextPanelByDirectory[DIRECTORY];
    expect(panel?.tabs.map((tab) => tab.targetPath)).toEqual([
      'http://127.0.0.1:3000/',
      'http://127.0.0.1:4000/',
    ]);
    expect(panel?.activeTabId).toBe('preview:http://127.0.0.1:4000/');
  });

  test('opens and reuses one blank browser tab', () => {
    useUIStore.getState().openContextPreview(DIRECTORY, 'about:blank');
    useUIStore.getState().openContextPreview(DIRECTORY, 'about:blank');

    const panel = useUIStore.getState().contextPanelByDirectory[DIRECTORY];
    expect(panel?.isOpen).toBe(true);
    expect(panel?.tabs).toHaveLength(1);
    expect(panel?.tabs[0]?.targetPath).toBe('about:blank');
    expect(panel?.activeTabId).toBe('preview:about:blank');
  });
});
