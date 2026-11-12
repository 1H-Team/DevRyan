// Toy fixture of the client conformance harness: an engine call that arrives
// after the file's recording was written is counted as unplaced (record.mjs
// TOY_UNPLACED), never dropped. Run only by the harness.
import { expect, test } from 'bun:test';
import { signal } from './toy-gate.mjs';

test('an engine call after the file was recorded is counted, never dropped', () => {
  setImmediate(() => { signal('gone', 1); });
  expect(signal('here', 1)).toBe(true);
});
