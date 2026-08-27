import { describe, expect, test } from 'bun:test';

import { createManagedTerminalErrorRegistry } from './terminal-error-registry.js';

describe('managed terminal error registry', () => {
  test('records authoritative session errors and gates them by prompt time', () => {
    const registry = createManagedTerminalErrorRegistry({ now: () => 2_000 });
    expect(registry.observe({
      id: 'evt_1',
      type: 'session.error',
      properties: {
        sessionID: 'ses_child',
        error: { name: 'UnknownError', data: { message: 'Model not found: provider/model' } },
      },
    })).toBe(true);
    expect(registry.read({ sessionId: 'ses_child', after: 2_001 })).toBeNull();
    expect(registry.read({ sessionId: 'ses_child', after: 2_000 })).toMatchObject({
      eventId: 'evt_1',
      message: 'Model not found: provider/model',
    });
  });

  test('removes terminal evidence only on authoritative session deletion', () => {
    const registry = createManagedTerminalErrorRegistry();
    registry.observe({
      type: 'session.error',
      properties: { sessionID: 'ses_child', error: { name: 'Failure' } },
    });
    expect(registry.observe({
      type: 'session.deleted',
      properties: { info: { id: 'ses_child' } },
    })).toBe(true);
    expect(registry.read({ sessionId: 'ses_child' })).toBeNull();
  });
});
