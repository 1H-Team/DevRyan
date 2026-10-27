import { describe, expect, test } from 'bun:test';

import { canonicalEventType } from './eventTypes';

describe('host event type names', () => {
  test('maps the openchamber:* alias to devryan:* and leaves other types alone', () => {
    expect(canonicalEventType('openchamber:managed-task')).toBe('devryan:managed-task');
    expect(canonicalEventType('devryan:heartbeat')).toBe('devryan:heartbeat');
    expect(canonicalEventType('session.status')).toBe('session.status');
  });
});
