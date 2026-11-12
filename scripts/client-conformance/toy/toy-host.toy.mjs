// Toy tests of the caller rule and of slices (self-test corpus of the client
// conformance harness): a family's entry called by an unmapped engine module
// is passed through, not a step; a large state is stored once, as slices of
// the value table. Run only by the harness.
import { describe, expect, test } from 'bun:test';
import { signal } from './toy-gate.mjs';
import { note, relay, relaySoon } from './toy-host.mjs';
import { applyEvent, createState } from './toy-reducer.mjs';

describe('toy host', () => {
  test('a call an unmapped engine module makes is passed through, not a step', async () => {
    const draft = createState();
    expect(applyEvent(draft, { type: 'session.created', id: 's1', title: 'by the test' })).toBe(true);
    // A draft of its own, last: a recorded relay would add a step and nothing else.
    const hosted = { sessions: {}, order: [], hidden: new Set(), status: new Map(), revision: 0 };
    expect(relay(hosted, { type: 'session.created', id: 'h1', title: 'by the host' })).toBe('changed');
    // The reducer reads the clock and draws a random id inside the host's call: the host's doing, never a flag.
    expect(relay(hosted, { type: 'message.added', session: 'h1', text: 'from the host' })).toBe('changed');
    relaySoon(hosted, { type: 'message.hidden', id: 'later' });
    await null;
    expect([...hosted.hidden]).toEqual(['later']);
    expect(hosted.order).toEqual(['h1']);
    expect(draft.order).toEqual(['s1']);
    // toy-log's log is a port of toy-gate, which has a line here: the host's use of it flags nothing.
    expect(signal('host', 1)).toBe(true);
    expect(note('noted')).toBe('host:noted'.length);
  });

  test('a large state is stored once, as slices', () => {
    const draft = createState();
    for (let index = 0; index < 4; index += 1) {
      expect(applyEvent(draft, { type: 'session.created', id: `s${index}`, title: `${'long title '.repeat(120)}${index}` })).toBe(true);
    }
    expect(draft.order).toHaveLength(4);
  });
});
