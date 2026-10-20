import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SessionStatusDot } from './SessionStatusDot';
import { SESSION_WORKING_BLINK_DURATION_MS, resolveWorkingBlinkCurrentTimeMs } from './sessionWorkingBlink';

const renderWorkingAt = (nowMs: number): string => {
  const originalDateNow = Date.now;
  Date.now = () => nowMs;

  try {
    return renderToStaticMarkup(
      <SessionStatusDot
        presentation={{ kind: 'working', labelKey: 'sessions.sidebar.session.status.active' }}
        label="Session active"
      />,
    );
  } finally {
    Date.now = originalDateNow;
  }
};

const readAnimationDelayMs = (markup: string): number => {
  const match = markup.match(/animation-delay:([^;"]+)ms/);
  if (!match) {
    throw new Error('Expected the working dot markup to include an animation delay');
  }
  return Number(match[1]);
};

const resolvePhaseAt = (
  animationDelayMs: number,
  mountedAtMs: number,
  observedAtMs: number,
): number => (
  (-animationDelayMs + observedAtMs - mountedAtMs) % SESSION_WORKING_BLINK_DURATION_MS
);

describe('SessionStatusDot', () => {
  test('renders working as a labelled slow-blink gray dot', () => {
    const markup = renderWorkingAt(1000);

    expect(markup).toContain('animate-session-working-blink');
    expect(markup).toContain('bg-muted-foreground');
    expect(markup).toContain('aria-label="Session active"');
    expect(markup).toContain('title="Session active"');
    expect(markup).not.toContain('<svg');
  });

  test('keeps delayed mounts on the same absolute blink phase', () => {
    const parentMountedAtMs = 1000;
    const childMountedAtMs = 6500;
    const parentDelayMs = readAnimationDelayMs(renderWorkingAt(parentMountedAtMs));
    const childDelayMs = readAnimationDelayMs(renderWorkingAt(childMountedAtMs));

    expect(parentDelayMs).toBe(-1000);
    expect(childDelayMs).toBe(-(childMountedAtMs % SESSION_WORKING_BLINK_DURATION_MS));
    expect(resolvePhaseAt(parentDelayMs, parentMountedAtMs, childMountedAtMs)).toBe(
      resolvePhaseAt(childDelayMs, childMountedAtMs, childMountedAtMs),
    );
  });

  test('realigns restarted blinks to the wall-clock phase whatever their mount delay', () => {
    const parentDelayMs = readAnimationDelayMs(renderWorkingAt(1000));
    const childDelayMs = readAnimationDelayMs(renderWorkingAt(6500));
    const restartedAtMs = 9_100;
    const activeTimeAt = (delayMs: number): number => (
      resolveWorkingBlinkCurrentTimeMs(restartedAtMs, delayMs) - delayMs
    ) % SESSION_WORKING_BLINK_DURATION_MS;

    expect(activeTimeAt(parentDelayMs)).toBe(restartedAtMs % SESSION_WORKING_BLINK_DURATION_MS);
    expect(activeTimeAt(childDelayMs)).toBe(restartedAtMs % SESSION_WORKING_BLINK_DURATION_MS);
  });

  test('keeps the realigned current time non-negative', () => {
    expect(resolveWorkingBlinkCurrentTimeMs(100, -2_000)).toBe(500);
    expect(resolveWorkingBlinkCurrentTimeMs(0, 0)).toBe(0);
  });

  test('renders attention states with their status color and label', () => {
    const markup = renderToStaticMarkup(
      <SessionStatusDot
        presentation={{
          kind: 'status',
          indicator: {
            className: 'bg-status-warning',
            labelKey: 'sessions.sidebar.session.status.planReady',
          },
        }}
        label="Plan ready for review"
      />,
    );

    expect(markup).toContain('bg-status-warning');
    expect(markup).toContain('aria-label="Plan ready for review"');
    expect(markup).not.toContain('animate-session-working-blink');
  });

  test('renders idle as a decorative hollow placeholder ring', () => {
    const markup = renderToStaticMarkup(<SessionStatusDot presentation={{ kind: 'idle' }} />);

    expect(markup).toContain('border border-muted-foreground/60');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('aria-label');
    expect(markup).not.toContain('animate-session-working-blink');
  });
});
