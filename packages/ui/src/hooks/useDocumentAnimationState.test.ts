import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { resolveDocumentAnimationState } from './useDocumentAnimationState';

describe('document animation state', () => {
  test('the desktop shell reports a hidden window the page cannot see for itself', () => {
    const source = readFileSync(new URL('./useDocumentAnimationState.ts', import.meta.url), 'utf8');
    // One listener for the life of the page, so a report is never missed.
    expect(source.match(/addEventListener\(WINDOW_VISIBILITY_EVENT/g)?.length).toBe(1);
    expect(source).toContain("export const WINDOW_VISIBILITY_EVENT = 'openchamber:window-visibility'");
    expect(source).toContain('const isVisible = !windowHidden && ');
    expect(source).toContain('document.documentElement.toggleAttribute(WINDOW_HIDDEN_ATTRIBUTE, windowHidden)');
    const shell = readFileSync(new URL('../../../electron/main.mjs', import.meta.url), 'utf8');
    expect(shell).toContain("emitToWindow(browserWindow, 'openchamber:window-visibility', {");
    expect(shell).toContain("for (const event of ['show', 'hide', 'minimize', 'restore']) browserWindow.on(event, emitWindowVisibility);");
    const styles = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
    expect(styles).toContain('html[data-window-hidden] *::after');
    expect(styles).toContain('animation-play-state: paused !important;');
  });


  test('runs presentation work only while visible and motion is allowed', () => {
    expect(resolveDocumentAnimationState(true, false)).toEqual({
      isVisible: true,
      prefersReducedMotion: false,
      shouldAnimate: true,
    });
    expect(resolveDocumentAnimationState(false, false).shouldAnimate).toBe(false);
    expect(resolveDocumentAnimationState(true, true).shouldAnimate).toBe(false);
    expect(resolveDocumentAnimationState(false, true).shouldAnimate).toBe(false);
  });

  test('shares one visibility and one reduced-motion listener at module scope', () => {
    const source = readFileSync(new URL('./useDocumentAnimationState.ts', import.meta.url), 'utf8');
    expect(source.match(/addEventListener\('visibilitychange'/g)?.length).toBe(1);
    expect(source.match(/addEventListener\('change'/g)?.length).toBe(1);
    expect(source).toContain('listeners.size === 1');
    expect(source).toContain('listeners.size === 0');
  });
});
