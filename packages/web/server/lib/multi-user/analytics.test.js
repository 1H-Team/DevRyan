import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';

import {
  ANALYTICS_ACTIONS,
  ANALYTICS_RANGE_MAX_DAYS,
  aggregateDailyAnalytics,
  aggregateRangeAnalytics,
  analyticsRowBeforeCursor,
  buildSafeFieldDeltas,
  extractHumanPrompt,
  decodeAnalyticsCursor,
  encodeAnalyticsCursor,
  sanitizeActivityForReviewer,
  stableAuditEventId,
  validateAnalyticsRange,
  validateInteractionEvent,
} from './analytics.js';

const assignment = {
  projectId: '22222222-2222-4222-8222-222222222222',
  projectName: 'Test',
  branchName: 'main',
  repositoryPath: '/repo',
};

describe('multi-user analytics', () => {
  it('extracts only non-synthetic prompt text and counts attachments', () => {
    const result = extractHumanPrompt({
      sessionId: 'ses_1',
      assignment,
      body: {
        messageID: 'msg_1',
        model: { providerID: 'openai', modelID: 'gpt-5' },
        agent: 'builder',
        variant: 'high',
        parts: [
          { type: 'text', text: 'Visible' },
          { type: 'text', text: 'internal', synthetic: true },
          { type: 'file', url: 'file:///secret.txt', content: 'never store this' },
          { type: 'agent', name: 'reviewer' },
        ],
      },
    });

    expect(result.metadata).toMatchObject({
      promptText: 'Visible',
      attachmentCount: 1,
      agent: 'builder',
      providerId: 'openai',
      modelId: 'gpt-5',
      branchName: 'main',
    });
    expect(JSON.stringify(result)).not.toContain('secret.txt');
    expect(result.eventId).toBe(stableAuditEventId('prompt.sent', 'msg_1'));
  });

  it('caps prompt text at 16 KiB without splitting unicode', () => {
    const source = '🙂'.repeat(5_000);
    const result = extractHumanPrompt({
      sessionId: 'ses_1',
      assignment,
      body: { messageID: 'msg_2', parts: [{ type: 'text', text: source }] },
    });
    expect(Buffer.byteLength(result.metadata.promptText, 'utf8')).toBeLessThanOrEqual(16 * 1024);
    expect(result.metadata.promptText.endsWith('🙂')).toBe(true);
    expect(result.metadata.promptOriginalLength).toBe(source.length);
    expect(result.metadata.promptTruncated).toBe(true);
  });

  it('does not create analytics for synthetic-only internal continuations', () => {
    expect(extractHumanPrompt({
      sessionId: 'ses_1',
      assignment,
      body: { messageID: 'msg_internal', parts: [{ type: 'text', text: 'continue', synthetic: true }] },
    })).toBeNull();
  });

  it('rejects copied content, caller-selected users, and escaping paths', () => {
    const options = {
      resolveAssignment: () => assignment,
      containsPath: (root, candidate) => candidate.startsWith(`${root}/`),
    };
    expect(validateInteractionEvent({
      id: crypto.randomUUID(), type: 'clipboard.copied', occurredAt: new Date().toISOString(),
      sourceSurface: 'editor', copyKind: 'text', characterCount: 4, text: 'nope', directory: '/repo',
    }, options).accepted).toBe(false);
    expect(validateInteractionEvent({
      id: crypto.randomUUID(), type: 'file.opened', occurredAt: new Date().toISOString(),
      sourceSurface: 'files', path: '../secret', directory: '/repo',
    }, options).accepted).toBe(false);
    expect(validateInteractionEvent({
      id: crypto.randomUUID(), type: 'file.opened', occurredAt: new Date().toISOString(),
      sourceSurface: 'files', path: 'src/index.ts', directory: '/repo', userId: crypto.randomUUID(),
    }, options).accepted).toBe(false);
  });

  it('records only safe field values in detailed deltas', () => {
    const changes = buildSafeFieldDeltas(
      { role: 'developer', enabled: false, apiToken: 'before', projectPath: '/private', arbitrary: { prompt: 'old' }, branches: ['main'] },
      { role: 'senior', enabled: true, apiToken: 'after', projectPath: '/other', arbitrary: { prompt: 'new', extra: true }, branches: ['main', 'release'] },
    );
    expect(changes).toContainEqual({ field: 'role', before: 'developer', after: 'senior' });
    expect(changes).toContainEqual({ field: 'enabled', before: false, after: true });
    expect(changes).toContainEqual({ field: 'apiToken', changed: true });
    expect(changes).toContainEqual({ field: 'projectPath', changed: true });
    expect(changes).toContainEqual({ field: 'branches', before: ['main'], after: ['main', 'release'] });
    expect(changes.find((change) => change.field === 'arbitrary')).toEqual({
      field: 'arbitrary', changed: true, changedKeys: ['extra', 'prompt'],
    });
    expect(JSON.stringify(changes)).not.toContain('/private');
    expect(changes.find((change) => change.field === 'apiToken')).not.toHaveProperty('before');
    expect(changes.find((change) => change.field === 'apiToken')).not.toHaveProperty('after');
  });

  it('splits at gaps over 30 minutes and gives single events a five-minute tail', () => {
    const rows = [
      ['2026-08-05T09:00:00.000Z', ANALYTICS_ACTIONS.promptSent],
      ['2026-08-05T09:30:00.000Z', ANALYTICS_ACTIONS.fileOpened],
      ['2026-08-05T10:00:01.000Z', ANALYTICS_ACTIONS.clipboardCopied],
    ].map(([created_at, action], index) => ({
      id: index + 1, created_at, action, actor_user_id: 'user-1', target_user_id: 'user-1', metadata: {},
    }));
    const result = aggregateDailyAnalytics({ rows, userId: 'user-1', date: '2026-08-05', timeZone: 'UTC' });
    expect(result.activitySessions).toHaveLength(2);
    expect(result.activitySessions[0].estimatedMinutes).toBe(35);
    expect(result.activitySessions[0].actionCount).toBe(2);
    expect(result.activitySessions[0].counts.prompts).toBe(1);
    expect(result.activitySessions[0].counts.filesOpened).toBe(1);
    expect(result.activitySessions[1].estimatedMinutes).toBe(5);
    expect(result.totals.estimatedActiveMinutes).toBe(40);
  });

  it.each([
    ['America/New_York', '2026-03-08', 23],
    ['UTC', '2026-08-05', 24],
    ['America/New_York', '2026-11-01', 25],
  ])('returns the real DST hour count for %s on %s', (timeZone, date, expected) => {
    const result = aggregateDailyAnalytics({ rows: [], userId: 'user-1', date, timeZone });
    expect(result.hours).toHaveLength(expected);
    expect(DateTime.fromISO(result.dayEnd).diff(DateTime.fromISO(result.dayStart), 'hours').hours).toBe(expected);
  });

  it('clips the five-minute tail at local midnight', () => {
    const result = aggregateDailyAnalytics({
      userId: 'user-1', date: '2026-08-05', timeZone: 'UTC',
      rows: [{
        id: 1, created_at: '2026-08-05T23:58:00.000Z', action: ANALYTICS_ACTIONS.promptSent,
        actor_user_id: 'user-1', target_user_id: 'user-1', metadata: {},
      }],
    });
    expect(result.activitySessions[0].estimatedMinutes).toBe(2);
    expect(result.activitySessions[0].end).toBe('2026-08-06T00:00:00.000Z');
  });

  it('removes detailed analytics and metadata from non-admin activity', () => {
    const visible = sanitizeActivityForReviewer([
      { id: 1, action: 'prompt.sent', metadata: { promptText: 'private' } },
      { id: 2, action: 'user.updated', metadata: { changes: [{ field: 'role' }] } },
    ], { isAdmin: false });
    expect(visible).toEqual([{ id: 2, action: 'user.updated', metadata: {} }]);
  });

  it('paginates newest-first rows with an opaque timestamp and id cursor', () => {
    const anchor = { id: 20, created_at: '2026-08-05T12:00:00.000Z' };
    const cursor = decodeAnalyticsCursor(encodeAnalyticsCursor(anchor));
    expect(cursor).toEqual({ createdAt: anchor.created_at, id: '20' });
    expect(analyticsRowBeforeCursor({ id: 19, created_at: anchor.created_at }, cursor)).toBe(true);
    expect(analyticsRowBeforeCursor({ id: 21, created_at: anchor.created_at }, cursor)).toBe(false);
    expect(analyticsRowBeforeCursor({ id: 99, created_at: '2026-08-05T11:59:59.000Z' }, cursor)).toBe(true);
  });
});

const promptRow = (id, created_at) => ({
  id, created_at, action: ANALYTICS_ACTIONS.promptSent,
  actor_user_id: 'user-1', target_user_id: 'user-1', success: true, metadata: {},
});

describe('multi-user range analytics', () => {
  it('validates dates, ordering, zone, and the span cap', () => {
    expect(validateAnalyticsRange('2026-08-01', '2026-08-05', 'UTC')?.days).toBe(5);
    expect(validateAnalyticsRange('2026-08-05', '2026-08-05', 'UTC')?.days).toBe(1);
    expect(validateAnalyticsRange('2026-08-05', '2026-08-01', 'UTC')).toBeNull();
    expect(validateAnalyticsRange('2026-8-5', '2026-08-06', 'UTC')).toBeNull();
    expect(validateAnalyticsRange('2026-08-01', '2026-08-05', 'Not/AZone')).toBeNull();
    expect(validateAnalyticsRange('2026-01-01', '2026-12-31', 'UTC')).toBeNull();
    expect(validateAnalyticsRange('2026-08-01', '2026-08-05', 'UTC', { maxDays: 3 })).toBeNull();
  });

  it('builds a per-day series and range totals that sum the days', () => {
    const rows = [
      promptRow(1, '2026-08-03T09:00:00.000Z'),
      promptRow(2, '2026-08-03T09:10:00.000Z'),
      promptRow(3, '2026-08-05T14:00:00.000Z'),
    ];
    const result = aggregateRangeAnalytics({
      rows, userId: 'user-1', start: '2026-08-03', end: '2026-08-05', timeZone: 'UTC',
    });
    expect(result.series.map((day) => day.date)).toEqual(['2026-08-03', '2026-08-04', '2026-08-05']);
    expect(result.series.map((day) => day.prompts)).toEqual([2, 0, 1]);
    expect(result.totals.prompts).toBe(3);
    expect(result.totals.estimatedActiveMinutes).toBe(
      result.series.reduce((sum, day) => sum + day.estimatedActiveMinutes, 0),
    );
    expect(result.days).toBe(3);
  });

  it('includes empty days as zero-filled series entries', () => {
    const result = aggregateRangeAnalytics({
      rows: [], userId: 'user-1', start: '2026-08-01', end: '2026-08-03', timeZone: 'UTC',
    });
    expect(result.series).toHaveLength(3);
    expect(result.series.every((day) => day.prompts === 0 && day.estimatedActiveMinutes === 0)).toBe(true);
    expect(result.totals).toEqual({
      estimatedActiveMinutes: 0, prompts: 0, filesOpened: 0, copies: 0, settingsChanges: 0,
    });
  });

  it('tags activity sessions with their day, newest first', () => {
    const rows = [
      promptRow(1, '2026-08-03T09:00:00.000Z'),
      promptRow(2, '2026-08-05T14:00:00.000Z'),
    ];
    const result = aggregateRangeAnalytics({
      rows, userId: 'user-1', start: '2026-08-03', end: '2026-08-05', timeZone: 'UTC',
    });
    expect(result.activitySessions.map((session) => session.date)).toEqual(['2026-08-05', '2026-08-03']);
  });

  it('rejects an over-cap span at the aggregate boundary', () => {
    expect(() => aggregateRangeAnalytics({
      rows: [], userId: 'user-1', start: '2026-01-01', end: '2026-12-31', timeZone: 'UTC',
    })).toThrowError(new RegExp(String(ANALYTICS_RANGE_MAX_DAYS)));
  });
});
