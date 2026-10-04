// Native OpenCode client contract and unchanged application wire projection.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLoopbackOpenCodeFixtureForGeneration } from '../../../../../../scripts/perf/loopback-opencode-fixtures.mjs';
import { PERF_CHILD_SESSION_IDS, PERF_PARENT_SESSION_ID } from '../../../../../../scripts/perf/fixture-session-seeds.mjs';
import { createOpenCodeAdmission } from '../v2/admission.js';
import { NO_CONTENT, isNoContent, readResponseBody, unwrapData, unwrapList, unwrapLocated, unwrapPage, unwrapV1Payload } from './envelope.js';
import { mapV2ErrorResponse, OPENCODE_CLIENT_ERROR_CODES, OpenCodeClientError, V2_ERROR_TAG_CODES } from './errors.js';
import { createOpenCodeClient, OPENCODE_CLIENT_SHAPE } from './index.js';
import { translateLocation } from './location.js';
import { createPrivilegedOpenCodeClient } from './privileged.js';
import { createV2AudienceRequester } from './requester.js';
import { createV2Requester, createV2SessionId, parseV2EventBlock } from './v2.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));
const SERVER_ROOT = path.join(REPO_ROOT, 'packages/web/server');
const [CHILD_ONE, CHILD_TWO, CHILD_THREE] = PERF_CHILD_SESSION_IDS;
const GENERATIONS = [2];
const C = OPENCODE_CLIENT_ERROR_CODES;

const sortBy = (items, key) => [...items].sort((left, right) => (String(left[key]) < String(right[key]) ? -1 : 1));

const normalizeSession = (session) => (session === null ? null : {
  title: session.title,
  directory: session.directory,
  projectID: session.projectID,
  parentID: session.parentID ?? null,
  archived: session.time?.archived ?? null,
});

const textOf = (record) => record.parts.filter((part) => part.type === 'text').map((part) => part.text).join('');

// Normalize application content independently of native step markers.
const STEP_MARKERS = new Set(['step-start', 'step-finish']);

const normalizeRecord = (record) => ({
  role: record.info.role,
  text: textOf(record),
  parts: record.parts.map((part) => part.type).filter((type) => !STEP_MARKERS.has(type)),
  ...(record.info.role === 'user' ? { agent: record.info.agent, model: { providerID: record.info.model?.providerID, modelID: record.info.model?.modelID } } : {}),
});

const nonIdle = (statuses) => Object.fromEntries(Object.entries(statuses ?? {}).filter(([, status]) => status?.type !== 'idle'));

describe('openCodeClient contract (native v2 fixture)', () => {
  let directory;
  const h = {};

  beforeAll(async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'devryan-opencode-client-'));
    const fixture = await createLoopbackOpenCodeFixtureForGeneration(2, { directory, heartbeatMs: 50 });
    const fetchCalls = [], diagnostics = [];
    let admission;
    const deps = {
      getAdmission: () => admission,
      getRuntime: () => ({ generation: 2, baseUrl: fixture.origin, paths: { home: '/home/fixture' } }),
      getAuthHeaders: () => ({ ...fixture.authHeaders }),
      fetchImpl: (url, init) => {
        fetchCalls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
        return globalThis.fetch(url, init);
      },
      recordDiagnostic: diagnostic => diagnostics.push(diagnostic),
    };
    // Wire-only fixture delegation; native lanes own real removal/admission authority.
    const fixtureWire = createV2AudienceRequester(deps, { audience: 'server' });
    deps.withNativeWebOperation = async (_spec, action) => action();
    deps.removeNativeSession = async (sessionID, options) => {
      await fixtureWire({ method: 'DELETE', path: `/api/session/${sessionID}`, directory: options.directory });
      return true;
    };
    admission = createOpenCodeAdmission(deps);
    h[2] = { fixture, client: createOpenCodeClient(deps), privileged: createPrivilegedOpenCodeClient(deps), fetchCalls, diagnostics };
  });

  afterAll(async () => {
    h[2]?.fixture.stopScenario({ settle: false });
    await h[2]?.fixture.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('exposes the public client and privileged shapes', () => {
    const { client, privileged } = h[2];
    expect(client.generation()).toBe(2);
    expect(Object.keys(client).sort()).toEqual(['catalog', 'events', 'generation', 'health', 'interaction', 'prompts', 'sessions']);
    for (const [group, names] of Object.entries(OPENCODE_CLIENT_SHAPE)) {
      if (Array.isArray(names)) expect(Object.keys(client[group]).sort()).toEqual([...names].sort());
    }
    expect(Object.keys(client.interaction.permissions).sort()).toEqual(['list', 'reply']);
    expect(Object.keys(client.interaction.questions).sort()).toEqual(['list', 'reject', 'reply']);
    expect(Object.keys(privileged).sort()).toEqual(['createChildSession', 'externalMessage', 'instructions', 'locationReload',
      'readCanonicalUserPage', 'readSessionMetadata', 'readUserMessage', 'revert', 'setMetadata', 'setPermissions', 'switchAgent', 'switchModel', 'synthetic']);
  });

  it.each([undefined, null, 1, 3, '2'])('refuses runtime identity %s before any I/O', async generation => {
    const fetchImpl = vi.fn();
    const client = createOpenCodeClient({ getRuntime: () => ({ generation, baseUrl: h[2].fixture.origin }), fetchImpl });
    expect(() => client.generation()).toThrow(OpenCodeClientError);
    expect(() => client.events.url()).toThrow(OpenCodeClientError);
    await expect(client.sessions.get(PERF_PARENT_SESSION_ID)).rejects.toMatchObject({ code: C.generationInvalid, statusCode: 503 });
    await expect(client.prompts.prompt(CHILD_ONE, { parts: [] })).rejects.toMatchObject({ code: C.generationInvalid });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe('sessions', () => {
    it('reads known sessions and distinguishes missing records', async () => {
      const { client } = h[2];
      const session = await client.sessions.get(PERF_PARENT_SESSION_ID, { directory });
      expect(normalizeSession(session)).toMatchObject({ title: 'Performance parent', directory, parentID: null });
      expect(await client.sessions.get('ses_missingcontract', { directory, allowNotFound: true })).toBeNull();
      await expect(client.sessions.get('ses_missingcontract', { directory })).rejects.toMatchObject({ code: C.notFound, statusCode: 404, generation: 2, tag: 'SessionNotFoundError' });
    });

    it('lists roots, children, parent filters and bounded pages', async () => {
      const { client } = h[2];
      const perf = new Set([PERF_PARENT_SESSION_ID, ...PERF_CHILD_SESSION_IDS]);
      const ids = sessions => sessions.map(row => row.id).filter(id => perf.has(id)).sort();
      expect(ids(await client.sessions.list({ directory }))).toEqual([...perf].sort());
      expect(ids(await client.sessions.list({ directory, roots: true }))).toEqual([PERF_PARENT_SESSION_ID]);
      expect(ids(await client.sessions.children(PERF_PARENT_SESSION_ID, { directory }))).toEqual([...PERF_CHILD_SESSION_IDS].sort());
      expect(ids(await client.sessions.list({ directory, parentID: PERF_PARENT_SESSION_ID }))).toEqual([...PERF_CHILD_SESSION_IDS].sort());
      expect(await client.sessions.list({ directory, limit: 2 })).toHaveLength(2);
    });

    it('keeps a search applied on later pages', async () => {
      const { client } = h[2];
      const kept = await client.sessions.create({ title: 'Needle kept', directory });
      await client.sessions.create({ title: 'Hay between', directory });
      const hidden = await client.sessions.create({ title: 'Needle archived', directory });
      await client.sessions.archive(hidden.id, 1_767_225_600_000, { directory });
      const pageRequests = [];
      const paging = createOpenCodeClient({
        getRuntime: () => ({ generation: 2, baseUrl: h[2].fixture.origin }),
        getAuthHeaders: () => ({ ...h[2].fixture.authHeaders }),
        fetchImpl: (url, init) => { pageRequests.push(new URL(url).searchParams); return globalThis.fetch(url, init); },
      });
      const listed = await paging.sessions.list({ directory, search: 'Needle', archived: false, limit: 1 });
      expect(listed.map(row => row.id)).toEqual([kept.id]);
      expect(pageRequests.length).toBeGreaterThan(1);
      expect(pageRequests[1].has('cursor')).toBe(true);
      await client.sessions.remove(hidden.id, { directory });
    });

    it('creates, renames, archives and removes exact sessions', async () => {
      const { client } = h[2];
      const root = await client.sessions.create({ title: 'Contract root', directory });
      expect(root.id).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      const child = await client.sessions.create({ title: 'Contract child', directory, parentID: root.id });
      expect(child).toMatchObject({ parentID: root.id, title: 'Contract child' });
      expect((await client.sessions.update(root.id, { title: 'Renamed' }, { directory })).title).toBe('Renamed');
      const at = 1_767_225_600_000;
      expect((await client.sessions.archive(root.id, at, { directory })).time.archived).toBe(at);
      const reread = await client.sessions.get(root.id, { directory });
      expect(reread.time.archived).toBe(at);
      expect(reread.metadata?.devryan).toBeUndefined();
      expect((await client.sessions.archive(root.id, null, { directory })).time.archived ?? null).toBeNull();
      expect(await client.sessions.remove(child.id, { directory })).toBe(true);
      expect(await client.sessions.get(child.id, { directory, allowNotFound: true })).toBeNull();
    });

    it('reads canonical user IDs and paginates complete history with exact assistant parents', async () => {
      const { client, fixture } = h[2];
      const userID = `msg_user_${PERF_PARENT_SESSION_ID}`;
      const seeded = await client.sessions.messages(PERF_PARENT_SESSION_ID, {}, { directory });
      expect(seeded.cursor).toBeUndefined();
      expect(seeded.records[0].info.id).toBe(userID);
      expect(normalizeRecord(await client.sessions.message(PERF_PARENT_SESSION_ID, userID, { directory }))).toEqual(normalizeRecord(seeded.records[0]));
      fixture.seedHistory(CHILD_THREE, { turns: 5 });
      const pages = [];
      let before;
      for (let index = 0; index < 5; index++) {
        const page = await client.sessions.messages(CHILD_THREE, { limit: 4, ...(before ? { before } : {}) }, { directory });
        pages.push(page);
        if (!page.cursor) break;
        before = page.cursor;
      }
      expect(pages.map(page => page.records.length)).toEqual([4, 4, 3]);
      expect(pages.map(page => Boolean(page.cursor))).toEqual([true, true, false]);
      const records = pages.flatMap(page => page.records), byID = new Map(records.map(row => [row.info.id, textOf(row)]));
      expect(records[0].info.role).toBe('assistant');
      expect(byID.get(records[0].info.parentID)).toBe('History request 4');
      expect(fixture.getState().messagePageRequests.some(row => row.type === 'user')).toBe(false);
      expect(fixture.getState().messagePageRequests.some(row => row.cursor && row.limit === 200)).toBe(true);
    });

    it('keeps todos scoped to their owner and returns projected diffs', async () => {
      const { client, fixture } = h[2];
      const items = [{ content: 'Write the contract suite', status: 'in_progress', priority: 'high', id: 'todo-1' }];
      fixture.setTodos(CHILD_ONE, items);
      expect(await client.sessions.todo(CHILD_ONE, { directory })).toEqual(items);
      expect(await client.sessions.todo(CHILD_TWO, { directory })).toEqual([]);
      expect(await client.sessions.diff(CHILD_ONE, { messageID: `msg_user_${CHILD_ONE}` }, { directory })).toEqual([]);
    });

    it('filters active statuses by directory and aborts idempotently', async () => {
      const { client, fixture } = h[2];
      fixture.startScenario('one-stream');
      try {
        expect(nonIdle(await client.sessions.status({ directory }))).toEqual({ [PERF_PARENT_SESSION_ID]: { type: 'busy' } });
        expect(nonIdle(await client.sessions.status({ directory: `${directory}-other` }))).toEqual({});
        expect(await client.sessions.abort(PERF_PARENT_SESSION_ID, { directory })).toBe(true);
        expect(nonIdle(await client.sessions.status({ directory }))).toEqual({});
        expect(await client.sessions.abort(PERF_PARENT_SESSION_ID, { directory })).toBe(true);
      } finally { fixture.stopScenario({ settle: false }); }
    });
  });

  describe('interaction', () => {
    it('answers permission requests without changing session ownership', async () => {
      const { client, fixture } = h[2];
      fixture.askPermission(CHILD_TWO, { permission: 'bash', patterns: ['npm test'] });
      const listed = await client.interaction.permissions.list({ directory });
      expect(listed).toMatchObject([{ sessionID: CHILD_TWO, permission: 'bash', patterns: ['npm test'], always: ['npm test'], metadata: {} }]);
      expect(await client.interaction.permissions.reply(listed[0].id, { reply: 'once' }, { directory })).toBe(true);
      expect(fixture.getState().replies.filter(row => row.type === 'permission').map(row => row.reply)).toEqual(['once']);
      expect(await client.interaction.permissions.list({ directory })).toEqual([]);
    });

    it('answers and rejects questions with canonical form IDs', async () => {
      const { client, fixture } = h[2];
      fixture.askQuestion(CHILD_TWO);
      const listed = await client.interaction.questions.list({ directory });
      expect(listed).toHaveLength(1);
      expect(listed[0].sessionID).toBe(CHILD_TWO);
      expect(await client.interaction.questions.reply(listed[0].id, { answers: [['Sort by priority']] }, { directory })).toBe(true);
      expect(fixture.getState().replies.filter(row => row.type === 'question').map(row => row.answers)).toEqual([[['Sort by priority']]]);
      fixture.askQuestion(CHILD_TWO);
      const pending = await client.interaction.questions.list({ directory });
      expect(await client.interaction.questions.reject(pending[0].id, { directory })).toBe(true);
      expect(await client.interaction.questions.list({ directory })).toEqual([]);
    });
  });

  describe('catalog', () => {
    it('projects native catalog, configuration and location into the app contract', async () => {
      const { client } = h[2];
      const agents = await client.catalog.agents({ directory });
      expect(agents).toHaveLength(3);
      expect(sortBy(agents, 'name').map(row => row.name)).toEqual(['build', 'builder', 'orchestrator']);
      const providers = await client.catalog.providers({ directory });
      expect(providers.default).toEqual({ fixture: 'fixture-model' });
      expect(providers.providers.map(row => ({ id: row.id, models: Object.keys(row.models).sort() }))).toEqual([{ id: 'fixture', models: ['fixture-model'] }]);
      const listed = await client.catalog.providerList({ directory });
      expect(listed).toMatchObject({ connected: ['fixture'], default: { fixture: 'fixture-model' } });
      expect(await client.catalog.commands({ directory })).toEqual([]);
      expect(await client.catalog.skills({ directory })).toEqual([]);
      expect(await client.catalog.mcp({ directory })).toEqual({});
      expect((await client.catalog.config({ directory })).model).toBe('fixture/fixture-model');
      expect(await client.catalog.project({ directory })).toMatchObject({ worktree: directory });
      expect(await client.catalog.path({ directory })).toMatchObject({ directory, worktree: directory, home: '/home/fixture' });
      expect(await client.catalog.vcs({ directory })).toEqual({ branch: 'perf-fixture' });
      const tools = await client.catalog.tools({ directory });
      expect(tools.ids).toEqual(['bash', 'read', 'edit', 'write', 'question']);
      expect(tools.definitions).toBeNull();
      expect((await client.catalog.tools({ directory, providerID: 'fixture', modelID: 'fixture-model' })).definitions.map(row => row.id)).toEqual(tools.ids);
    });
  });

  describe('health and events', () => {
    it('checks native readiness and projects native event envelopes', async () => {
      const { client, fixture } = h[2];
      expect(await client.health.probe({ timeoutMs: 3000, env: {} })).toMatchObject({ ready: true, generation: 2 });
      expect(client.events.url()).toBe(`${fixture.origin}/api/event`);
      expect(client.events.parseBlock(': heartbeat')).toEqual({ kind: 'comment' });
      const envelope = { id: 'evt_1', created: 1, type: 'session.execution.started', location: { directory }, data: { sessionID: 'ses_a' } };
      expect(client.events.parseBlock(`data: ${JSON.stringify(envelope)}`)).toEqual({ kind: 'event', eventId: 'evt_1', directory, envelope });
      expect(parseV2EventBlock('data: {not json')).toBeNull();
      expect(parseV2EventBlock('event: x')).toBeNull();
      expect(client.events.createProjector()).toMatchObject({ generation: 2 });
    });
  });

  describe('prompts', () => {
    it('gen 2 fails closed without admission and delegates to it when present', async () => {
      const fetchCount = h[2].fetchCalls.length;
      const withoutAdmission = createOpenCodeClient({ getRuntime: () => ({ generation: 2, baseUrl: h[2].fixture.origin }) });
      await expect(withoutAdmission.prompts.prompt(CHILD_TWO, { parts: [] }, { directory })).rejects.toMatchObject({ code: C.admissionUnavailable });
      await expect(withoutAdmission.prompts.command(CHILD_TWO, { command: 'x' }, { directory })).rejects.toMatchObject({ code: C.admissionUnavailable });
      expect(h[2].fetchCalls.length).toBe(fetchCount);

      const admission = { prompt: vi.fn(async () => ({ accepted: true })), command: vi.fn(async () => true) };
      const client = createOpenCodeClient({
        getRuntime: () => ({ generation: 2, baseUrl: h[2].fixture.origin }),
        getAuthHeaders: () => ({ ...h[2].fixture.authHeaders }),
        getAdmission: () => admission,
      });
      const body = { messageID: 'msg_x', parts: [{ type: 'text', text: 'hello' }] };
      await expect(client.prompts.prompt(CHILD_TWO, body, { directory })).resolves.toEqual({ accepted: true });
      expect(admission.prompt).toHaveBeenCalledWith(CHILD_TWO, body, { directory });
      await expect(client.prompts.command(CHILD_TWO, { command: 'x' }, { directory })).resolves.toBe(true);
      // Without an admission compactor, compact posts /compact directly.
      await expect(client.prompts.compact(CHILD_TWO, {}, { directory })).resolves.toBe(true);
    });
  });

  describe('gen 2 only', () => {
    it('location-scoped operations fail closed before any request', async () => {
      const before = h[2].fetchCalls.length;
      const locationRequired = h[2].fixture.getState().locationRequired.length;
      await expect(h[2].client.catalog.agents()).rejects.toMatchObject({ code: C.locationRequired, statusCode: 400 });
      await expect(h[2].client.interaction.permissions.list()).rejects.toMatchObject({ code: C.locationRequired });
      await expect(h[2].client.interaction.questions.list({})).rejects.toMatchObject({ code: C.locationRequired });
      await expect(h[2].client.sessions.create({ title: 'nowhere' })).rejects.toMatchObject({ code: C.locationRequired });
      await expect(h[2].client.catalog.tools({})).rejects.toMatchObject({ code: C.locationRequired });
      await expect(h[2].client.catalog.agents({ directory: 'relative/dir' })).rejects.toMatchObject({ code: C.locationInvalid });
      expect(h[2].fetchCalls.length).toBe(before);
      expect(h[2].fixture.getState().locationRequired.length).toBe(locationRequired);
    });

    it('sends the location header URI-encoded and never on session-scoped routes', async () => {
      const calls = [];
      const client = createOpenCodeClient({
        getRuntime: () => ({ generation: 2, baseUrl: h[2].fixture.origin }),
        getAuthHeaders: () => ({ ...h[2].fixture.authHeaders }),
        fetchImpl: (url, init) => { calls.push({ url: String(url), headers: init.headers }); return globalThis.fetch(url, init); },
      });
      await client.catalog.vcs({ directory });
      await client.sessions.get(PERF_PARENT_SESSION_ID, { directory });
      await client.sessions.list({ directory, limit: 1 });
      expect(calls[0].headers['x-opencode-directory']).toBe(encodeURIComponent(directory));
      expect(calls[1].headers['x-opencode-directory']).toBeUndefined();
      expect(new URL(calls[1].url).search).toBe('');
      expect(new URL(calls[2].url).searchParams.get('directory')).toBe(directory);
      expect(calls[2].headers['x-opencode-directory']).toBeUndefined();
    });

    it('the route policy keeps privileged and denied routes off the server client', async () => {
      const fetchImpl = vi.fn();
      const deps = { getRuntime: () => ({ generation: 2, baseUrl: h[2].fixture.origin }), fetchImpl };
      const server = createV2Requester(deps, { audience: 'server' });
      await expect(server({ label: 'test.synthetic', method: 'POST', path: `/api/session/${CHILD_TWO}/synthetic`, body: { text: 'x' } }))
        .rejects.toMatchObject({ code: C.routeDenied, statusCode: 403, detail: { reason: 'audience_insufficient' } });
      await expect(server({ label: 'test.shell', method: 'POST', path: `/api/session/${CHILD_TWO}/shell`, body: { command: 'ls' } }))
        .rejects.toMatchObject({ code: C.routeDenied, detail: { reason: 'route_denied' } });
      await expect(server({ label: 'test.patch', method: 'PATCH', path: `/api/session/${CHILD_TWO}`, body: { metadata: {} } }))
        .rejects.toMatchObject({ code: C.routeDenied });
      await expect(server({ label: 'test.unknown', path: '/api/nope' })).rejects.toMatchObject({ code: C.routeDenied, detail: { reason: 'route_unknown' } });
      await expect(server({ label: 'test.dotdot', path: '/api/session/../pty' })).rejects.toMatchObject({ code: C.routeDenied });
      await expect(server({ label: 'test.host', method: 'POST', path: `/devryan/session/${CHILD_TWO}/external-message`, body: { message: {} } }))
        .rejects.toMatchObject({ code: C.routeDenied, detail: { reason: 'audience_insufficient' } });
      await expect(server({ label: 'test.host', method: 'POST', path: '/devryan/session', body: { parentID: CHILD_TWO, metadata: {} } }))
        .rejects.toMatchObject({ code: C.routeDenied });
      expect(() => createV2Requester(deps, { audience: 'browser' })).toThrow(TypeError);
      expect(fetchImpl).not.toHaveBeenCalled();
      await expect(h[2].client.sessions.create({ title: 'x', directory, permission: [] })).rejects.toMatchObject({ code: C.privilegeRequired });
    });

    it('binds locations to the allowed roots when the policy lists them', async () => {
      const client = createOpenCodeClient({
        getRuntime: () => ({ generation: 2, baseUrl: h[2].fixture.origin }),
        getAuthHeaders: () => ({ ...h[2].fixture.authHeaders }),
        policy: { allowedRoots: () => [directory] },
      });
      await expect(client.catalog.vcs({ directory })).resolves.toEqual({ branch: 'perf-fixture' });
      await expect(client.catalog.vcs({ directory: path.join(path.dirname(directory), 'elsewhere') })).rejects.toMatchObject({ code: C.locationInvalid });
    });

    it('fills a page that switch rows shrank', async () => {
      const { fixture, client, privileged } = h[2];
      fixture.seedHistory(CHILD_TWO, { turns: 4 });
      for (const agent of ['build', 'orchestrator', 'build', 'orchestrator', 'build', 'orchestrator']) {
        await privileged.switchAgent(CHILD_TWO, agent);
      }
      const requests = fixture.getState().messagePageRequests.length;
      const page = await client.sessions.messages(CHILD_TWO, { limit: 4 }, { directory });
      expect(page.records.length).toBeGreaterThanOrEqual(4);
      expect(page.cursor).toMatch(/^v2:/);
      const fetched = fixture.getState().messagePageRequests.slice(requests).filter((request) => request.type === null);
      expect(fetched.length).toBeGreaterThan(1);
      expect(page.records.every((record) => ['user', 'assistant'].includes(record.info.role))).toBe(true);
      await expect(client.sessions.messages(CHILD_TWO, { limit: 4, before: 'msg_gen1cursor' }, { directory }))
        .rejects.toMatchObject({ code: C.invalidCursor, statusCode: 400 });
    });

    it('fork keeps a fork a root session', async () => {
      const fork = await h[2].client.sessions.fork(PERF_PARENT_SESSION_ID, { messageID: `msg_user_${PERF_PARENT_SESSION_ID}` });
      expect(fork.id).not.toBe(PERF_PARENT_SESSION_ID);
      expect(fork.parentID).toBeUndefined();
      expect(fork.directory).toBe(directory);
    });

    it('private canonical user pages preserve native input provenance and count every scanned row', async () => {
      const sessionID = 'ses_private_page';
      const user = { id: 'msg_actual_user', type: 'user', seq: 1, text: 'real input', time: { created: 1 },
        metadata: { devryan: { v: 1, parts: [{ kind: 'synthetic', length: 10, id: 'part_real_input' }] } } };
      const notice = { id: 'msg_notice', type: 'synthetic', seq: 2, text: 'status notice', time: { created: 2 }, metadata:{devryan:{v:1,origin:'interview',statusOnly:true}} };
      const info = { id: sessionID, location: { directory }, agent: 'build', model: { providerID: 'fixture', model: 'fixture-model' } };
      let rawPage = { data: [notice], cursor: { next: 'older' } };
      const fetchImpl = vi.fn(async url => {
        const parsed = new URL(url);
        const body = parsed.pathname.endsWith('/message') ? rawPage : { data: info };
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      });
      const privateClient = createPrivilegedOpenCodeClient({
        getRuntime: () => ({ generation: 2, baseUrl: 'http://127.0.0.1:1' }), fetchImpl,
      });
      const latest = await privateClient.readCanonicalUserPage(sessionID, { limit: 1 }, { directory });
      expect(latest).toEqual({ records: [], cursor: 'v2:older', scannedCount: 1, scannedBytes: Buffer.byteLength(JSON.stringify(rawPage)) });
      rawPage = { data: [user], cursor: { next: 'exhausted' } };
      const older = await privateClient.readCanonicalUserPage(sessionID, { limit: 2, before: latest.cursor }, { directory });
      expect(older.latestTurnParent).toEqual({id:user.id,type:'user',fingerprint:createHash('sha256').update(JSON.stringify(user)).digest('hex')});
      expect(older.cursor).toBeUndefined();
      expect(older.records).toHaveLength(1);
      expect(older.records[0]).toMatchObject({ info: { id: user.id, sessionID, role: 'user' },
        parts: [{ id: 'part_real_input', type: 'text', text: 'real input', synthetic: true }] });
      const messageRequests = fetchImpl.mock.calls.filter(([url]) => new URL(url).pathname.endsWith('/message'));
      expect(messageRequests).toHaveLength(2);
      expect(new URL(messageRequests[1][0]).searchParams.get('cursor')).toBe('older');
      expect(new URL(messageRequests[0][0]).searchParams.has('type')).toBe(false);
      rawPage = { data: [notice, user], cursor: { next: 'older' } };
      await expect(privateClient.readCanonicalUserPage(sessionID, { limit: 1 }, { directory })).rejects.toMatchObject({ code: C.invalidResponse });
      await expect(privateClient.readCanonicalUserPage(sessionID, { limit: 201 }, { directory })).rejects.toMatchObject({ code: C.invalidInput });
      await expect(privateClient.readCanonicalUserPage(sessionID, { before: 'legacy-message' }, { directory })).rejects.toMatchObject({ code: C.invalidInput });
      await expect(privateClient.readCanonicalUserPage(sessionID, {}, { directory: path.join(directory, 'foreign') })).rejects.toMatchObject({ code: C.invalidResponse });
      await expect(privateClient.readCanonicalUserPage(sessionID, {}, { directory, maxResponseBytes: 1 })).rejects.toMatchObject({ code: 'opencode_response_too_large' });
      rawPage = { data: [{ ...notice, text: 'x'.repeat(2000) }], cursor: { next: 'older' } };
      await expect(privateClient.readCanonicalUserPage(sessionID, {}, { directory, maxResponseBytes: 512 })).rejects.toMatchObject({ code: 'opencode_response_too_large' });
      rawPage = { data: Array.from({ length: 200 }, (_, index) => ({ ...notice, id: `msg_notice_${index}` })), cursor: { next: 'older' } };
      await expect(privateClient.readCanonicalUserPage(sessionID, {}, { directory })).resolves.toEqual({
        records: [], cursor: 'v2:older', scannedCount: 200, scannedBytes: Buffer.byteLength(JSON.stringify(rawPage)) });
      const fetchedBeforeInvalidBudget = fetchImpl.mock.calls.length;
      for (const maxResponseBytes of [0, -1, NaN, Infinity, 1.5]) {
        await expect(privateClient.readCanonicalUserPage(sessionID, {}, { directory, maxResponseBytes })).rejects.toThrow('maxResponseBytes must be a positive integer');
      }
      expect(fetchImpl.mock.calls).toHaveLength(fetchedBeforeInvalidBudget);
    });

    it('privileged operations reach the host and fold into the projected session', async () => {
      const { client, privileged } = h[2];
      await expect(privileged.switchModel(CHILD_ONE, { providerID: 'fixture', modelID: 'fixture-model', variant: 'high' })).resolves.toBe(true);
      await expect(privileged.switchAgent(CHILD_ONE, 'orchestrator')).resolves.toBe(true);
      const session = await client.sessions.get(CHILD_ONE);
      expect(session).toMatchObject({ agent: 'orchestrator', model: { id: 'fixture-model', providerID: 'fixture', variant: 'high' } });

      const metadata = { note: 'kept', devryan: { todo: { sessionID: CHILD_ONE, items: [], rev: 4 } } };
      await expect(privileged.setMetadata(CHILD_ONE, metadata)).resolves.toBe(true);
      expect((await client.sessions.get(CHILD_ONE)).metadata).toEqual({ note: 'kept' });
      await expect(privileged.readSessionMetadata(CHILD_ONE, { directory })).resolves.toEqual({ id: CHILD_ONE, directory, metadata });
      await expect(privileged.readSessionMetadata(CHILD_ONE, { directory: path.join(directory, 'other') }))
        .rejects.toMatchObject({ code: C.invalidResponse });
      await expect(privileged.readSessionMetadata(CHILD_ONE)).rejects.toMatchObject({ code: C.invalidInput });
      await expect(privileged.readUserMessage(CHILD_ONE, `msg_user_${CHILD_ONE}`, { directory })).resolves.toMatchObject({
        id: `msg_user_${CHILD_ONE}`, type: 'user', sessionID: CHILD_ONE, directory });
      await expect(privileged.readUserMessage(CHILD_ONE, `msg_user_${CHILD_ONE}`, { directory: path.join(directory, 'other') }))
        .rejects.toMatchObject({ code: C.invalidResponse });
      await expect(privileged.readUserMessage(CHILD_ONE, '../foreign', { directory })).rejects.toMatchObject({ code: C.invalidInput });
      await expect(privileged.setPermissions(CHILD_ONE, [{ action: 'shell', resource: '*', effect: 'ask' }])).resolves.toBe(true);
      expect((await client.sessions.get(CHILD_ONE)).permission).toEqual([{ permission: 'bash', pattern: '*', action: 'ask' }]);

      const child = await privileged.createChildSession({ parentID: CHILD_ONE, title: 'Privileged child', metadata: { origin: 'test' } });
      expect(child).toMatchObject({ parentID: CHILD_ONE, title: 'Privileged child', directory, metadata: { origin: 'test' } });

      const staged = await privileged.revert.stage(CHILD_ONE, { messageID: `msg_user_${CHILD_ONE}` });
      expect(staged).toEqual({ messageID: `msg_user_${CHILD_ONE}`, files: [] });
      expect((await client.sessions.get(CHILD_ONE)).revert).toEqual(staged);
      await expect(privileged.revert.clear(CHILD_ONE)).resolves.toBe(true);
      await privileged.revert.stage(CHILD_ONE, { messageID: `msg_user_${CHILD_ONE}` });
      await expect(privileged.revert.commit(CHILD_ONE)).resolves.toBe(true);

      const inbox = await privileged.synthetic(CHILD_ONE, { text: 'Context note', resume: false });
      expect(inbox).toMatchObject({ type: 'synthetic', sessionID: CHILD_ONE });
      await expect(privileged.synthetic(CHILD_ONE, { text: 'spoof', metadata: { source: 'subagent' } }))
        .rejects.toMatchObject({ code: C.routeDenied, detail: { reason: 'body_rejected' } });

      const external = await privileged.externalMessage(CHILD_ONE, { id: 'msg_external1', type: 'user', text: 'From Cursor', time: { created: Date.now() } });
      expect(external).toEqual({ id: 'msg_external1' });
      await expect(privileged.locationReload()).resolves.toBe(true);
    });

    it('privileged instructions use the session instructions routes', async () => {
      const calls = [];
      const privileged = createPrivilegedOpenCodeClient({
        getRuntime: () => ({ generation: 2, baseUrl: 'http://127.0.0.1:9' }),
        fetchImpl: async (url, init) => { calls.push({ method: init.method, path: new URL(url).pathname, body: init.body }); return new Response(null, { status: 204 }); },
      });
      await expect(privileged.instructions.put(CHILD_ONE, 'devryan.plan', 'Plan text')).resolves.toBe(true);
      await expect(privileged.instructions.remove(CHILD_ONE, 'devryan.plan')).resolves.toBe(true);
      expect(calls).toEqual([
        { method: 'PUT', path: `/api/experimental/session/${CHILD_ONE}/instructions/entries/devryan.plan`, body: JSON.stringify({ value: 'Plan text' }) },
        { method: 'DELETE', path: `/api/experimental/session/${CHILD_ONE}/instructions/entries/devryan.plan`, body: undefined },
      ]);
    });

    it('the server requester cannot be raised to the privileged audience', () => {
      const deps = { getRuntime: () => ({ generation: 2, baseUrl: h[2].fixture.origin }), fetchImpl: vi.fn() };
      expect(() => createV2Requester(deps, { audience: 'privileged' })).toThrow(TypeError);
      expect(() => createV2Requester(deps, { audience: 'browser' })).toThrow(TypeError);
      expect(typeof createV2Requester(deps)).toBe('function');
      expect(() => createV2AudienceRequester(deps, { audience: 'browser' })).toThrow(TypeError);
    });

    it('host routes are normalized and bound to the allowed roots', async () => {
      const fetchImpl = vi.fn(async () => Response.json({ data: { id: 'ses_child' } }));
      const deps = { getRuntime: () => ({ generation: 2, baseUrl: 'http://127.0.0.1:9' }), fetchImpl, policy: { allowedRoots: () => ['/allowed'] } };
      const server = createV2AudienceRequester(deps, { audience: 'server' });
      const privileged = createV2AudienceRequester(deps, { audience: 'privileged' });
      await expect(server({ label: 'test.tools', path: '/devryan/tools', directory: '/etc' }))
        .rejects.toMatchObject({ code: C.locationInvalid, detail: { reason: 'location_outside_roots' } });
      await expect(server({ label: 'test.child', method: 'POST', path: '/devryan/session', body: { parentID: 'ses_p', location: { directory: '/etc' } } }))
        .rejects.toMatchObject({ code: C.locationInvalid });
      await expect(privileged({ label: 'test.external', method: 'POST', path: `/devryan/session/${encodeURIComponent('ses/../x')}/external-message`, body: { message: {} } }))
        .rejects.toMatchObject({ code: C.routeDenied, detail: { reason: 'encoded_separator' } });
      await expect(privileged({ label: 'test.external', method: 'POST', path: '/devryan/session/ses_a/../ses_b/external-message', body: { message: {} } }))
        .rejects.toMatchObject({ code: C.routeDenied });
      expect(fetchImpl).not.toHaveBeenCalled();

      await server({ label: 'test.tools', path: '/devryan/tools', directory: '/allowed/project' });
      await server({ label: 'test.child', method: 'POST', path: '/devryan/session', body: { parentID: 'ses_p' } });
      await server({ label: 'test.child', method: 'POST', path: '/devryan/session', body: { parentID: 'ses_p', location: { directory: '/allowed' } } });
      expect(fetchImpl.mock.calls.map(([url]) => { const parsed = new URL(url); return `${parsed.pathname}${parsed.search}`; }))
        .toEqual([`/devryan/tools?directory=${encodeURIComponent('/allowed/project')}`, '/devryan/session', '/devryan/session']);
    });

    it('questions.list cancels pending forms no question card can answer', async () => {
      const formVector = JSON.parse(readFileSync(new URL('../v2/__vectors__/05-question-form.json', import.meta.url), 'utf8'));
      const listBody = formVector.rest.find((entry) => entry.label === 'form.list.external').body;
      const [external] = listBody.data;
      const calls = [];
      const diagnostics = [];
      const client = createOpenCodeClient({
        getRuntime: () => ({ generation: 2, baseUrl: 'http://127.0.0.1:9' }),
        recordDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        fetchImpl: async (url, init) => {
          const parsed = new URL(url);
          calls.push(`${init.method} ${parsed.pathname}`);
          if (init.method === 'GET') return Response.json(listBody);
          return new Response(null, { status: 204 });
        },
      });
      await expect(client.interaction.questions.list({ directory })).resolves.toEqual([]);
      expect(calls).toEqual(['GET /api/form', `DELETE /api/session/${external.sessionID}/form/${external.id}`]);
      expect(diagnostics).toEqual([expect.objectContaining({ reason: 'external_field', action: 'cancel', outcome: 'cancelled', operation: 'questions.list' })]);
      expect(JSON.stringify(diagnostics)).not.toMatch(/https?:/);
    });

    it('questions.list reports a failed cancel without failing the list', async () => {
      const formVector = JSON.parse(readFileSync(new URL('../v2/__vectors__/05-question-form.json', import.meta.url), 'utf8'));
      const listBody = formVector.rest.find((entry) => entry.label === 'form.list.external').body;
      const diagnostics = [];
      const client = createOpenCodeClient({
        getRuntime: () => ({ generation: 2, baseUrl: 'http://127.0.0.1:9' }),
        recordDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        fetchImpl: async (_url, init) => (init.method === 'GET'
          ? Response.json(listBody)
          : Response.json({ _tag: 'ServiceUnavailableError', message: 'down' }, { status: 503 })),
      });
      await expect(client.interaction.questions.list({ directory })).resolves.toEqual([]);
      expect(diagnostics).toEqual([expect.objectContaining({ outcome: 'cancel_failed', errorCode: C.unavailable })]);
    });

    it('status recovers retry from the latest assistant when the projector does not hold it', async () => {
      const retry = { attempt: 2, at: 1_767_225_660_000, error: { message: 'Rate limited' } };
      const calls = [];
      const deps = (projector) => ({
        getRuntime: () => ({ generation: 2, baseUrl: 'http://127.0.0.1:9' }),
        projector,
        fetchImpl: async (url) => {
          const parsed = new URL(url);
          calls.push(`${parsed.pathname}${parsed.search}`);
          if (parsed.pathname === '/api/session/active') return Response.json({ data: { ses_retrying: { type: 'running' }, ses_running: { type: 'running' } } });
          const rows = parsed.pathname === '/api/session/ses_retrying/message' ? [{ id: 'msg_a', type: 'assistant', retry }] : [{ id: 'msg_b', type: 'assistant' }];
          return Response.json({ data: rows, cursor: {} });
        },
      });
      const cold = await createOpenCodeClient(deps(null)).sessions.status();
      expect(cold).toEqual({ ses_retrying: { type: 'retry', attempt: 2, message: 'Rate limited', next: retry.at }, ses_running: { type: 'busy' } });
      expect(calls).toContain('/api/session/ses_retrying/message?type=assistant&order=desc&limit=1');

      calls.length = 0;
      const live = { sessionStatus: () => ({ type: 'busy' }) };
      expect(await createOpenCodeClient(deps(live)).sessions.status()).toEqual({ ses_retrying: { type: 'busy' }, ses_running: { type: 'busy' } });
      expect(calls).toEqual(['/api/session/active']);
    });

    it('the privileged client refuses a legacy runtime without I/O', async () => {
      const fetchImpl = vi.fn();
      const privileged = createPrivilegedOpenCodeClient({ getRuntime: () => ({ generation: 1, baseUrl: h[2].fixture.origin }), fetchImpl });
      await expect(privileged.switchAgent(CHILD_ONE, 'build')).rejects.toMatchObject({ code: C.capabilityUnavailable, statusCode: 501, generation: 1 });
      await expect(privileged.revert.commit(CHILD_ONE)).rejects.toMatchObject({ code: C.capabilityUnavailable });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
});

describe('envelopes', () => {
  it('unwraps {data}, {data, cursor}, {location, data}, 204 and bare bodies', async () => {
    expect(unwrapData({ data: { id: 'ses_a' } })).toEqual({ id: 'ses_a' });
    expect(unwrapData([{ type: 'document' }])).toEqual([{ type: 'document' }]);
    expect(unwrapData({ interrupted: false })).toEqual({ interrupted: false });
    expect(unwrapData(NO_CONTENT)).toBeNull();
    expect(isNoContent(NO_CONTENT)).toBe(true);
    expect(unwrapLocated({ location: { directory: '/a' }, data: [1] })).toEqual({ location: { directory: '/a' }, data: [1] });
    expect(unwrapPage({ data: [1, 2], cursor: { previous: 'p', next: 'n' } })).toEqual({ data: [1, 2], next: 'n', previous: 'p' });
    expect(unwrapPage({ data: [], cursor: { previous: null, next: null } })).toEqual({ data: [], next: undefined, previous: undefined });
    expect(unwrapList({ location: { directory: '/a' }, data: [3] })).toEqual([3]);
    expect(unwrapList({ data: null })).toEqual([]);
    expect(unwrapV1Payload({ data: 1 })).toBe(1);
    expect(unwrapV1Payload([1])).toEqual([1]);

    expect(await readResponseBody(new Response(null, { status: 204 }))).toMatchObject({ empty: true });
    expect(await readResponseBody(new Response('  ', { status: 200 }))).toMatchObject({ empty: true });
    expect(await readResponseBody(new Response('{"a":1}', { status: 200 }))).toMatchObject({ empty: false, parsed: true, value: { a: 1 } });
    expect(await readResponseBody(new Response('<html>', { status: 200 }))).toMatchObject({ empty: false, parsed: false });
  });

  it('invalid native JSON is opencode_invalid_response', async () => {
    for (const generation of GENERATIONS) {
      const client = createOpenCodeClient({
        getRuntime: () => ({ generation, baseUrl: 'http://127.0.0.1:9' }),
        fetchImpl: async () => new Response('not json', { status: 200 }),
      });
      await expect(client.sessions.get('ses_a', { directory: '/tmp' })).rejects.toMatchObject({ code: C.invalidResponse, statusCode: 502, generation });
    }
  });
});

describe('body-read failures', () => {
  const brokenBody = (status = 200) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"id":"ses_a",'));
      controller.error(new Error('socket reset'));
    },
  }), { status, headers: { 'content-type': 'application/json' } });

  it('a 2xx body that fails mid-read rejects on the native runtime (never null or empty)', async () => {
    for (const generation of GENERATIONS) {
      const client = createOpenCodeClient({
        getRuntime: () => ({ generation, baseUrl: 'http://127.0.0.1:9' }),
        fetchImpl: async () => brokenBody(),
      });
      await expect(client.sessions.get('ses_a', { directory: '/tmp', allowNotFound: true })).rejects.toThrow('socket reset');
      await expect(client.sessions.messages('ses_a', {}, { directory: '/tmp' })).rejects.toThrow('socket reset');
    }
    await expect(readResponseBody(brokenBody())).rejects.toThrow('socket reset');
  });

  it('an error status preserves a body-read failure', async () => {
    for (const generation of GENERATIONS) {
      const client = createOpenCodeClient({
        getRuntime: () => ({ generation, baseUrl: 'http://127.0.0.1:9' }),
        fetchImpl: async () => brokenBody(500),
      });
      await expect(client.sessions.get('ses_a', { directory: '/tmp' })).rejects.toThrow('socket reset');
    }
  });
});

describe('errors and locations', () => {
  it('maps typed v2 tags to DevRyan codes, falling back on the status', () => {
    expect(mapV2ErrorResponse(404, { _tag: 'SessionNotFoundError' })).toEqual({ code: C.notFound, status: 404, retryable: false, tag: 'SessionNotFoundError' });
    expect(mapV2ErrorResponse(409, { _tag: 'SessionBusyError' })).toMatchObject({ code: C.sessionBusy, status: 409 });
    expect(mapV2ErrorResponse(409, { _tag: 'ConflictError' })).toMatchObject({ code: C.conflict, status: 409 });
    expect(mapV2ErrorResponse(503, { _tag: 'ServiceUnavailableError' })).toMatchObject({ code: C.unavailable, status: 503, retryable: true });
    expect(mapV2ErrorResponse(503, { code: 'service_starting' })).toMatchObject({ code: C.unavailable, retryable: true, tag: null });
    expect(mapV2ErrorResponse(418, null)).toMatchObject({ code: C.httpError, status: 418 });
    expect([...V2_ERROR_TAG_CODES.values()].every((entry) => Number.isInteger(entry.status))).toBe(true);
  });

  it('translates each location mode and fails closed on header and body-location', () => {
    expect(translateLocation({ mode: 'header', directory: '/a b', operation: 'op' }).headers).toEqual({ 'x-opencode-directory': '%2Fa%20b' });
    expect(translateLocation({ mode: 'session', directory: '/a', operation: 'op' })).toMatchObject({ headers: {}, query: {} });
    expect(translateLocation({ mode: 'query-directory', directory: '/a', operation: 'op' }).query).toEqual({ directory: '/a' });
    expect(translateLocation({ mode: 'query-directory', operation: 'op' }).query).toEqual({});
    expect(translateLocation({ mode: 'body-location', directory: '/a', body: { id: 'ses_x' }, operation: 'op' }).body)
      .toEqual({ id: 'ses_x', location: { directory: '/a' } });
    expect(() => translateLocation({ mode: 'header', operation: 'op' })).toThrow(expect.objectContaining({ code: C.locationRequired }));
    expect(() => translateLocation({ mode: 'body-location', directory: '  ', operation: 'op' })).toThrow(expect.objectContaining({ code: C.locationRequired }));
    expect(() => translateLocation({ mode: 'query-directory', operation: 'op', required: true })).toThrow(expect.objectContaining({ code: C.locationRequired }));
    expect(() => translateLocation({ mode: 'header', directory: '/a/../b', operation: 'op' })).toThrow(expect.objectContaining({ code: C.locationInvalid }));
    expect(() => translateLocation({ mode: 'mystery', directory: '/a', operation: 'op' })).toThrow(expect.objectContaining({ code: C.locationRequired }));
  });

  it('generates descending, schema-shaped session ids', () => {
    const first = createV2SessionId(1_000);
    const second = createV2SessionId(2_000);
    expect(first).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(second < first).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Privilege boundary (C.1): only the allowlisted modules import the privileged
// factory. Paths are relative to packages/web/server.

const PRIVILEGED_IMPORT_ALLOWLIST = Object.freeze([
  'lib/opencode/v2/admission.js',
  'lib/opencode/session-revert-coordinator.js',
  'lib/opencode/config-apply-runtime.js',
  'lib/opencode/session-execution-host.js',
  'lib/opencode/runtime-host/native-runtime-owner.js',
]);
const CLIENT_DIRECTORY = 'lib/opencode/opencode-client/';
/** Client internals that build privileged requests themselves (the factory, the scoped archive write). */
const CLIENT_INTERNAL_PRIVILEGED = Object.freeze([`${CLIENT_DIRECTORY}privileged.js`, `${CLIENT_DIRECTORY}requester.js`, `${CLIENT_DIRECTORY}v2.js`]);
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', '.vite', '.turbo']);
const SOURCE_FILE = /\.(?:[cm]?js|[cm]?ts|tsx)$/;
const TEST_FILE = /\.(?:test|spec|bench)\.[cm]?[jt]sx?$/;

/** Every source file (not tests) under `root`. */
const listSourceFiles = (root) => {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      if (SKIPPED_DIRECTORIES.has(entry)) continue;
      const full = path.join(current, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) walk(full);
      else if (SOURCE_FILE.test(entry) && !TEST_FILE.test(entry)) files.push(full);
    }
  };
  walk(root);
  return files;
};

/**
 * Files whose source can reach a privileged request: the privileged module or
 * factory, the requester module (it builds the `privileged` audience) or its
 * factory, or a privileged audience literal. A reference counts whether it is
 * a static import, a re-export, `require` or a dynamic `import()`.
 * @param {{ relative: string, source: string }[]} files
 */
const findPrivilegedImporters = (files) => files
  .filter(({ relative, source }) => /opencode-client\/(?:privileged|requester)(?:\.js)?['"]/.test(source)
    || /createPrivilegedOpenCodeClient|createV2AudienceRequester/.test(source)
    || /audience\s*:\s*['"]privileged['"]/.test(source)
    || (relative.startsWith(CLIENT_DIRECTORY) && /['"]\.\/(?:privileged|requester)(?:\.js)?['"]/.test(source)))
  .map(({ relative }) => relative)
  .sort();

describe('privileged client boundary', () => {
  it('detects importers in every form', () => {
    expect(findPrivilegedImporters([
      { relative: 'lib/routes/a.js', source: "import { createPrivilegedOpenCodeClient } from '../opencode/opencode-client/privileged.js';" },
      { relative: 'lib/routes/b.js', source: "const m = await import('../opencode/opencode-client/privileged.js');" },
      { relative: `${CLIENT_DIRECTORY}index.js`, source: "export * from './privileged.js';" },
      { relative: 'lib/routes/c.js', source: "import { createOpenCodeClient } from '../opencode/opencode-client/index.js';" },
      { relative: 'lib/routes/d.js', source: "import { createV2AudienceRequester } from '../opencode/opencode-client/requester.js';" },
      { relative: 'lib/routes/e.js', source: "import { createV2Requester } from '../opencode/opencode-client/v2.js';\ncreateV2Requester(deps, { audience: 'privileged' });" },
      { relative: 'lib/routes/f.js', source: "import { createV2Requester } from '../opencode/opencode-client/v2.js';\ncreateV2Requester(deps);" },
      { relative: `${CLIENT_DIRECTORY}index.js`.replace('index', 'other'), source: "export { createV2AudienceRequester } from './requester.js';" },
    ])).toEqual([`${CLIENT_DIRECTORY}index.js`, `${CLIENT_DIRECTORY}other.js`, 'lib/routes/a.js', 'lib/routes/b.js', 'lib/routes/d.js', 'lib/routes/e.js']);
  });

  it('only the allowlisted modules import the privileged factory', () => {
    const files = listSourceFiles(SERVER_ROOT).map((file) => ({
      relative: path.relative(SERVER_ROOT, file).split(path.sep).join('/'),
      source: readFileSync(file, 'utf8'),
    }));
    expect(files.length).toBeGreaterThan(100);
    const importers = findPrivilegedImporters(files);
    expect(importers.filter((relative) => !PRIVILEGED_IMPORT_ALLOWLIST.includes(relative) && !CLIENT_INTERNAL_PRIVILEGED.includes(relative)))
      .toEqual([]);
    // The detector sees the internals, so a silent miss would show here.
    expect(importers).toEqual(expect.arrayContaining([`${CLIENT_DIRECTORY}privileged.js`, `${CLIENT_DIRECTORY}v2.js`]));
  });

  it('the public client entry does not expose the privileged factory', async () => {
    const entry = await import('./index.js');
    expect(Object.keys(entry)).not.toContain('createPrivilegedOpenCodeClient');
    expect(Object.values(entry)).not.toContain(createPrivilegedOpenCodeClient);
    expect(Object.values(entry)).not.toContain(createV2AudienceRequester);
    const v2 = await import('./v2.js');
    expect(Object.values(v2)).not.toContain(createV2AudienceRequester);
  });
});
