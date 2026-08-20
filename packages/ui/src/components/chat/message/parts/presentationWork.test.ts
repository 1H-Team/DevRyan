import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import {
  formatRetryCountdown,
  getRetryCountdownBoundaryDelayMs,
  getRetryCountdownSeconds,
} from './workingPlaceholderTiming';

describe('mounted presentation work', () => {
  test('the plan skeleton owns one container animation and no line animations', () => {
    const styles = readFileSync(new URL('../../../../index.css', import.meta.url), 'utf8');
    const skeleton = readFileSync(new URL('./PlanCardSkeleton.tsx', import.meta.url), 'utf8');
    const containerRule = styles.slice(
      styles.indexOf('.oc-plan-skeleton-lines[data-animation-state="running"]'),
      styles.indexOf('.oc-plan-skeleton-line {'),
    );
    const lineRule = styles.slice(
      styles.indexOf('.oc-plan-skeleton-line {'),
      styles.indexOf('.oc-plan-skeleton-line:nth-child'),
    );

    expect(containerRule.match(/animation:/g)?.length).toBe(1);
    expect(lineRule).not.toContain('animation:');
    expect(skeleton).toContain("data-animation-state={shouldAnimate ? 'running' : 'paused'}");
  });

  test('retry countdown aligns to the next second boundary and stops at zero', () => {
    expect(getRetryCountdownSeconds(2_500, 0)).toBe(3);
    expect(getRetryCountdownBoundaryDelayMs(2_500, 0)).toBe(500);
    expect(getRetryCountdownSeconds(2_500, 500)).toBe(2);
    expect(getRetryCountdownBoundaryDelayMs(2_500, 500)).toBe(1_000);
    expect(getRetryCountdownSeconds(2_500, 2_500)).toBe(0);
    expect(getRetryCountdownBoundaryDelayMs(2_500, 2_500)).toBeNull();
    expect(formatRetryCountdown(61)).toBe('1m 1s');
  });

  test('visibility-gates shimmers, countdowns, and duration tickers', () => {
    const placeholder = readFileSync(new URL('./WorkingPlaceholder.tsx', import.meta.url), 'utf8');
    const ticker = readFileSync(new URL('./useDurationTicker.ts', import.meta.url), 'utf8');

    expect(placeholder.match(/data-animation-state=/g)?.length).toBe(1);
    expect(placeholder.match(/<StatusShimmerText/g)?.length).toBe(2);
    expect(placeholder).toContain('if (!isVisible || seconds === 0) return;');
    expect(placeholder).not.toContain('AnimatePresence');
    expect(ticker).toContain('if (!active || !isVisible)');
  });
});
