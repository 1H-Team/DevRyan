import { describe, expect, test } from 'bun:test';

import { useUIStore } from './useUIStore';

const mergeRestored = (persisted: unknown) => {
  const merge = useUIStore.persist.getOptions().merge;
  expect(typeof merge).toBe('function');
  if (!merge) {
    throw new Error('ui-store persist options define no merge');
  }
  return merge(persisted, useUIStore.getState());
};

describe('useUIStore file editor line wrapping', () => {
  test('defaults to wrapping and stays separate from diff wrapping', () => {
    const state = useUIStore.getState();

    expect(state.fileEditorWrapLines).toBe(true);
    expect(state.diffWrapLines).toBe(false);
  });

  test('includes the editor wrap preference in persisted UI preferences', () => {
    const partialize = useUIStore.persist.getOptions().partialize;
    expect(partialize).toBeTruthy();

    const persisted = partialize?.(useUIStore.getState()) as Record<string, unknown>;
    expect(persisted.fileEditorWrapLines).toBe(true);
    expect(persisted.diffWrapLines).toBe(false);
  });

  test('persists the toggled value through the public store action', () => {
    const original = useUIStore.getState().fileEditorWrapLines;
    try {
      useUIStore.getState().setFileEditorWrapLines(false);
      expect(useUIStore.getState().fileEditorWrapLines).toBe(false);
      expect(useUIStore.getState().diffWrapLines).toBe(false);

      const partialize = useUIStore.persist.getOptions().partialize;
      const persisted = partialize?.(useUIStore.getState()) as Record<string, unknown>;
      expect(persisted.fileEditorWrapLines).toBe(false);
    } finally {
      useUIStore.getState().setFileEditorWrapLines(original);
    }
  });

  test('restores a missing value as wrapping', () => {
    const original = useUIStore.getState().fileEditorWrapLines;
    try {
      // Rehydration after a principal switch may merge into a store that had wrapping off.
      useUIStore.getState().setFileEditorWrapLines(false);
      expect(mergeRestored({ diffWrapLines: true }).fileEditorWrapLines).toBe(true);
    } finally {
      useUIStore.getState().setFileEditorWrapLines(original);
    }
  });

  test('restores malformed values as wrapping', () => {
    for (const malformed of ['false', 0, 1, null, {}, [], 'true']) {
      expect(mergeRestored({ fileEditorWrapLines: malformed }).fileEditorWrapLines).toBe(true);
    }
  });

  test('restores a saved false as not wrapping', () => {
    expect(mergeRestored({ fileEditorWrapLines: false }).fileEditorWrapLines).toBe(false);
    expect(mergeRestored({ fileEditorWrapLines: true }).fileEditorWrapLines).toBe(true);
  });

  test('keeps the shallow merge for other fields', () => {
    const current = useUIStore.getState();
    const restored = mergeRestored({
      diffWrapLines: true,
      diffViewMode: 'single',
      fileEditorWrapLines: false,
    });

    expect(restored.diffWrapLines).toBe(true);
    expect(restored.diffViewMode).toBe('single');
    expect(restored.fileEditorWrapLines).toBe(false);
    expect(restored.theme).toBe(current.theme);
    expect(restored.notificationTemplates).toBe(current.notificationTemplates);
    expect(restored.setFileEditorWrapLines).toBe(current.setFileEditorWrapLines);
    expect(restored.setDiffWrapLines).toBe(current.setDiffWrapLines);
  });

  test('ignores a restored snapshot that is not a plain object', () => {
    const current = useUIStore.getState();
    for (const invalid of [undefined, null, 'ui-store', 7, ['fileEditorWrapLines']]) {
      expect(mergeRestored(invalid)).toBe(current);
    }
  });
});
