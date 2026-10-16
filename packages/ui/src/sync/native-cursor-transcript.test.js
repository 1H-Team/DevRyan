import { expect, test } from 'bun:test';
import { createEventProjector } from '../../../web/server/lib/opencode/v2/projection/events.js';
import { projectMessagePage } from '../../../web/server/lib/opencode/v2/projection/messages.js';
import { serializeEventPayload } from '../../../web/server/lib/event-stream/payload-serialization.js';
import { applyDirectoryEvent } from './event-reducer';
import { INITIAL_STATE } from './types';
import { hasMessageRecordInfo, unwrapMessageRecordsResult } from './message-fetch';
import { materializeSessionSnapshots } from './materialization';
import { getMessageCopyText } from '../lib/messages/messageCopyText';
import { hasNativeCursorTextProvenance } from '../lib/messages/nativeCursorText';
import { collapseExactDuplicateAdjacentTextParts, extractTextContent, mergeConsecutiveTextParts } from '../components/chat/message/partUtils';
import { projectAssistantDisplayParts, projectAssistantVisibleParts } from '../components/chat/message/assistantRowContent';

const sessionID = 'ses_cursor', messageID = 'msg_cursor', userID = 'msg_user';
const metadata = { devryan: { cursor: { source: 'cursor-acp', userMessageID: userID } } };
const state = () => ({ ...INITIAL_STATE, message: {}, part: {}, session_status: {}, session_diff: {} });
const content = texts => texts.map((text, index) => ({ type: 'text', text, state: { devryan: { cursor: { partID: `prt_cursor${index}` } } } }));
const transcript = parts => parts.map(extractTextContent).join('');
function harness() {
  const projector = createEventProjector(), draft = state(); let sequence = 0;
  const apply = (type, data) => {
    const envelope = { id: `evt_${++sequence}`, type, data, created: 1000 + sequence, location: { directory: '/fixture' }, metadata };
    for (const event of projector.project(envelope)) {
      // Use the real SSE payload serializer; no simplified concatenating fold.
      const payload = JSON.parse(serializeEventPayload(event.payload));
      applyDirectoryEvent(draft, payload);
    }
  };
  apply('session.step.started', { sessionID, assistantMessageID: messageID, agent: 'build', model: { providerID: 'cursor-acp', id: 'fixture' }, started: 1001 });
  apply('session.execution.started', { sessionID });
  return { draft, apply };
}
function history(texts, completed = true) {
  const records = projectMessagePage([
    { id: userID, type: 'user', text: 'Preserve the source', time: { created: 1000 } },
    { id: messageID, type: 'assistant', agent: 'build', model: { providerID: 'cursor-acp', id: 'fixture' }, metadata,
      content: content(texts), time: { created: 1001, ...(completed ? { completed: 1005 } : {}) }, ...(completed ? { finish: 'stop' } : {}) },
  ], { sessionID, directory: '/fixture' }).records;
  return unwrapMessageRecordsResult({ data: JSON.parse(JSON.stringify(records)), response: { status: 200 } }).filter(hasMessageRecordInfo);
}

const repeated = '- Repeat this exact markdown instruction twice.\n'.repeat(2);
for (const texts of [
  [repeated],
  ['\t  😀 café 日本語\r\n\r\n```md\r\n  indented  \r\n  indented  \r\n```\r\n\r\n'],
  ['**Exact markdown**', ' \t', 'continuation\r\n\r\n', repeated, repeated],
  ['Continuing with `Write` and `StrReplace` since `edit` is blocked.\n'],
]) test('native Cursor published bytes survive busy/completed SSE, reload, rendering and copy: ' + texts.length, () => {
  const exact = texts.join(''), f = harness();
  f.apply('session.message.content.updated', { sessionID, messageID, content: content(texts) });
  expect(transcript(f.draft.part[messageID])).toBe(exact);
  f.apply('session.step.ended', { sessionID, assistantMessageID: messageID, finish: 'stop', cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
  expect(transcript(f.draft.part[messageID])).toBe(exact);
  const restored = materializeSessionSnapshots(state(), sessionID, history(texts));
  expect(transcript(restored.part[messageID])).toBe(exact);
  const display = projectAssistantDisplayParts({ parts: restored.part[messageID], messageFinish: 'stop' }).displayParts;
  const visible = projectAssistantVisibleParts(display).visibleParts;
  expect(collapseExactDuplicateAdjacentTextParts(visible)).toHaveLength(texts.length);
  expect(extractTextContent(mergeConsecutiveTextParts(visible))).toBe(exact);
  expect(getMessageCopyText(display, 'assistant')).toBe(exact);
  if (exact === repeated) expect(Buffer.byteLength(getMessageCopyText(display, 'assistant'))).toBe(96);
});

test('a real cumulative Cursor prefix correction replaces the old text while busy and on materialization', () => {
  const f = harness();
  f.apply('session.message.content.updated', { sessionID, messageID, content: content(['exact corrected text plus old suffix']) });
  f.apply('session.message.content.updated', { sessionID, messageID, content: content(['exact corrected text']) });
  expect(transcript(f.draft.part[messageID])).toBe('exact corrected text');
  const restored = materializeSessionSnapshots(f.draft, sessionID, history(['exact corrected'], false));
  expect(transcript(restored.part[messageID])).toBe('exact corrected');
  f.apply('session.step.ended', { sessionID, assistantMessageID: messageID, finish: 'stop', cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
  const stale = materializeSessionSnapshots(f.draft, sessionID, history(['older unfinished text'], false));
  expect(transcript(stale.part[messageID])).toBe('exact corrected text');
  expect(stale.message[sessionID].find(message => message.id === messageID).time.completed).toBeGreaterThan(0);
});
test('a native cumulative history replacement does not reattach removed earlier text parts', () => {
  const f = harness();
  f.apply('session.message.content.updated', { sessionID, messageID, content: content(['current', 'removed earlier source']) });
  const restored = materializeSessionSnapshots(f.draft, sessionID, history(['current'], false));
  expect(restored.part[messageID]).toHaveLength(1);
  expect(transcript(restored.part[messageID])).toBe('current');
});

test('existing part provenance is exact and does not promote arbitrary legacy parts by content', () => {
  const parts = history([repeated]).find(record => record.info.id === messageID)?.parts ?? [];
  expect(hasNativeCursorTextProvenance(parts[0])).toBe(true);
  expect(hasNativeCursorTextProvenance({ ...parts[0], id: 'prt_foreign' })).toBe(false);
  expect(hasNativeCursorTextProvenance({ ...parts[0], metadata: undefined })).toBe(false);
  expect(hasNativeCursorTextProvenance({ type: 'text', id: 'prt_cursor0', metadata: { devryan: { cursor: { partID: 'prt_cursor0' } } } })).toBe(false);
});

test('native reasoning and text between typed activity parts retain their ordered content', () => {
  const f = harness(), text = '  exact reasoning repeated for a purpose\n'.repeat(2);
  const items = [{ type: 'reasoning', text, state: { devryan: { cursor: { partID: 'prt_reasoning' } } }, time: { created: 1001 } },
    ...content(['and']), { type: 'reasoning', text: 'next thought', state: { devryan: { cursor: { partID: 'prt_reasoning2' } } }, time: { created: 1002 } }];
  f.apply('session.message.content.updated', { sessionID, messageID, content: items });
  f.apply('session.step.ended', { sessionID, assistantMessageID: messageID, finish: 'stop', cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
  expect(transcript(f.draft.part[messageID])).toBe(text + 'andnext thought');
  expect(projectAssistantVisibleParts(f.draft.part[messageID]).visibleParts.map(part => part.id)).toEqual(['prt_reasoning', 'prt_cursor0', 'prt_reasoning2']);
  expect(hasNativeCursorTextProvenance(f.draft.part[messageID][0])).toBe(true);
});
