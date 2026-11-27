// Harness-owned test helper that the naming rule does not call test code
// (self-test corpus of the client conformance harness): its entry calls are
// passed through, and the family command finds it as an unclassified caller,
// test support code under another name. Run only by the harness.
import { applyEvent } from './toy-reducer.mjs';

export function seedTwice(draft) {
  const first = applyEvent(draft, { type: 'session.created', id: 'f1', title: 'first' });
  const second = applyEvent(draft, { type: 'session.created', id: 'f2', title: 'second' });
  return first && second;
}
