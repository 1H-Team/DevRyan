import { expect, test } from 'bun:test';
import { createStore } from 'zustand/vanilla';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { INITIAL_STATE, type State } from './types';
import { subscribeSessionRecords } from './session-record-subscription';

test('exact-session record observers ignore child streams and release their one shared listener', () => {
  const owned = { id: 'owned', sessionID: 'root', role: 'user', agent: 'build', model: { providerID: 'fixture', modelID: 'model' }, time: { created: 1 } } satisfies Message;
  const child = { id: 'child', sessionID: 'child-session', role: 'user', agent: 'build', model: { providerID: 'fixture', modelID: 'model' }, time: { created: 1 } } satisfies Message;
  const text = (messageID: string, value: string): Part => ({ type: 'text', id: `part-${messageID}`, messageID, sessionID: messageID === 'owned' ? 'root' : 'child-session', text: value });
  const store = createStore<State>(() => ({ ...INITIAL_STATE, message: { root: [owned], 'child-session': [child] }, part: { owned: [text('owned', 'root')], child: [text('child', '')] } }));
  let rootCalls = 0, childCalls = 0;
  const stopRoot = subscribeSessionRecords(store, 'root', () => rootCalls++);
  const stopRootAgain = subscribeSessionRecords(store, 'root', () => rootCalls++);
  const stopChild = subscribeSessionRecords(store, 'child-session', () => childCalls++);
  for (let i = 0; i < 500; i++) store.setState(state => ({ part: { ...state.part, child: [text('child', String(i))] } }));
  expect(rootCalls).toBe(0);
  expect(childCalls).toBe(500);
  store.setState({ session_status: { root: { type: 'busy' } } });
  expect(rootCalls).toBe(0);
  store.setState(state => ({ part: { ...state.part, owned: [text('owned', 'changed')] } }));
  expect(rootCalls).toBe(2);
  stopRoot(); stopRootAgain(); stopChild();
  store.setState({ message: {} });
  expect(rootCalls).toBe(2);
  expect(childCalls).toBe(500);
});

test('hinted child deltas inspect zero retained root messages; unhinted hydration still recovers changes', async () => {
  const { createEventDraft } = await import('./event-batch');
  const { applyDirectoryEvent } = await import('./event-reducer');
  const { hintPartChange, getPartChangeHints } = await import('./part-change-hints');
  let rootReads = 0, rootCalls = 0;
  const rootMessage = { id: 'owned', sessionID: 'root', role: 'user', agent: 'build', model: { providerID: 'fixture', modelID: 'model' }, time: { created: 1 } } satisfies Message;
  const childMessage = { ...rootMessage, id: 'child', sessionID: 'child-session' };
  const text = (id: string, sessionID: string): Extract<Part, { type: 'text' }> => ({ id: `part-${id}`, messageID: id, sessionID, type: 'text', text: '' });
  const part = new Proxy({ owned: [text('owned', 'root')], child: [text('child', 'child-session')] }, { get(target, key, receiver) { if (key === 'owned') rootReads++; return Reflect.get(target, key, receiver); } });
  const store = createStore<State>(() => ({ ...INITIAL_STATE, message: { root: [rootMessage], 'child-session': [childMessage] }, part }));
  const stop = subscribeSessionRecords(store, 'root', () => rootCalls++);
  const event = { id: 'event_child_delta', type: 'message.part.delta', properties: { sessionID: 'child-session', messageID: 'child', partID: 'part-child', field: 'text', delta: 'child output' } } as const;
  const draft = createEventDraft(store.getState(), event);
  applyDirectoryEvent(draft, event, { resolveSessionIDForMessage: () => 'child-session' });
  rootReads = 0;
  store.setState(draft);
  expect(rootReads).toBe(0);
  expect(rootCalls).toBe(0);
  expect([...getPartChangeHints(draft.part, part) ?? []]).toEqual(['child']);
  // A coalesced batch extends the same receipt and keeps its original base.
  hintPartChange(draft.part, draft.part, 'owned');
  expect([...getPartChangeHints(draft.part, part) ?? []]).toEqual(['child', 'owned']);
  expect(getPartChangeHints(draft.part, {})).toBeUndefined();
  // An HTTP hydration owns no event receipt and must take the conservative scan.
  store.setState(state => ({ part: { ...state.part, owned: [{ ...text('owned', 'root'), type: 'text', text: 'hydrated' }] } }));
  expect(rootCalls).toBe(1);
  stop();
});
