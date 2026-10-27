import { expect, test } from 'bun:test';
import { createManagedAssistantActivityRegistry } from './assistant-activity.js';

const message = (id, created = 100, role = 'assistant', sessionID = 'child') => ({
  type: 'message.updated', properties: { info: { id, sessionID, role, time: { created } } },
});
const part = (messageID, type = 'text', extra = {}, sessionID = 'child') => ({
  type: 'message.part.updated', properties: {
    part: { sessionID, messageID, type, text: 'output', ...extra },
  },
});

test('completion hints and reconnect wake exact directory subscriptions without waking for deltas',()=>{
  const registry=createManagedAssistantActivityRegistry();let changes=0;
  const dispose=registry.subscribeChanges({sessionId:'child',directory:'/a'},()=>{changes++;});
  registry.observe(part('new'),'/a');registry.observe(message('new'),'/a');expect(changes).toBe(0);
  registry.observe({type:'session.idle',properties:{sessionID:'other'}},'/a');
  registry.observe({type:'session.idle',properties:{sessionID:'child'}},'/b');expect(changes).toBe(0);
  registry.observe({type:'session.idle',properties:{sessionID:'child'}},'/a');
  registry.observe({type:'server.connected',properties:{}},'/a');expect(changes).toBe(2);
  dispose();registry.observe({type:'server.connected',properties:{}},'/a');expect(changes).toBe(2);
});

test('recognizes reasoning, text and tool activity even when parts precede metadata', () => {
  for (const type of ['reasoning', 'text', 'tool']) {
    const registry = createManagedAssistantActivityRegistry({ now: () => 120 });
    const seen = [];
    const dispose = registry.subscribe({ sessionId: 'child', after: 100 }, (value) => seen.push(value));
    registry.observe(part('new', type, { callID: 'call' }));
    expect(seen).toEqual([]);
    registry.observe(message('new'));
    expect(seen).toEqual([{ messageId: 'new', observedAt: 120 }]);
    dispose();
    registry.observe(part('new'));
    expect(seen).toHaveLength(1);
  }
});

test('ignores placeholders, user content, stale attempts and mismatched children/directories', () => {
  const registry = createManagedAssistantActivityRegistry();
  const seen = [];
  registry.subscribe({ sessionId: 'child', directory: '/a', after: 100, excludedMessageId: 'anchor' }, (v) => seen.push(v));
  registry.observe(message('empty'));
  registry.observe(part('empty', 'text', { text: ' ' }));
  registry.observe(part('empty', 'step-start'));
  for (const info of [message('old', 99), message('user', 101, 'user'), message('anchor'), message('other', 101, 'assistant', 'other')]) {
    registry.observe(info);
    registry.observe(part(info.properties.info.id));
  }
  registry.observe(message('wrong-directory'), '/b');
  registry.observe(part('wrong-directory'), '/b');
  expect(seen).toEqual([]);
  registry.observe(message('correct'), '/a');
  registry.observe(part('correct'), '/a');
  expect(seen).toHaveLength(1);
  registry.clear();
  registry.observe(part('correct'));
  expect(seen).toHaveLength(1);
});

test('accepts streaming deltas only with current assistant metadata', () => {
  const registry = createManagedAssistantActivityRegistry();
  const seen = [];
  registry.subscribe({ sessionId: 'child', after: 100 }, (v) => seen.push(v));
  registry.observe({ type: 'message.part.delta', properties: {
    sessionID: 'child', messageID: 'new', field: 'text', delta: 'Thinking',
  } });
  expect(seen).toHaveLength(0);
  registry.observe(message('new'));
  expect(seen).toHaveLength(1);
});

test('concurrent children keep separate evidence and disposal', () => {
  const registry = createManagedAssistantActivityRegistry();
  const first = [];
  const second = [];
  const dispose = registry.subscribe({ sessionId: 'child', after: 100 }, (v) => first.push(v));
  registry.subscribe({ sessionId: 'other', after: 100 }, (v) => second.push(v));
  registry.observe(message('new'));
  registry.observe(part('new'));
  expect(first).toHaveLength(1);
  expect(second).toHaveLength(0);
  dispose();
  registry.observe(message('other_message', 100, 'assistant', 'other'));
  registry.observe(part('other_message', 'text', {}, 'other'));
  expect(first).toHaveLength(1);
  expect(second).toHaveLength(1);
});

test('continuous progress correlates live IDs, grows snapshots, and rejects duplicate or nonsemantic events', () => {
  let clock = 120;
  const registry = createManagedAssistantActivityRegistry({ now: () => clock }), seen = [];
  const dispose = registry.subscribe({ sessionId: 'child', directory: '/a', after: 100, excludedMessageId: 'anchor' }, () => {}, v => seen.push(v));
  const delta = (id, messageID = 'new', text = '.') => ({ id, type: 'message.part.delta', properties: {
    sessionID: 'child', messageID, partID: `part_${messageID}`, field: 'text', delta: text,
  } });
  registry.observe(delta('evt_first'), '/a'); expect(seen).toEqual([]);
  registry.observe(message('new'), '/a'); expect(seen).toEqual([{ messageId: 'new', observedAt: 120 }]);
  clock = 140; registry.observe(delta('evt_first'), '/a');
  registry.observe(message('new'), '/a'); expect(seen).toHaveLength(1);
  registry.observe(delta('evt_second'), '/a'); expect(seen.at(-1)).toEqual({ messageId: 'new', observedAt: 140 });
  // A full snapshot of the two already observed deltas is unchanged content.
  clock = 150; registry.observe(part('new', 'text', { id: 'part_new', text: '..' }), '/a');
  expect(seen).toHaveLength(2);
  clock = 160;
  for (const event of [delta('evt_blank', 'new', ' '), delta('evt_empty', 'new', ''), delta(undefined),
    { type: 'session.status', properties: { sessionID: 'child', status: { type: 'busy' } } },
    { type: 'server.connected', properties: {} }]) registry.observe(event, '/a');
  registry.observe(delta('evt_wrong_directory'), '/b');
  for (const info of [message('old', 99), message('user', 101, 'user'), message('anchor')]) {
    registry.observe(info, '/a'); registry.observe(delta(`evt_${info.properties.info.id}`, info.properties.info.id), '/a');
  }
  expect(seen).toHaveLength(2);
  registry.observe(part('new', 'reasoning', { id: 'reasoning', text: 'thinking' }), '/a');
  expect(seen.at(-1)).toEqual({ messageId: 'new', observedAt: 160 });
  clock = 180; registry.observe(part('new', 'reasoning', { id: 'reasoning', text: 'thinking' }), '/a');
  registry.observe(part('new', 'reasoning', { id: 'reasoning', text: 'sameSize' }), '/a'); expect(seen).toHaveLength(3);
  registry.observe(part('new', 'reasoning', { id: 'reasoning', text: 'thinking more' }), '/a'); expect(seen).toHaveLength(4);
  registry.observe({ ...message('new'), properties: { info: { ...message('new').properties.info, time: { created: 100, completed: 180 } } } }, '/a');
  clock = 200; registry.observe(delta('evt_after_completed'), '/a'); expect(seen).toHaveLength(4);
  dispose(); registry.observe(delta('evt_after_disposal'), '/a'); expect(seen).toHaveLength(4);
});

test('canonical identity binding flushes only real current-scope events at their original time', () => {
  let clock = 110;
  const registry = createManagedAssistantActivityRegistry({ now: () => clock });
  const scope = { sessionId: 'child', directory: '/a', after: 100, excludedMessageId: 'prior' };
  const activity = [], progress = [];
  registry.subscribe(scope, value => activity.push(value), value => progress.push(value));
  registry.bind(scope, [{ messageId: 'empty', createdAt: 100 }]);
  expect(activity).toEqual([]); expect(progress).toEqual([]);
  const delta = messageID => ({ id: `evt_${messageID}`, type: 'message.part.delta', properties: {
    sessionID: 'child', messageID, partID: `part_${messageID}`, field: 'text', delta: '.',
  } });
  for (const id of ['current', 'old', 'prior', 'done']) registry.observe(delta(id), '/a');
  const bindings = [
    { messageId: 'current', createdAt: 100 }, { messageId: 'old', createdAt: 99 },
    { messageId: 'prior', createdAt: 101 }, { messageId: 'done', createdAt: 100, completedAt: 109 },
  ];
  clock = 150;
  registry.bind({ ...scope, directory: '/b' }, bindings);
  registry.bind({ ...scope, after: 99 }, bindings);
  expect(progress).toEqual([]);
  registry.bind(scope, bindings);
  expect(progress).toEqual([{ messageId: 'current', observedAt: 110 }]);
  // Rebinding and a stale incomplete metadata frame cannot reopen completion.
  registry.bind(scope, bindings); registry.observe(message('done'), '/a');
  registry.observe({ ...delta('done'), id: 'evt_after_done' }, '/a');
  expect(progress).toHaveLength(1);
  expect(activity.some(value => value.messageId === 'empty' || value.messageId === 'old' || value.messageId === 'prior')).toBe(false);
});

test('binding cannot move buffered activity from before the attempt into its new time window', () => {
  let clock = 90;
  const registry = createManagedAssistantActivityRegistry({ now: () => clock });
  const scope = { sessionId: 'child', after: 100 };
  const activity = [], progress = [];
  registry.subscribe(scope, value => activity.push(value), value => progress.push(value));
  registry.observe({ id: 'evt_early', type: 'message.part.delta', properties: {
    sessionID: 'child', messageID: 'current', partID: 'part_current', field: 'text', delta: '.',
  } });
  clock = 120; registry.bind(scope, [{ messageId: 'current', createdAt: 100 }]);
  expect(activity).toEqual([]); expect(progress).toEqual([]);
});
