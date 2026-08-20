import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./useNativeSurfaceRectSync.ts', import.meta.url), 'utf8');
const browserPane = readFileSync(new URL('./DesktopBrowserPane.tsx', import.meta.url), 'utf8');

describe('native browser surface rect synchronization', () => {
  test('diff-gates rounded rectangles and retains resize observation', () => {
    expect(source).toContain('const sameRect =');
    expect(source).toContain('readRoundedRect(element)');
    expect(source).toContain('if (sameRect(lastRectRef.current, next)) return;');
    expect(source).toContain('new ResizeObserver(scheduleMeasure)');
    expect(source).toContain("window.addEventListener('resize', scheduleMeasure)");
    expect(source).toContain('if (queuedMeasureFrame) return;');
  });

  test('tracks width transitions and imperative panel drags with a bounded rAF loop', () => {
    expect(source).toContain("document.addEventListener('transitionrun'");
    expect(source).toContain("event.propertyName === 'width'");
    expect(source).toContain("target.closest('[data-panel-resize-handle]')");
    expect(source).toContain('ACTIVITY_HARD_STOP_MS = 1_000');
    expect(source).toContain('window.requestAnimationFrame(runActivityFrame)');
  });

  test('keeps a visible safety poll and is used by ElectronBrowserPane', () => {
    expect(source).toContain('POLL_INTERVAL_MS = 250');
    expect(source).toContain('document.visibilityState');
    expect(browserPane).toContain('useNativeSurfaceRectSync(contentRef, syncLayout);');
  });
});
