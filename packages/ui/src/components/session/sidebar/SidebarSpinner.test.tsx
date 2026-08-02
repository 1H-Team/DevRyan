import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SidebarSpinner } from './SidebarSpinner';

const SPIN_DURATION_MS = 4000;

const renderSpinnerAt = (nowMs: number): string => {
  const originalDateNow = Date.now;
  Date.now = () => nowMs;

  try {
    return renderToStaticMarkup(<SidebarSpinner aria-label="Working" />);
  } finally {
    Date.now = originalDateNow;
  }
};

const readAnimationDelayMs = (markup: string): number => {
  const match = markup.match(/animation-delay:([^;"]+)ms/);
  if (!match) {
    throw new Error('Expected the spinner markup to include an animation delay');
  }
  return Number(match[1]);
};

const resolvePhaseAt = (
  animationDelayMs: number,
  mountedAtMs: number,
  observedAtMs: number,
): number => (
  (-animationDelayMs + observedAtMs - mountedAtMs) % SPIN_DURATION_MS
);

describe('SidebarSpinner', () => {
  test('keeps delayed mounts on the same absolute animation phase', () => {
    const parentMountedAtMs = 1000;
    const childMountedAtMs = 6500;
    const parentDelayMs = readAnimationDelayMs(renderSpinnerAt(parentMountedAtMs));
    const childDelayMs = readAnimationDelayMs(renderSpinnerAt(childMountedAtMs));

    expect(parentDelayMs).toBe(-1000);
    expect(childDelayMs).toBe(-2500);
    expect(resolvePhaseAt(parentDelayMs, parentMountedAtMs, childMountedAtMs)).toBe(
      resolvePhaseAt(childDelayMs, childMountedAtMs, childMountedAtMs),
    );
  });
});
