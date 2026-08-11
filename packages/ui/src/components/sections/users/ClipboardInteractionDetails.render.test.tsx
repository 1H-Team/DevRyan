import * as React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ClipboardInteractionDetails } from './UserAnalytics';
import type { UserAnalyticsEvent } from './types';

const clipboardEvent: UserAnalyticsEvent = {
  id: 77,
  event_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  action: 'clipboard.copied',
  actor_role: 'developer',
  target_type: 'user',
  target_id: 'user-1',
  success: true,
  created_at: '2026-08-10T10:15:00.000Z',
  actor_user_id: 'user-1',
  target_user_id: 'user-1',
  project_id: 'project-1',
  session_id: null,
  actor: null,
  metadata: {
    sourceSurface: 'settings',
    copyKind: 'text',
    characterCount: 80_000,
  },
  clipboard: {
    available: true,
    preview: 'Visible copied preview',
    originalLength: 80_000,
    truncated: true,
    redacted: true,
  },
};

describe('ClipboardInteractionDetails rendering', () => {
  test('shows the bounded preview and keeps the full body behind a disclosure', () => {
    const markup = renderToStaticMarkup(
      <ClipboardInteractionDetails event={clipboardEvent} userId="user-1" />,
    );

    expect(markup).toContain('Visible copied preview');
    expect(markup).toContain('Show full copied text');
    expect(markup).toContain('<details');
    expect(markup).not.toContain('Loading copied text');
    expect(markup).not.toContain('<pre');
  });

  test('explains historical rows whose text was not captured', () => {
    const markup = renderToStaticMarkup(
      <ClipboardInteractionDetails
        event={{ ...clipboardEvent, clipboard: { ...clipboardEvent.clipboard!, available: false, preview: '' } }}
        userId="user-1"
      />,
    );

    expect(markup).toContain('Text was not captured');
    expect(markup).not.toContain('<details');
  });
});
