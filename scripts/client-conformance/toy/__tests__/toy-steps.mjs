// Harness-owned test helper under a __tests__ directory (self-test corpus of
// the client conformance harness): test code by the naming rule, so the
// entry calls it makes are the test's. Run only by the harness.
import { applyEvent } from '../toy-reducer.mjs';

export function seedSession(draft, id) {
  const changed = applyEvent(draft, { type: 'session.created', id, title: `seeded ${id}` });
  return changed === true;
}
