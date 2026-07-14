import { describe, expect, test } from 'bun:test';

import { createClientMessageId } from './client-message-id';

describe('createClientMessageId', () => {
  test('creates unique OpenCode-compatible IDs in sortable generation order', () => {
    const first = createClientMessageId('msg');
    const second = createClientMessageId('msg');

    expect(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(first)).toBe(true);
    expect(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(second)).toBe(true);
    expect(first === second).toBe(false);
    expect(first < second).toBe(true);
  });
});
