import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SessionStatusDot } from './SessionStatusDot';

const renderWorking = (): string => renderToStaticMarkup(
  <SessionStatusDot
    presentation={{ kind: 'working', labelKey: 'sessions.sidebar.session.status.active' }}
    label="Session active"
  />,
);

describe('SessionStatusDot', () => {
  test('renders working as a labelled gray dot on the shared blink tick', () => {
    const markup = renderWorking();

    expect(markup).toContain('oc-tick-blink');
    expect(markup).toContain('bg-muted-foreground');
    expect(markup).toContain('aria-label="Session active"');
    expect(markup).toContain('title="Session active"');
    expect(markup).not.toContain('<svg');
  });

  test('owns no per-dot CSS animation or mount-time phase', () => {
    // Every dot reads one document attribute, so rows that mount later or
    // re-enter rendering after the hover swap blink in unison by construction.
    const markup = renderWorking();

    expect(markup).not.toContain('animate-');
    expect(markup).not.toContain('animation');
    expect(markup).not.toContain('style=');
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
