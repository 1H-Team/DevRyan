import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { resolveDocumentAnimationState } from './useDocumentAnimationState';

describe('document animation state', () => {
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
