import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { isNativeCompactionRecord, observesNativeContinuation } from '../../../../../../harness-runtime/lib/objective-identity.js';
import { isPlanModeUserMessage, isPlanSelectionMaintenanceMessage } from '../../../../../../ui/src/lib/messages/actionablePlan.ts';
import { resolveLatestUserChoiceFromMessages } from '../../../../../../ui/src/sync/subtask-agent.ts';
import { createEventProjector } from './events.js';

import {
  InvalidMessageCursorError,
  InvalidMessagePageError,
  MAX_PAGE_FILL_EXTRA_FETCHES,
  addUserIndexEntry,
  buildUserIndex,
  compactionPartId,
  compactionSummaryTextPartId,
  decodeMessageCursor,
  encodeMessageCursor,
  fillMessagePage,
  findIndexedParentID,
  isDroppedMessageType,
  projectMessagePage,
  projectSingleMessage,
  readDevryanPromptSelection,
  toV1PathInfo,
  toV1Tokens,
  toV1UserMetadata,
  turnSummaryDiffs,
} from './messages.js';

const VECTORS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__vectors__');
const loadVector = (file) => JSON.parse(fs.readFileSync(path.join(VECTORS, file), 'utf8'));
const rest = (file, label) => {
  const entry = loadVector(file).rest.find((item) => item.label === label);
  if (!entry) throw new Error(`missing ${file} ${label}`);
  return entry.body;
};

const SID = 'ses_fffffffffffenormalized0000';
const DIR = '<home>/workspace';
const mid = (n) => `msg_${n.toString(16).padStart(12, '0')}normalized0000`;
const context = { sessionID: SID, directory: DIR };
const project = (rows, extra = {}) => projectMessagePage(rows, { ...context, ...extra }).records;
const summary = (records) => records.map(({ info }) => ({
  id: info.id, role: info.role, parentID: info.parentID, created: info.time.created,
}));

const zeroTokens = { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
const pathInfo = { cwd: DIR, root: DIR };

describe('vector 01: two-step tool turn (golden v1 records)', () => {
  it('projects the asc page to the exact v1 records', () => {
    const records = project(rest('01-two-step-tool-turn.json', 'session.messages.asc').data);
    const step1Tokens = { total: 1050, input: 600, output: 40, reasoning: 10, cache: { read: 400, write: 0 } };
    const step2Tokens = { total: 1220, input: 200, output: 20, reasoning: 0, cache: { read: 1000, write: 0 } };
    const base = (messageID) => ({ sessionID: SID, messageID });
    expect(records).toEqual([
      {
        info: {
          id: mid(1),
          sessionID: SID,
          role: 'user',
          time: { created: 1767225605000 },
          // LOSS(user-selection): no metadata.devryan, so the answering assistant fills these.
          agent: 'build',
          model: { providerID: 'sim', modelID: 'm1' },
          metadata: {},
        },
        parts: [{ id: `${mid(1)}:text:0`, ...base(mid(1)), type: 'text', text: 'Run the probe tool' }],
      },
      {
        turnOwnership: { source: 'native-sequence', userMessageID: mid(1) },
        info: {
          id: mid(2),
          sessionID: SID,
          role: 'assistant',
          parentID: mid(1),
          agent: 'build',
          mode: 'build',
          providerID: 'sim',
          modelID: 'm1',
          path: pathInfo,
          time: { created: 1767225606000, completed: 1767225623000 },
          cost: 0,
          tokens: step1Tokens,
          finish: 'tool-calls',
        },
        parts: [
          { id: `${mid(2)}:step-start`, ...base(mid(2)), type: 'step-start' },
          {
            id: `${mid(2)}:reasoning:0`,
            ...base(mid(2)),
            type: 'reasoning',
            text: 'Let me think.',
            time: { start: 1767225608000, end: 1767225615000 },
            metadata: { reasoningField: 'reasoning_content' },
          },
          {
            id: `${mid(2)}:text:0`,
            ...base(mid(2)),
            type: 'text',
            text: 'I will probe.',
            time: { start: 1767225606000, end: 1767225623000 },
          },
          {
            id: `${mid(2)}:tool:call_s01_probe`,
            ...base(mid(2)),
            type: 'tool',
            callID: 'call_s01_probe',
            tool: 'sim_probe',
            state: {
              status: 'completed',
              input: { n: 1 },
              output: 'probe-ok',
              title: '',
              metadata: { truncated: false },
              time: { start: 1767225617000, end: 1767225622000 },
            },
            metadata: { opencodeTool: 'sim_probe' },
          },
          {
            id: `${mid(2)}:step-finish`,
            ...base(mid(2)),
            type: 'step-finish',
            reason: 'tool-calls',
            cost: 0,
            tokens: step1Tokens,
          },
        ],
      },
      {
        turnOwnership: { source: 'native-sequence', userMessageID: mid(1) },
        info: {
          id: mid(3),
          sessionID: SID,
          role: 'assistant',
          parentID: mid(1),
          agent: 'build',
          mode: 'build',
          providerID: 'sim',
          modelID: 'm1',
          path: pathInfo,
          time: { created: 1767225625000, completed: 1767225632000 },
          cost: 0,
          tokens: step2Tokens,
          finish: 'stop',
        },
        parts: [
          { id: `${mid(3)}:step-start`, ...base(mid(3)), type: 'step-start' },
          {
            id: `${mid(3)}:text:0`,
            ...base(mid(3)),
            type: 'text',
            text: 'All done.',
            time: { start: 1767225625000, end: 1767225632000 },
          },
          { id: `${mid(3)}:step-finish`, ...base(mid(3)), type: 'step-finish', reason: 'stop', cost: 0, tokens: step2Tokens },
        ],
      },
    ]);
  });

  it('projects the same records from the default (desc) order once reversed', () => {
    const asc = project(rest('01-two-step-tool-turn.json', 'session.messages.asc').data);
    const desc = rest('01-two-step-tool-turn.json', 'session.messages.default').data;
    expect(project([...desc].reverse())).toEqual(asc);
  });

  it('projects a single message (GET message/:mid) with its parent from the user index', () => {
    const message = rest('01-two-step-tool-turn.json', 'session.message.get').data;
    const userIndex = buildUserIndex(rest('01-two-step-tool-turn.json', 'session.messages.type.user').data);
    const [record] = projectSingleMessage(message, { ...context, userIndex });
    expect(record.info).toMatchObject({ id: mid(3), role: 'assistant', parentID: mid(1) });
    expect(projectSingleMessage({ id: mid(4), type: 'idle', time: { created: 1 }, outcome: 'succeeded' }, context))
      .toEqual([]);
  });
});

describe('parentID', () => {
  it('uses the nearest earlier user in seq order, not id order (vector 12, steer + queue)', () => {
    const records = project(rest('12-steer-queue-switch.json', 'session.messages.asc').data);
    expect(summary(records)).toEqual([
      { id: mid(1), role: 'user', parentID: undefined, created: 1767225605000 },
      { id: mid(2), role: 'assistant', parentID: mid(1), created: 1767225606000 },
      { id: mid(4), role: 'user', parentID: undefined, created: 1767225616000 },
      { id: mid(6), role: 'assistant', parentID: mid(4), created: 1767225617000 },
      { id: mid(5), role: 'user', parentID: undefined, created: 1767225623000 },
      { id: mid(7), role: 'assistant', parentID: mid(5), created: 1767225624000 },
    ]);
  });

  it('parents assistants at the older page edge from the user index', () => {
    const page = [...rest('01-two-step-tool-turn.json', 'session.messages.desc.limit2').data].reverse();
    expect(project(page)[0].info.parentID).toBe('');
    const userIndex = buildUserIndex(rest('01-two-step-tool-turn.json', 'session.messages.type.user').data);
    expect(userIndex).toEqual([{ deliveredAt: 1767225605000, userID: mid(1) }]);
    expect(project(page, { userIndex })[0].info).toMatchObject({ id: mid(3), parentID: mid(1) });
  });

  it('picks the latest user delivered at or before the assistant (ties keep seq order)', () => {
    const index = buildUserIndex([
      { id: 'msg_b', type: 'user', time: { created: 200 } },
      { id: 'msg_a', type: 'user', time: { created: 100 } },
      { id: 'msg_c', type: 'synthetic', time: { created: 200 } },
      { id: 'msg_x', type: 'assistant', time: { created: 150 } },
    ]);
    expect(index.map((entry) => entry.userID)).toEqual(['msg_a', 'msg_b', 'msg_c']);
    expect(findIndexedParentID(index, 99)).toBeUndefined();
    expect(findIndexedParentID(index, 100)).toBe('msg_a');
    expect(findIndexedParentID(index, 199)).toBe('msg_a');
    expect(findIndexedParentID(index, 200)).toBe('msg_c');
    expect(findIndexedParentID(undefined, 200)).toBeUndefined();
  });

  it('adds live deliveries to the index without duplicating ids', () => {
    const index = buildUserIndex([{ id: 'msg_a', type: 'user', time: { created: 100 } }]);
    const next = addUserIndexEntry(index, { deliveredAt: 300, userID: 'msg_b' });
    expect(next).toEqual([{ deliveredAt: 100, userID: 'msg_a' }, { deliveredAt: 300, userID: 'msg_b' }]);
    expect(index).toHaveLength(1);
    expect(addUserIndexEntry(next, { deliveredAt: 50, userID: 'msg_a' })).toEqual(next);
    expect(addUserIndexEntry(next, { deliveredAt: 200, userID: 'msg_c' }).map((entry) => entry.userID))
      .toEqual(['msg_a', 'msg_c', 'msg_b']);
  });

  it('re-parents after a standalone synthetic and after a compaction', () => {
    const records = project(rest('11-synthetic.json', 'session.messages.asc').data);
    expect(summary(records).map(({ id, parentID }) => [id, parentID])).toEqual([
      [mid(1), undefined],
      [mid(2), mid(1)],
      [mid(4), undefined],
      [mid(5), mid(4)],
    ]);
  });
});

describe('time clamp', () => {
  it('makes time.created strictly increasing in seq order so the UI sort keeps seq order', () => {
    const rows = [
      { id: 'msg_9', type: 'user', text: 'first', time: { created: 100 } },
      { id: 'msg_1', type: 'assistant', agent: 'build', model: { id: 'm', providerID: 'p' }, content: [], time: { created: 100 } },
      { id: 'msg_2', type: 'user', text: 'steer', time: { created: 90 } },
      { id: 'msg_3', type: 'assistant', agent: 'build', model: { id: 'm', providerID: 'p' }, content: [], time: { created: 95 } },
    ];
    const records = project(rows);
    expect(records.map((record) => record.info.time.created)).toEqual([100, 101, 102, 103]);
    const sorted = [...records].sort((left, right) => (
      left.info.time.created - right.info.time.created || (left.info.id < right.info.id ? -1 : 1)
    ));
    expect(sorted.map((record) => record.info.id)).toEqual(['msg_9', 'msg_1', 'msg_2', 'msg_3']);
  });

  it('continues from previousTime and reports lastTime', () => {
    const page = projectMessagePage([{ id: 'msg_1', type: 'user', text: 'x', time: { created: 10 } }], {
      ...context, previousTime: 50,
    });
    expect(page.records[0].info.time.created).toBe(51);
    expect(page.lastTime).toBe(51);
    expect(page.lastParentID).toBe('msg_1');
  });

  it('keeps the retried assistant time from the second step start (vector 02)', () => {
    const records = project(rest('02-retry.json', 'session.messages.asc').data);
    expect(summary(records)).toEqual([
      { id: mid(1), role: 'user', parentID: undefined, created: 1767225605000 },
      { id: mid(2), role: 'assistant', parentID: mid(1), created: 1767225610000 },
    ]);
  });
});

describe('user records', () => {
  const devryanMetadata = {
    devryan: {
      v: 1,
      origin: 'human',
      agent: 'plan',
      providerID: 'anthropic',
      modelID: 'claude',
      variant: null,
      planMode: true,
      parts: [
        { kind: 'synthetic', length: 6, id: 'prt_pre' },
        { kind: 'text', length: 5, id: 'prt_main' },
        { kind: 'attachment', length: 4 },
      ],
    },
    other: 'kept',
  };

  it('splits text segments with client part ids and reads the selection from metadata.devryan', () => {
    const [record] = project([{
      id: 'msg_u', type: 'user', text: 'PREFIXhelloFILE', metadata: devryanMetadata, time: { created: 5 },
    }], { agent: 'build', model: { id: 'other', providerID: 'x' } });
    expect(record.info).toEqual({
      id: 'msg_u',
      sessionID: SID,
      role: 'user',
      time: { created: 5 },
      agent: 'plan',
      model: { providerID: 'anthropic', modelID: 'claude', variant: '' },
      metadata: { other: 'kept', openchamberPlanMode: true },
    });
    expect(record.parts).toEqual([
      { id: 'prt_pre', sessionID: SID, messageID: 'msg_u', type: 'text', text: 'PREFIX', synthetic: true },
      { id: 'prt_main', sessionID: SID, messageID: 'msg_u', type: 'text', text: 'hello' },
      { id: 'msg_u:text:2', sessionID: SID, messageID: 'msg_u', type: 'text', text: 'FILE', synthetic: true },
    ]);
  });

  it('projects files as data-URL file parts and agents as agent parts', () => {
    const [record] = project([{
      id: 'msg_u',
      type: 'user',
      text: '@fixer look',
      files: [
        { data: 'aGk=', mime: 'image/png', source: { type: 'inline' }, name: 'a.png' },
        { data: 'eA==', mime: 'text/plain', source: { type: 'uri', uri: 'file:///b.txt' } },
        { mime: 'text/plain' },
      ],
      agents: [{ name: 'fixer', mention: { start: 0, end: 6, text: '@fixer' } }, { name: 'bare' }],
      time: { created: 5 },
    }]);
    expect(record.parts.slice(1)).toEqual([
      { id: 'msg_u:file:0', sessionID: SID, messageID: 'msg_u', type: 'file', mime: 'image/png', url: 'data:image/png;base64,aGk=', filename: 'a.png' },
      { id: 'msg_u:file:1', sessionID: SID, messageID: 'msg_u', type: 'file', mime: 'text/plain', url: 'data:text/plain;base64,eA==' },
      { id: 'msg_u:agent:0', sessionID: SID, messageID: 'msg_u', type: 'agent', name: 'fixer', source: { value: '@fixer', start: 0, end: 6 } },
      { id: 'msg_u:agent:1', sessionID: SID, messageID: 'msg_u', type: 'agent', name: 'bare' },
    ]);
  });

  it('falls back to a switched row, then the answering assistant, then the session seed', () => {
    const rows = rest('12-steer-queue-switch.json', 'session.messages.asc').data;
    const records = project(rows, { agent: 'seed', model: { id: 'seed-model', providerID: 'seed' } });
    const users = records.filter((record) => record.info.role === 'user').map((record) => [record.info.id, record.info.agent, record.info.model]);
    expect(users).toEqual([
      [mid(1), 'build', { providerID: 'sim', modelID: 'm1' }],
      // after the model-switched row: the switch wins over the answering assistant
      [mid(4), 'build', { providerID: 'sim', modelID: 'm2' }],
      [mid(5), 'build', { providerID: 'sim', modelID: 'm2', variant: 'default' }],
    ]);
    const unanswered = project([{ id: 'msg_u', type: 'user', text: 'x', time: { created: 1 } }], {
      agent: 'seed', model: { id: 'seed-model', providerID: 'seed', variant: 'high' },
    });
    expect(unanswered[0].info).toMatchObject({ agent: 'seed', model: { providerID: 'seed', modelID: 'seed-model', variant: 'high' } });
  });

  it('reads only version-1 DevRyan metadata', () => {
    expect(readDevryanPromptSelection({ devryan: { v: 2, agent: 'x' } })).toBeNull();
    expect(readDevryanPromptSelection({ devryan: { kind: 'probe' } })).toBeNull();
    expect(readDevryanPromptSelection(undefined)).toBeNull();
    expect(toV1UserMetadata({ devryan: { kind: 'probe' } })).toEqual({});
    expect(toV1UserMetadata(undefined)).toEqual({});
  });
});

describe('synthetic rows', () => {
  it.each([true, false])('preserves explicitly marked standalone synthetic maintenance through REST and SSE without replacing Plan %s or user choice', (planMode) => {
    const anchor = { id: 'msg_anchor', type: 'user', text: 'Original request', time: { created: 1 },
      metadata: { devryan: { v: 1, agent: 'builder', providerID: 'p', modelID: 'm', variant: 'low', planMode } } };
    const metadata = { compaction_continue: true, privateField: 'excluded',
      devryan: { v: 1, agent: 'explorer', providerID: 'p', modelID: 'other', variant: 'high' } };
    const raw = { id: 'msg_continue', type: 'synthetic', text: 'Continue.', description: 'native wake', metadata, time: { created: 3 } };
    const records = project([anchor, raw]);
    const continuation = records[1];
    expect(continuation.parts[0].metadata).toEqual({ opencodeDescription: 'native wake', compaction_continue: true });
    expect(isNativeCompactionRecord(continuation)).toBe(true);
    expect(observesNativeContinuation({ sessionID: SID, directory: DIR, anchorID: anchor.id },
      { complete: true, session: { id: SID, directory: DIR }, messages: records }, raw.id)).toBe(true);
    const authoritative = records.filter(record => !isPlanSelectionMaintenanceMessage(record.parts)).at(-1);
    expect(authoritative.info.id).toBe(anchor.id);
    expect(isPlanModeUserMessage(authoritative.info, authoritative.parts)).toBe(planMode);
    expect(resolveLatestUserChoiceFromMessages(records.map(record => record.info),
      id => records.find(record => record.info.id === id)?.parts)).toMatchObject({ id: anchor.id, agent: 'builder', modelID: 'm', variant: 'low' });
    const projector = createEventProjector();
    const envelope = (id, type, data, created) => ({ id, type, data, created, location: { directory: DIR } });
    projector.project(envelope('evt_enqueue', 'session.inbox.enqueued', { sessionID: SID, inboxID: raw.id,
      item: { type: 'synthetic', delivery: 'steer', payload: { text: raw.text, description: raw.description, metadata } } }, 2));
    const events = projector.project(envelope('evt_delivered', 'session.inbox.delivered', { sessionID: SID, inboxID: raw.id }, 3));
    expect(events.find(event => event.payload.type === 'message.part.updated').payload.properties.part).toEqual(continuation.parts[0]);
  });

  it.each([undefined, false, 'true', 1])('does not infer continuation from non-true metadata %s or text', (marker) => {
    const record = project([{ id: 'msg_s', type: 'synthetic', text: 'Continue from where the previous response left off.',
      metadata: { compaction_continue: marker, privateField: true, devryan: { secret: 'excluded' } }, time: { created: 1 } }])[0];
    expect(record.parts[0].metadata).toBeUndefined();
    expect(isNativeCompactionRecord(record)).toBe(false);
    expect(isPlanSelectionMaintenanceMessage(record.parts)).toBe(false);
  });

  it('does not mark an ordinary user or a human with a folded marked synthetic preface as maintenance', () => {
    const raw = { id: 'msg_s', type: 'synthetic', text: 'Continue.', description: 'preface', metadata: { compaction_continue: true }, time: { created: 1 } };
    const human = { id: 'msg_human', type: 'user', text: 'New human request', metadata: { compaction_continue: true }, time: { created: 2 } };
    const standalone = project([human])[0];
    const folded = project([raw, human])[0];
    expect(folded.info.id).toBe(human.id);
    expect(folded.parts[0].metadata).toEqual({ opencodeDescription: 'preface' });
    for (const record of [standalone, folded]) {
      expect(isNativeCompactionRecord(record)).toBe(false);
      expect(isPlanSelectionMaintenanceMessage(record.parts)).toBe(false);
      expect(resolveLatestUserChoiceFromMessages([record.info], () => record.parts)?.id).toBe(human.id);
    }
  });

  it('folds a synthetic row into the immediately following user row of the page', () => {
    const records = project([
      { id: 'msg_s', type: 'synthetic', text: 'context', description: 'preface', time: { created: 1 } },
      { id: 'msg_m', type: 'agent-switched', agent: 'build', time: { created: 2 } },
      { id: 'msg_u', type: 'user', text: 'hello', time: { created: 3 } },
    ]);
    expect(records).toHaveLength(1);
    expect(records[0].info).toMatchObject({ id: 'msg_u', agent: 'build', time: { created: 3 } });
    expect(records[0].parts).toEqual([
      { id: 'msg_s:text:0', sessionID: SID, messageID: 'msg_u', type: 'text', text: 'context', synthetic: true, metadata: { opencodeDescription: 'preface' } },
      { id: 'msg_u:text:0', sessionID: SID, messageID: 'msg_u', type: 'text', text: 'hello' },
    ]);
  });

  it('keeps a synthetic row followed by an assistant as its own user record (vector 11)', () => {
    const records = project(rest('11-synthetic.json', 'session.messages.asc').data);
    const synthetic = records.find((record) => record.info.id === mid(4));
    expect(synthetic.info).toMatchObject({ role: 'user', agent: 'build', metadata: {}, model: { providerID: 'sim', modelID: 'm1' } });
    expect(synthetic.parts).toEqual([{
      id: `${mid(4)}:text:0`,
      sessionID: SID,
      messageID: mid(4),
      type: 'text',
      text: 'Synthetic context note',
      synthetic: true,
      metadata: { opencodeDescription: 'probe synthetic' },
    }]);
  });

  it('keeps a trailing synthetic row standalone', () => {
    const records = project([{ id: 'msg_s', type: 'synthetic', text: 'tail', time: { created: 1 } }]);
    expect(records.map((record) => [record.info.id, record.parts[0].synthetic])).toEqual([['msg_s', true]]);
  });
});

describe('dropped and folded types', () => {
  it('drops system, idle and switched rows and folds a location switch into later paths', () => {
    const rows = [
      { id: 'msg_1', type: 'system', text: 'legacy notice', time: { created: 1 } },
      { id: 'msg_2', type: 'location-switched', location: { directory: '/other/pkg' }, subpath: 'pkg', time: { created: 2 } },
      { id: 'msg_3', type: 'model-switched', model: { id: 'm2', providerID: 'p' }, time: { created: 3 } },
      { id: 'msg_4', type: 'agent-switched', agent: 'fixer', time: { created: 4 } },
      { id: 'msg_5', type: 'user', text: 'go', time: { created: 5 } },
      { id: 'msg_6', type: 'assistant', agent: 'fixer', model: { id: 'm2', providerID: 'p' }, content: [], time: { created: 6 } },
      { id: 'msg_7', type: 'idle', outcome: 'succeeded', time: { created: 7 } },
      { id: 'msg_8', type: 'brand-new-type', time: { created: 8 } },
    ];
    const page = projectMessagePage(rows, context);
    expect(page.records.map((record) => record.info.id)).toEqual(['msg_5', 'msg_6']);
    expect(page.records[0].info).toMatchObject({ agent: 'fixer', model: { providerID: 'p', modelID: 'm2' } });
    expect(page.records[1].info.path).toEqual({ cwd: path.join('/other', 'pkg'), root: '/other' });
    expect(page.fold).toEqual({ agent: 'fixer', model: { id: 'm2', providerID: 'p' }, path: { cwd: path.join('/other', 'pkg'), root: '/other' } });
    expect(rows.map(isDroppedMessageType)).toEqual([true, true, true, true, false, false, true, false]);
  });

  it('drops rows without an id', () => {
    expect(project([null, { type: 'user', text: 'x' }, 'x'])).toEqual([]);
  });
});

describe('compaction pair (vector 07)', () => {
  it('projects the compaction row to a user compaction record and a summary assistant', () => {
    const records = project(rest('07-compaction.json', 'session.messages.asc').data);
    const user = records.find((record) => record.info.id === mid(4));
    const assistant = records.find((record) => record.info.id === `${mid(4)}:summary`);
    expect(user).toEqual({
      info: {
        id: mid(4),
        sessionID: SID,
        role: 'user',
        time: { created: 1767225614000 },
        agent: 'build',
        model: { providerID: 'sim', modelID: 'm1' },
        metadata: {},
      },
      parts: [{ id: compactionPartId(mid(4)), sessionID: SID, messageID: mid(4), type: 'compaction', auto: false }],
    });
    expect(assistant).toEqual({
      turnOwnership: { source: 'native-sequence', userMessageID: mid(4) },
      info: {
        id: `${mid(4)}:summary`,
        sessionID: SID,
        role: 'assistant',
        parentID: mid(4),
        agent: 'compaction',
        mode: 'compaction',
        summary: true,
        providerID: 'sim',
        modelID: 'm1',
        path: pathInfo,
        time: { created: 1767225614001, completed: 1767225614001 },
        cost: 0,
        tokens: zeroTokens,
        finish: 'stop',
      },
      parts: [{
        id: compactionSummaryTextPartId(mid(4)),
        sessionID: SID,
        messageID: `${mid(4)}:summary`,
        type: 'text',
        text: '## Objective\nAnswer the first question.\n\n## Next Move\nWait for the next prompt.',
      }],
    });
    expect(compactionSummaryTextPartId(mid(4))).toBe(`${mid(4)}:summary:text:0`);
  });

  it('parents the next turn to its own prompt after compaction', () => {
    const records = project(rest('07-compaction.json', 'after.session.messages.asc').data);
    const last = records.at(-1).info;
    const lastUser = records.filter((record) => record.info.role === 'user' && record.parts[0].type === 'text').at(-1).info;
    expect(last).toMatchObject({ role: 'assistant', parentID: lastUser.id });
  });

  it('marks automatic, running and failed compactions', () => {
    const [runningUser, running] = project([{
      type: 'compaction', id: 'msg_c', status: 'running', reason: 'auto', summary: '', recent: '', time: { created: 9 },
    }]);
    expect(runningUser.parts[0].auto).toBe(true);
    expect(running.info.time).toEqual({ created: 10 });
    expect(running.info.finish).toBeUndefined();
    expect(running.parts).toEqual([{ id: 'msg_c:summary:text:0', sessionID: SID, messageID: 'msg_c:summary', type: 'text', text: '' }]);
    const [, failed] = project([{
      type: 'compaction', id: 'msg_c', status: 'failed', reason: 'manual', error: { type: 'provider.auth', message: 'no' }, time: { created: 9 },
    }]);
    expect(failed.info).toMatchObject({ finish: 'error', error: { name: 'ProviderAuthError', data: { message: 'no', v2Type: 'provider.auth' } } });
    expect(failed.parts).toEqual([]);
  });
});

describe('shell and skill rows', () => {
  it('projects a shell row to an assistant with one completed bash tool part', () => {
    const [user, shell] = project([
      { id: 'msg_u', type: 'user', text: 'x', time: { created: 1 } },
      {
        id: 'msg_sh',
        type: 'shell',
        shellID: 'sh_1',
        command: 'ls',
        status: 'exited',
        exit: 0,
        output: { output: 'a\nb', cursor: 3, size: 3, truncated: false },
        time: { created: 2, completed: 3 },
      },
    ], { agent: 'build', model: { id: 'm', providerID: 'p' } });
    expect(user.info.id).toBe('msg_u');
    expect(shell.info).toMatchObject({ id: 'msg_sh', role: 'assistant', parentID: 'msg_u', agent: 'build', providerID: 'p', modelID: 'm', time: { created: 2, completed: 3 } });
    expect(shell.parts).toEqual([{
      id: 'msg_sh:tool:sh_1',
      sessionID: SID,
      messageID: 'msg_sh',
      type: 'tool',
      callID: 'sh_1',
      tool: 'bash',
      state: { status: 'completed', input: { command: 'ls' }, title: 'ls', output: 'a\nb', metadata: { status: 'exited', exit: 0 }, time: { start: 2, end: 3 } },
      metadata: { opencodeTool: 'shell' },
    }]);
  });

  it('projects a skill row to a user record with a hidden part that is not a parent', () => {
    const records = project([
      { id: 'msg_u', type: 'user', text: 'x', time: { created: 1 } },
      { id: 'msg_k', type: 'skill', skill: 'pdf', name: 'pdf', text: 'SKILL BODY', time: { created: 2 } },
      { id: 'msg_a', type: 'assistant', agent: 'build', model: { id: 'm', providerID: 'p' }, content: [], time: { created: 3 } },
    ]);
    expect(records[1]).toMatchObject({
      info: { id: 'msg_k', role: 'user' },
      parts: [{ id: 'msg_k:text:0', type: 'text', text: 'SKILL BODY', synthetic: true, metadata: { opencodeSkill: { id: 'pdf', name: 'pdf' } } }],
    });
    expect(records[2].info.parentID).toBe('msg_u');
  });
});

describe('assistant states from vectors', () => {
  it('keeps an in-flight retry assistant open (vector 02, no step-finish)', () => {
    const records = project(rest('02-retry.json', 'retrying.session.messages.asc').data);
    const assistant = records[1];
    expect(assistant.info.time).toEqual({ created: 1767225606000 });
    expect(assistant.parts.map((part) => part.type)).toEqual(['step-start']);
  });

  it('projects provider auth and abort errors (vectors 04, 03)', () => {
    const failure = project(rest('04-failure.json', 'session.messages.asc').data)[1].info;
    expect(failure).toMatchObject({
      finish: 'error',
      error: { name: 'ProviderAuthError', data: { message: 'Invalid API key provided', statusCode: 200, v2Type: 'provider.auth' } },
    });
    const abort = project(rest('03-abort.json', 'session.messages.asc').data)[1].info;
    expect(abort.error).toEqual({ name: 'MessageAbortedError', data: { message: 'Step interrupted', v2Type: 'aborted' } });
  });

  it('projects running and failed tool parts (vectors 05, 04b)', () => {
    const pending = project(rest('05-question-form.json', 'session.messages.pending').data);
    const question = pending[1].parts.find((part) => part.type === 'tool');
    expect(question).toMatchObject({ tool: 'question', callID: 'call_s05_question', state: { status: 'running', metadata: {}, time: { start: 1767225609000 } } });
    const failed = project(rest('04b-tool-failed.json', 'session.messages.asc').data)[1].parts.find((part) => part.type === 'tool');
    expect(failed.state).toMatchObject({ status: 'error', time: { start: 1767225609000, end: 1767225611000 } });
    expect(failed.state.error).toMatch(/^Invalid arguments for tool "question"/);
  });

  it('projects the subagent tool with v1 vocabulary (vector 10)', () => {
    const records = project(rest('10-child.json', 'parent.session.messages.asc').data);
    const task = records[1].parts.find((part) => part.type === 'tool');
    expect(task).toMatchObject({
      tool: 'task',
      state: {
        status: 'completed',
        input: { agent: 'general', subagent_type: 'general', description: 'probe child' },
        title: 'probe child',
        metadata: { sessionID: 'ses_fffffffffffdnormalized0000', sessionId: 'ses_fffffffffffdnormalized0000' },
      },
      metadata: { opencodeTool: 'subagent' },
    });
  });

  it('computes v1 token totals', () => {
    expect(toV1Tokens({ input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }))
      .toEqual({ total: 15, input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } });
    expect(toV1Tokens(undefined)).toEqual(zeroTokens);
  });

  it('builds the v1 path from a location and subpath', () => {
    expect(toV1PathInfo('/repo/pkg/a', 'pkg/a')).toEqual({ cwd: path.join('/repo', 'pkg/a'), root: '/repo' });
    expect(toV1PathInfo('/repo', '')).toEqual({ cwd: '/repo', root: '/repo' });
    expect(toV1PathInfo(undefined)).toEqual({ cwd: '', root: '' });
  });

  it('does not manufacture a root or change cwd from an inconsistent or external subpath', () => {
    for (const subpath of ['pkg/other', '../a', '/repo/pkg/a']) {
      expect(toV1PathInfo('/repo/pkg/a', subpath)).toEqual({ cwd: '/repo/pkg/a', root: '/repo/pkg/a' });
    }
  });
});

describe('turn summaries', () => {
  const editTool = (id, tool, files, status = 'completed') => ({
    type: 'tool',
    id,
    name: tool,
    state: status === 'completed'
      ? { status, input: { path: 'a' }, content: [{ type: 'text', text: 'ok' }], metadata: { files } }
      : { status: 'running', input: { path: 'a' }, metadata: { files } },
    time: { created: 1 },
  });
  const assistant = (id, content, created) => ({
    id, type: 'assistant', agent: 'build', model: { id: 'm', providerID: 'p' }, content, time: { created, completed: created },
  });

  it('sums edit/write/patch file counts per turn without patch bodies', () => {
    const records = project([
      { id: 'msg_u1', type: 'user', text: 'x', time: { created: 1 } },
      assistant('msg_a1', [
        editTool('c1', 'edit', [{ file: 'a.ts', patch: 'PATCH', additions: 2, deletions: 1, status: 'modified' }]),
        editTool('c2', 'patch', [
          { file: 'a.ts', patch: 'PATCH', additions: 3, deletions: 0, status: 'modified' },
          { file: 'b.ts', patch: 'PATCH', additions: 1, deletions: 0, status: 'added' },
        ]),
        editTool('c3', 'grep', [{ file: 'ignored.ts', additions: 9, deletions: 9 }]),
        editTool('c4', 'write', [{ file: 'running.ts', additions: 9, deletions: 9 }], 'running'),
      ], 2),
      assistant('msg_a2', [editTool('c5', 'write', [{ file: 'c.ts', patch: 'PATCH', additions: 4, deletions: 0, status: 'added' }])], 3),
      { id: 'msg_u2', type: 'user', text: 'y', time: { created: 4 } },
      assistant('msg_a3', [], 5),
    ]);
    expect(records[0].info.summary).toEqual({
      diffs: [
        { file: 'a.ts', additions: 5, deletions: 1, status: 'modified' },
        { file: 'b.ts', additions: 1, deletions: 0, status: 'added' },
        { file: 'c.ts', additions: 4, deletions: 0, status: 'added' },
      ],
    });
    expect(JSON.stringify(records[0].info.summary)).not.toContain('PATCH');
    expect(records[3].info.summary).toBeUndefined();
    expect(turnSummaryDiffs(records).get('msg_u2')).toBeUndefined();
  });

  it('records no summary for 2.0.20 write results without files (vector 06, F8)', () => {
    const records = project(rest('06-permission.json', 'session.messages.asc').data);
    expect(records.filter((record) => record.info.summary !== undefined)).toEqual([]);
  });
});

describe('cursors', () => {
  it('round-trips v2 cursors through the v2: prefix', () => {
    expect(encodeMessageCursor('eyJabc')).toBe('v2:eyJabc');
    expect(encodeMessageCursor(undefined)).toBeUndefined();
    expect(decodeMessageCursor('v2:eyJabc')).toBe('eyJabc');
    expect(decodeMessageCursor(undefined)).toBeUndefined();
    expect(decodeMessageCursor('')).toBeUndefined();
    expect(decodeMessageCursor('msg_123')).toBeNull();
    expect(decodeMessageCursor('v2:')).toBeNull();
    expect(decodeMessageCursor(42)).toBeNull();
  });
});

/** A v2 message list over seq-ordered rows: desc first page, opaque cursors afterwards. */
const createPager = (rows) => {
  const requests = [];
  const cursors = new Map();
  const fetchPage = async (request) => {
    requests.push(request);
    const end = request.cursor === undefined ? rows.length : cursors.get(request.cursor);
    if (end === undefined) throw new Error(`unknown cursor ${request.cursor}`);
    const start = Math.max(0, end - request.limit);
    const data = rows.slice(start, end).reverse();
    const next = `cursor-${start}`;
    cursors.set(next, start);
    return { data, cursor: { previous: `prev-${end}`, next } };
  };
  return { fetchPage, requests };
};

describe('fillMessagePage', () => {
  it('fills a page across the real 01 cursor pages and emits x-next-cursor v2:<next>', async () => {
    const first = rest('01-two-step-tool-turn.json', 'session.messages.desc.limit2');
    const second = rest('01-two-step-tool-turn.json', 'session.messages.cursor.next');
    const requests = [];
    const fetchPage = async (request) => {
      requests.push(request);
      if (request.cursor === undefined) return first;
      if (request.cursor === first.cursor.next) return second;
      throw new Error('unexpected cursor');
    };
    const page = await fillMessagePage({ limit: 2, fetchPage, context });
    expect(requests).toEqual([{ limit: 2 }, { cursor: first.cursor.next, limit: 2 }]);
    expect(page.records.map((record) => record.info.id)).toEqual([mid(1), mid(2), mid(3)]);
    expect(page.records[2].info.parentID).toBe(mid(1));
    expect(page.nextCursor).toBe(`v2:${second.cursor.next}`);
    expect(page.fetches).toBe(2);
  });

  it('keeps an advancing cursor after the work cap so older messages remain reachable', async () => {
    const switches = Array.from({ length: 20 }, (_, index) => ({
      id: `msg_${String(index).padStart(3, '0')}`, type: 'agent-switched', agent: 'build', time: { created: index + 1 },
    }));
    const capped = createPager([{ id: 'msg_older', type: 'user', text: 'Still here', time: { created: 0 } }, ...switches]);
    const page = await fillMessagePage({ limit: 2, fetchPage: capped.fetchPage, context });
    expect(page.records).toEqual([]);
    expect(page.fetches).toBe(1 + MAX_PAGE_FILL_EXTRA_FETCHES);
    expect(page.nextCursor).toMatch(/^v2:cursor-/);

    const ids = [];
    let before = page.nextCursor;
    for (let index = 0; before && index < 4; index += 1) {
      const older = await fillMessagePage({ limit: 2, before, fetchPage: capped.fetchPage, context });
      expect(older.fetches).toBeLessThanOrEqual(1 + MAX_PAGE_FILL_EXTRA_FETCHES);
      expect(older.nextCursor).not.toBe(before);
      ids.push(...older.records.map((record) => record.info.id));
      before = older.nextCursor;
    }
    expect(ids).toEqual(['msg_older']);
    expect(before).toBeUndefined();

    const rows = rest('01-two-step-tool-turn.json', 'session.messages.asc').data;
    const short = createPager(rows);
    const all = await fillMessagePage({ limit: 50, fetchPage: short.fetchPage, context });
    expect(all.records).toHaveLength(3);
    expect(all.nextCursor).toBeUndefined();
  });

  it('rejects a repeated native cursor instead of returning a looping continuation', async () => {
    let fetches = 0;
    const fetchPage = async () => {
      fetches += 1;
      return { data: [{ id: 'msg_idle', type: 'idle', time: { created: 1 } }], cursor: { next: 'same' } };
    };
    await expect(fillMessagePage({ limit: 1, fetchPage, context })).rejects.toBeInstanceOf(InvalidMessagePageError);
    expect(fetches).toBe(2);
  });

  it('passes the decoded cursor through and rejects foreign cursors', async () => {
    const rows = rest('01-two-step-tool-turn.json', 'session.messages.asc').data;
    const pager = createPager(rows);
    const head = await fillMessagePage({ limit: 1, fetchPage: pager.fetchPage, context });
    const older = await fillMessagePage({ limit: 1, before: head.nextCursor, fetchPage: pager.fetchPage, context });
    expect(pager.requests[pager.requests.length - 1].cursor).toBeDefined();
    expect(older.records.length).toBeGreaterThan(0);
    await expect(fillMessagePage({ limit: 1, before: 'msg_v1cursor', fetchPage: pager.fetchPage, context }))
      .rejects.toBeInstanceOf(InvalidMessageCursorError);
    await expect(fillMessagePage({ limit: 1, before: 'msg_v1cursor', fetchPage: pager.fetchPage, context }))
      .rejects.toMatchObject({ code: 'opencode_invalid_cursor', status: 400 });
  });

  it('resolves the native sequence parent for an older-edge assistant when history continues', async () => {
    const rows = [
      { id: 'msg_01', type: 'user', text: 'long turn', time: { created: 100 } },
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `msg_1${index}`, type: 'assistant', agent: 'build', model: { id: 'm', providerID: 'p' }, content: [], time: { created: 200 + index, completed: 200 + index },
      })),
    ];
    const pager = createPager(rows);
    const page = await fillMessagePage({ limit: 2, fetchPage: pager.fetchPage, context });
    expect(page.records.map((record) => [record.info.id, record.info.parentID])).toEqual([
      ['msg_12', 'msg_01'],
      ['msg_13', 'msg_01'],
    ]);
    expect(pager.requests).toEqual([{ limit: 2 }, { cursor: 'cursor-3', limit: 200 }]);
    expect(page.records.map((record) => record.turnOwnership)).toEqual([
      { source: 'native-sequence', userMessageID: 'msg_01' },
      { source: 'native-sequence', userMessageID: 'msg_01' },
    ]);
  });
});



describe('private native status-only turn identity', () => {
  const metadata = { devryan: { v: 1, origin: 'interview', statusOnly: true } };
  const status = {id:'msg_notice',type:'synthetic',metadata,text:'UI ready',time:{created:2}};
  const assistant = {id:'msg_assistant',type:'assistant',agent:'build',model:{id:'m',providerID:'p'},content:[],time:{created:3}};
  it('preserves the visible notice and real user identity across a full page and history index', () => {
    const user = {id:'msg_user',type:'user',metadata,text:'actual request',time:{created:1}};
    const result=projectMessagePage([user,status,assistant],context);
    expect(result.records.map(row=>row.info.id)).toEqual(['msg_user','msg_notice','msg_assistant']);
    expect(result.records[0].nativeStatus).toBeUndefined();
    expect(result.records[1].nativeStatus).toEqual({source:'native-sequence',kind:'status-only'});
    expect(result.records[1].parts[0]).toMatchObject({text:'UI ready',synthetic:true});
    expect(result.records[2].info.parentID).toBe('msg_user');
    expect(result.records[2].turnOwnership).toEqual({source:'native-sequence',userMessageID:'msg_user'});
    expect(buildUserIndex([user,status])).toEqual([{deliveredAt:1,userID:'msg_user'}]);
  });
  it('looks past status-only rows at the older page edge', async () => {
    const rows=[{id:'msg_user',type:'user',text:'request',time:{created:1}},status,assistant];
    const pager=createPager(rows);
    const page=await fillMessagePage({limit:1,fetchPage:pager.fetchPage,context});
    expect(page.records[0].info.parentID).toBe('msg_user');
    expect(page.records[0].turnOwnership).toEqual({source:'native-sequence',userMessageID:'msg_user'});
  });
});
