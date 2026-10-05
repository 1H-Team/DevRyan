import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { EVENT_PROJECTOR_P99_BUDGET_US, runEventProjectorBench } from './events.bench.mjs';
import {
  EMPTY_PROJECTION,
  EVENT_PROJECTOR_DIAGNOSTICS,
  createEventProjector,
  createEventProjectorForGeneration,
} from './events.js';
import { projectMessagePage } from './messages.js';

const VECTORS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__vectors__');
const loadVector = (file) => JSON.parse(fs.readFileSync(path.join(VECTORS, file), 'utf8'));
const framesOf = (file) => loadVector(file).frames
  .filter((frame) => frame.startsWith('data:'))
  .map((frame) => JSON.parse(frame.slice('data:'.length)));
const rest = (file, label) => {
  const entry = loadVector(file).rest.find((item) => item.label === label);
  if (!entry) throw new Error(`missing ${file} ${label}`);
  return entry.body;
};

const SID = 'ses_fffffffffffenormalized0000';
const DIR = '<home>/workspace';
const mid = (n) => `msg_${n.toString(16).padStart(12, '0')}normalized0000`;

const createProjector = (options = {}) => {
  const diagnostics = [];
  const projector = createEventProjector({ recordDiagnostic: (entry) => diagnostics.push(entry), ...options });
  return { projector, diagnostics };
};

/** Projects envelopes in order and returns every emitted event. */
const replay = (projector, envelopes) => envelopes.flatMap((envelope) => [...projector.project(envelope)]);

const types = (events) => events.map((event) => event.payload.type);
const ofType = (events, type) => events.filter((event) => event.payload.type === type).map((event) => event.payload.properties);

/**
 * Folds v1 payloads the way the UI store does (message and part upserts by id,
 * deltas appended, removals), for one session.
 */
const foldStore = (events, sessionID) => {
  const messages = new Map();
  const parts = new Map();
  for (const { payload } of events) {
    const props = payload.properties;
    if (payload.type === 'message.updated' && props.info.sessionID === sessionID) {
      messages.set(props.info.id, props.info);
    } else if (payload.type === 'message.part.updated' && props.part.sessionID === sessionID) {
      let byID = parts.get(props.part.messageID);
      if (!byID) parts.set(props.part.messageID, (byID = new Map()));
      byID.set(props.part.id, props.part);
    } else if (payload.type === 'message.part.delta' && props.sessionID === sessionID) {
      const byID = parts.get(props.messageID);
      const part = byID?.get(props.partID);
      if (!part) throw new Error(`delta before its part: ${props.partID}`);
      byID.set(props.partID, { ...part, [props.field]: `${part[props.field] ?? ''}${props.delta}` });
    } else if (payload.type === 'message.part.removed' && props.sessionID === sessionID) {
      parts.get(props.messageID)?.delete(props.partID);
    } else if (payload.type === 'message.removed' && props.sessionID === sessionID) {
      messages.delete(props.messageID);
      parts.delete(props.messageID);
    }
  }
  return { messages, parts };
};

// LOSS(text-time): a live text part ends at its `text.ended`, a REST one at the step end.
const withoutTextTime = (part) => {
  if (part.type !== 'text') return part;
  const { time: _time, ...rest } = part;
  return rest;
};

/** Asserts the live fold equals the REST projection of a page, record by record. */
const expectLiveEqualsRest = (events, sessionID, page) => {
  const { records } = projectMessagePage(page, { sessionID, directory: DIR });
  const store = foldStore(events, sessionID);
  expect(records.length).toBeGreaterThan(0);
  for (const record of records) {
    expect(store.messages.get(record.info.id)).toEqual(record.info);
    const liveParts = [...(store.parts.get(record.info.id)?.values() ?? [])].map(withoutTextTime);
    expect(liveParts).toEqual(record.parts.map(withoutTextTime));
  }
  return { records, store };
};

/** Moves every delta of an assistant in front of its `step.started` (D1 `deltaFirst:true`). */
const deltaFirst = (envelopes) => {
  const isDelta = (envelope) => envelope.type === 'session.text.delta' || envelope.type === 'session.reasoning.delta';
  const deltasByAssistant = new Map();
  for (const envelope of envelopes) {
    if (!isDelta(envelope)) continue;
    const list = deltasByAssistant.get(envelope.data.assistantMessageID) ?? [];
    list.push(envelope);
    deltasByAssistant.set(envelope.data.assistantMessageID, list);
  }
  const reordered = [];
  for (const envelope of envelopes) {
    if (isDelta(envelope)) continue;
    if (envelope.type === 'session.step.started') reordered.push(...(deltasByAssistant.get(envelope.data.assistantMessageID) ?? []));
    reordered.push(envelope);
  }
  return reordered;
};

describe('generation selection', () => {
  it('gives gen 1 no projection hook and gen 2 a projector', () => {
    expect(createEventProjectorForGeneration(1)).toBeNull();
    expect(createEventProjectorForGeneration(undefined)).toBeNull();
    expect(createEventProjectorForGeneration(2)?.generation).toBe(2);
  });
});

describe('vector 01: two-step tool turn', () => {
  const envelopes = framesOf('01-two-step-tool-turn.json');

  it('emits the B.4 payload sequence with #k ids for extra payloads', () => {
    const { projector, diagnostics } = createProjector();
    const events = replay(projector, envelopes);
    expect(types(events)).toEqual([
      'session.created',
      'session.status',
      'message.updated', 'message.part.updated',
      'message.updated', 'message.updated', 'message.part.updated',
      'message.part.updated', 'message.part.delta', 'message.part.delta',
      'message.part.updated', 'message.part.delta', 'message.part.delta',
      'message.part.updated',
      'message.part.updated',
      'message.part.updated',
      'message.part.updated',
      'message.part.updated', 'message.part.updated',
      'message.part.updated',
      'message.part.updated', 'message.updated',
      'message.updated', 'message.part.updated',
      'message.part.updated', 'message.part.delta', 'message.part.delta', 'message.part.updated',
      'message.part.updated', 'message.updated',
      'session.status', 'session.idle',
    ]);
    // step.started projects 1 -> 3: the refined user record, the assistant, the step-start part.
    const stepStarted = envelopes.find((envelope) => envelope.type === 'session.step.started');
    expect(projector.stats().payloads).toBe(events.length);
    expect(events.filter((event) => event.eventId?.startsWith(stepStarted.id)).map((event) => event.eventId))
      .toEqual([stepStarted.id, `${stepStarted.id}#1`, `${stepStarted.id}#2`]);
    for (const event of events) {
      expect(event.payload.id).toBe(event.eventId);
      expect(event.directory).toBe(DIR);
    }
    expect(diagnostics).toEqual([]);
    expect(projector.takeReseedRequests()).toEqual([]);
  });

  it('streams deltas on the text field with the ordinal part ids', () => {
    const { projector } = createProjector();
    const deltas = ofType(replay(projector, envelopes), 'message.part.delta');
    expect(deltas.map(({ partID, field, delta }) => [partID, field, delta])).toEqual([
      [`${mid(2)}:reasoning:0`, 'text', 'Let me '],
      [`${mid(2)}:reasoning:0`, 'text', 'think.'],
      [`${mid(2)}:text:0`, 'text', 'I will '],
      [`${mid(2)}:text:0`, 'text', 'probe.'],
      [`${mid(3)}:text:0`, 'text', 'All '],
      [`${mid(3)}:text:0`, 'text', 'done.'],
    ]);
    expect(deltas.every((delta) => delta.sessionID === SID)).toBe(true);
  });

  it('derives busy then idle status, with session.idle at the terminal', () => {
    const { projector } = createProjector();
    const events = replay(projector, envelopes);
    expect(ofType(events, 'session.status').map((status) => status.status)).toEqual([{ type: 'busy' }, { type: 'idle' }]);
    expect(ofType(events, 'session.status').at(-1).userMessageID).toBe(mid(1));
    expect(ofType(events, 'session.idle')).toEqual([{ sessionID: SID }]);
    expect(projector.sessionStatus(SID)).toEqual({ type: 'idle' });
  });

  it('folds to exactly the REST projection of the same turn', () => {
    const { projector } = createProjector();
    const events = replay(projector, envelopes);
    expectLiveEqualsRest(events, SID, rest('01-two-step-tool-turn.json', 'session.messages.asc').data);
  });

  it('keeps the v2 tool input reference (no alias applies to sim_probe)', () => {
    const { projector } = createProjector();
    const called = envelopes.find((envelope) => envelope.type === 'session.tool.called');
    const events = replay(projector, envelopes.slice(0, envelopes.indexOf(called) + 1));
    const running = ofType(events, 'message.part.updated').map((props) => props.part)
      .filter((part) => part.type === 'tool' && part.state.status === 'running');
    expect(running).toHaveLength(1);
    expect(running[0].state.input).toBe(called.data.input);
  });

  it('builds session.created from the event with the envelope time', () => {
    const { projector } = createProjector();
    const [created] = replay(projector, envelopes.slice(0, 1));
    expect(created.payload).toEqual({
      id: envelopes[0].id,
      type: 'session.created',
      properties: {
        sessionID: SID,
        info: {
          id: SID,
          slug: 'slug-1',
          projectID: 'global',
          directory: DIR,
          title: 'Two-step tool turn',
          version: '2',
          time: { created: envelopes[0].created, updated: envelopes[0].created },
        },
      },
    });
  });
});

describe('reviewed skill names on the live stream', () => {
  it('names the running and completed skill row from metadata, never from the hashed id', () => {
    const hashed = 'devryan-539ddc37a961e3aceadfc7bbb540b8e7';
    const envelopes = framesOf('01-two-step-tool-turn.json');
    const called = envelopes.find((envelope) => envelope.type === 'session.tool.called');
    const prefix = envelopes.slice(0, envelopes.indexOf(called) + 1).map((envelope) => {
      if (envelope.type === 'session.tool.input.started') return { ...envelope, data: { ...envelope.data, name: 'skill' } };
      if (envelope === called) return { ...envelope, data: { ...envelope.data, input: { id: hashed } } };
      return envelope;
    });
    const tool = (type, offset, data) => ({
      id: `${called.id}_${type}`, created: called.created + offset, type, location: { directory: DIR },
      data: { sessionID: SID, assistantMessageID: called.data.assistantMessageID, id: called.data.id, ...data },
    });
    const { projector } = createProjector();
    const events = replay(projector, [
      ...prefix,
      tool('session.tool.progress', 1, { metadata: { name: 'Superpowers' } }),
      tool('session.tool.success', 2, { content: [{ type: 'text', text: '<skill_content name="Superpowers">' }], metadata: { name: 'Superpowers', directory: '/skills/superpowers' } }),
    ]);
    const states = ofType(events, 'message.part.updated').map((props) => props.part)
      .filter((part) => part.type === 'tool' && part.tool === 'skill').map((part) => part.state);
    expect(states.map((state) => [state.status, state.input?.name, state.title])).toEqual([
      ['pending', undefined, undefined],
      ['running', undefined, undefined],
      ['running', 'Superpowers', 'Superpowers'],
      ['completed', 'Superpowers', 'Superpowers'],
    ]);
  });
});

describe('first-sight rule (D1 deltaFirst)', () => {
  const ordered = framesOf('01-two-step-tool-turn.json');
  const reordered = deltaFirst(ordered);

  it('announces the assistant and a typed empty part before the first delta', () => {
    const { projector } = createProjector();
    const events = replay(projector, reordered);
    const firstDelta = reordered.find((envelope) => envelope.type === 'session.reasoning.delta');
    const fromFirstDelta = events.filter((event) => event.eventId?.startsWith(firstDelta.id));
    expect(fromFirstDelta.map((event) => [event.eventId, event.payload.type])).toEqual([
      [firstDelta.id, 'message.updated'],
      [`${firstDelta.id}#1`, 'message.part.updated'],
      [`${firstDelta.id}#2`, 'message.part.delta'],
    ]);
    const [info, part, delta] = fromFirstDelta.map((event) => event.payload.properties);
    expect(info.info).toMatchObject({ id: mid(2), role: 'assistant', parentID: mid(1), sessionID: SID });
    expect(part.part).toMatchObject({ id: `${mid(2)}:reasoning:0`, type: 'reasoning', text: '' });
    expect(delta).toMatchObject({ partID: `${mid(2)}:reasoning:0`, field: 'text', delta: 'Let me ' });
  });

  it('makes the durable started events no-ops and completes the info at step.started', () => {
    const { projector } = createProjector();
    const events = [];
    for (const envelope of reordered) {
      const projected = projector.project(envelope);
      if (envelope.type === 'session.reasoning.started' || envelope.type === 'session.text.started') {
        expect(projected).toBe(EMPTY_PROJECTION);
      }
      if (envelope.type === 'session.step.started' && envelope.data.assistantMessageID === mid(2)) {
        expect(projected.map((event) => event.payload.type)).toEqual(['message.updated', 'message.updated', 'message.part.updated']);
        expect(projected[1].payload.properties.info.time.created).toBe(envelope.data.started);
      }
      events.push(...projected);
    }
    // The reasoning part never became a text part.
    const reasoningParts = ofType(events, 'message.part.updated').map((props) => props.part)
      .filter((part) => part.id === `${mid(2)}:reasoning:0`);
    expect(reasoningParts.every((part) => part.type === 'reasoning')).toBe(true);
    expect(ofType(events, 'message.part.delta').every((delta) => delta.field === 'text')).toBe(true);
  });

  it('folds to the same records as the in-order stream, keyed by part id', () => {
    const { projector } = createProjector();
    const { records } = projectMessagePage(rest('01-two-step-tool-turn.json', 'session.messages.asc').data, {
      sessionID: SID, directory: DIR,
    });
    const store = foldStore(replay(projector, reordered), SID);
    // The UI keys parts by id; a first-sight part is inserted before the step-start part, and a
    // reasoning part announced by its first delta starts at that delta's envelope time.
    const comparable = (part) => {
      const stripped = withoutTextTime(part);
      return stripped.type === 'reasoning' ? { ...stripped, time: { end: stripped.time.end } } : stripped;
    };
    const byID = (parts) => Object.fromEntries(parts.map((part) => [part.id, comparable(part)]));
    for (const record of records) {
      expect(store.messages.get(record.info.id)).toEqual(record.info);
      expect(byID([...(store.parts.get(record.info.id)?.values() ?? [])])).toEqual(byID(record.parts));
    }
  });
});

describe('REST agreement across vectors', () => {
  it.each([
    ['02-retry.json', 'session.messages.asc', SID],
    ['03-abort.json', 'session.messages.asc', SID],
    ['04-failure.json', 'session.messages.asc', SID],
    ['04b-tool-failed.json', 'session.messages.asc', SID],
    ['05-question-form.json', 'session.messages.asc', SID],
    ['05b-question-dismissed.json', 'session.messages.asc', SID],
    ['06-permission.json', 'session.messages.asc', SID],
    ['07-compaction.json', 'after.session.messages.asc', SID],
    ['08-revert.json', 'committed.session.messages.asc', SID],
    ['09-rename-metadata.json', 'session.messages.asc', 'ses_fffffffffff3normalized0000'],
    ['10-child.json', 'parent.session.messages.asc', SID],
    ['10-child.json', 'child.session.messages.asc', 'ses_fffffffffffdnormalized0000'],
    ['11-synthetic.json', 'session.messages.asc', SID],
    ['12-steer-queue-switch.json', 'session.messages.asc', SID],
  ])(
    '%s live fold equals %s',
    (file, label, sessionID) => {
      const { projector, diagnostics } = createProjector();
      expectLiveEqualsRest(replay(projector, framesOf(file)), sessionID, rest(file, label).data);
      expect(diagnostics.filter((entry) => entry.code !== EVENT_PROJECTOR_DIAGNOSTICS.form)).toEqual([]);
    },
  );
});

describe('vector 02: retry on the same assistant', () => {
  it('goes busy -> retry -> busy -> idle and moves the restarted assistant time', () => {
    const { projector } = createProjector();
    const envelopes = framesOf('02-retry.json');
    const events = replay(projector, envelopes);
    const retry = envelopes.find((envelope) => envelope.type === 'session.retry.scheduled');
    expect(ofType(events, 'session.status').map((props) => props.status)).toEqual([
      { type: 'busy' },
      { type: 'retry', attempt: 2, message: 'Rate limit exceeded, please retry', next: retry.data.at },
      { type: 'busy' },
      { type: 'idle' },
    ]);
    const assistantTimes = ofType(events, 'message.updated')
      .filter((props) => props.info.id === mid(2))
      .map((props) => props.info.time.created);
    const starts = envelopes.filter((envelope) => envelope.type === 'session.step.started').map((envelope) => envelope.data.started);
    expect(assistantTimes[0]).toBe(starts[0]);
    expect(assistantTimes.at(-1)).toBe(starts[1]);
  });

  it('removes content announced by an attempt that restarted', () => {
    const { projector } = createProjector();
    const envelopes = framesOf('02-retry.json');
    const [firstStart, secondStart] = envelopes.filter((envelope) => envelope.type === 'session.step.started');
    const partial = {
      ...firstStart,
      id: 'evt_partial',
      type: 'session.text.delta',
      data: { sessionID: SID, assistantMessageID: mid(2), ordinal: 0, delta: 'half' },
    };
    const withPartial = [...envelopes];
    withPartial.splice(withPartial.indexOf(firstStart) + 1, 0, partial);
    const events = replay(projector, withPartial);
    const atRestart = events.filter((event) => event.eventId?.startsWith(secondStart.id)).map((event) => event.payload);
    expect(atRestart[0]).toMatchObject({
      type: 'message.part.removed',
      properties: { sessionID: SID, messageID: mid(2), partID: `${mid(2)}:text:0` },
    });
    expectLiveEqualsRest(events, SID, rest('02-retry.json', 'session.messages.asc').data);
  });
});

describe('execution terminals', () => {
  it('maps an abort to MessageAbortedError, then idle and session.idle', () => {
    const { projector } = createProjector();
    const events = replay(projector, framesOf('03-abort.json'));
    const tail = events.slice(-3).map((event) => event.payload);
    expect(tail.map((payload) => payload.type)).toEqual(['session.error', 'session.status', 'session.idle']);
    expect(tail[0].properties).toEqual({
      sessionID: SID,
      error: { name: 'MessageAbortedError', data: { message: 'Aborted', reason: 'user', v2Type: 'aborted' } },
    });
    const assistant = ofType(events, 'message.updated').filter((props) => props.info.id === mid(2)).at(-1).info;
    expect(assistant).toMatchObject({ finish: 'error', error: { name: 'MessageAbortedError' } });
  });

  it('maps an execution failure to session.error with the B.3 error', () => {
    const { projector } = createProjector();
    const events = replay(projector, framesOf('04-failure.json'));
    const tail = events.slice(-3).map((event) => event.payload);
    expect(tail.map((payload) => payload.type)).toEqual(['session.error', 'session.status', 'session.idle']);
    expect(tail[0].properties.error).toEqual({
      name: 'ProviderAuthError',
      data: { message: 'Invalid API key provided', statusCode: 200, v2Type: 'provider.auth' },
    });
  });

  it('treats a shutdown interrupt as a restart candidate (active reconciliation queued)', () => {
    const { projector } = createProjector();
    const events = replay(projector, framesOf('05b-question-dismissed.json'));
    expect(ofType(events, 'session.error')).toEqual([]);
    expect(projector.takeReseedRequests()).toContainEqual({ kind: 'active', reason: 'interrupted_shutdown' });
  });

  it('maps tool.failed to an error tool state', () => {
    const { projector } = createProjector();
    const events = replay(projector, framesOf('04b-tool-failed.json'));
    const failed = ofType(events, 'message.part.updated').map((props) => props.part)
      .find((part) => part.type === 'tool' && part.state.status === 'error');
    expect(failed).toMatchObject({ callID: 'call_s04b_question', tool: 'question' });
    expect(failed.state.error).toContain('Invalid arguments for tool "question"');
  });

  it('ignores native session.status and session.idle with a diagnostic', () => {
    const { projector, diagnostics } = createProjector();
    expect(projector.project({ id: 'evt_x', type: 'session.status', data: { sessionID: SID, status: { type: 'busy' } } }))
      .toBe(EMPTY_PROJECTION);
    expect(projector.project({ id: 'evt_y', type: 'session.idle', data: { sessionID: SID } })).toBe(EMPTY_PROJECTION);
    expect(diagnostics.map((entry) => [entry.code, entry.type])).toEqual([
      [EVENT_PROJECTOR_DIAGNOSTICS.nativeStatus, 'session.status'],
      [EVENT_PROJECTOR_DIAGNOSTICS.nativeStatus, 'session.idle'],
    ]);
  });
});

describe('questions and permissions', () => {
  it('maps forms to questions and queues a cancel for an external-field form', () => {
    const { projector, diagnostics } = createProjector();
    const events = replay(projector, framesOf('05-question-form.json'));
    const asked = ofType(events, 'question.asked');
    expect(asked[0]).toMatchObject({
      id: 'frm_000000000001normalized0000',
      sessionID: SID,
      tool: { messageID: mid(2), callID: 'call_s05_question' },
    });
    expect(asked[0].questions.map((question) => question.header)).toEqual(['Color', 'Sizes']);
    expect(ofType(events, 'question.replied')[0]).toEqual({
      sessionID: SID, requestID: 'frm_000000000001normalized0000', answers: [['Red'], ['S', 'M']],
    });
    expect(asked.map((question) => question.id)).not.toContain('frm_000000000003normalized0000');
    expect(ofType(events, 'question.rejected')).toEqual([{ sessionID: SID, requestID: 'frm_000000000003normalized0000' }]);
    expect(diagnostics).toEqual([expect.objectContaining({
      code: EVENT_PROJECTOR_DIAGNOSTICS.form, reason: 'external_field', formID: 'frm_000000000003normalized0000',
    })]);
    expect(projector.takeReseedRequests()).toEqual([{
      kind: 'form-cancel', sessionID: SID, formID: 'frm_000000000003normalized0000', reason: 'external_field',
    }]);
  });

  it('projects permission.asked to the v1 request and caches the session', () => {
    const { projector } = createProjector();
    const envelopes = framesOf('06-permission.json');
    const askedAt = envelopes.findIndex((envelope) => envelope.type === 'permission.asked');
    const events = replay(projector, envelopes.slice(0, askedAt + 1));
    const asked = ofType(events, 'permission.asked')[0];
    expect(asked).toMatchObject({
      id: 'per_000000000001normalized0000',
      sessionID: SID,
      permission: 'edit',
      patterns: ['notes.txt'],
      always: ['*'],
      tool: { messageID: mid(2), callID: 'call_s06_write' },
    });
    expect(projector.permissionSession('per_000000000001normalized0000')).toBe(SID);
    const replied = replay(projector, envelopes.slice(askedAt + 1, askedAt + 2));
    expect(replied.map((event) => event.payload)).toEqual([{
      id: envelopes[askedAt + 1].id,
      type: 'permission.replied',
      properties: { sessionID: SID, requestID: 'per_000000000001normalized0000', reply: 'once' },
    }]);
    expect(projector.permissionSession('per_000000000001normalized0000')).toBeUndefined();
  });
});

describe('vector 07: compaction', () => {
  it('emits the pair, streams the summary and ends with session.compacted', () => {
    const { projector } = createProjector();
    const envelopes = framesOf('07-compaction.json');
    const events = replay(projector, envelopes);
    const started = envelopes.find((envelope) => envelope.type === 'session.compaction.started');
    const atStart = events.filter((event) => event.eventId?.startsWith(started.id)).map((event) => event.payload);
    expect(atStart.map((payload) => [payload.type, payload.properties.info?.id ?? payload.properties.part?.id])).toEqual([
      ['message.updated', mid(4)],
      ['message.part.updated', `${mid(4)}:compaction`],
      ['message.updated', `${mid(4)}:summary`],
      ['message.part.updated', `${mid(4)}:summary:text:0`],
    ]);
    const delta = ofType(events, 'message.part.delta').find((props) => props.messageID === `${mid(4)}:summary`);
    expect(delta).toMatchObject({ partID: `${mid(4)}:summary:text:0`, field: 'text' });
    expect(ofType(events, 'session.compacted')).toEqual([{ sessionID: SID }]);
    // The turn after compaction is parented on the compaction user record.
    const next = ofType(events, 'message.updated').find((props) => props.info.id === mid(7));
    expect(next.info.parentID).toBe(mid(6));
  });
});

describe('compaction without an inbox item (auto, context overflow)', () => {
  const C07 = '07-compaction.json';
  /** Core's `SessionMessage.ID.fromEvent`. */
  const fromEvent = (eventId) => eventId.replace(/^evt_/, 'msg_');
  const isCompactionInbox = (envelope) => (
    (envelope.type === 'session.inbox.enqueued' && envelope.data.item.type === 'compaction')
    || (envelope.type === 'session.inbox.delivered' && envelope.data.inboxID === mid(4))
  );
  /** Vector 07 as core publishes an auto compaction: no inbox item and no inputID. */
  const autoFrames = () => framesOf(C07)
    .filter((envelope) => !isCompactionInbox(envelope))
    .map((envelope) => (envelope.type === 'session.compaction.started'
      ? { ...envelope, data: { sessionID: SID, reason: 'auto', recent: '' } }
      : envelope));
  /** The REST page with the compaction row re-keyed the way core keys it. */
  const autoPage = (id, fields = {}) => rest(C07, 'after.session.messages.asc').data.map((row) => (
    row.type === 'compaction' ? { ...row, id, reason: 'auto', ...fields } : row
  ));

  it('keys the pair on the started event id and streams to it (no diagnostics)', () => {
    const { projector, diagnostics } = createProjector();
    const envelopes = autoFrames();
    const started = envelopes.find((envelope) => envelope.type === 'session.compaction.started');
    const id = fromEvent(started.id);
    const events = replay(projector, envelopes);
    const atStart = events.filter((event) => event.eventId?.startsWith(started.id)).map((event) => event.payload);
    expect(atStart.map((payload) => [payload.type, payload.properties.info?.id ?? payload.properties.part?.id])).toEqual([
      ['message.updated', id],
      ['message.part.updated', `${id}:compaction`],
      ['message.updated', `${id}:summary`],
      ['message.part.updated', `${id}:summary:text:0`],
    ]);
    expect(atStart[1].properties.part.auto).toBe(true);
    expect(ofType(events, 'message.part.delta').filter((props) => props.messageID === `${id}:summary`)).toHaveLength(1);
    expect(ofType(events, 'session.compacted')).toEqual([{ sessionID: SID }]);
    expect(diagnostics).toEqual([]);
    expect(projector.takeReseedRequests()).toEqual([]);
    expectLiveEqualsRest(events, SID, autoPage(id));
  });

  it('buffers summary deltas that precede compaction.started into the announced pair', () => {
    const { projector, diagnostics } = createProjector();
    const ordered = autoFrames();
    const started = ordered.find((envelope) => envelope.type === 'session.compaction.started');
    const delta = ordered.find((envelope) => envelope.type === 'session.compaction.delta');
    const reordered = ordered.filter((envelope) => envelope !== delta);
    reordered.splice(reordered.indexOf(started), 0, delta);
    const id = fromEvent(started.id);
    const events = [];
    for (const envelope of reordered) {
      const projected = projector.project(envelope);
      if (envelope === delta) expect(projected).toBe(EMPTY_PROJECTION);
      events.push(...projected);
    }
    const summaryPart = events.find((event) => event.eventId === `${started.id}#3`).payload.properties.part;
    expect(summaryPart).toMatchObject({ id: `${id}:summary:text:0`, text: delta.data.text });
    expect(diagnostics).toEqual([]);
    expectLiveEqualsRest(events, SID, autoPage(id));
  });

  it('appends a completed pair keyed on the ended event id when none is running', () => {
    const { projector, diagnostics } = createProjector();
    const envelopes = autoFrames().filter((envelope) => (
      envelope.type !== 'session.compaction.started' && envelope.type !== 'session.compaction.delta'
    ));
    const ended = envelopes.find((envelope) => envelope.type === 'session.compaction.ended');
    const id = fromEvent(ended.id);
    const events = replay(projector, envelopes);
    const atEnd = events.filter((event) => event.eventId?.startsWith(ended.id)).map((event) => event.payload);
    expect(atEnd.map((payload) => payload.type)).toEqual([
      'message.updated', 'message.part.updated', 'message.updated', 'message.part.updated', 'session.compacted',
    ]);
    expect(atEnd[2].properties.info).toMatchObject({ id: `${id}:summary`, finish: 'stop', summary: true });
    expect(diagnostics).toEqual([]);
    expectLiveEqualsRest(events, SID, autoPage(id, { reason: 'manual', time: { created: ended.created } }));
  });

  it('keys an unmatched failure on its inputID, else its event id', () => {
    const { projector } = createProjector();
    replay(projector, framesOf(C07).slice(0, 1));
    const failed = (id, data) => projector.project({
      id, created: 1767225700000, type: 'session.compaction.failed', location: { directory: DIR },
      data: { sessionID: SID, reason: 'auto', error: { type: 'compaction.failed', message: 'no' }, ...data },
    });
    const byEvent = failed('evt_00000000fail', {});
    expect(byEvent.map((event) => event.payload.properties.info?.id).filter(Boolean))
      .toEqual(['msg_00000000fail', 'msg_00000000fail:summary']);
    expect(byEvent.at(-1).payload.type).toBe('message.updated');
    expect(byEvent.at(-1).payload.properties.info).toMatchObject({ finish: 'error', error: { data: { message: 'no' } } });
    const byInput = failed('evt_00000001fail', { inputID: 'msg_input' });
    expect(byInput[0].payload.properties.info.id).toBe('msg_input');
  });

  it('adopts a running compaction from the history seed of a cold session', () => {
    const { projector, diagnostics } = createProjector();
    const envelopes = autoFrames();
    const started = envelopes.find((envelope) => envelope.type === 'session.compaction.started');
    const id = fromEvent(started.id);
    // Join after compaction.started: the projector never saw it.
    const tail = envelopes.slice(envelopes.indexOf(started) + 1);
    const delta = tail.find((envelope) => envelope.type === 'session.compaction.delta');
    expect(replay(projector, tail.slice(0, tail.indexOf(delta) + 1))).toEqual([]);
    expect(diagnostics.map((entry) => [entry.code, entry.reason])).toEqual([
      [EVENT_PROJECTOR_DIAGNOSTICS.compactionUnknown, 'cold_session'],
    ]);
    expect(projector.takeReseedRequests()).toContainEqual({ kind: 'history', sessionID: SID, reason: 'cold_session' });
    const page = rest(C07, 'session.messages.asc').data.slice(0, 3).concat([{
      type: 'compaction', id, time: { created: started.created }, status: 'running', reason: 'auto', summary: '', recent: '',
    }]);
    const seeded = projector.applyHistory(SID, page);
    expect(seeded.map((event) => [event.payload.type, event.payload.properties.partID, event.payload.properties.delta]))
      .toEqual([['message.part.delta', `${id}:summary:text:0`, delta.data.text]]);
    const later = replay(projector, tail.slice(tail.indexOf(delta) + 1));
    const summary = ofType(later, 'message.updated').find((props) => props.info.id === `${id}:summary`);
    expect(summary.info).toMatchObject({ finish: 'stop', parentID: id });
    expect(ofType(later, 'session.compacted')).toEqual([{ sessionID: SID }]);
    expect(diagnostics).toHaveLength(1);
  });

  it('records one diagnostic for a stream of unattributable deltas in a cold session', () => {
    const { projector, diagnostics } = createProjector();
    for (let index = 0; index < 5; index += 1) {
      projector.project({
        id: `evt_cd${index}`, created: 10 + index, type: 'session.compaction.delta', location: { directory: DIR },
        data: { sessionID: SID, text: 'x' },
      });
    }
    const ended = projector.project({
      id: 'evt_ce', created: 20, type: 'session.compaction.ended', location: { directory: DIR },
      data: { sessionID: SID, reason: 'auto', text: 'xxxxx' },
    });
    expect(types(ended)).toEqual(['session.compacted']);
    expect(diagnostics.filter((entry) => entry.code === EVENT_PROJECTOR_DIAGNOSTICS.compactionUnknown)).toHaveLength(1);
  });
});

describe('vector 08: revert', () => {
  it('folds staged/cleared into session.updated and removes messages from `to` on commit', () => {
    const { projector, diagnostics } = createProjector();
    const envelopes = framesOf('08-revert.json');
    const events = replay(projector, envelopes);
    const updates = ofType(events, 'session.updated').map((props) => props.info.revert);
    expect(updates).toEqual([
      { messageID: mid(4), files: [] },
      undefined,
      { messageID: mid(4), files: [] },
      undefined,
    ]);
    const committed = envelopes.find((envelope) => envelope.type === 'session.revert.committed');
    const atCommit = events.filter((event) => event.eventId?.startsWith(committed.id)).map((event) => event.payload);
    expect(atCommit.map((payload) => [payload.type, payload.properties.messageID])).toEqual([
      ['message.removed', mid(4)],
      ['message.removed', mid(5)],
      ['session.updated', undefined],
    ]);
    expect(diagnostics).toEqual([]);
  });

  it('asks for a global gap when the revert target is unknown', () => {
    const { projector, diagnostics } = createProjector();
    replay(projector, framesOf('08-revert.json').slice(0, 1));
    const events = projector.project({
      id: 'evt_commit', created: 1, type: 'session.revert.committed', location: { directory: DIR },
      data: { sessionID: SID, to: 'msg_unknown' },
    });
    expect(types(events)).toEqual([]);
    expect(diagnostics.map((entry) => entry.code)).toEqual([EVENT_PROJECTOR_DIAGNOSTICS.revertTargetUnknown]);
    expect(projector.takeReseedRequests()).toContainEqual({
      kind: 'gap', scope: 'global', sessionID: SID, reason: 'revert_target_unknown',
    });
  });
});

describe('vector 09: rename, metadata and no-op suppression', () => {
  const S09 = 'ses_fffffffffff3normalized0000';

  it('emits session.updated only for UI-relevant changes and todo.updated on rev changes', () => {
    const { projector } = createProjector();
    const envelopes = framesOf('09-rename-metadata.json');
    const events = replay(projector, envelopes);
    const updates = ofType(events, 'session.updated').map((props) => ({
      title: props.info.title, archived: props.info.time.archived,
    }));
    expect(updates).toEqual([
      { title: 'Generated title', archived: undefined },
      { title: 'Renamed by user', archived: undefined },
      { title: 'Renamed by user', archived: 1767225601000 },
      { title: 'Renamed by user', archived: undefined },
    ]);
    // The permissions patch and the third metadata patch change nothing the UI shows.
    const permissions = envelopes.find((envelope) => envelope.type === 'session.permissions');
    expect(events.some((event) => event.eventId === permissions.id)).toBe(false);
    expect(ofType(events, 'todo.updated')).toEqual([
      { sessionID: S09, todos: [{ content: 'x', status: 'pending' }] },
      { sessionID: S09, todos: [] },
    ]);
  });

  it('suppresses a repeated rename and a repeated busy status', () => {
    const { projector } = createProjector();
    replay(projector, framesOf('09-rename-metadata.json').slice(0, 1));
    const rename = (id) => projector.project({
      id, created: 2, type: 'session.renamed', location: { directory: DIR }, data: { sessionID: S09, title: 'Same' },
    });
    expect(types(rename('evt_r1'))).toEqual(['session.updated']);
    expect(rename('evt_r2')).toBe(EMPTY_PROJECTION);
    const started = (id) => projector.project({ id, created: 3, type: 'session.execution.started', data: { sessionID: S09 } });
    expect(types(started('evt_s1'))).toEqual(['session.status']);
    expect(started('evt_s2')).toBe(EMPTY_PROJECTION);
  });

  it('queues a session seed for forks and announces them as created', () => {
    const { projector } = createProjector();
    replay(projector, framesOf('09-rename-metadata.json'));
    const forks = projector.takeReseedRequests();
    expect(forks).toEqual([
      { kind: 'session', sessionID: 'ses_fffffffffff2normalized0000', reason: 'forked' },
      { kind: 'session', sessionID: 'ses_fffffffffff1normalized0000', reason: 'forked' },
    ]);
    const fork = rest('09-rename-metadata.json', 'fork.session.get').data;
    const seeded = projector.applySession(fork.id, fork);
    expect(seeded.map((event) => [event.eventId, event.directory, event.payload.type])).toEqual([
      [undefined, DIR, 'session.created'],
    ]);
    expect(seeded[0].payload.properties.info).toMatchObject({ id: fork.id, directory: DIR });
    expect(seeded[0].payload.properties.info.parentID).toBeUndefined();
  });
});

describe('vector 10: child sessions', () => {
  it('creates the child with parentID and aliases the subagent session id', () => {
    const { projector } = createProjector();
    const events = replay(projector, framesOf('10-child.json'));
    const child = ofType(events, 'session.created').find((props) => props.info.parentID === SID);
    expect(child.info).toMatchObject({ id: 'ses_fffffffffffdnormalized0000', parentID: SID, agent: 'general' });
    const progress = ofType(events, 'message.part.updated').map((props) => props.part)
      .find((part) => part.tool === 'task' && part.state.status === 'running' && part.state.metadata.sessionID);
    expect(progress.state.metadata).toMatchObject({
      sessionID: 'ses_fffffffffffdnormalized0000', sessionId: 'ses_fffffffffffdnormalized0000',
    });
    expect(progress.state.input).toMatchObject({ agent: 'general', subagent_type: 'general' });
    // An inherited todo (owner is another session) is not this session's list.
    expect(ofType(events, 'todo.updated')).toEqual([]);
  });
});

describe('vector 12: steered prompt', () => {
  it('re-parents later steps and reports the model switch', () => {
    const { projector } = createProjector();
    const events = replay(projector, framesOf('12-steer-queue-switch.json'));
    const parents = new Map(ofType(events, 'message.updated')
      .filter((props) => props.info.role === 'assistant')
      .map((props) => [props.info.id, props.info.parentID]));
    expect(Object.fromEntries(parents)).toEqual({ [mid(2)]: mid(1), [mid(6)]: mid(4), [mid(7)]: mid(5) });
    expect(ofType(events, 'session.updated').map((props) => props.info.model))
      .toEqual([{ id: 'm2', providerID: 'sim' }]);
  });
});

describe('first sight before a steered delivery', () => {
  it('re-derives the guessed parent at step.started (fold equals REST)', () => {
    const ordered = framesOf('12-steer-queue-switch.json');
    const delivered = ordered.find((envelope) => envelope.type === 'session.inbox.delivered' && envelope.data.inboxID === mid(4));
    const delta = ordered.find((envelope) => envelope.type === 'session.text.delta' && envelope.data.assistantMessageID === mid(6));
    const reordered = ordered.filter((envelope) => envelope !== delta);
    reordered.splice(reordered.indexOf(delivered), 0, delta);
    const { projector, diagnostics } = createProjector();
    const events = replay(projector, reordered);
    const firstSight = events.find((event) => event.eventId === delta.id).payload.properties.info;
    expect(firstSight).toMatchObject({ id: mid(6), parentID: mid(1) });
    const parents = new Map(ofType(events, 'message.updated')
      .filter((props) => props.info.role === 'assistant')
      .map((props) => [props.info.id, props.info.parentID]));
    expect(Object.fromEntries(parents)).toEqual({ [mid(2)]: mid(1), [mid(6)]: mid(4), [mid(7)]: mid(5) });
    const { records } = projectMessagePage(rest('12-steer-queue-switch.json', 'session.messages.asc').data, {
      sessionID: SID, directory: DIR,
    });
    const store = foldStore(events, SID);
    const byID = (parts) => Object.fromEntries(parts.map((part) => [part.id, withoutTextTime(part)]));
    for (const record of records) {
      expect(store.messages.get(record.info.id)).toEqual(record.info);
      expect(byID([...(store.parts.get(record.info.id)?.values() ?? [])])).toEqual(byID(record.parts));
    }
    expect(diagnostics).toEqual([]);
  });
});

describe('late events for an assistant that already ended', () => {
  it('never announces an empty part or a blank info over the ended assistant', () => {
    const { projector } = createProjector();
    const envelopes = framesOf('01-two-step-tool-turn.json');
    const firstEnd = envelopes.find((envelope) => envelope.type === 'session.step.ended');
    replay(projector, envelopes.slice(0, envelopes.indexOf(firstEnd) + 1));
    projector.takeReseedRequests();
    const late = (type, data) => projector.project({
      id: `evt_late_${type}`, created: firstEnd.created + 1, type, location: { directory: DIR },
      data: { sessionID: SID, assistantMessageID: mid(2), ordinal: 0, ...data },
    });
    expect(types(late('session.text.started', {}))).toEqual([]);
    expect(types(late('session.text.delta', { delta: 'more' }))).toEqual(['message.part.delta']);
    expect(types(late('session.step.ended', { finish: 'stop' }))).toEqual(['message.part.updated']);
    expect(projector.takeReseedRequests()).toEqual([
      { kind: 'message', sessionID: SID, messageID: mid(2), reason: 'late_assistant' },
    ]);
  });
});

describe('turn summaries (B.6)', () => {
  it('emits the user record with patch-free diffs at the execution terminal, equal to REST', () => {
    const files = [{ file: 'a.txt', patch: '@@ -1 +1,2 @@', additions: 2, deletions: 1, status: 'modified' }];
    // Vector 01 with its tool turned into an edit that reports file counts.
    const envelopes = framesOf('01-two-step-tool-turn.json').map((envelope) => {
      if (envelope.type === 'session.tool.input.started') return { ...envelope, data: { ...envelope.data, name: 'edit' } };
      if (envelope.type === 'session.tool.success') {
        return { ...envelope, data: { ...envelope.data, metadata: { truncated: false, files } } };
      }
      return envelope;
    });
    const page = rest('01-two-step-tool-turn.json', 'session.messages.asc').data.map((row) => (
      row.type !== 'assistant' ? row : {
        ...row,
        content: row.content.map((item) => (item.type !== 'tool' ? item : {
          ...item, name: 'edit', state: { ...item.state, metadata: { truncated: false, files } },
        })),
      }
    ));
    const { projector } = createProjector();
    const events = replay(projector, envelopes);
    const terminal = envelopes.at(-1);
    const atTerminal = events.filter((event) => event.eventId?.startsWith(terminal.id)).map((event) => event.payload);
    expect(atTerminal.map((payload) => payload.type)).toEqual(['message.updated', 'session.status', 'session.idle']);
    expect(atTerminal[0].properties.info.summary).toEqual({
      diffs: [{ file: 'a.txt', additions: 2, deletions: 1, status: 'modified' }],
    });
    expectLiveEqualsRest(events, SID, page);
  });
});

describe('session folds', () => {
  const base = (type, data, extra = {}) => ({
    id: `evt_${type}`, created: 50, type, location: { directory: DIR }, data: { sessionID: SID, ...data }, ...extra,
  });

  it('reports agent, model and move changes and drops the session state on delete', () => {
    const { projector } = createProjector();
    replay(projector, framesOf('01-two-step-tool-turn.json').slice(0, 1));
    const agent = projector.project(base('session.agent.selected', { agent: 'plan' }));
    expect(agent[0].payload.properties.info).toMatchObject({ agent: 'plan', time: { updated: 50 } });
    const moved = projector.project(base('session.moved', {
      location: { directory: '<home>/other' }, projectID: 'global', subpath: 'pkg',
    }, { location: { directory: '<home>/other' } }));
    expect(moved.map((event) => [event.directory, event.payload.properties.info.directory, event.payload.properties.info.path]))
      .toEqual([['<home>/other', '<home>/other', 'pkg']]);
    const deleted = projector.project(base('session.deleted', {}));
    expect(deleted[0].payload).toMatchObject({ type: 'session.deleted', properties: { sessionID: SID, info: { id: SID, agent: 'plan' } } });
    expect(projector.stats().sessions).toBe(0);
    const unknown = projector.project(base('session.deleted', { sessionID: 'ses_unknown' }));
    expect(unknown[0].payload.properties).toEqual({ sessionID: 'ses_unknown', info: { id: 'ses_unknown' } });
  });
});

describe('envelopes without a session counterpart', () => {
  it('maps location.shutdown, project, vcs, filesystem, mcp and server.connected', () => {
    const { projector } = createProjector();
    const shutdown = replay(projector, framesOf('14-location-shutdown.json'))
      .filter((event) => event.payload.type === 'server.instance.disposed');
    expect(shutdown[0]).toMatchObject({ directory: DIR, payload: { properties: { directory: DIR } } });

    const [project] = replay(projector, framesOf('00-catalog-cold.json'))
      .filter((event) => event.payload.type === 'project.updated');
    expect(project.payload.properties).toMatchObject({ id: 'global', canonical: DIR, worktree: DIR });

    expect(projector.project({ id: 'evt_c', type: 'server.connected', data: {} })).toEqual([
      { eventId: 'evt_c', directory: 'global', payload: { id: 'evt_c', type: 'server.connected', properties: {} } },
    ]);
    const changed = projector.project({
      id: 'evt_f', created: 1, type: 'filesystem.changed', location: { directory: DIR }, data: { file: 'a.txt', event: 'change' },
    });
    expect(changed[0].payload).toEqual({ id: 'evt_f', type: 'file.watcher.updated', properties: { file: 'a.txt', event: 'change' } });
    const mcp = projector.project({ id: 'evt_m', created: 1, type: 'mcp.status.changed', data: { server: 'x' } });
    expect(mcp[0].payload).toEqual({ id: 'evt_m', type: 'mcp.status.changed', properties: { server: 'x' } });
  });

  it('drops folded/catalog events silently and reports an unknown type once', () => {
    const { projector, diagnostics } = createProjector();
    expect(projector.project({ id: 'evt_1', type: 'agent.updated', data: {} })).toBe(EMPTY_PROJECTION);
    expect(projector.project({ id: 'evt_2', type: 'brand.new', data: {} })).toBe(EMPTY_PROJECTION);
    expect(projector.project({ id: 'evt_3', type: 'brand.new', data: {} })).toBe(EMPTY_PROJECTION);
    expect(projector.project(null)).toBe(EMPTY_PROJECTION);
    expect(diagnostics.map((entry) => entry.code)).toEqual([
      EVENT_PROJECTOR_DIAGNOSTICS.unprojected,
      EVENT_PROJECTOR_DIAGNOSTICS.malformed,
    ]);
  });

  it('omits the payload id when the upstream event has none', () => {
    const { projector } = createProjector();
    const [event] = projector.project({ type: 'vcs.branch.updated', location: { directory: DIR }, data: { branch: 'main' } });
    expect(event).toEqual({ eventId: undefined, directory: DIR, payload: { type: 'vcs.branch.updated', properties: { branch: 'main' } } });
  });
});

describe('cold sessions, gaps and reseeds', () => {
  const tail = () => {
    // Vector 01 without session.created, enqueued or the first delivery: a session that
    // was running before this projector existed.
    const envelopes = framesOf('01-two-step-tool-turn.json');
    return envelopes.filter((envelope) => (
      envelope.type !== 'session.created' && envelope.type !== 'session.inbox.enqueued'
    ));
  };

  it('queues history, session and message seeds and never awaits', () => {
    const { projector } = createProjector({ onReseedRequested: () => {} });
    const events = replay(projector, tail());
    // The prompt content is unknown: the user record waits for its message seed.
    expect(ofType(events, 'message.updated').some((props) => props.info.role === 'user')).toBe(false);
    expect(projector.isCold(SID)).toBe(true);
    expect(projector.takeReseedRequests()).toEqual([
      { kind: 'history', sessionID: SID, reason: 'cold_session' },
      { kind: 'session', sessionID: SID, reason: 'unknown_session' },
      { kind: 'message', sessionID: SID, messageID: mid(1), reason: 'unknown_inbox_item' },
    ]);
    // Parent ids still come from the delivered inbox id.
    const assistants = ofType(events, 'message.updated').filter((props) => props.info.role === 'assistant');
    expect(new Set(assistants.map((props) => props.info.parentID))).toEqual(new Set([mid(1)]));
  });

  it('notifies the hub synchronously when a request is queued', () => {
    let notified = 0;
    const { projector } = createProjector({ onReseedRequested: () => { notified += 1; } });
    projector.project({ id: 'evt_1', created: 1, type: 'session.execution.started', data: { sessionID: SID } });
    expect(notified).toBe(2);
    expect(projector.pendingReseedCount()).toBe(2);
  });

  it('holds a status without a known directory until the session seed lands', () => {
    const { projector } = createProjector();
    const [status] = projector.project({ id: 'evt_1', created: 1, type: 'session.execution.started', data: { sessionID: SID } });
    expect(status.directory).toBe('global');
    const info = rest('01-two-step-tool-turn.json', 'session.get').data;
    const seeded = projector.applySession(SID, info);
    expect(seeded.map((event) => [event.directory, event.payload.type, event.payload.properties.status])).toEqual([
      [DIR, 'session.status', { type: 'busy' }],
    ]);
    expect(projector.sessionDirectory(SID)).toBe(DIR);
  });

  it('emits a fold that arrived before the record once the session seed lands', () => {
    const { projector } = createProjector();
    expect(projector.project({
      id: 'evt_1', created: 5, type: 'session.renamed', location: { directory: DIR }, data: { sessionID: SID, title: 'New' },
    })).toBe(EMPTY_PROJECTION);
    const info = { ...rest('01-two-step-tool-turn.json', 'session.get').data, title: 'New' };
    const seeded = projector.applySession(SID, info);
    expect(seeded.map((event) => [event.payload.type, event.payload.properties.info.title])).toEqual([['session.updated', 'New']]);
    expect(projector.applySession(SID, info)).toBe(EMPTY_PROJECTION);
  });

  it('applies a history seed: parents restored and the session no longer cold', () => {
    const { projector } = createProjector();
    const envelopes = framesOf('01-two-step-tool-turn.json');
    const start = envelopes.findIndex((envelope) => envelope.type === 'session.step.started');
    // Join mid-turn: only the frames from the first step on.
    const events = replay(projector, envelopes.slice(start, start + 1));
    expect(ofType(events, 'message.updated')[0].info.parentID).toBe('');
    const history = rest('01-two-step-tool-turn.json', 'mid.session.messages.asc').data
      .filter((row) => row.type === 'user');
    const corrections = projector.applyHistory(SID, history);
    expect(corrections.map((event) => [event.payload.type, event.payload.properties.info.parentID])).toEqual([
      ['message.updated', mid(1)],
    ]);
    expect(projector.isCold(SID)).toBe(false);
    const later = replay(projector, envelopes.slice(start + 1));
    const second = ofType(later, 'message.updated').find((props) => props.info.id === mid(3));
    expect(second.info.parentID).toBe(mid(1));
  });

  it('applies a message seed for an unknown inbox item', () => {
    const { projector } = createProjector();
    replay(projector, tail());
    const row = rest('01-two-step-tool-turn.json', 'session.messages.asc').data[0];
    const seeded = projector.applyMessage(SID, row);
    expect(seeded.map((event) => event.payload.type)).toEqual(['message.updated', 'message.part.updated']);
    expect(seeded[0].payload.properties.info).toMatchObject({ id: mid(1), role: 'user' });
  });

  it('recovers a retry status from the latest assistant on gap reconciliation (B.3)', () => {
    const { projector } = createProjector();
    replay(projector, framesOf('01-two-step-tool-turn.json').slice(0, 3));
    projector.handleGap('upstream_reconnect');
    projector.takeReseedRequests();
    const retry = { type: 'retry', attempt: 3, message: 'Rate limited', next: 1767225700000 };
    const reconciled = projector.applyActive({ data: { [SID]: { type: 'running' } } }, new Map([[SID, retry]]));
    expect(reconciled.map((event) => event.payload.properties.status)).toEqual([retry]);
    expect(projector.sessionStatus(SID)).toEqual(retry);
    // A plain record works too, and no retry entry means busy.
    const busy = projector.applyActive({ data: { [SID]: { type: 'running' } } }, { [SID]: null });
    expect(busy.map((event) => event.payload.properties.status)).toEqual([{ type: 'busy' }]);
  });

  it('asks for the session seed again after a gap', () => {
    const { projector } = createProjector();
    projector.project({ id: 'evt_1', created: 1, type: 'session.execution.started', data: { sessionID: SID } });
    expect(projector.takeReseedRequests().map((request) => request.kind)).toEqual(['history', 'session']);
    projector.handleGap('upstream_reconnect');
    expect(projector.takeReseedRequests()).toEqual([{ kind: 'active', reason: 'upstream_reconnect' }]);
    projector.project({ id: 'evt_2', created: 2, type: 'session.retry.scheduled', data: { sessionID: SID, attempt: 1, at: 5 } });
    expect(projector.takeReseedRequests().map((request) => request.kind)).toEqual(['history', 'session']);
  });

  it('reconciles status after a gap from /api/session/active', () => {
    const { projector } = createProjector();
    const two = 'ses_ffffffffffffnormalized0001';
    replay(projector, framesOf('01-two-step-tool-turn.json').slice(0, 3));
    projector.project({ id: 'evt_c2', created: 1, type: 'session.created', location: { directory: DIR }, data: {
      sessionID: two, slug: 's2', version: '2', projectID: 'global', location: { directory: DIR }, subpath: '',
    } });
    expect(projector.sessionStatus(SID)).toEqual({ type: 'busy' });
    projector.handleGap('upstream_reconnect');
    expect(projector.isCold(SID)).toBe(true);
    expect(projector.takeReseedRequests()).toEqual([{ kind: 'active', reason: 'upstream_reconnect' }]);
    const reconciled = projector.applyActive({ data: { [two]: { type: 'running' } } });
    expect(reconciled.map((event) => [event.payload.type, event.payload.properties.sessionID, event.payload.properties.status]))
      .toEqual([
        ['session.status', SID, { type: 'idle' }],
        ['session.idle', SID, undefined],
        ['session.status', two, { type: 'busy' }],
      ]);
    expect(reconciled.every((event) => event.eventId === undefined && event.directory === DIR)).toBe(true);
  });

  it('lets a failed reseed be requested again', () => {
    const { projector } = createProjector();
    const execution = (id) => ({ id, created: 1, type: 'session.execution.started', data: { sessionID: SID } });
    projector.project(execution('evt_1'));
    const [history] = projector.takeReseedRequests();
    projector.project(execution('evt_2'));
    expect(projector.takeReseedRequests()).toEqual([]);
    projector.reseedFailed(history);
    projector.project(execution('evt_3'));
    expect(projector.takeReseedRequests()).toEqual([{ kind: 'history', sessionID: SID, reason: 'cold_session' }]);
  });
});

describe('caps and eviction', () => {
  const created = (sessionID) => ({
    id: `evt_${sessionID}`, created: 1, type: 'session.created', location: { directory: DIR },
    data: { sessionID, slug: sessionID, version: '2', projectID: 'global', location: { directory: DIR }, subpath: '' },
  });

  it('evicts the least recently used session with a diagnostic; it returns cold', () => {
    const { projector, diagnostics } = createProjector({ limits: { sessions: 2 } });
    projector.project(created('ses_a'));
    projector.project(created('ses_b'));
    projector.project({ id: 'evt_touch', created: 2, type: 'session.execution.started', data: { sessionID: 'ses_a' } });
    projector.project(created('ses_c'));
    expect(diagnostics).toEqual([{ code: EVENT_PROJECTOR_DIAGNOSTICS.evicted, scope: 'session', sessionID: 'ses_b' }]);
    expect(projector.stats()).toMatchObject({ sessions: 2, evictions: 1 });
    expect(projector.isCold('ses_a')).toBe(false);
    expect(projector.isCold('ses_b')).toBe(true);
  });

  it('evicts an active assistant over the cap, marks the session cold and queues a reseed', () => {
    const { projector, diagnostics } = createProjector({ limits: { assistantsPerSession: 2 } });
    projector.project(created(SID));
    for (let index = 1; index <= 3; index += 1) {
      projector.project({
        id: `evt_d${index}`, created: 10 + index, type: 'session.text.delta', location: { directory: DIR },
        data: { sessionID: SID, assistantMessageID: mid(index), ordinal: 0, delta: 'x' },
      });
    }
    expect(diagnostics).toEqual([{ code: EVENT_PROJECTOR_DIAGNOSTICS.evicted, scope: 'assistant', sessionID: SID, messageID: mid(1) }]);
    expect(projector.isCold(SID)).toBe(true);
    expect(projector.takeReseedRequests()).toEqual([{ kind: 'history', sessionID: SID, reason: 'assistant_evicted' }]);
  });

  it('evicts a tool over the cap the same way', () => {
    const { projector, diagnostics } = createProjector({ limits: { toolsPerSession: 1 } });
    projector.project(created(SID));
    for (const callID of ['call_a', 'call_b']) {
      projector.project({
        id: `evt_${callID}`, created: 10, type: 'session.tool.input.started', location: { directory: DIR },
        data: { sessionID: SID, assistantMessageID: mid(1), id: callID, name: 'read' },
      });
    }
    expect(diagnostics).toEqual([{
      code: EVENT_PROJECTOR_DIAGNOSTICS.evicted, scope: 'tool', sessionID: SID, partID: `${mid(1)}:tool:call_a`,
    }]);
    expect(projector.isCold(SID)).toBe(true);
  });

  it('bounds the reseed queue, records dropped requests once and asks for them again', () => {
    const { projector, diagnostics } = createProjector({ limits: { reseedQueue: 1 } });
    const execution = (id, sessionID = SID) => ({ id, created: 1, type: 'session.execution.started', data: { sessionID } });
    projector.project(execution('evt_1'));
    expect(projector.pendingReseedCount()).toBe(1);
    projector.project(execution('evt_2', 'ses_other'));
    expect(diagnostics).toEqual([{ code: EVENT_PROJECTOR_DIAGNOSTICS.reseedDropped, kind: 'session', reason: 'unknown_session' }]);
    expect(projector.stats().reseedsDropped).toBe(3);
    expect(projector.takeReseedRequests()).toEqual([{ kind: 'history', sessionID: SID, reason: 'cold_session' }]);
    // The dropped session seed is requested on the session's next event.
    projector.project({
      id: 'evt_3', created: 2, type: 'session.renamed', location: { directory: DIR }, data: { sessionID: SID, title: 'x' },
    });
    expect(projector.takeReseedRequests()).toEqual([{ kind: 'session', sessionID: SID, reason: 'unknown_session' }]);
  });

  it('survives a throwing diagnostic recorder and a malformed event', () => {
    const projector = createEventProjector({ recordDiagnostic: () => { throw new Error('boom'); } });
    expect(projector.project({ id: 'evt_1', type: 'session.text.delta', data: { assistantMessageID: mid(1) } }))
      .toBe(EMPTY_PROJECTION);
    expect(projector.stats().diagnostics).toBe(1);
  });
});

describe('bench (F13)', () => {
  it(`keeps gen 2 p99 below ${EVENT_PROJECTOR_P99_BUDGET_US} µs per event at 8 sessions x 10 deltas/s`, () => {
    const result = runEventProjectorBench({ sessions: 8, deltasPerSecond: 10, seconds: 120, warmupSeconds: 20 });
    // Written to stderr directly: the default reporter hides console output of passing tests.
    process.stderr.write(
      `[events.bench] gen 2: ${result.events} events (${result.deltas} deltas), 8 sessions x 10 deltas/s: `
      + `p50 ${result.p50Us} µs, p99 ${result.p99Us} µs, max ${result.maxUs} µs, mean ${result.meanUs} µs\n`,
    );
    expect(result.deltas).toBeGreaterThan(8 * 10 * 100);
    expect(result.stats.failures).toBe(0);
    expect(result.p99Us).toBeLessThan(EVENT_PROJECTOR_P99_BUDGET_US);
  });
});


it.each(['synthetic','user'])('history and Revert preserve exact %s status provenance without borrowing a user parent',type=>{
  const {projector}=createProjector();
  projector.project({id:'evt_wake',created:1,type:'session.execution.started',location:{directory:DIR},data:{sessionID:SID}});
  const metadata={devryan:{v:1,origin:'interview',statusOnly:true}};
  projector.applyHistory(SID,[{id:'msg_original',type:'user',text:'request',time:{created:1}},
    {id:'msg_notice',type,metadata,text:'UI ready',time:{created:2}},
    {id:'msg_remove',type:'assistant',agent:'build',model:{id:'m',providerID:'p'},content:[],time:{created:3}}]);
  const removed=projector.project({id:'evt_revert',created:4,type:'session.revert.committed',location:{directory:DIR},data:{sessionID:SID,to:'msg_remove'}});
  expect(ofType(removed,'message.removed').map(row=>row.messageID)).toContain('msg_remove');
  const events=projector.project({id:'evt_step',created:5,type:'session.step.started',location:{directory:DIR},data:{sessionID:SID,assistantMessageID:'msg_next',agent:'build',model:{id:'m',providerID:'p'}}});
  expect(ofType(events,'message.updated').find(row=>row.info.id==='msg_next').info.parentID).toBe(type==='synthetic'?'msg_original':'msg_notice');
});
