// Toy fixture of the mock-module layer (package C0c2): family code that calls
// a mocked module's export with no engine chain (the scheduler toy's timer,
// when an unmapped module's call of it is passed through) records nothing for
// the call, but the outside-chain detector still sees the family's frame, so the
// case is unrecordable (`outside-chain`). The self-test corpus of the client
// conformance harness records it; TOY_UNRECORDABLE lists it.
import { expect, mock, test } from 'bun:test';

test('family code that calls a mocked export with no chain is flagged', async () => {
  mock.module('./toy-sink.mjs', () => ({ sink: { write: (items) => items.length * 10 } }));
  const { hostSinkLater } = await import('./toy-host.mjs');
  expect(await hostSinkLater()).toBe(10);
});
