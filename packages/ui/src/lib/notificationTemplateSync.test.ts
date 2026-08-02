import { describe, expect, test } from 'bun:test';

import { resolveNotificationTemplatesFromSettingsSnapshot } from './notificationTemplateSync';

describe('notification template settings synchronization', () => {
  test('applies the response when templates have not changed since the request started', () => {
    const baseline = { completion: { title: 'Before', message: '' } };
    const incoming = { completion: { title: 'Saved', message: '' } };

    expect(resolveNotificationTemplatesFromSettingsSnapshot({
      baseline,
      current: baseline,
      incoming,
    })).toBe(incoming);
  });

  test('keeps newer local templates when an older response arrives', () => {
    const baseline = { completion: { title: 'Before', message: '' } };
    const current = { completion: { title: 'Typed later', message: '' } };
    const incoming = { completion: { title: 'Before', message: '' } };

    expect(resolveNotificationTemplatesFromSettingsSnapshot({
      baseline,
      current,
      incoming,
    })).toBe(current);
  });
});
