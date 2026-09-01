import { describe, expect, test } from 'bun:test';

import {
  EMPTY_NOTIFICATION_TEMPLATES,
  normalizeNotificationTemplates,
} from './notificationTemplates';

describe('notification template normalization', () => {
  test('returns an already complete record without changing its identity', () => {
    const complete = {
      ...EMPTY_NOTIFICATION_TEMPLATES,
      completion: { title: 'Custom', message: 'Done' },
    };

    expect(normalizeNotificationTemplates(complete)).toBe(complete);
  });

  test('fills missing and malformed entries while preserving valid identities', () => {
    const completion = { title: 'Custom', message: 'Done' };
    const normalized = normalizeNotificationTemplates({
      completion,
      planReady: { title: 42, message: 'invalid' },
    });

    expect(normalized.completion).toBe(completion);
    expect(normalized.planReady).toBe(EMPTY_NOTIFICATION_TEMPLATES.planReady);
    expect(normalized.permission).toBe(EMPTY_NOTIFICATION_TEMPLATES.permission);
  });
});
