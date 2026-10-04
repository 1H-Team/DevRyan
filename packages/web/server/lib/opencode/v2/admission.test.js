// Admission module (DESIGN.md B.5, E item 12) against the v2 loopback fixture
// (item 9), plus the pure prompt-content and metadata.devryan contracts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLoopbackOpenCodeFixtureForGeneration } from '../../../../../../scripts/perf/loopback-opencode-fixtures.mjs';
import { PERF_PARENT_SESSION_ID } from '../../../../../../scripts/perf/fixture-session-seeds.mjs';
import { OPENCODE_CLIENT_ERROR_CODES } from '../opencode-client/errors.js';
import { createOpenCodeClient } from '../opencode-client/index.js';
import { createPrivilegedOpenCodeClient } from '../opencode-client/privileged.js';
import { createV2AudienceRequester } from '../opencode-client/requester.js';
import {
  ADMISSION_ERROR_CODES,
  buildDevryanPromptMetadata,
  buildV2PromptContent,
  createOpenCodeAdmission,
  createV2MessageId,
  DEVRYAN_PROMPT_METADATA_SCHEMA,
  formatAttachmentSegment,
  isSameModelSelection,
  readRequestedModel,
  toV2PermissionRuleset,
  V2_ATTACHMENT_MAX_BYTES,
  validateDevryanPromptMetadata,
} from './admission.js';
import { createPrimaryRecoveryHost } from '../../../../../harness-runtime/lib/provider-recovery-host.js';
import { resolveProviderPromptTools } from '../../../../../orchestration-runtime/provider-prompt-tools.js';
import { readDevryanPartDescriptors, userTextSegments } from './projection/ids.js';
import { readDevryanPromptSelection, toV1UserMetadata } from './projection/messages.js';

const C = OPENCODE_CLIENT_ERROR_CODES;
const MODEL = Object.freeze({ providerID: 'fixture', modelID: 'fixture-model' });
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const PNG_URL = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')}`;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Builds an admission wired the way the server wires it (client.getAdmission -> admission). */
const harness = (fixture, { options = {}, deps: extraDeps = {}, generation = 2 } = {}) => {
  const calls = [];
  const diagnostics = [];
  const ownedRemovals = [];
  const deps = {
    getRuntime: () => ({ generation, baseUrl: fixture.origin }),
    getAuthHeaders: () => ({ ...fixture.authHeaders }),
    fetchImpl: (url, init = {}) => {
      const parsed = new URL(url);
      calls.push({ method: init.method ?? 'GET', path: parsed.pathname, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
      return globalThis.fetch(url, init);
    },
    recordDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    ...extraDeps,
  };
  if (generation === 2) {
    // This wire fixture delegates deletion explicitly. Native acceptance owns
    // the separate hold, process settlement and durable removal proof.
    const fixtureWire = createV2AudienceRequester(deps, { audience: 'server' });
    deps.withNativeWebOperation ??= async (scope, action) => {
      if (scope.operation === 'sessions.remove') ownedRemovals.push(scope);
      return action();
    };
    deps.removeNativeSession ??= async (sessionID, options) => {
      await fixtureWire({ method: 'DELETE', path: `/api/session/${sessionID}`, directory: options.directory });
      return true;
    };
  }
  let admission;
  const client = createOpenCodeClient({ ...deps, getAdmission: () => admission });
  const privileged = createPrivilegedOpenCodeClient(deps);
  admission = createOpenCodeAdmission(deps, { client, privileged, ...options });
  const since = () => {
    const start = calls.length;
    return () => calls.slice(start);
  };
  return { admission, client, privileged, calls, diagnostics, since, ownedRemovals };
};

const writes = (calls) => calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.path}`);

const waitForIdle = async (fixture, sessionID, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (fixture.getState().executingSessions.includes(sessionID)) {
    if (Date.now() > deadline) throw new Error(`session ${sessionID} did not settle`);
    await sleep(10);
  }
};

const quickPrompt = (fixture, sessionID) => fixture.configureNextPrompt(sessionID, { chunks: 1, intervalMs: 10 });

// ---------------------------------------------------------------------------

describe('metadata.devryan schema', () => {
  const parts = [{ kind: 'synthetic', length: 5, id: 'prt_a' }, { kind: 'text', length: 3, id: 'prt_b' }, { kind: 'attachment', length: 2 }];
  const valid = {
    v: 1, origin: 'human', agent: 'build', providerID: 'fixture', modelID: 'fixture-model', variant: null,
    planMode: true, parts, objectiveID: 'msg_objective1',
  };

  it('is a frozen JSON schema whose keys the validator enforces', () => {
    expect(Object.isFrozen(DEVRYAN_PROMPT_METADATA_SCHEMA)).toBe(true);
    expect(DEVRYAN_PROMPT_METADATA_SCHEMA.required).toEqual(['v', 'origin', 'planMode', 'parts']);
    expect(Object.keys(DEVRYAN_PROMPT_METADATA_SCHEMA.properties).sort())
      .toEqual(['admission', 'agent', 'modelID', 'objectiveID', 'origin', 'parts', 'planMode', 'providerID', 'v', 'variant']);
    expect(DEVRYAN_PROMPT_METADATA_SCHEMA.properties.parts.items.properties.kind.enum).toEqual(['text', 'synthetic', 'attachment']);
    expect(validateDevryanPromptMetadata(valid, { text: 'aaaaabbbcc' })).toEqual({ ok: true });
  });

  it('rejects every schema violation', () => {
    const cases = [
      [{ ...valid, extra: 1 }, /unknown key extra/],
      [{ ...valid, v: 2 }, /v must be 1/],
      [{ ...valid, origin: 'Human Being' }, /origin/],
      [{ ...valid, agent: '' }, /agent/],
      [{ ...valid, variant: 3 }, /variant/],
      [{ ...valid, planMode: 'yes' }, /planMode/],
      [{ ...valid, objectiveID: 'not-a-message' }, /objectiveID/],
      [{ ...valid, admission: { v: 1, fingerprint: 'not-a-digest' } }, /admission/],
      [{ ...valid, admission: { v: 2, fingerprint: 'a'.repeat(64) } }, /admission/],
      [{ ...valid, admission: { v: 1, fingerprint: 'a'.repeat(64), extra: true } }, /admission/],
      [{ ...valid, parts: 'x' }, /parts must be an array/],
      [{ ...valid, parts: [{ kind: 'image', length: 1 }] }, /kind/],
      [{ ...valid, parts: [{ kind: 'text', length: -1 }] }, /length/],
      [{ ...valid, parts: [{ kind: 'text', length: 1, id: 'x' }, { kind: 'text', length: 1, id: 'x' }] }, /duplicated/],
      [{ ...valid, parts: [{ kind: 'text', length: 1, extra: true }] }, /unknown key extra/],
    ];
    for (const [value, pattern] of cases) {
      const result = validateDevryanPromptMetadata(value);
      expect(result.ok).toBe(false);
      expect(result.errors.join('; ')).toMatch(pattern);
    }
    expect(validateDevryanPromptMetadata(valid, { text: 'too short' })).toMatchObject({ ok: false });
    expect(validateDevryanPromptMetadata(null)).toMatchObject({ ok: false });
    expect(() => buildDevryanPromptMetadata({ origin: 'BAD', planMode: false, parts: [] })).toThrow(TypeError);
  });

  it('round-trips through the projection readers', () => {
    const text = 'aaaaabbbcc';
    const metadata = { devryan: buildDevryanPromptMetadata(valid, { text }) };
    expect(readDevryanPartDescriptors(metadata)).toEqual(parts);
    expect(readDevryanPromptSelection(metadata)).toEqual({ agent: 'build', providerID: 'fixture', modelID: 'fixture-model', variant: null, planMode: true });
    expect(userTextSegments('msg_x', text, metadata).map((segment) => [segment.id, segment.kind, segment.text]))
      .toEqual([['prt_a', 'synthetic', 'aaaaa'], ['prt_b', 'text', 'bbb'], ['msg_x:text:2', 'attachment', 'cc']]);
    expect(toV1UserMetadata(metadata)).toEqual({ openchamberPlanMode: true });
    // Absent variant means "inherited": the key is omitted, never undefined.
    const inherited = buildDevryanPromptMetadata({ origin: 'server', planMode: false, parts: [] });
    expect(inherited).toEqual({ v: 1, origin: 'server', planMode: false, parts: [] });
    expect(Object.hasOwn(inherited, 'variant')).toBe(false);
  });
});

describe('prompt content', () => {
  it('builds text segments, inlines text attachments and keeps binary files and agents', () => {
    const attachment = formatAttachmentSegment('notes.md', 'text/markdown', '# Notes');
    const content = buildV2PromptContent([
      { type: 'text', id: 'prt_plan', text: 'User has requested to enter plan mode.\n', synthetic: true },
      { type: 'text', id: 'prt_text', text: 'Plan the change.' },
      { type: 'text', id: 'prt_attach', text: attachment, synthetic: true },
      { type: 'text', id: 'prt_ignored', text: 'never sent', ignored: true },
      { type: 'file', id: 'prt_file_txt', mime: 'text/plain', filename: 'a.txt', url: `data:text/plain;base64,${b64('hello')}` },
      { type: 'file', id: 'prt_file_png', mime: 'image/png', filename: 'a.png', url: PNG_URL,
        source: { type: 'file', path: 'a.png', text: { value: '@a.png', start: 0, end: 6 } } },
      { type: 'agent', id: 'prt_agent', name: 'explorer', source: { value: '@explorer', start: 7, end: 16 } },
    ]);
    expect(content.planMode).toBe(true);
    expect(content.segments).toEqual([
      { kind: 'synthetic', length: 39, id: 'prt_plan' },
      { kind: 'text', length: 16, id: 'prt_text' },
      { kind: 'attachment', length: attachment.length, id: 'prt_attach' },
      { kind: 'attachment', length: formatAttachmentSegment('a.txt', 'text/plain', 'hello').length, id: 'prt_file_txt' },
    ]);
    expect(content.text).toBe(`User has requested to enter plan mode.\nPlan the change.${attachment}${formatAttachmentSegment('a.txt', 'text/plain', 'hello')}`);
    expect(content.files).toEqual([{ uri: PNG_URL, name: 'a.png', mention: { start: 0, end: 6, text: '@a.png' } }]);
    expect(content.agents).toEqual([{ name: 'explorer', mention: { start: 7, end: 16, text: '@explorer' } }]);
  });

  it('canonicalizes base64 and drops duplicate part ids from descriptors', () => {
    const content = buildV2PromptContent([
      { type: 'text', id: 'prt_same', text: 'a' },
      { type: 'text', id: 'prt_same', text: 'b' },
      { type: 'file', mime: 'image/png', url: 'data:image/png;base64,iVBORw0KGgo' },
    ]);
    expect(content.segments).toEqual([{ kind: 'text', length: 1, id: 'prt_same' }, { kind: 'text', length: 1 }]);
    expect(content.files).toEqual([{ uri: 'data:image/png;base64,iVBORw0KGgo=' }]);
  });

  it('refuses non-data URLs, unsupported parts and oversized attachments', () => {
    const refuse = (parts, reason, code = C.invalidInput) => {
      let error;
      try { buildV2PromptContent(parts); } catch (caught) { error = caught; }
      expect(error).toMatchObject({ code, ...(reason ? { detail: { reason } } : {}) });
    };
    refuse([{ type: 'file', mime: 'text/plain', url: 'file:///etc/passwd' }], 'file_url_scheme');
    refuse([{ type: 'file', mime: 'image/png', url: 'https://example.invalid/a.png' }], 'file_url_scheme');
    refuse([{ type: 'file', mime: 'text/plain', url: 'data:text/plain,hello' }], 'file_url_not_base64');
    refuse([{ type: 'subtask', prompt: 'x' }], 'part_type_unsupported');
    refuse([{ type: 'agent' }]);
    refuse('nope');
    const big = `data:application/octet-stream;base64,${'A'.repeat(Math.ceil((V2_ATTACHMENT_MAX_BYTES + 3) / 3) * 4)}`;
    refuse([{ type: 'file', mime: 'application/octet-stream', url: big }], 'attachment_too_large', C.payloadTooLarge);
  });

  it('selection helpers follow the 2.0.20 comparison', () => {
    expect(readRequestedModel(MODEL)).toEqual(MODEL);
    expect(readRequestedModel('fixture/fixture-model/extra')).toEqual({ providerID: 'fixture', modelID: 'fixture-model/extra' });
    expect(readRequestedModel('fixture')).toBeNull();
    expect(isSameModelSelection({ id: 'm', providerID: 'p' }, { id: 'm', providerID: 'p', variant: 'default' })).toBe(true);
    expect(isSameModelSelection({ id: 'm', providerID: 'p', variant: 'high' }, { id: 'm', providerID: 'p' })).toBe(false);
    expect(isSameModelSelection(undefined, { id: 'm', providerID: 'p' })).toBe(false);
    expect(toV2PermissionRuleset([{ permission: 'bash', pattern: '*', action: 'ask' }])).toEqual([{ action: 'shell', resource: '*', effect: 'ask' }]);
    expect(() => toV2PermissionRuleset([{ permission: 'bash', pattern: '*', action: 'maybe' }])).toThrow(expect.objectContaining({ code: C.invalidInput }));
    expect(createV2MessageId(2_000) > createV2MessageId(1_000)).toBe(true);
    expect(createV2MessageId()).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  });
});

// ---------------------------------------------------------------------------

describe('admission against the v2 fixture', () => {
  let directory;
  let fixture;
  let h;

  beforeAll(async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'devryan-admission-'));
    fixture = await createLoopbackOpenCodeFixtureForGeneration(2, { directory, heartbeatMs: 50, commands: [{ name: 'review', description: 'Review' }] });
    h = harness(fixture);
  });

  afterAll(async () => {
    fixture?.stopScenario({ settle: false });
    await fixture?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  const newSession = async (title = 'Admission') => (await h.admission.create({ title, directory })).id;

  it('external dispatch must persist the exact accepted native turn and shares durable retry identity',async()=>{
    let count=0;
    const external=harness(fixture,{options:{externalPromptDispatch:async(receipt,request)=>{
      count++;expect(receipt.messageID).toBe(request.id);
      expect(request.metadata.devryan.admission.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      const response=await fetch(`${fixture.origin}/api/session/${receipt.sessionID}/prompt`,{
        method:'POST',headers:{...fixture.authHeaders,'Content-Type':'application/json'},body:JSON.stringify(request),
      });expect(response.ok).toBe(true);return true;
    }}});
    const sessionID=await newSession(),body={messageID:createV2MessageId(),parts:[{type:'text',text:'External fixture'}]};
    quickPrompt(fixture,sessionID);const window=external.since();
    await expect(external.admission.prompt(sessionID,body,{directory})).resolves.toBeNull();
    await expect(external.admission.prompt(sessionID,body,{directory})).resolves.toBeNull();
    expect(count).toBe(1);expect(writes(window())).not.toContain(`POST /api/session/${sessionID}/prompt`);
    await expect(external.admission.prompt(sessionID,{...body,parts:[{type:'text',text:'Changed'}]},{directory})).rejects.toMatchObject({code:C.conflict});
    expect(count).toBe(1);await waitForIdle(fixture,sessionID);
    const missing=harness(fixture,{options:{externalPromptDispatch:async()=>true}});
    await expect(missing.admission.prompt(await newSession(),{parts:[{type:'text',text:'Unpersisted'}]},{directory}))
      .rejects.toMatchObject({code:ADMISSION_ERROR_CODES.identityUncertain});
  });

  it('admits a prompt with selection switches, segments and metadata.devryan', async () => {
    const sessionID = await newSession();
    quickPrompt(fixture, sessionID);
    const messageID = createV2MessageId();
    const window = h.since();
    await expect(h.admission.prompt(sessionID, {
      messageID,
      agent: 'build',
      model: MODEL,
      variant: 'high',
      parts: [
        { type: 'text', id: 'prt_plan', text: 'User has requested to enter plan mode.\n', synthetic: true },
        { type: 'text', id: 'prt_text', text: 'Plan the change.' },
        { type: 'file', id: 'prt_png', mime: 'image/png', filename: 'a.png', url: PNG_URL },
        { type: 'agent', id: 'prt_agent', name: 'explorer' },
      ],
    }, { directory, origin: 'human', objectiveID: 'msg_objective1' })).resolves.toBeNull();
    const calls = window();
    expect(writes(calls)).toEqual([`POST /api/session/${sessionID}/agent`, `POST /api/session/${sessionID}/model`, `POST /api/session/${sessionID}/prompt`]);
    expect(calls.find((call) => call.path.endsWith('/model')).body).toEqual({ model: { id: 'fixture-model', providerID: 'fixture', variant: 'high' } });
    const sent = calls.find((call) => call.path.endsWith('/prompt')).body;
    expect(sent).toMatchObject({
      id: messageID,
      text: 'User has requested to enter plan mode.\nPlan the change.',
      files: [{ uri: PNG_URL, name: 'a.png' }],
      agents: [{ name: 'explorer' }],
      delivery: 'queue',
    });
    expect(sent.metadata.devryan).toEqual({
      v: 1, origin: 'human', agent: 'build', providerID: 'fixture', modelID: 'fixture-model', variant: 'high', planMode: true,
      parts: [{ kind: 'synthetic', length: 39, id: 'prt_plan' }, { kind: 'text', length: 16, id: 'prt_text' }],
      objectiveID: 'msg_objective1',
      admission: { v: 1, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(validateDevryanPromptMetadata(sent.metadata.devryan, { text: sent.text })).toEqual({ ok: true });

    // The projected transcript restores the client's part ids and the selection.
    await waitForIdle(fixture, sessionID);
    const page = await h.client.sessions.messages(sessionID, { limit: 10 }, { directory });
    const user = page.records.find((record) => record.info.id === messageID);
    expect(user.info).toMatchObject({ role: 'user', agent: 'build', model: { providerID: 'fixture', modelID: 'fixture-model', variant: 'high' },
      metadata: { openchamberPlanMode: true } });
    expect(user.parts.map((part) => [part.id, part.type, part.synthetic === true])).toEqual([
      ['prt_plan', 'text', true], ['prt_text', 'text', false], [`${messageID}:file:0`, 'file', false], [`${messageID}:agent:0`, 'agent', false],
    ]);

    // Same selection again: no switch rows.
    quickPrompt(fixture, sessionID);
    const second = h.since();
    await h.admission.prompt(sessionID, { messageID: createV2MessageId(), agent: 'build', model: MODEL, variant: 'high',
      parts: [{ type: 'text', text: 'Next.' }] }, { directory });
    expect(writes(second())).toEqual([`POST /api/session/${sessionID}/prompt`]);
    await waitForIdle(fixture, sessionID);
  });

  it('takes the id from the message id header and maps empty and omitted variants', async () => {
    const sessionID = await newSession();
    await h.privileged.switchModel(sessionID, { ...MODEL, variant: 'high' });
    quickPrompt(fixture, sessionID);
    const messageID = createV2MessageId();
    const window = h.since();
    // v1 explicit empty variant = provider default: a switch away from 'high', recorded as null.
    await h.admission.prompt(sessionID, { model: MODEL, variant: '', parts: [{ type: 'text', text: 'Default effort.' }] },
      { directory, headers: { 'X-OpenChamber-Message-Id': messageID } });
    const calls = window();
    expect(calls.find((call) => call.path.endsWith('/model')).body).toEqual({ model: { id: 'fixture-model', providerID: 'fixture' } });
    const sent = calls.find((call) => call.path.endsWith('/prompt')).body;
    expect(sent.id).toBe(messageID);
    expect(sent.metadata.devryan).toMatchObject({ origin: 'unknown', variant: null, planMode: false, providerID: 'fixture' });
    await waitForIdle(fixture, sessionID);

    // Omitted variant inherits the agent's (none in this catalog): no switch, no variant key.
    quickPrompt(fixture, sessionID);
    const inherit = h.since();
    await h.admission.prompt(sessionID, { messageID: createV2MessageId(), agent: 'build', model: MODEL, parts: [{ type: 'text', text: 'Inherit.' }] },
      { directory });
    const inherited = inherit();
    expect(writes(inherited)).toEqual([`POST /api/session/${sessionID}/agent`, `POST /api/session/${sessionID}/prompt`]);
    expect(inherited.some((call) => call.method === 'GET' && call.path === '/api/agent')).toBe(true);
    expect(Object.hasOwn(inherited.at(-1).body.metadata.devryan, 'variant')).toBe(false);
    await waitForIdle(fixture, sessionID);

    await expect(h.admission.prompt(sessionID, { messageID: 'msg_a', parts: [{ type: 'text', text: 'x' }] },
      { headers: { 'x-openchamber-message-id': 'msg_b' } })).rejects.toMatchObject({ code: C.invalidInput });
    await expect(h.admission.prompt(sessionID, { messageID: 'bad id', parts: [{ type: 'text', text: 'x' }] }))
      .rejects.toMatchObject({ code: C.invalidInput });
  });

  it('refuses a selection change while busy (409) but admits an unchanged one', async () => {
    const sessionID = await newSession();
    fixture.configureNextPrompt(sessionID, { hold: true });
    await h.admission.prompt(sessionID, { messageID: createV2MessageId(), agent: 'build', model: MODEL, parts: [{ type: 'text', text: 'Hold.' }] },
      { directory });
    expect(fixture.getState().executingSessions).toContain(sessionID);

    const window = h.since();
    const error = await h.admission.prompt(sessionID, { messageID: createV2MessageId(), agent: 'orchestrator', model: MODEL,
      parts: [{ type: 'text', text: 'Switch.' }] }, { directory }).catch((caught) => caught);
    expect(error).toMatchObject({ code: ADMISSION_ERROR_CODES.selectionChangeWhileBusy, statusCode: 409, detail: { changes: ['agent'] } });
    const model = await h.admission.prompt(sessionID, { messageID: createV2MessageId(), agent: 'build', model: { ...MODEL, modelID: 'other' },
      parts: [{ type: 'text', text: 'Switch.' }] }, { directory }).catch((caught) => caught);
    expect(model).toMatchObject({ code: ADMISSION_ERROR_CODES.selectionChangeWhileBusy, detail: { changes: ['model'] } });
    expect(writes(window())).toEqual([]);

    const queued = h.since();
    await h.admission.prompt(sessionID, { messageID: createV2MessageId(), agent: 'build', model: MODEL, parts: [{ type: 'text', text: 'Queued.' }] },
      { directory, delivery: 'queue' });
    expect(writes(queued())).toEqual([`POST /api/session/${sessionID}/prompt`]);

    // Interrupt: true while running and true for the idle no-op.
    fixture.configureNextPrompt(sessionID, { chunks: 1, intervalMs: 10 });
    await expect(h.admission.abort(sessionID)).resolves.toBe(true);
    await waitForIdle(fixture, sessionID);
    await expect(h.admission.abort(sessionID)).resolves.toBe(true);
  });

  it('uses the live projector busy state without asking the server', async () => {
    const sessionID = await newSession();
    const live = harness(fixture, { deps: { projector: () => ({ sessionStatus: () => ({ type: 'retry', attempt: 1, message: 'x', next: 0 }) }) } });
    const window = live.since();
    await expect(live.admission.prompt(sessionID, { agent: 'orchestrator', parts: [{ type: 'text', text: 'x' }] }, { directory }))
      .rejects.toMatchObject({ code: ADMISSION_ERROR_CODES.selectionChangeWhileBusy });
    expect(window().some((call) => call.path === '/api/session/active')).toBe(false);
  });

  it('makes retries idempotent and refuses a reused id with other content', async () => {
    const sessionID = await newSession();
    quickPrompt(fixture, sessionID);
    const messageID = createV2MessageId();
    const body = { messageID, agent: 'build', model: MODEL, parts: [{ type: 'text', id: 'prt_retry', text: 'Retry me.' }] };
    await h.admission.prompt(sessionID, body, { directory });
    const window = h.since();
    await expect(h.admission.prompt(sessionID, structuredClone(body), { directory })).resolves.toBeNull();
    expect(writes(window())).toEqual([]);
    await expect(h.admission.prompt(sessionID, { ...body, parts: [{ type: 'text', text: 'Different.' }] }, { directory }))
      .rejects.toMatchObject({ code: C.conflict, statusCode: 409, detail: { reason: 'prompt_id_reused' } });

    // A fresh admission (restart, no local memory) reconciles the upstream conflict.
    await waitForIdle(fixture, sessionID);
    const fresh = harness(fixture);
    await expect(fresh.admission.prompt(sessionID, structuredClone(body), { directory })).resolves.toBeNull();
    expect(fresh.diagnostics).toContainEqual(expect.objectContaining({ code: 'opencode_admission_prompt_reconciled', messageID }));
    const other = harness(fixture);
    await expect(other.admission.prompt(sessionID, { ...body, parts: [{ type: 'text', text: 'Different.' }] }, { directory }))
      .rejects.toMatchObject({ code: C.conflict, statusCode: 409 });
  });

  it('serializes admissions per session under the admission lock', async () => {
    const sessionID = await newSession();
    await h.privileged.switchAgent(sessionID, 'build');
    await h.privileged.switchModel(sessionID, MODEL);
    const window = h.since();
    quickPrompt(fixture, sessionID);
    await Promise.all([
      h.admission.prompt(sessionID, { messageID: createV2MessageId(), agent: 'build', model: MODEL, parts: [{ type: 'text', text: 'One.' }] }, { directory }),
      h.admission.prompt(sessionID, { messageID: createV2MessageId(), agent: 'build', model: MODEL, parts: [{ type: 'text', text: 'Two.' }] }, { directory }),
    ]);
    const sequence = window().filter((call) => call.path === `/api/session/${sessionID}` || call.path.endsWith('/prompt'))
      .map((call) => `${call.method} ${call.path.endsWith('/prompt') ? 'prompt' : 'session'}`);
    expect(sequence).toEqual(['GET session', 'POST prompt', 'GET session', 'POST prompt']);
    await waitForIdle(fixture, sessionID);
    expect(h.admission.inspect().lockedSessions).not.toContain(sessionID);
  });

  it('withSessionLock orders runs, survives failures and honours abort while waiting', async () => {
    const order = [];
    let releaseFirst;
    const first = h.admission.withSessionLock('ses_locktest', () => new Promise((resolve) => { releaseFirst = () => { order.push('first'); resolve(1); }; }));
    const failing = h.admission.withSessionLock('ses_locktest', async () => { order.push('failing'); throw new Error('boom'); });
    const controller = new AbortController();
    const aborted = h.admission.withSessionLock('ses_locktest', async () => { order.push('aborted-ran'); }, { signal: controller.signal });
    const third = h.admission.withSessionLock('ses_locktest', async () => { order.push('third'); return 3; });
    const other = await h.admission.withSessionLock('ses_otherlock', async () => 'independent');
    expect(other).toBe('independent');
    controller.abort(new Error('stop waiting'));
    await expect(aborted).rejects.toThrow('stop waiting');
    releaseFirst();
    await expect(first).resolves.toBe(1);
    await expect(failing).rejects.toThrow('boom');
    await expect(third).resolves.toBe(3);
    expect(order).toEqual(['first', 'failing', 'third']);
    expect(h.admission.inspect().lockedSessions).toEqual([]);
  });

  it('enforces tool overrides as native permissions before prompt admission', async () => {
    const sessionID = await newSession();
    quickPrompt(fixture, sessionID);
    const window = h.since();
    await h.admission.prompt(sessionID, { messageID: createV2MessageId(), tools: { bash: false, read: true }, parts: [{ type: 'text', text: 'x' }] },
      { directory });
    expect(writes(window())).toEqual([`PATCH /api/session/${sessionID}`, `POST /api/session/${sessionID}/prompt`]);
    expect(window().find((call) => call.method === 'PATCH').body).toEqual({ permissions: [
      { action: 'read', resource: '*', effect: 'allow' },
      { action: 'shell', resource: '*', effect: 'deny' },
    ] });
    await waitForIdle(fixture, sessionID);
  });

  it('patches the ruleset through the privileged client only when a resolver changes it', async () => {
    const rules = [{ action: 'shell', resource: '*', effect: 'deny' }];
    const resolve = vi.fn(async () => rules);
    const custom = harness(fixture, { options: { toolRules: { resolve } } });
    const sessionID = (await custom.admission.create({ title: 'Rules', directory })).id;
    quickPrompt(fixture, sessionID);
    const window = custom.since();
    await custom.admission.prompt(sessionID, { messageID: createV2MessageId(), tools: { bash: false }, parts: [{ type: 'text', text: 'x' }] }, { directory });
    const calls = window();
    expect(writes(calls)).toEqual([`PATCH /api/session/${sessionID}`, `POST /api/session/${sessionID}/prompt`]);
    expect(calls.find((call) => call.method === 'PATCH').body).toEqual({ permissions: rules });
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ sessionID, tools: { bash: false } }));
    await waitForIdle(fixture, sessionID);

    quickPrompt(fixture, sessionID);
    const again = custom.since();
    await custom.admission.prompt(sessionID, { messageID: createV2MessageId(), tools: { bash: false }, parts: [{ type: 'text', text: 'y' }] }, { directory });
    expect(writes(again())).toEqual([`POST /api/session/${sessionID}/prompt`]);
    await waitForIdle(fixture, sessionID);
  });

  it('runs commands as {name, text, files, delivery} after the same switching', async () => {
    const sessionID = await newSession();
    quickPrompt(fixture, sessionID);
    const window = h.since();
    await expect(h.admission.command(sessionID, { command: 'review', arguments: 'src', agent: 'build', model: 'fixture/fixture-model',
      parts: [{ type: 'file', mime: 'image/png', filename: 'a.png', url: PNG_URL }] }, { directory })).resolves.toBeNull();
    const calls = window();
    expect(writes(calls)).toEqual([`POST /api/session/${sessionID}/agent`, `POST /api/session/${sessionID}/model`, `POST /api/session/${sessionID}/command`]);
    expect(calls.at(-1).body).toEqual({ name: 'review', text: 'src', files: [{ uri: PNG_URL, name: 'a.png' }], delivery: 'queue' });
    await waitForIdle(fixture, sessionID);

    await expect(h.admission.command(sessionID, { command: 'missing' }, { directory })).rejects.toMatchObject({ code: C.notFound, statusCode: 404 });
    await expect(h.admission.command(sessionID, { command: 'review', parts: [{ type: 'text', text: 'x' }] })).rejects.toMatchObject({ code: C.invalidInput });
    await expect(h.admission.command(sessionID, {})).rejects.toMatchObject({ code: C.invalidInput });
  });

  it('scopes command selection authority to selection requests and releases it on failure', async () => {
    const sessionID = await newSession();
    const observed = [];
    let selectionActive = false;
    let denied = false;
    const withCommandSelection = vi.fn(async (input, action) => {
      expect(input).toEqual({ sessionID,delivery:'queue' });
      selectionActive = true;
      try {
        if (denied) throw new Error('selection revoked');
        return await action();
      } finally { selectionActive = false; }
    });
    const custom = harness(fixture, {
      options: { nativeOwner: { requestHeaders: () => ({}), withCommandSelection } },
      deps: { fetchImpl: (url, init = {}) => {
        if (init.method && init.method !== 'GET') observed.push({ path: new URL(url).pathname, selectionActive });
        return globalThis.fetch(url, init);
      } },
    });
    quickPrompt(fixture, sessionID);
    await custom.admission.command(sessionID, { command: 'review', agent: 'build', model: 'fixture/fixture-model', tools: { bash: false } });
    expect(observed).toEqual([
      { path: `/api/session/${sessionID}/agent`, selectionActive: true },
      { path: `/api/session/${sessionID}/model`, selectionActive: true },
      { path: `/api/session/${sessionID}`, selectionActive: true },
      { path: `/api/session/${sessionID}/command`, selectionActive: false },
    ]);
    await waitForIdle(fixture, sessionID);
    denied = true;
    await expect(custom.admission.command(sessionID, { command: 'review' })).rejects.toThrow('selection revoked');
    expect(observed).toHaveLength(4);
    expect(selectionActive).toBe(false);
    expect(withCommandSelection).toHaveBeenCalledTimes(2);
  });

  it('compacts through POST /compact', async () => {
    const sessionID = await newSession();
    quickPrompt(fixture, sessionID);
    await h.admission.prompt(sessionID, { messageID: createV2MessageId(), parts: [{ type: 'text', text: 'Before compaction.' }] }, { directory });
    await waitForIdle(fixture, sessionID);
    const messageID = createV2MessageId();
    const window = h.since();
    await expect(h.admission.compact(sessionID, { providerID: 'fixture', modelID: 'fixture-model', messageID })).resolves.toBe(true);
    const calls = window();
    expect(writes(calls)).toEqual([`POST /api/session/${sessionID}/compact`]);
    expect(calls[0].body).toEqual({ id: messageID });
    await waitForIdle(fixture, sessionID);
  });

  it('creates sessions with DevRyan ids, privileged children and mapped rules', async () => {
    const id = 'ses_admissioncreate01';
    const first = await h.admission.create({ id, title: 'Idempotent', directory });
    const retried = await h.admission.create({ id, title: 'Idempotent', directory });
    expect(retried.id).toBe(first.id);
    expect(first).toMatchObject({ id, title: 'Idempotent', directory });

    const window = h.since();
    const child = await h.admission.create({ parentID: id, title: 'Child', agent: 'build', model: MODEL, metadata: { origin: 'test', devryan: { spoof: true } } });
    expect(child).toMatchObject({ parentID: id, title: 'Child', directory, metadata: { origin: 'test' } });
    expect(child.id).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    const childCall = window().find((call) => call.path === '/devryan/session');
    expect(childCall.body).toMatchObject({ parentID: id, model: { id: 'fixture-model', providerID: 'fixture' }, metadata: { origin: 'test' } });
    expect(childCall.body.metadata.devryan).toBeUndefined();
    expect(h.diagnostics).toContainEqual(expect.objectContaining({ code: 'opencode_admission_reserved_metadata_dropped' }));

    const permission = [{ permission: 'bash', pattern: '*', action: 'ask' }, { permission: 'read', pattern: '*', action: 'allow' }];
    const rooted = h.since();
    const ruled = await h.admission.create({ title: 'Ruled', directory, permission });
    expect(rooted().find((call) => call.method === 'POST' && call.path === '/api/session').body)
      .toMatchObject({ permissions: [{ action: 'shell', resource: '*', effect: 'ask' }, { action: 'read', resource: '*', effect: 'allow' }] });
    expect((await h.client.sessions.get(ruled.id)).permission).toEqual(permission);

    await expect(h.admission.create({ title: 'nowhere' })).rejects.toMatchObject({ code: C.locationRequired });
    await expect(h.admission.create({ id: 'bad', directory })).rejects.toMatchObject({ code: C.invalidInput });
    await expect(h.admission.create({ directory, permission: 'all' })).rejects.toMatchObject({ code: C.invalidInput });
  });

  it('forks with {before} and removes through the owned delegate', async () => {
    const window = h.since();
    const fork = await h.admission.fork(PERF_PARENT_SESSION_ID, { messageID: `msg_user_${PERF_PARENT_SESSION_ID}` });
    expect(window().find((call) => call.path.endsWith('/fork')).body).toEqual({ before: `msg_user_${PERF_PARENT_SESSION_ID}` });
    expect(fork.parentID).toBeUndefined();
    expect(fork.id).not.toBe(PERF_PARENT_SESSION_ID);
    await expect(h.admission.fork(PERF_PARENT_SESSION_ID, { messageID: 'nope' })).rejects.toMatchObject({ code: C.invalidInput });

    await expect(h.admission.remove(fork.id)).resolves.toBe(true);
    expect(h.ownedRemovals).toEqual([{ operation: 'sessions.remove', method: 'DELETE',
      path: `/api/session/${fork.id}`, directory: undefined }]);
    await expect(h.client.sessions.get(fork.id, { allowNotFound: true })).resolves.toBeNull();
  });

  it('is reached through the openCodeClient prompts group', async () => {
    const sessionID = await newSession();
    quickPrompt(fixture, sessionID);
    const window = h.since();
    await expect(h.client.prompts.prompt(sessionID, { messageID: createV2MessageId(), parts: [{ type: 'text', text: 'Via client.' }] }, { directory }))
      .resolves.toBeNull();
    expect(writes(window())).toEqual([`POST /api/session/${sessionID}/prompt`]);
    await waitForIdle(fixture, sessionID);
    await expect(h.client.prompts.compact(sessionID, {}, { directory })).resolves.toBe(true);
    await waitForIdle(fixture, sessionID);
  });

  it('refuses unsupported or invalid prompt bodies before any request', async () => {
    const window = h.since();
    await expect(h.admission.prompt('ses_perfchild1', { format: { type: 'json_schema', schema: {} }, parts: [{ type: 'text', text: 'x' }] }))
      .rejects.toMatchObject({ code: C.capabilityUnavailable, statusCode: 501 });
    await expect(h.admission.prompt('ses_perfchild1', { system: 'Be terse.', parts: [{ type: 'text', text: 'x' }] }))
      .rejects.toMatchObject({ code: C.capabilityUnavailable });
    await expect(h.admission.prompt('ses_perfchild1', { parts: [] })).rejects.toMatchObject({ code: C.invalidInput });
    await expect(h.admission.prompt('not-a-session', { parts: [{ type: 'text', text: 'x' }] })).rejects.toMatchObject({ code: C.invalidInput });
    await expect(h.admission.prompt('ses_perfchild1', { parts: [{ type: 'text', text: 'x' }], delivery: 'later' })).rejects.toMatchObject({ code: C.invalidInput });
    await expect(h.admission.prompt('ses_perfchild1', { parts: [{ type: 'text', text: 'x' }] }, { objectiveID: 'nope' })).rejects.toMatchObject({ code: C.invalidInput });
    expect(window()).toEqual([]);
  });

  it('accepts the companion immediate-prompt body as a steer', async () => {
    const sessionID = await newSession();
    quickPrompt(fixture, sessionID);
    const window = h.since();
    await h.admission.prompt(sessionID, { prompt: { text: 'Follow up.', agents: [{ name: 'explorer' }] }, delivery: 'immediate' }, { directory });
    const sent = window().find((call) => call.path.endsWith('/prompt')).body;
    expect(sent).toMatchObject({ text: 'Follow up.', agents: [{ name: 'explorer' }], delivery: 'steer' });
    expect(sent.id).toMatch(/^msg_/);
    await waitForIdle(fixture, sessionID);
  });

  it('is gen-2 only', async () => {
    const gen1 = harness(fixture, { generation: 1 });
    const window = gen1.since();
    await expect(gen1.admission.prompt('ses_perfchild1', { parts: [{ type: 'text', text: 'x' }] })).rejects.toMatchObject({ code: C.capabilityUnavailable, generation: 1 });
    await expect(gen1.admission.command('ses_perfchild1', { command: 'review' })).rejects.toMatchObject({ code: C.capabilityUnavailable });
    await expect(gen1.admission.compact('ses_perfchild1')).rejects.toMatchObject({ code: C.capabilityUnavailable });
    await expect(gen1.admission.abort('ses_perfchild1')).rejects.toMatchObject({ code: C.capabilityUnavailable });
    await expect(gen1.admission.create({ directory })).rejects.toMatchObject({ code: C.capabilityUnavailable });
    await expect(gen1.admission.fork('ses_perfchild1')).rejects.toMatchObject({ code: C.capabilityUnavailable });
    await expect(gen1.admission.remove('ses_perfchild1')).rejects.toMatchObject({ code: C.capabilityUnavailable });
    expect(window()).toEqual([]);
    expect(() => createOpenCodeAdmission({})).toThrow(TypeError);
    expect(() => createOpenCodeAdmission({ getRuntime: () => ({}) }, { defaultDelivery: 'later' })).toThrow(TypeError);
  });
});

describe('admission variant inheritance from the agent catalog', () => {
  let directory;
  let fixture;

  beforeAll(async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'devryan-admission-variant-'));
    fixture = await createLoopbackOpenCodeFixtureForGeneration(2, { directory, heartbeatMs: 50, agentVariant: 'high' });
  });

  afterAll(async () => {
    fixture?.stopScenario({ settle: false });
    await fixture?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('switches to the agent variant when the prompt omits it, and omits it when the catalog fails', async () => {
    const h = harness(fixture);
    const sessionID = (await h.admission.create({ title: 'Variant', directory })).id;
    quickPrompt(fixture, sessionID);
    const window = h.since();
    await h.admission.prompt(sessionID, { messageID: createV2MessageId(), agent: 'build', model: MODEL, parts: [{ type: 'text', text: 'x' }] }, { directory });
    const calls = window();
    expect(calls.find((call) => call.path.endsWith('/model')).body).toEqual({ model: { id: 'fixture-model', providerID: 'fixture', variant: 'high' } });
    expect(Object.hasOwn(calls.find((call) => call.path.endsWith('/prompt')).body.metadata.devryan, 'variant')).toBe(false);
    await waitForIdle(fixture, sessionID);

    const failing = harness(fixture, { deps: { fetchImpl: (url, init) => (new URL(url).pathname === '/api/agent'
      ? Promise.resolve(Response.json({ _tag: 'ServiceUnavailableError', message: 'down' }, { status: 503 }))
      : globalThis.fetch(url, init)) } });
    quickPrompt(fixture, sessionID);
    await failing.admission.prompt(sessionID, { messageID: createV2MessageId(), agent: 'build', model: MODEL, parts: [{ type: 'text', text: 'y' }] }, { directory });
    expect(failing.diagnostics).toContainEqual(expect.objectContaining({ code: 'opencode_admission_variant_unresolved', errorCode: C.unavailable }));
    await waitForIdle(fixture, sessionID);
  });
});

/** Native 2.0.20 replays an existing inbox ID with 200 regardless of payload. */
const nativeAdmissionStore = () => {
  const turns = new Map();
  const calls = [];
  const session = { id: 'ses_identity', title: 'Identity', agent: 'build', model: { id: MODEL.modelID, providerID: MODEL.providerID },
    location: { directory: '/workspace' }, permissions: [], time: { created: 1, updated: 1 } };
  let runtime = { generation: 2, baseUrl: 'http://admission.invalid', epoch: 1 };
  let transcript = false;
  let busy = false;
  let post;
  let inbox;
  const deps = {
    getRuntime: () => runtime,
    fetchImpl: async (url, init = {}) => {
      const pathname = new URL(url).pathname;
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: pathname, body });
      if (method === 'GET' && pathname.includes('/message/')) {
        const id = pathname.split('/').at(-1);
        const turn = transcript ? turns.get(id) : undefined;
        return turn ? Response.json({ data: { id: turn.id, type: turn.type, time: turn.time, ...turn.payload } })
          : Response.json({ _tag: 'MessageNotFoundError' }, { status: 404 });
      }
      if (method === 'GET' && pathname.endsWith('/inbox')) return Response.json({ data: inbox ? inbox() : (transcript ? [] : [...turns.values()]) });
      if (method === 'GET' && pathname === '/api/session/active') return Response.json({ data: busy ? { [session.id]: {} } : {} });
      if (method === 'GET' && pathname === '/api/agent') return Response.json({ data: [] });
      if (method === 'GET' && pathname === `/api/session/${session.id}`) return Response.json({ data: session });
      if (method === 'PATCH') { session.permissions = body.permissions; return Response.json({ data: session }); }
      if (method === 'POST' && pathname.endsWith('/agent')) { session.agent = body.agent; return Response.json({ data: session }); }
      if (method === 'POST' && pathname.endsWith('/model')) { session.model = body.model; return Response.json({ data: session }); }
      if (method === 'POST' && pathname.endsWith('/prompt')) {
        if (post) return post(body);
        const existing = turns.get(body.id);
        if (existing) return Response.json({ data: existing });
        const turn = { id: body.id, sessionID: session.id, type: 'user', time: { created: 1 }, delivery: body.delivery,
          payload: { text: body.text, metadata: body.metadata, ...(body.files ? { files: body.files } : {}), ...(body.agents ? { agents: body.agents } : {}) } };
        turns.set(body.id, turn);
        return Response.json({ data: turn });
      }
      throw new Error(`Unexpected native admission fixture request: ${method} ${pathname}`);
    },
  };
  return { deps, calls, turns, session, fresh: (options) => createOpenCodeAdmission(deps, options),
    setTranscript: (value) => { transcript = value; }, setBusy: (value) => { busy = value; },
    setPost: (value) => { post = value; }, setInbox: (value) => { inbox = value; },
    replaceRuntime: () => { runtime = { ...runtime, baseUrl: 'http://relocated.invalid', epoch: runtime.epoch + 1, paths: { data: '/relocated' } }; } };
};

describe('durable accepted-operation identity and native permissions', () => {
  const original = () => ({ messageID: 'msg_identity', agent: 'build', model: { ...MODEL }, noReply: true, tools: { bash: false },
    parts: [{ type: 'text', id: 'prt_identity', text: 'Same text.' },
      { type: 'file', mime: 'image/png', filename: 'a.png', url: PNG_URL }, { type: 'agent', name: 'explorer' }] });
  const originalOptions = () => ({ origin: 'human', objectiveID: 'msg_objective1' });
  const changes = [
    ['text', (body) => { body.parts[0].text = 'Other text.'; }],
    ['image bytes', (body) => { body.parts[1].url = 'data:image/png;base64,AQID'; }],
    ['file name', (body) => { body.parts[1].filename = 'b.png'; }],
    ['segment identity', (body) => { body.parts[0].id = 'prt_other'; }],
    ['synthetic segment', (body) => { body.parts[0].synthetic = true; }],
    ['agent mention', (body) => { body.parts[2].name = 'librarian'; }],
    ['agent selection', (body) => { body.agent = 'orchestrator'; }],
    ['model selection', (body) => { body.model.modelID = 'other-model'; }],
    ['effort', (body) => { body.variant = 'high'; }],
    ['inherit versus provider default', (body) => { body.variant = null; }],
    ['tool restriction', (body) => { body.tools.bash = true; }],
    ['objective', (_body, opts) => { opts.objectiveID = 'msg_objective2'; }],
    ['origin', (_body, opts) => { opts.origin = 'orchestration'; }],
    ['resume', (body) => { body.noReply = false; }],
    ['delivery', (body) => { body.delivery = 'steer'; }],
    ['plan metadata', (body) => { body.planMode = true; }],
  ];

  for (const state of ['warm', 'inbox', 'transcript']) {
    it.each(changes)(`refuses changed %s in ${state} before any selection/permission effects`, async (_name, change) => {
      const store = nativeAdmissionStore();
      const admission = store.fresh();
      await admission.prompt(store.session.id, original(), originalOptions());
      store.setTranscript(state === 'transcript');
      const body = original();
      const opts = originalOptions();
      change(body, opts);
      store.calls.length = 0;
      await expect((state === 'warm' ? admission : store.fresh()).prompt(store.session.id, body, opts))
        .rejects.toMatchObject({ code: C.conflict, detail: { reason: 'prompt_id_reused' } });
      expect(writes(store.calls)).toEqual([]);
      expect(store.calls.some((call) => call.path === `/api/session/${store.session.id}`)).toBe(false);
    });
  }

  it('queued callback rejection retains the accepted ID and retry refuses an unowned pending row without a second POST',async()=>{
    const store=nativeAdmissionStore();let staged,calls=0,failures=0,owns=false;
    const nativeOwner={checkQueuedPromptAdmission:async()=>{},requestHeaders:()=>({}),withAcceptedOperation:async(_input,action)=>action(),updateAcceptedOperation:()=>{},
      stageQueuedPromptAdmission:(_receipt,admit)=>{staged=admit},
      assertQueuedPromptReconciled:async()=>{if(!owns)throw Object.assign(Error('Retained input needs review'),{code:'native_queued_input_retained',status:409})}};
    const options={nativeOwner,beforePromptDispatch:async()=>{calls++;throw Error('Primary refused')},onPromptDispatchFailure:async()=>{failures++}};
    store.setPost(async body=>{
      store.turns.set(body.id,{id:body.id,sessionID:store.session.id,type:'user',delivery:'queue',payload:{text:body.text,metadata:body.metadata}});
      await expect(staged(async()=>{})).rejects.toThrow('Primary refused');
      return Response.json({_tag:'InternalError'},{status:500});
    });
    const body={...original(),delivery:'queue'},admission=store.fresh(options);
    await expect(admission.prompt(store.session.id,body,originalOptions())).rejects.toThrow();
    expect(calls).toBe(1);expect(failures).toBe(1);expect(store.turns.size).toBe(1);
    const posts=()=>store.calls.filter(call=>call.method==='POST'&&call.path.endsWith('/prompt')).length;
    expect(posts()).toBe(1);
    await expect(store.fresh(options).prompt(store.session.id,body,originalOptions())).rejects.toMatchObject({code:'native_queued_input_retained'});
    expect(posts()).toBe(1);expect(calls).toBe(1);
    owns=true;await expect(store.fresh(options).prompt(store.session.id,body,originalOptions())).resolves.toBeNull();
    expect(posts()).toBe(1);expect(calls).toBe(1);
    owns=false;store.setTranscript(true);
    await expect(store.fresh(options).prompt(store.session.id,body,originalOptions())).resolves.toBeNull();
    expect(posts()).toBe(1);expect(calls).toBe(1);
  });

  it('known native queue rollback is nonacceptance and never runs the staged primary callback',async()=>{
    const store=nativeAdmissionStore();let staged=false,calls=0;
    const nativeOwner={checkQueuedPromptAdmission:async()=>{},requestHeaders:()=>({}),withAcceptedOperation:async(_input,action)=>action(),updateAcceptedOperation:()=>{},
      stageQueuedPromptAdmission:()=>{staged=true},queuedPromptWasRejected:()=>staged};
    store.setPost(()=>Response.json({_tag:'ConflictError'},{status:409}));
    await expect(store.fresh({nativeOwner,beforePromptDispatch:async()=>{calls++}}).prompt(store.session.id,{...original(),delivery:'queue'},originalOptions()))
      .rejects.toMatchObject({code:'native_queued_input_blocked',statusCode:409});
    expect(staged).toBe(true);expect(calls).toBe(0);expect(store.turns.size).toBe(0);
  });

  it.each(['inbox', 'transcript'])('reconciles an unchanged %s after restart/relocation without selection effects', async (state) => {
    const store = nativeAdmissionStore();
    await store.fresh().prompt(store.session.id, original(), originalOptions());
    store.setTranscript(state === 'transcript');
    store.replaceRuntime();
    store.calls.length = 0;
    await expect(store.fresh().prompt(store.session.id, original(), originalOptions())).resolves.toBeNull();
    expect(writes(store.calls)).toEqual([]);
    expect(store.calls.some((call) => call.path === `/api/session/${store.session.id}`)).toBe(false);
  });

  it('refuses legacy same-text evidence and ignores caller-supplied accepted metadata', async () => {
    const store = nativeAdmissionStore();
    store.turns.set('msg_identity', { id: 'msg_identity', sessionID: store.session.id, type: 'user', payload: { text: 'Same text.' } });
    const body = original();
    body.metadata = { devryan: { admission: { v: 1, fingerprint: 'a'.repeat(64) } } };
    await expect(store.fresh().prompt(store.session.id, body, originalOptions()))
      .rejects.toMatchObject({ code: ADMISSION_ERROR_CODES.identityUncertain, retryable: false });
    expect(writes(store.calls)).toEqual([]);
  });

  it.each([200, 409])('does not trust same-ID native %i replay with different accepted identity', async (status) => {
    const store = nativeAdmissionStore();
    await store.fresh().prompt(store.session.id, original(), originalOptions());
    const old = structuredClone(store.turns.get('msg_identity'));
    store.turns.clear();
    store.setPost(() => {
      store.turns.set(old.id, old);
      return status === 200 ? Response.json({ data: old }) : Response.json({ _tag: 'ConflictError' }, { status });
    });
    const changed = original();
    changed.parts[1].filename = 'changed.png';
    const fresh = store.fresh();
    await expect(fresh.prompt(store.session.id, changed, originalOptions())).rejects.toMatchObject({ code: C.conflict });
    expect(fresh.inspect().admittedCount).toBe(0);
  });

  it('propagates bounded-read failures during conflict reconciliation', async () => {
    const store = nativeAdmissionStore();
    store.setPost(() => { store.setInbox(() => [{ id: 'msg_identity', text: 'x'.repeat(8192) }]);
      return Response.json({ _tag: 'ConflictError' }, { status: 409 }); });
    await expect(store.fresh().prompt(store.session.id, { messageID: 'msg_identity', parts: [{ type: 'text', text: 'x' }] },
      { maxResponseBytes: 2048 })).rejects.toMatchObject({ code: 'opencode_response_too_large' });
  });

  it('fails closed on malformed absence evidence before effects', async () => {
    const store = nativeAdmissionStore();
    store.setInbox(() => ({ not: 'a list' }));
    await expect(store.fresh().prompt(store.session.id, original(), originalOptions()))
      .rejects.toMatchObject({ code: ADMISSION_ERROR_CODES.identityUncertain });
    expect(writes(store.calls)).toEqual([]);
  });

  it('preserves unrelated native permissions and applies last-match denies before admission', async () => {
    const store = nativeAdmissionStore();
    store.session.permissions = [{ action: '*', resource: '*', effect: 'allow' }, { action: 'read', resource: '/private/*', effect: 'deny' }];
    const body = original();
    body.tools = { write: false, task: false, bash: false };
    await store.fresh().prompt(store.session.id, body, originalOptions());
    expect(store.session.permissions).toEqual([
      { action: '*', resource: '*', effect: 'allow' }, { action: 'read', resource: '/private/*', effect: 'deny' },
      { action: 'edit', resource: '*', effect: 'deny' }, { action: 'shell', resource: '*', effect: 'deny' },
      { action: 'subagent', resource: '*', effect: 'deny' },
    ]);
    expect(writes(store.calls)).toEqual([`PATCH /api/session/${store.session.id}`, `POST /api/session/${store.session.id}/prompt`]);
  });

  it.each([{ write: false, edit: true }, { write: true }, { bash: false, shell: true }])('refuses unrepresentable overrides %j without effects', async (tools) => {
    const store = nativeAdmissionStore();
    await expect(store.fresh().prompt(store.session.id, { ...original(), tools }, originalOptions()))
      .rejects.toMatchObject({ code: C.capabilityUnavailable, detail: { reason: 'shared_permission_action' } });
    expect(store.calls).toEqual([]);
  });

  it('allows an explicit whole-writer-group override', async () => {
    const store = nativeAdmissionStore();
    await store.fresh().prompt(store.session.id, { ...original(), tools: { write: true, edit: true, apply_patch: true } }, originalOptions());
    expect(store.session.permissions).toEqual([{ action: 'edit', resource: '*', effect: 'allow' }]);
  });

  it('denies every custom action before granting only explicit native recovery reads',async()=>{
    const store=nativeAdmissionStore();store.session.permissions=[{action:'custom-write',resource:'*',effect:'allow'}];
    await store.fresh().prompt(store.session.id,{...original(),tools:{'*':false,devryan_task:false,devryan_document:false,read:true,glob:true,grep:false}},originalOptions());
    expect(store.session.permissions).toEqual([{action:'custom-write',resource:'*',effect:'allow'},
      {action:'*',resource:'*',effect:'deny'},{action:'glob',resource:'*',effect:'allow'},
      {action:'grep',resource:'*',effect:'deny'},{action:'read',resource:'*',effect:'allow'}]);
    const denied=nativeAdmissionStore();
    await expect(denied.fresh().prompt(denied.session.id,{...original(),tools:{'*':true}},originalOptions())).rejects.toMatchObject({code:C.invalidInput});
    expect(denied.calls).toEqual([]);
  });

  it('refuses changed permissions while busy before switching agent/model or admitting', async () => {
    const store = nativeAdmissionStore();
    store.setBusy(true);
    await expect(store.fresh().prompt(store.session.id, original(), originalOptions()))
      .rejects.toMatchObject({ code: ADMISSION_ERROR_CODES.selectionChangeWhileBusy, detail: { changes: ['permissions'] } });
    expect(writes(store.calls)).toEqual([]);
  });

  it('does not let a custom rule resolver drop required overrides', async () => {
    const store = nativeAdmissionStore();
    await store.fresh({ toolRules: { resolve: async () => [{ action: '*', resource: '*', effect: 'allow' }] } })
      .prompt(store.session.id, original(), originalOptions());
    expect(store.session.permissions.at(-1)).toEqual({ action: 'shell', resource: '*', effect: 'deny' });
  });

  it('fails closed when a rule resolver cannot resolve requested permissions', async () => {
    const store = nativeAdmissionStore();
    await expect(store.fresh({ toolRules: { resolve: async () => null } }).prompt(store.session.id, original(), originalOptions()))
      .rejects.toMatchObject({ code: C.capabilityUnavailable });
    expect(writes(store.calls)).toEqual([]);
  });

  it('refuses an unknown plugin permission mapping instead of silently ignoring its deny', async () => {
    const store = nativeAdmissionStore();
    await expect(store.fresh().prompt(store.session.id, { ...original(), tools: { plugin_writer: false } }, originalOptions()))
      .rejects.toMatchObject({ code: C.capabilityUnavailable, detail: { reason: 'tool_permission_action_unavailable' } });
    expect(store.calls).toEqual([]);
  });

  it('admits the shared Orchestrator policy without granting native delegation', async () => {
    const store = nativeAdmissionStore();
    store.session.agent = 'orchestrator';
    const tools = resolveProviderPromptTools('fixture', 'orchestrator');
    await store.fresh().prompt(store.session.id, { ...original(), agent: 'orchestrator', tools }, originalOptions());
    expect(store.session.permissions.at(-1)).toEqual({ action: 'subagent', resource: '*', effect: 'deny' });
    expect(writes(store.calls)).toEqual([`PATCH /api/session/${store.session.id}`, `POST /api/session/${store.session.id}/prompt`]);
  });

  it.each(['invalid', 'arbitrary_plugin_tool'])('still refuses an unknown %s permission action before effects', async (name) => {
    const store = nativeAdmissionStore();
    await expect(store.fresh().prompt(store.session.id, { ...original(), tools: { [name]: false } }, originalOptions()))
      .rejects.toMatchObject({ code: C.capabilityUnavailable, statusCode: 501,
        detail: { reason: 'tool_permission_action_unavailable', tool: name } });
    expect(store.calls).toEqual([]);
  });

  it('reconciles from durable metadata after bounded cache eviction', async () => {
    const store = nativeAdmissionStore();
    const admission = store.fresh();
    await admission.prompt(store.session.id, original(), originalOptions());
    for (let index = 0; index < 512; index += 1) {
      await admission.prompt(store.session.id, { messageID: `msg_eviction${index}`, noReply: true, parts: [{ type: 'text', text: `${index}` }] });
    }
    expect(admission.inspect().admittedCount).toBe(512);
    store.calls.length = 0;
    await expect(admission.prompt(store.session.id, original(), originalOptions())).resolves.toBeNull();
    expect(store.calls).toHaveLength(1);
    expect(writes(store.calls)).toEqual([]);
  });

  it('drops warm identity on runtime replacement and admits against the new store', async () => {
    const store = nativeAdmissionStore();
    const admission = store.fresh();
    await admission.prompt(store.session.id, original(), originalOptions());
    store.replaceRuntime();
    store.turns.clear();
    store.calls.length = 0;
    await admission.prompt(store.session.id, original(), originalOptions());
    expect(writes(store.calls)).toEqual([`POST /api/session/${store.session.id}/prompt`]);
  });

  it('does not manufacture warm success or resurrect an accepted turn removed by native Revert', async () => {
    const store = nativeAdmissionStore();
    const admission = store.fresh();
    await admission.prompt(store.session.id, original(), originalOptions());
    store.turns.clear();
    store.calls.length = 0;
    await expect(admission.prompt(store.session.id, original(), originalOptions()))
      .rejects.toMatchObject({ code: ADMISSION_ERROR_CODES.identityUncertain, retryable: false });
    expect(writes(store.calls)).toEqual([]);
    expect(store.calls).toHaveLength(2);
  });

  it('finds a turn promoted from inbox to transcript between preflight reads', async () => {
    const store = nativeAdmissionStore();
    await store.fresh().prompt(store.session.id, original(), originalOptions());
    store.setInbox(() => { store.setTranscript(true); return []; });
    store.calls.length = 0;
    await expect(store.fresh().prompt(store.session.id, original(), originalOptions())).resolves.toBeNull();
    expect(store.calls.map((call) => call.path)).toEqual([
      `/api/session/${store.session.id}/inbox`, `/api/session/${store.session.id}/message/msg_identity`,
    ]);
    expect(writes(store.calls)).toEqual([]);
  });

  it('refuses invalid live activity evidence before changing selection or permissions', async () => {
    const store = nativeAdmissionStore();
    const fetchImpl = store.deps.fetchImpl;
    store.deps.fetchImpl = (url, init) => new URL(url).pathname === '/api/session/active'
      ? Promise.resolve(Response.json({ data: [] })) : fetchImpl(url, init);
    await expect(store.fresh().prompt(store.session.id, original(), originalOptions())).rejects.toMatchObject({ code: C.invalidResponse });
    expect(writes(store.calls)).toEqual([]);
  });

  it('does not swallow a caller response-budget observer failure while resolving effort', async () => {
    const store = nativeAdmissionStore();
    const failure = Object.assign(new Error('aggregate budget exhausted'), { code: 'caller_budget_exhausted' });
    let readingCatalog = false;
    const fetchImpl = store.deps.fetchImpl;
    store.deps.fetchImpl = async (url, init) => {
      readingCatalog = new URL(url).pathname === '/api/agent';
      return fetchImpl(url, init);
    };
    await expect(store.fresh().prompt(store.session.id, original(), {
      ...originalOptions(), directory: '/workspace', onResponseRead: ({ phase }) => { if (readingCatalog && phase === 'chunk') throw failure; },
    })).rejects.toBe(failure);
    expect(writes(store.calls)).toEqual([]);
  });
});

describe('trusted accepted effective selection', () => {
  const body = (id, variant) => ({ messageID: id, agent: 'build', model: MODEL,
    ...(variant === undefined ? {} : { variant }), parts: [{ type: 'text', text: 'Selection' }] });

  it('accepts a native new session with a selected model and no stored agent', async () => {
    const store = nativeAdmissionStore();
    delete store.session.agent;
    const receipts = [];
    await store.fresh({ beforePromptDispatch: async receipt => { receipts.push(receipt); } })
      .prompt(store.session.id, { messageID: 'msg_nativeNew', model: MODEL, parts: [{ type: 'text', text: 'Ordinary prompt' }] });
    expect(store.turns.has('msg_nativeNew')).toBe(true);
    expect(receipts[0].execution).toBeNull();
    expect(Object.hasOwn(store.turns.get('msg_nativeNew').payload.metadata.devryan, 'agent')).toBe(false);
  });

  it('freezes inherited effort after native switches while preserving request intent and retry budgets', async () => {
    const store = nativeAdmissionStore();
    const fetchNative = store.deps.fetchImpl;
    store.deps.fetchImpl = (url, init) => new URL(url).pathname === '/api/agent'
      ? Promise.resolve(Response.json({ data: [{ id: 'build', model: { providerID: MODEL.providerID, id: MODEL.modelID, variant: 'high' } }] }))
      : fetchNative(url, init);
    const receipts = [];
    const admission = store.fresh({ beforePromptDispatch: async receipt => {
      expect(store.calls.some(call => call.path.endsWith('/prompt'))).toBe(false);
      receipts.push(receipt);
    } });
    await admission.prompt(store.session.id, body('msg_effective'));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ messageID: 'msg_effective', directory: '/workspace',
      execution: { providerID: MODEL.providerID, modelID: MODEL.modelID, agent: 'build', variant: 'high' } });
    expect(Object.hasOwn(receipts[0].body, 'variant')).toBe(false);
    expect(Object.hasOwn(store.turns.get('msg_effective').payload.metadata.devryan, 'variant')).toBe(false);
    store.session.model.variant = 'low';
    await admission.prompt(store.session.id, body('msg_effective'));
    await store.fresh({ beforePromptDispatch: async () => { throw new Error('cold replay must not re-admit'); } })
      .prompt(store.session.id, body('msg_effective'));
    expect(receipts).toHaveLength(1);
    expect(store.session.model.variant).toBe('low');
  });

  it.each(['', null, 'default'])('freezes explicit default %j without inheriting configured effort', async variant => {
    const store = nativeAdmissionStore();
    store.session.model.variant = 'high';
    const receipts = [];
    await store.fresh({ beforePromptDispatch: async receipt => { receipts.push(receipt); } })
      .prompt(store.session.id, body('msg_default', variant));
    expect(receipts[0].execution.variant).toBe('default');
    expect(receipts[0].body.variant).toBe(variant);
    expect(store.turns.get('msg_default').payload.metadata.devryan.variant).toBe(variant === 'default' ? 'default' : null);
  });

  it('rejects invalid, refused and unresolved selection before primary admission', async () => {
    for (const failure of ['invalid', 'switch', 'catalog', 'runtime']) {
      const store = nativeAdmissionStore();
      const nativeFetch = store.deps.fetchImpl;
      let sessionReads = 0;
      store.deps.fetchImpl = async (url, init) => {
        const pathname = new URL(url).pathname;
        if (failure === 'switch' && pathname.endsWith('/model')) return Response.json({ _tag: 'ServiceUnavailableError' }, { status: 503 });
        if (failure === 'catalog' && pathname === '/api/agent') return Response.json({ _tag: 'ServiceUnavailableError' }, { status: 503 });
        const result = await nativeFetch(url, init);
        if (failure === 'runtime' && pathname === `/api/session/${store.session.id}` && ++sessionReads === 2) store.replaceRuntime();
        return result;
      };
      let admitted = false;
      const requested = body('msg_refused', failure === 'catalog' ? undefined : 'high');
      if (failure === 'invalid') requested.model = {};
      await expect(store.fresh({ beforePromptDispatch: async () => { admitted = true; } })
        .prompt(store.session.id, requested)).rejects.toBeDefined();
      expect(admitted).toBe(false);
      expect(store.calls.some(call => call.path.endsWith('/prompt'))).toBe(false);
    }
  });

  it('keeps the prior durable primary unchanged when a later model switch is refused', async () => {
    const store = nativeAdmissionStore();
    const nativeFetch = store.deps.fetchImpl;
    let refuseSwitch = false;
    store.deps.fetchImpl = (url, init) => refuseSwitch && new URL(url).pathname.endsWith('/model')
      ? Promise.resolve(Response.json({ _tag: 'ServiceUnavailableError' }, { status: 503 })) : nativeFetch(url, init);
    const directory = mkdtempSync(path.join(tmpdir(), 'accepted-primary-'));
    let admission;
    const client = createOpenCodeClient({ ...store.deps, getAdmission: () => admission });
    const host = createPrimaryRecoveryHost({ dataDirectory: directory, openCodeClient: client, isManaged: () => true,
      buildOpenCodeUrl: () => { throw new Error('v1 unavailable'); }, authorize: async () => true,
      managedBarrier: async () => ({ state: 'clear' }), progressTimeoutMs: false });
    try {
      await host.initialize();
      admission = store.fresh({ client, beforePromptDispatch: receipt => host.admitNativePrompt(receipt, { owner: 'fixture' }) });
      await admission.prompt(store.session.id, body('msg_prior', ''));
      const prior = await host.readRecord(store.session.id);
      refuseSwitch = true;
      await expect(admission.prompt(store.session.id, body('msg_later', 'high'))).rejects.toBeDefined();
      await expect(admission.prompt(store.session.id, { ...body('msg_invalid', 'high'), model: {} })).rejects.toBeDefined();
      expect(await host.readRecord(store.session.id)).toEqual(prior);
      expect(prior).toMatchObject({ anchorID: 'msg_prior', variant: 'default', executionGeneration: 2 });
    } finally { await host.drain(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('marks post-callback runtime replacement uncertain before any native dispatch', async () => {
    const store = nativeAdmissionStore();
    const events = [];
    await expect(store.fresh({ beforePromptDispatch: async receipt => {
      events.push(['admit', receipt.messageID]); store.replaceRuntime();
    }, onPromptDispatchFailure: async receipt => { events.push(['uncertain', receipt.messageID]); } })
      .prompt(store.session.id, body('msg_replaced', ''))).rejects.toMatchObject({ code: C.runtimeChanged });
    expect(events).toEqual([['admit', 'msg_replaced'], ['uncertain', 'msg_replaced']]);
    expect(store.calls.some(call => call.path.endsWith('/prompt'))).toBe(false);
  });

  it('reads the actual post-switch tuple for a background primary callback outside web prompt context', async () => {
    for (const agent of ['build', 'orchestrator']) {
      const store = nativeAdmissionStore();
      store.session.model.variant = 'high';
      const expected = { providerID: 'fixture', modelID: 'fallback-model', agent, variant: 'default' };
      let receipt;
      const admission = store.fresh({ requiresEffectiveSelection: () => false,
        beforePromptDispatch: async value => {
          // The original recovery owner fences this exact reserved tuple before POST.
          if (JSON.stringify(value.execution) !== JSON.stringify({ agent, providerID: expected.providerID,
            modelID: expected.modelID, variant: expected.variant })) {
            throw Object.assign(new Error('native_fallback_fenced'), { code: 'native_fallback_fenced' });
          }
          expect(store.calls.some(call => call.path.endsWith('/prompt'))).toBe(false);
          receipt = value;
        } });
      await expect(admission.prompt(store.session.id, { messageID: 'msg_backgroundFallback', agent,
        model: { providerID: expected.providerID, modelID: expected.modelID }, variant: expected.variant,
        parts: [{ type: 'text', text: 'Original failed input' }] }, { origin: 'provider-recovery' })).resolves.toBeNull();
      expect(receipt.execution).toEqual(expected);
      expect(store.turns.has('msg_backgroundFallback')).toBe(true);
      expect(store.calls.filter(call => call.path === `/api/session/${store.session.id}`)).toHaveLength(2);
    }
  });

  it('refuses a post-switch native snapshot that did not accept the requested background selection', async () => {
    const store = nativeAdmissionStore(), fetchNative = store.deps.fetchImpl;
    store.deps.fetchImpl = (url, init) => init?.method === 'POST' && new URL(url).pathname.endsWith('/model')
      ? Promise.resolve(Response.json({ data: store.session })) : fetchNative(url, init);
    let admitted = false;
    await expect(store.fresh({ requiresEffectiveSelection: () => false,
      beforePromptDispatch: async () => { admitted = true; } }).prompt(store.session.id,
    { ...body('msg_refusedBackground', 'default'), model: { providerID: MODEL.providerID, modelID: 'fallback-model' } },
    { origin: 'provider-recovery' })).rejects.toMatchObject({ code: C.conflict });
    expect(admitted).toBe(false);
    expect(store.turns.size).toBe(0);
  });

  it('keeps unchanged primary opt-out and child selection outside the post-switch primary proof', async () => {
    for (const parentID of [undefined, 'ses_parent']) {
      const store = nativeAdmissionStore();
      if (parentID) store.session.parentID = parentID;
      await store.fresh({ requiresEffectiveSelection: () => false, beforePromptDispatch: async () => {} })
        .prompt(store.session.id, { ...body('msg_optoutScope', 'default'),
          ...(parentID ? { model: { providerID: MODEL.providerID, modelID: 'child-model' } } : {}) });
      expect(store.turns.has('msg_optoutScope')).toBe(true);
      expect(store.calls.filter(call => call.path === `/api/session/${store.session.id}`)).toHaveLength(1);
    }
  });

  it('preserves catalog fallback when the trusted host opts out of primary selection', async () => {
    const store = nativeAdmissionStore();
    const nativeFetch = store.deps.fetchImpl;
    store.deps.fetchImpl = (url, init) => new URL(url).pathname === '/api/agent'
      ? Promise.resolve(Response.json({ _tag: 'ServiceUnavailableError' }, { status: 503 })) : nativeFetch(url, init);
    await store.fresh({ requiresEffectiveSelection: () => false, beforePromptDispatch: async () => {} })
      .prompt(store.session.id, body('msg_unmanaged'));
    expect(store.turns.has('msg_unmanaged')).toBe(true);
    expect(store.calls.filter(call => call.path === `/api/session/${store.session.id}`)).toHaveLength(1);
  });

  it('reports a lost native acknowledgement without rolling back a recorded primary selection', async () => {
    const store = nativeAdmissionStore();
    store.setPost(() => { throw new Error('lost native acknowledgement'); });
    const events = [];
    await expect(store.fresh({ beforePromptDispatch: async receipt => { events.push(['admit', receipt.messageID]); },
      onPromptDispatchFailure: async receipt => { events.push(['uncertain', receipt.messageID]); } })
      .prompt(store.session.id, body('msg_uncertain', ''))).rejects.toThrow('lost native acknowledgement');
    expect(events).toEqual([['admit', 'msg_uncertain'], ['uncertain', 'msg_uncertain']]);
  });
});
