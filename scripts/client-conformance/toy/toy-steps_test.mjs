// Harness-owned test helper named by Bun's `name_test` rule (self-test corpus
// of the client conformance harness): test code by the naming rule, so the
// entry calls it makes are the test's. It holds no test. Run only by the harness.
import { applyEvent } from './toy-reducer.mjs';

export function hideMessage(draft, id) {
  const changed = applyEvent(draft, { type: 'message.hidden', id });
  return changed === true;
}
