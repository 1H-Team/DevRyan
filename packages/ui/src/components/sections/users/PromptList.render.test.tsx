import * as React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { PromptList } from './UserAnalytics';
import {
  groupPromptEventsBySession,
  nextSelectedAnalyticsDate,
  resolveAnalyticsDetailRange,
} from './userAnalyticsState';
import type { UserAnalyticsEvent } from './types';

const event: UserAnalyticsEvent = {
  id: 42,
  action: 'prompt.sent',
  actor_role: 'developer',
  target_type: null,
  target_id: null,
  success: true,
  created_at: '2026-08-07T10:15:00.000Z',
  actor_user_id: 'user-1',
  target_user_id: null,
  project_id: 'project-1',
  session_id: 'session-1',
  actor: null,
  metadata: {
    promptText: 'Improve prompt rows\nShow a useful preview beneath the title.\nKeep every metadata field visible.',
    agent: 'builder',
    providerId: 'openai',
    modelId: 'gpt-5',
    variant: 'high',
    projectName: 'DevRyan',
    branchName: 'feature/prompt-rows',
    attachmentCount: 1,
    promptTruncated: true,
    promptOriginalLength: 20_000,
  },
};

const renderPromptList = (events: UserAnalyticsEvent[] = [event]): string => renderToStaticMarkup(
  <PromptList
    events={events}
    timeZone="UTC"
    nextCursor={null}
    loadingMore={false}
    onLoadMore={() => undefined}
  />,
);

describe('PromptList rendering', () => {
  test('groups prompts under an initially collapsed session summary', () => {
    const markup = renderPromptList();

    expect(markup).toContain('Session session-1');
    expect(markup).toContain('1 prompt shown');
    expect(markup).not.toContain('<details open');
    expect(markup).toContain('Improve prompt rows');
    expect(markup).toContain('Show a useful preview beneath the title. Keep every metadata field visible.');
    expect(markup).toContain('Builder');
    expect(markup).toContain('openai/gpt-5');
    expect(markup).toContain('High');
    expect(markup).toContain('DevRyan / feature/prompt-rows');
    expect(markup).toContain('1 attachment');
    expect(markup).toContain('10:15:00');
    expect(markup).toContain('flex shrink-0 flex-col items-end');
  });

  test('renders the complete stored prompt with UI typography and no internal height clamp', () => {
    const markup = renderPromptList();

    expect(markup).toContain('whitespace-pre-wrap break-words font-sans typography-ui-label');
    expect(markup).toContain('Truncated at 16 KiB; original length 20,000 characters.');
    expect(markup).not.toContain('<pre');
    expect(markup).not.toContain('typography-code');
    expect(markup).not.toContain('max-h-96');
  });

  test('renders attachment-only rows without a redundant preview', () => {
    const attachmentOnly = {
      ...event,
      id: 43,
      metadata: { ...event.metadata, promptText: '', attachmentCount: 2, promptTruncated: false },
    };
    const markup = renderPromptList([attachmentOnly]);

    expect(markup).toContain('(Attachment-only prompt)');
    expect(markup).toContain('2 attachments');
    expect(markup).toContain('(No text parts)');
  });

  test('orders session groups by newest prompt and merges prompts from the same session', () => {
    const events: UserAnalyticsEvent[] = [
      { ...event, id: 43, session_id: 'session-2', created_at: '2026-08-08T12:00:00.000Z' },
      { ...event, id: 44, session_id: 'session-1', created_at: '2026-08-07T12:00:00.000Z' },
      { ...event, id: 45, session_id: 'session-2', created_at: '2026-08-06T12:00:00.000Z' },
      { ...event, id: 46, session_id: null, created_at: '2026-08-05T12:00:00.000Z' },
    ];

    const groups = groupPromptEventsBySession(events);

    expect(groups.map((group) => group.sessionId)).toEqual(['session-2', 'session-1', null]);
    expect(groups[0].events.map((prompt) => prompt.id)).toEqual([43, 45]);
    expect(renderPromptList(events)).toContain('Unattributed prompts');
  });

  test('uses one selected day for detail requests and toggles it deterministically', () => {
    const range = { start: '2026-08-01', end: '2026-08-14' };
    expect(resolveAnalyticsDetailRange(range, '2026-08-07')).toEqual({ start: '2026-08-07', end: '2026-08-07' });
    expect(resolveAnalyticsDetailRange(range, null)).toEqual(range);
    expect(nextSelectedAnalyticsDate(null, '2026-08-07')).toBe('2026-08-07');
    expect(nextSelectedAnalyticsDate('2026-08-07', '2026-08-08')).toBe('2026-08-08');
    expect(nextSelectedAnalyticsDate('2026-08-08', '2026-08-08')).toBeNull();
  });
});
