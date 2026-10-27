import { expect, test } from 'bun:test';
import { canonicalDevRyanEventType } from './event-types.js';

test('canonicalises only the legacy event prefix and retains unrelated identities', () => {
  expect(canonicalDevRyanEventType('openchamber:managed-task')).toBe('devryan:managed-task');
  for (const type of ['devryan:managed-task', 'message.part.delta', 'prefix-openchamber:event', null]) {
    expect(canonicalDevRyanEventType(type)).toBe(type);
  }
});
