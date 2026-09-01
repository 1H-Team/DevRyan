import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NOTIFICATION_TEMPLATES,
  normalizeNotificationTemplates,
} from './notification-settings.js';

describe('notification settings normalization', () => {
  it('projects a total record while preserving valid custom entries', () => {
    const completion = { title: 'Custom', message: 'Done' };
    const { templates, changed } = normalizeNotificationTemplates({ completion });

    expect(changed).toBe(true);
    expect(templates.completion).toBe(completion);
    expect(templates.permission).toBe(DEFAULT_NOTIFICATION_TEMPLATES.permission);
    expect(Object.keys(templates)).toHaveLength(6);
  });

  it('inherits missing entries from the effective host record', () => {
    const host = {
      ...DEFAULT_NOTIFICATION_TEMPLATES,
      error: { title: 'Host error', message: 'Host message' },
    };
    const custom = { title: 'Personal completion', message: 'Personal message' };
    const { templates } = normalizeNotificationTemplates({ completion: custom }, host);

    expect(templates.completion).toBe(custom);
    expect(templates.error).toBe(host.error);
  });
});
