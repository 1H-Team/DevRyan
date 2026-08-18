import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  MAX_VISIBLE_COMPOSER_LINES,
  resolveComposerTextareaSize,
} from './composerTextareaSizing';

const chatInputSource = readFileSync(new URL('./ChatInput.tsx', import.meta.url), 'utf8');

describe('composer textarea sizing', () => {
  test('uses the measured content height below the visible-line cap', () => {
    expect(resolveComposerTextareaSize({
      scrollHeight: 76,
      offsetHeight: 54,
      lineHeight: 22,
      paddingTop: 8,
      paddingBottom: 8,
    })).toEqual({
      height: 76,
      maxHeight: 22 * MAX_VISIBLE_COMPOSER_LINES + 16,
    });
  });

  test('caps a heavily wrapped draft and can shrink it after the width expands', () => {
    const narrow = resolveComposerTextareaSize({
      scrollHeight: 420,
      offsetHeight: 54,
      lineHeight: 22,
      paddingTop: 8,
      paddingBottom: 8,
    });
    const wide = resolveComposerTextareaSize({
      scrollHeight: 76,
      offsetHeight: narrow.height,
      lineHeight: 22,
      paddingTop: 8,
      paddingBottom: 8,
    });

    expect(narrow).toEqual({ height: 192, maxHeight: 192 });
    expect(wide).toEqual({ height: 76, maxHeight: 192 });
  });

  test('falls back to stable typography metrics when computed styles are unavailable', () => {
    expect(resolveComposerTextareaSize({
      scrollHeight: 0,
      offsetHeight: 54,
      lineHeight: Number.NaN,
      paddingTop: Number.NaN,
      paddingBottom: Number.NaN,
    })).toEqual({ height: 54, maxHeight: 192 });
  });

  test('remeasures panel and window width changes once per frame and cleans up observers', () => {
    expect(chatInputSource).toContain("typeof ResizeObserver === 'undefined'");
    expect(chatInputSource).toContain('observer.observe(composer)');
    expect(chatInputSource).toContain('resizeFrame = requestAnimationFrame(() => {');
    expect(chatInputSource).toContain('adjustTextareaHeight({ allowShrink: true });');
    expect(chatInputSource).toContain('observer.disconnect()');
    expect(chatInputSource).toContain('cancelAnimationFrame(resizeFrame)');
  });

  test('restores textarea height in layout before revealing it after Question Card takeover', () => {
    expect(chatInputSource).toContain('const hadPending = hadPendingQuestionsRef.current;');
    expect(chatInputSource).toContain('if (!hadPending || hasPendingQuestions)');
    expect(chatInputSource).toContain('Restore its intrinsic height before paint');
  });
});
