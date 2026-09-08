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
