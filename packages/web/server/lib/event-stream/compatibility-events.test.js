import { describe, expect, it } from 'vitest';

import { deriveDirectoryCompatibilityEvents } from './compatibility-events.js';

describe('deriveDirectoryCompatibilityEvents', () => {
  it('projects status and activity without performing side effects', () => {
    expect(deriveDirectoryCompatibilityEvents({
      type: 'session.status',
      properties: {
        sessionID: 'ses_1',
        status: { type: 'retry', attempt: 2, message: 'again', next: 123 },
      },
    }, 456)).toEqual([
      {
        type: 'openchamber:session-status',
        properties: {
          sessionId: 'ses_1',
          sessionID: 'ses_1',
          status: 'retry',
          timestamp: 456,
          metadata: { attempt: 2, message: 'again', next: 123 },
          needsAttention: false,
        },
      },
      {
        type: 'openchamber:session-activity',
        properties: { sessionId: 'ses_1', sessionID: 'ses_1', phase: 'busy' },
      },
    ]);
  });

  it('ignores unrelated and malformed events', () => {
    expect(deriveDirectoryCompatibilityEvents({ type: 'session.updated', properties: {} })).toEqual([]);
    expect(deriveDirectoryCompatibilityEvents({ type: 'session.status', properties: {} })).toEqual([]);
  });
});
