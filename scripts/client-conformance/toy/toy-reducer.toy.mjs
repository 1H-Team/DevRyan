// Toy tests of the harness-owned reducer: the self-test corpus of the client
// conformance harness records them. Run only by the harness, with and without
// the recorder (their name keeps them out of every suite's discovery).
import { describe, expect, test } from 'bun:test';
import { applyEvent, createState } from './toy-reducer.mjs';

describe('toy reducer', () => {
  test('creates a session and keeps untouched branches shared', () => {
    const draft = createState();
    applyEvent(draft, { type: 'session.created', id: 's1', title: undefined });
    const before = draft.sessions.s1;
    applyEvent(draft, { type: 'session.created', id: 's2', title: 'second' });
    expect(draft.sessions.s1).toBe(before);
    expect(draft.order).toEqual(['s1', 's2']);
    expect('title' in draft.sessions.s1).toBe(true);
  });

  test('adds a message with a clock time and a random id', () => {
    const draft = createState();
    applyEvent(draft, { type: 'session.created', id: 's1', title: 't' });
    expect(applyEvent(draft, { type: 'message.added', session: 's1', text: 'hi' })).toBe(true);
    expect(applyEvent(draft, { type: 'message.added', session: 'missing', text: 'no' })).toBe(false);
    const [message] = draft.sessions.s1.messages;
    expect(message.id).toMatch(/^m-[0-9a-z]+$/);
    expect(typeof message.time).toBe('number');
  });

  test('keeps Set and Map insertion order and -0', () => {
    const draft = createState();
    for (const id of ['z', 'a', 'm']) applyEvent(draft, { type: 'message.hidden', id });
    applyEvent(draft, { type: 'status', session: 'b', status: 'busy' });
    applyEvent(draft, { type: 'status', session: 'a', status: 'idle', offset: 0 });
    expect([...draft.hidden]).toEqual(['z', 'a', 'm']);
    expect([...draft.status.keys()]).toEqual(['b', 'a']);
    expect(Object.is(draft.status.get('b').offset, -0)).toBe(true);
  });

  test('a thrown error is recorded with its class and message', () => {
    const draft = createState();
    expect(() => applyEvent(draft, { type: 'fail', session: 'x' })).toThrow(TypeError);
  });
});
