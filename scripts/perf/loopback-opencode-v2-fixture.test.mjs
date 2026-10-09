import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assistantContentPartIds, userTextSegments } from '../../packages/web/server/lib/opencode/v2/projection/ids.js';
import { toV1ToolPart } from '../../packages/web/server/lib/opencode/v2/projection/tools.js';
import { matchOpenCodeV2Route } from '../../packages/web/server/lib/opencode/v2/route-policy.js';
import { createQaManagedTaskReadModel } from '../qa/fixture-managed-tasks.mjs';
import { createLoopbackOpenCodeFixtureForGeneration, resolveLoopbackOpenCodeFixtureGeneration } from './loopback-opencode-fixtures.mjs';
import {
  createLoopbackOpenCodeV2Fixture, OPENCODE_V2_FIXTURE_OPENAPI_PATH, OPENCODE_V2_FIXTURE_SEQUENCES, OPENCODE_V2_FIXTURE_VECTORS_DIRECTORY,
  PERF_CHILD_SESSION_IDS, PERF_PARENT_SESSION_ID,
} from './loopback-opencode-v2-fixture.mjs';
import {
  checkOpenApiValue, createV2FrameParser, createV2WireStore, DEVRYAN_FIXTURE_EVENT_TYPES, OPENCODE_V2_DURABLE_EVENT_VERSIONS,
  OPENCODE_V2_UNLOCATED_EVENT_TYPES, openApiResponseSchema, parseV2FrameBlock, wireEventsForDomainRows,
} from './opencode-v2-wire.mjs';

// ---------------------------------------------------------------------------
// @opencode/schema@2.0.26 validates the retained 2.0.20 vectors. `effect` is resolved from the
// schema package's own location because it is not hoisted.

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const schemaRoot = fs.realpathSync(path.join(repositoryRoot, 'node_modules/@opencode/schema'));
const schemaPackage = JSON.parse(fs.readFileSync(path.join(schemaRoot, 'package.json'), 'utf8'));
const requireFromSchema = createRequire(path.join(schemaRoot, 'package.json'));
const { Schema } = await import(pathToFileURL(requireFromSchema.resolve('effect')).href);
const { EventManifest } = await import(pathToFileURL(path.join(schemaRoot, 'dist/event-manifest.js')).href);

/** Every annotated schema in the package, by identifier (these match the OpenAPI component names). */
const registry = new Map();
{
  const seen = new Set();
  const walk = (value, depth) => {
    if (!value || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value) || depth > 4) return;
    seen.add(value);
    if (Schema.isSchema(value)) {
      const identifier = value.ast?.annotations?.identifier;
      if (typeof identifier === 'string' && !registry.has(identifier)) registry.set(identifier, value);
      return;
    }
    for (const key of Object.keys(value)) {
      try { walk(value[key], depth + 1); } catch { /* getters that throw are not schemas */ }
    }
  };
  for (const folder of ['dist', 'dist/config']) {
    for (const file of fs.readdirSync(path.join(schemaRoot, folder)).filter((name) => name.endsWith('.js')).sort()) {
      walk(await import(pathToFileURL(path.join(schemaRoot, folder, file)).href), 0);
    }
  }
}

const openapiText = fs.readFileSync(OPENCODE_V2_FIXTURE_OPENAPI_PATH, 'utf8');
const openapi = JSON.parse(openapiText);

const decodeError = (schema, value) => {
  try {
    Schema.decodeUnknownSync(schema)(value, { onExcessProperty: 'error' });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const validation = { frames: 0, fixtureOnlyFrames: 0, bodies: 0, effectDecodes: 0 };

/** Decodes one `/api/event` frame with `EventManifest.Latest` (excess properties are errors). */
const validateFrame = (event) => {
  if (DEVRYAN_FIXTURE_EVENT_TYPES.has(event.type)) {
    assert.equal(event.metadata?.devryanFixture, true, 'fixture-only frames are marked');
    validation.fixtureOnlyFrames += 1;
    return;
  }
  const definition = EventManifest.Latest.get(event.type);
  assert.ok(definition, `${event.type} is in the 2.0.20 manifest`);
  if (event.type === 'server.connected') {
    // 2.0.20 writes server.connected as {id, type, data} (server-info-asp20mjn.js), which its own
    // schema rejects for the missing `created`; the fixture mirrors the wire, so `created` is supplied here.
    assert.deepEqual(Object.keys(event).sort(), ['data', 'id', 'type']);
    assert.equal(decodeError(definition, { ...event, created: 0 }), null);
  } else {
    assert.equal(decodeError(definition, event), null, `${event.type} decodes: ${JSON.stringify(event).slice(0, 400)}`);
  }
  validation.frames += 1;
};

/** Validates a REST body against the 2.0.20 response schema: identified components through @opencode/schema. */
const validateBody = (method, template, status, text) => {
  const schema = openApiResponseSchema(openapi, method, template, status);
  assert.notEqual(schema, undefined, `${method} ${template} declares status ${status}`);
  if (schema === null) {
    assert.equal(text, '', `${method} ${template} ${status} has no body`);
    validation.bodies += 1;
    return;
  }
  const value = JSON.parse(text);
  const error = checkOpenApiValue(schema, value, {
    components: openapi.components.schemas,
    onRef: (name, item) => {
      if (!registry.has(name)) return undefined;
      validation.effectDecodes += 1;
      return decodeError(registry.get(name), item);
    },
  });
  assert.equal(error, null, `${method} ${template} ${status}: ${error}`);
  validation.bodies += 1;
};

// ---------------------------------------------------------------------------
// Helpers

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (label, predicate, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await wait(5);
  }
  assert.fail(`timed out waiting for ${label}`);
};

const client = (fixture, location = fixture.directory) => {
  const call = async (method, target, { body, headers = {}, withLocation = true, auth = true, validate = true } = {}) => {
    const response = await fetch(fixture.origin + target, {
      method,
      headers: { ...(auth ? fixture.authHeaders : {}), ...(withLocation ? { 'x-opencode-directory': encodeURIComponent(location) } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const match = matchOpenCodeV2Route(method, target);
    if (validate && match.ok && (response.headers.get('content-type')?.includes('application/json') || text === '')) {
      validateBody(method, match.route.template, response.status, text);
    }
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined };
  };
  return {
    call,
    get: (target, options) => call('GET', target, options),
    post: (target, body, options) => call('POST', target, { ...options, body }),
    patch: (target, body, options) => call('PATCH', target, { ...options, body }),
    del: (target, options) => call('DELETE', target, options),
  };
};

const openStream = async (fixture) => {
  const controller = new AbortController();
  const response = await fetch(`${fixture.origin}/api/event`, { headers: fixture.authHeaders, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const parser = createV2FrameParser();
  const stream = { events: [], comments: 0, ended: false, raw: '' };
  const decoder = new TextDecoder();
  stream.reading = (async () => {
    for await (const chunk of response.body) {
      const text = decoder.decode(chunk, { stream: true });
      stream.raw += text;
      for (const frame of parser.push(text)) {
        if (frame.kind === 'event') stream.events.push(frame.event);
        else stream.comments += 1;
      }
    }
    stream.ended = true;
  })().catch((error) => { if (error.name !== 'AbortError') throw error; });
  stream.close = async () => { controller.abort(); await stream.reading; };
  await waitFor('server.connected', () => stream.events.some((event) => event.type === 'server.connected'));
  return stream;
};

const textItems = (record) => record.content.filter((item) => item.type === 'text');

describe('loopback OpenCode 2.0.20 fixture', () => {
  it('pins the schema package and exposes the v2 control API through the generation selector', async () => {
    assert.equal(schemaPackage.version, '2.0.26');
    assert.ok(registry.has('Session.Info') && registry.has('Session.Message.Info') && registry.has('Form.Info'));
    for (const [type, version] of OPENCODE_V2_DURABLE_EVENT_VERSIONS) {
      const definition = EventManifest.Latest.get(type);
      assert.ok(definition, `${type} is in the manifest`);
      assert.equal(definition.durability, 'durable', `${type} is durable`);
      assert.equal(definition.durable.version, version, `${type} durable version`);
    }
    for (const [type, definition] of EventManifest.Latest) {
      if (definition.durability === 'durable' && type.startsWith('session.')) assert.ok(OPENCODE_V2_DURABLE_EVENT_VERSIONS.has(type), `${type} has a durable version`);
    }
    const gen2 = await createLoopbackOpenCodeFixtureForGeneration('2', { directory: '/qa-selector' });
    try {
      const required = ['origin', 'appendVisualPartDelta', 'replayRecoveryVisual', 'replaySessionFailure', 'configureNextCreatedSessionPrompt',
        'setPromptReasoning', 'releasePrompt', 'appendManagedTaskVisual', 'removeManagedTaskVisual', 'suppressMessageEvents',
        'clearMessageEventSuppression', 'getState', 'close'];
      for (const key of required) assert.equal(typeof gen2[key], key === 'origin' ? 'string' : 'function', `v2 exposes ${key}`);
      assert.equal(gen2.generation, 2);
      assert.equal(gen2.runtimeEnv.DEVRYAN_OPENCODE_GENERATION, '2');
      assert.equal(gen2.runtimeEnv.OPENCODE_SERVER_PASSWORD, gen2.password);
      await assert.rejects(createLoopbackOpenCodeFixtureForGeneration(1, { directory: '/qa-selector' }), /Unsupported/);
      assert.throws(() => resolveLoopbackOpenCodeFixtureGeneration(3), /Unsupported/);
      await assert.rejects(createLoopbackOpenCodeV2Fixture({ directory: 'relative' }), /absolute directory/);
    } finally {
      await gen2.close();
    }
  });

  it('enforces Basic auth, location rules and request schemas, and records unknown routes', async () => {
    const fixture = await createLoopbackOpenCodeV2Fixture({ directory: '/qa-v2-auth', heartbeatMs: 50 });
    const api = client(fixture);
    try {
      const unauthorized = await api.get('/api/info', { auth: false });
      assert.equal(unauthorized.status, 401);
      assert.equal(unauthorized.headers.get('www-authenticate'), 'Basic realm="Secure Area"');
      assert.equal((await api.get('/api/session', { headers: { authorization: 'Basic b3BlbmNvZGU6d3Jvbmc=' } })).status, 401);
      const token = fixture.authHeaders.authorization.slice('Basic '.length);
      assert.equal((await fetch(`${fixture.origin}/api/info?auth_token=${token}`)).status, 200);
      assert.equal((await fetch(`${fixture.origin}/devryan/ready`)).status, 401, '/devryan routes need the same auth');

      const missing = await api.get('/api/agent', { withLocation: false });
      assert.equal(missing.status, 400);
      assert.equal(missing.body.message, 'location_required');
      const locationQuery = await api.get(`/api/agent?location[directory]=${encodeURIComponent('/qa-v2-auth')}`, { withLocation: false });
      assert.equal(locationQuery.status, 200);
      assert.equal((await api.post('/api/session', {}, { withLocation: false })).status, 400, 'session create needs a location');
      assert.equal((await api.post('/api/session', { location: { directory: '/qa-v2-auth' } }, { withLocation: false })).status, 200);
      assert.equal((await api.get('/api/session', { withLocation: false })).status, 200, 'session list is query-directory, not header');
      assert.deepEqual(fixture.getState().locationRequired.map((entry) => entry.path), ['/api/agent', '/api/session']);

      assert.equal((await api.post(`/api/session/${PERF_PARENT_SESSION_ID}/prompt`, { text: 'x', parts: [] })).status, 400, 'unknown body keys are rejected');
      assert.equal((await api.post(`/api/session/${PERF_PARENT_SESSION_ID}/prompt`, {})).status, 400, 'required text');
      assert.equal((await api.get('/api/session/ses_missing')).status, 404);

      assert.equal((await fetch(`${fixture.origin}/session`, { headers: fixture.authHeaders })).status, 404, 'v1 paths are not served on gen 2');
      assert.equal((await api.get('/api/pty', { validate: false })).status, 404, 'known but unserved 2.0.20 route');
      assert.deepEqual(fixture.getState().unknownRoutes.map(({ path: route, known }) => [route, known]), [['/session', false], ['/api/pty', true]]);

      const document = await fetch(`${fixture.origin}/openapi.json`, { headers: fixture.authHeaders });
      assert.equal(await document.text(), openapiText);
    } finally {
      await fixture.close();
    }
  });

  it('answers every DESIGN D route with 2.0.20 schema-valid bodies', async () => {
    const directory = '/qa-v2-routes';
    const fixture = await createLoopbackOpenCodeV2Fixture({ directory, heartbeatMs: 50, commands: [{ name: 'probe', description: 'Probe' }] });
    const api = client(fixture);
    try {
      const info = await api.get('/api/info', { withLocation: false });
      assert.equal(info.body.version, '2.0.20');
      for (const route of ['/api/location', '/api/agent', '/api/agent/build', '/api/provider', '/api/provider/fixture', '/api/model', '/api/model/default',
        '/api/integration', '/api/command', '/api/skill', '/api/mcp', '/api/config', '/api/project', '/api/vcs', '/api/form', '/api/permission/request']) {
        assert.equal((await api.get(route)).status, 200, route);
      }
      assert.equal((await api.get('/api/agent/missing')).status, 404);
      assert.equal((await api.get('/api/provider/missing')).status, 404);
      assert.deepEqual((await api.get('/api/model/default')).body.data.variants.map((variant) => variant.id), ['low', 'high']);

      // Sessions: create (idempotent), list paging at 50 with cursors, get, patch, fork, selections.
      const created = await api.post('/api/session', { id: 'ses_route_created', title: 'Route session' });
      assert.equal(created.body.data.id, 'ses_route_created');
      assert.equal((await api.post('/api/session', { id: 'ses_route_created', title: 'Again' })).body.data.title, 'Route session');
      for (let index = 0; index < 50; index += 1) await api.post('/api/session', { title: `Paged ${index}` });
      const first = await api.get(`/api/session?directory=${encodeURIComponent(directory)}`, { withLocation: false });
      assert.equal(first.body.data.length, 50);
      const second = await api.get(`/api/session?cursor=${first.body.cursor.next}`, { withLocation: false });
      assert.equal(second.body.data.length, 5);
      const third = await api.get(`/api/session?cursor=${second.body.cursor.next}`, { withLocation: false });
      assert.deepEqual(third.body, { data: [], cursor: { previous: null, next: null } });
      assert.equal(new Set([...first.body.data, ...second.body.data].map((session) => session.id)).size, 55);
      const children = await api.get(`/api/session?parentID=${PERF_PARENT_SESSION_ID}`, { withLocation: false });
      assert.deepEqual(children.body.data.map((session) => session.id).sort(), [...PERF_CHILD_SESSION_IDS].sort());
      const roots = await api.get('/api/session?parentID=null&limit=200', { withLocation: false });
      assert.ok(roots.body.data.every((session) => !session.parentID));

      const sessionID = 'ses_route_created';
      const route = `/api/session/${sessionID}`;
      assert.equal((await api.get(route, { withLocation: false })).body.data.title, 'Route session');
      assert.equal((await api.patch(route, { title: 'Renamed' }, { withLocation: false })).status, 204);
      assert.equal((await api.patch(route, { metadata: { devryan: { archive: { sessionID, at: 1 } } } }, { withLocation: false })).status, 204);
      assert.equal((await api.patch(route, { permissions: [{ action: 'edit', resource: '*', effect: 'ask' }] }, { withLocation: false })).status, 204);
      const patched = (await api.get(route, { withLocation: false })).body.data;
      assert.equal(patched.title, 'Renamed');
      assert.deepEqual(patched.metadata, { devryan: { archive: { sessionID, at: 1 } } });
      assert.equal((await api.post(`${route}/agent`, { agent: 'orchestrator' }, { withLocation: false })).status, 204);
      assert.equal((await api.post(`${route}/model`, { model: { id: 'fixture-model', providerID: 'fixture', variant: 'high' } }, { withLocation: false })).status, 204);
      assert.deepEqual((await api.get(route, { withLocation: false })).body.data.model, { id: 'fixture-model', providerID: 'fixture', variant: 'high' });

      // A turn, then the message page rules.
      fixture.configureNextPrompt(sessionID, { chunks: 2, intervalMs: 10, tool: 'completed', reasoning: 'text' });
      const prompted = await api.post(`${route}/prompt`, { id: 'msg_route_user', text: 'Route turn' }, { withLocation: false });
      assert.equal(prompted.status, 200);
      assert.equal(prompted.body.data.type, 'user');
      await waitFor('turn idle', () => fixture.getState().activePrompts === 0 && !fixture.getState().executingSessions.includes(sessionID));
      const asc = await api.get(`${route}/message?order=asc`, { withLocation: false });
      assert.deepEqual(asc.body.data.map((record) => record.type), ['agent-switched', 'model-switched', 'user', 'assistant', 'idle']);
      const page = await api.get(`${route}/message?limit=2`, { withLocation: false });
      assert.deepEqual(page.body.data.map((record) => record.type), ['idle', 'assistant']);
      const older = await api.get(`${route}/message?limit=2&cursor=${page.body.cursor.next}`, { withLocation: false });
      assert.deepEqual(older.body.data.map((record) => record.type), ['user', 'model-switched']);
      assert.equal((await api.get(`${route}/message?limit=2&order=desc&cursor=${page.body.cursor.next}`, { withLocation: false })).body._tag, 'InvalidCursorError');
      assert.equal((await api.get(`${route}/message?type=user,synthetic`, { withLocation: false })).status, 400);
      assert.equal((await api.get(`${route}/message?type=user&type=synthetic`, { withLocation: false })).status, 400);
      assert.deepEqual((await api.get(`${route}/message?type=user`, { withLocation: false })).body.data.map((record) => record.id), ['msg_route_user']);
      assert.equal((await api.get(`${route}/message/msg_route_user`, { withLocation: false })).body.data.text, 'Route turn');
      assert.equal((await api.get(`${route}/message/msg_missing`, { withLocation: false })).status, 404);
      assert.deepEqual((await api.get(`${route}/diff`, { withLocation: false })).body, { data: [] });
      assert.deepEqual((await api.get(`${route}/inbox`, { withLocation: false })).body, { data: [] });
      assert.equal((await api.get('/api/session/active', { withLocation: false })).status, 200);

      // Command, synthetic (no resume), compact, interrupt.
      assert.equal((await api.post(`${route}/command`, { name: 'missing', text: '' }, { withLocation: false })).status, 404);
      fixture.configureNextPrompt(sessionID, { chunks: 1, intervalMs: 10 });
      assert.equal((await api.post(`${route}/command`, { name: 'probe', text: 'now' }, { withLocation: false })).status, 204);
      await waitFor('command idle', () => fixture.getState().activePrompts === 0 && !fixture.getState().executingSessions.includes(sessionID));
      const synthetic = await api.post(`${route}/synthetic`, { text: 'Deferred note', resume: false }, { withLocation: false });
      assert.equal(synthetic.body.data.type, 'synthetic');
      assert.equal((await api.get(`${route}/inbox`, { withLocation: false })).body.data.length, 1);
      const compact = await api.post(`${route}/compact`, {}, { withLocation: false });
      assert.equal(compact.body.data.type, 'compaction');
      assert.equal((await api.get(`${route}/message?type=compaction`, { withLocation: false })).body.data[0].status, 'completed');
      assert.deepEqual((await api.post(`${route}/interrupt`, undefined, { withLocation: false })).body, { interrupted: false });

      // Revert stage, clear, stage, commit.
      const stage = await api.post(`${route}/revert/stage`, { messageID: 'msg_route_user' }, { withLocation: false });
      assert.deepEqual(stage.body.data, { messageID: 'msg_route_user', files: [] });
      assert.equal((await api.del(`${route}/revert`, { withLocation: false })).status, 204);
      await api.post(`${route}/revert/stage`, { messageID: 'msg_route_user' }, { withLocation: false });
      assert.equal((await api.post(`${route}/revert/commit`, undefined, { withLocation: false })).status, 204);
      const reverted = (await api.get(`${route}/message?order=asc`, { withLocation: false })).body.data;
      assert.deepEqual(reverted.map((record) => record.type), ['agent-switched', 'model-switched']);

      // Forks: before and through.
      const forkBefore = await api.post(`/api/session/${PERF_PARENT_SESSION_ID}/fork`, { before: `msg_user_${PERF_PARENT_SESSION_ID}` }, { withLocation: false });
      assert.equal(forkBefore.body.data.fork.boundary.type, 'before');
      assert.equal(forkBefore.body.data.parentID, undefined, 'v2 forks are not children');
      const forkAll = await api.post(`/api/session/${PERF_PARENT_SESSION_ID}/fork`, {}, { withLocation: false });
      const forkMessages = (await api.get(`/api/session/${forkAll.body.data.id}/message?order=asc`, { withLocation: false })).body.data;
      assert.equal(forkMessages.length, 1);
      assert.match(forkMessages[0].id, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}_\d+$/);

      // Forms and permissions.
      const formID = fixture.askQuestion(sessionID, { question: 'Pick?', options: ['A', 'B'] });
      const permissionID = fixture.askPermission(sessionID);
      assert.equal((await api.get('/api/form')).body.data.length, 1);
      assert.equal((await api.get(`${route}/form`, { withLocation: false })).body.data[0].id, formID);
      assert.equal((await api.get(`${route}/form/${formID}`, { withLocation: false })).body.data.state.status, 'pending');
      assert.equal((await api.post(`${route}/form/${formID}/reply`, { answer: { nope: 'A' } }, { withLocation: false })).status, 400);
      assert.equal((await api.post(`${route}/form/${formID}/reply`, { answer: { q0: 'A' } }, { withLocation: false })).status, 204);
      assert.equal((await api.post(`${route}/form/${formID}/reply`, { answer: { q0: 'A' } }, { withLocation: false })).status, 409);
      assert.deepEqual((await api.get(`${route}/form/${formID}`, { withLocation: false })).body.data.state, { status: 'answered', answer: { q0: 'A' } });
      const cancelID = fixture.askQuestion(sessionID);
      assert.equal((await api.del(`${route}/form/${cancelID}`, { withLocation: false })).status, 204);
      assert.equal((await api.get(`${route}/form/frm_missing`, { withLocation: false })).status, 404);
      assert.equal((await api.get('/api/permission/request')).body.data[0].id, permissionID);
      assert.equal((await api.get(`${route}/permission`, { withLocation: false })).body.data.length, 1);
      assert.equal((await api.get(`${route}/permission/${permissionID}`, { withLocation: false })).body.data.action, 'shell');
      assert.equal((await api.post(`${route}/permission/${permissionID}/reply`, { decision: 'once' }, { withLocation: false })).status, 204);
      assert.equal((await api.get(`${route}/permission/${permissionID}`, { withLocation: false })).status, 404);
      assert.deepEqual(fixture.getState().replies.map((reply) => [reply.type, reply.requestID]),
        [['question', formID], ['question', cancelID], ['permission', permissionID]]);

      // Fixture-only /devryan routes.
      const ready = await fetch(`${fixture.origin}/devryan/ready`, { headers: fixture.authHeaders });
      assert.equal(ready.headers.get('x-devryan-fixture-only'), 'true');
      assert.deepEqual(await ready.json(), { ready: true, generation: 2, opencode: { version: '2.0.20' },
        host: { version: '0.0.0-fixture', buildId: 'loopback-opencode-v2-fixture' }, migration: { v1: 'not-needed' }, catalog: { asserted: true } });
      fixture.setReady({ ready: false, phase: 'migrating', retryAfterMs: 250 });
      assert.equal((await fetch(`${fixture.origin}/devryan/ready`, { headers: fixture.authHeaders })).status, 503);
      fixture.setReady({ ready: true });
      assert.equal((await fetch(`${fixture.origin}/devryan/tools`, { headers: fixture.authHeaders })).status, 400);
      const tools = await fetch(`${fixture.origin}/devryan/tools?directory=${encodeURIComponent(directory)}`, { headers: fixture.authHeaders }).then((response) => response.json());
      assert.deepEqual(tools.ids, ['shell', 'read', 'edit', 'write', 'question']);
      const child = await fetch(`${fixture.origin}/devryan/session`, { method: 'POST', headers: { ...fixture.authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ parentID: sessionID, title: 'Child via host' }) }).then((response) => response.json());
      assert.equal(child.data.parentID, sessionID);
      assert.equal(decodeError(registry.get('Session.Info'), child.data), null);
      assert.equal(child.data.metadata.devryan.archive.at, 1, 'children inherit parent metadata (F4)');
      const external = await fetch(`${fixture.origin}/devryan/session/${child.data.id}/external-message`, { method: 'POST',
        headers: { ...fixture.authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ message: { id: 'msg_external_1', type: 'user', text: 'From Cursor', time: { created: Date.now() } } }) });
      assert.equal(external.status, 200);
      assert.equal((await api.get(`/api/session/${child.data.id}/message/msg_external_1`, { withLocation: false })).body.data.text, 'From Cursor');
      assert.equal((await fetch(`${fixture.origin}/devryan/session/revert-capabilities`, { headers: fixture.authHeaders })).status, 200);
      assert.equal((await fetch(`${fixture.origin}/devryan/session/retention-control`, { method: 'POST', headers: fixture.authHeaders })).status, 200);

      assert.equal((await api.del(route, { withLocation: false })).status, 204);
      assert.equal((await api.get(route, { withLocation: false })).status, 404);
      assert.ok(validation.bodies > 80 && validation.effectDecodes > 100);
    } finally {
      await fixture.close();
    }
  });

  it('publishes schema-valid frames with locations, durable sequences and heartbeats for every flow and named sequence', async () => {
    const directory = '/qa-v2-frames';
    const fixture = await createLoopbackOpenCodeV2Fixture({ directory, heartbeatMs: 50 });
    const api = client(fixture);
    const stream = await openStream(fixture);
    const published = () => Object.values(fixture.getState().eventCounts).reduce((sum, count) => sum + count, 0);
    const baseline = published();
    try {
      const sessionID = (await api.post('/api/session', { title: 'Frames' })).body.data.id;
      fixture.configureNextPrompt(sessionID, { reasoning: 'delayed', reasoningDelayChunks: 1, tool: 'completed', chunks: 3, intervalMs: 10 });
      await api.post(`/api/session/${sessionID}/prompt`, { text: 'Stream it' }, { withLocation: false });
      await waitFor('prompt idle', () => fixture.getState().activePrompts === 0);
      fixture.setTodos(sessionID, [{ id: 'todo_1', content: 'Check frames', status: 'in_progress', priority: 'high' }]);
      assert.deepEqual((await api.get(`/api/session/${sessionID}`, { withLocation: false })).body.data.metadata.devryan.todo.items[0].content, 'Check frames');
      fixture.appendCompactionBoundary(sessionID, { autoContinue: true });
      fixture.replaySessionFailure(sessionID, 'provider_authentication');
      fixture.startScenario('four-stream');
      await wait(60);
      fixture.stopScenario();
      assert.ok(Object.values(fixture.getState().textLengths).every((length) => length > 0));
      for (const name of Object.keys(OPENCODE_V2_FIXTURE_SEQUENCES).filter((sequence) => sequence !== 'stream-drop')) {
        const played = fixture.playSequence(name, name === 'two-step-tool-turn' ? { deltaFirst: true } : {});
        assert.equal(played.done, true, name);
      }
      fixture.shutdownLocation();
      await wait(120);
      await waitFor('all frames received', () => stream.events.length === published() - baseline + 1);
      assert.ok(stream.comments >= 2, 'heartbeat comments are sent');
      for (const event of stream.events) validateFrame(event);
      const lastSeq = new Map();
      for (const event of stream.events) {
        if (event.type === 'server.connected' || DEVRYAN_FIXTURE_EVENT_TYPES.has(event.type)) continue;
        if (OPENCODE_V2_UNLOCATED_EVENT_TYPES.has(event.type)) assert.equal(event.location, undefined, `${event.type} has no location`);
        else if (event.type !== 'session.tool.progress') assert.ok(event.location?.directory, `${event.type} has a location`);
        if (!event.durable) continue;
        const previous = lastSeq.get(event.durable.aggregateID) ?? -1;
        assert.ok(event.durable.seq > previous, `${event.type} seq increases for ${event.durable.aggregateID}`);
        lastSeq.set(event.durable.aggregateID, event.durable.seq);
      }
      const types = new Set(stream.events.map((event) => event.type));
      for (const type of ['session.created', 'session.inbox.enqueued', 'session.inbox.delivered', 'session.execution.started', 'session.step.started',
        'session.reasoning.started', 'session.reasoning.delta', 'session.reasoning.ended', 'session.text.started', 'session.text.delta', 'session.text.ended',
        'session.tool.input.started', 'session.tool.input.ended', 'session.tool.called', 'session.tool.progress', 'session.tool.success', 'session.tool.failed',
        'session.step.ended', 'session.step.failed', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted',
        'session.retry.scheduled', 'session.compaction.started', 'session.compaction.delta', 'session.compaction.ended', 'session.revert.staged',
        'session.revert.cleared', 'session.revert.committed', 'session.renamed', 'session.metadata.updated', 'session.permissions', 'session.forked',
        'session.model.selected', 'form.created', 'form.replied', 'form.cancelled', 'permission.asked', 'permission.replied', 'location.shutdown',
        'project.updated', 'vcs.branch.updated', 'server.connected']) {
        assert.ok(types.has(type), `frames include ${type}`);
      }
      // deltaFirst: every delta of the replayed turn precedes its durable *.started.
      const sequenceStart = stream.events.findIndex((event) => event.type === 'session.created' && event.data.title === 'Two-step tool turn');
      const turn = stream.events.slice(sequenceStart);
      for (const [index, event] of turn.entries()) {
        if (!/^session\.(text|reasoning)\.delta$/.test(event.type)) continue;
        const kind = event.type.split('.')[1];
        const started = turn.findIndex((candidate) => candidate.type === `session.${kind}.started`
          && candidate.data.assistantMessageID === event.data.assistantMessageID && candidate.data.ordinal === event.data.ordinal);
        assert.ok(started > index, 'delta precedes its started event');
        if (event.data.assistantMessageID !== turn.find((candidate) => candidate.type === 'session.step.started')?.data.assistantMessageID) break;
      }
      assert.ok(validation.frames > 400);
    } finally {
      await stream.close();
      await fixture.close();
    }
  });

  it('folds the captured 2.0.20 frames into exactly the REST records 2.0.20 served', () => {
    const cases = [['01-two-step-tool-turn.json', 'session.messages.asc'], ['02-retry.json', 'session.messages.asc'],
      ['03-abort.json', 'session.messages.asc'], ['04-failure.json', 'session.messages.asc'], ['04b-tool-failed.json', 'session.messages.asc'],
      ['05-question-form.json', 'session.messages.asc'], ['06-permission.json', 'session.messages.asc'],
      ['08-revert.json', 'committed.session.messages.asc'], ['10-child.json', 'child.session.messages.asc'], ['12-steer-queue-switch.json', 'session.messages.asc']];
    // Idle/switch ids derive from event ids, which the capture normalised with a separate map.
    const comparable = (records) => records.map((record) => (['idle', 'agent-switched', 'model-switched'].includes(record.type) ? { ...record, id: '<from-event>' } : record));
    for (const [file, label] of cases) {
      const vector = JSON.parse(fs.readFileSync(path.join(OPENCODE_V2_FIXTURE_VECTORS_DIRECTORY, file), 'utf8'));
      const store = createV2WireStore();
      for (const raw of vector.frames) {
        const frame = parseV2FrameBlock(raw.replace(/\n\n$/, ''));
        if (frame?.kind === 'event') store.apply(frame.event);
      }
      const rest = vector.rest.find((entry) => entry.label === label);
      const sessionID = /\/api\/session\/([^/]+)\/message/.exec(rest.path)[1];
      assert.deepEqual(comparable(store.messages(sessionID)), comparable(rest.body.data), `${file} ${label}`);
      for (const record of rest.body.data) assert.equal(decodeError(registry.get('Session.Message.Info'), record), null);
    }
    const sessionCases = [['01-two-step-tool-turn.json', 'session.get'], ['06-permission.json', 'session.get'], ['08-revert.json', 'committed.session.get']];
    for (const [file, label] of sessionCases) {
      const vector = JSON.parse(fs.readFileSync(path.join(OPENCODE_V2_FIXTURE_VECTORS_DIRECTORY, file), 'utf8'));
      const store = createV2WireStore();
      for (const raw of vector.frames) {
        const frame = parseV2FrameBlock(raw.replace(/\n\n$/, ''));
        if (frame?.kind === 'event') store.apply(frame.event);
      }
      const rest = vector.rest.find((entry) => entry.label === label);
      assert.deepEqual(store.session(rest.body.data.id), rest.body.data, `${file} ${label}`);
    }
  });

  it('ends subscribers cleanly after N frames (SubscriberOverflow) and replays the stream-drop sequence', async () => {
    const fixture = await createLoopbackOpenCodeV2Fixture({ directory: '/qa-v2-drop', heartbeatMs: 1000 });
    try {
      const stream = await openStream(fixture);
      const played = fixture.playSequence('stream-drop');
      await waitFor('stream end', () => stream.ended);
      assert.equal(stream.events.filter((event) => event.type !== 'server.connected').length, played.frames);
      assert.deepEqual(stream.events.slice(1).map((event) => event.type), ['session.created', ...Array(played.frames - 1).fill('session.renamed')]);
      for (const event of stream.events) validateFrame(event);
      assert.equal(fixture.getState().streamDrops.length, 1);
      const reconnected = await openStream(fixture);
      fixture.dropEventStream({ afterFrames: 2 });
      fixture.askPermission(PERF_PARENT_SESSION_ID);
      fixture.askQuestion(PERF_PARENT_SESSION_ID);
      await waitFor('second stream end', () => reconnected.ended);
      assert.deepEqual(reconnected.events.map((event) => event.type), ['server.connected', 'permission.asked', 'form.created']);
      assert.equal(fixture.getState().sseConnectionCount, 2);
    } finally {
      await fixture.close();
    }
  });

  it('round-trips domain rows through the wire: user segments, content ids, tools and the loss register', async () => {
    const directory = '/qa-v2-oracle';
    const fixture = await createLoopbackOpenCodeV2Fixture({ directory, heartbeatMs: 50 });
    const api = client(fixture);
    const stream = await openStream(fixture);
    try {
      const sessionID = PERF_CHILD_SESSION_IDS[0];
      const userID = 'msg_00000000000aoracleuser0001';
      const assistantID = 'msg_00000000000boracleasst0001';
      const openID = 'msg_00000000000coracleopen0001';
      const now = Date.now();
      const rows = [
        { info: { id: userID, sessionID, role: 'user', agent: 'build', model: { providerID: 'fixture', modelID: 'fixture-model', variant: 'high' }, time: { created: now } },
          parts: [
            { id: 'prt_oracle_text', sessionID, messageID: userID, type: 'text', text: 'Fix the bug.' },
            { id: 'prt_oracle_plan', sessionID, messageID: userID, type: 'text', text: '\nPlan mode preface.', synthetic: true },
            { id: 'prt_oracle_file', sessionID, messageID: userID, type: 'file', mime: 'text/plain', filename: 'a.txt', url: 'data:text/plain;base64,aGVsbG8=' },
            { id: 'prt_oracle_agent', sessionID, messageID: userID, type: 'agent', name: 'explorer' },
          ] },
        { info: { id: assistantID, sessionID, parentID: userID, role: 'assistant', agent: 'build', mode: 'build', providerID: 'fixture', modelID: 'fixture-model',
          cost: 0.5, tokens: { input: 3, output: 4, reasoning: 1, cache: { read: 2, write: 0 } }, finish: 'stop', time: { created: now + 1, completed: now + 9 } },
          parts: [
            { id: 'prt_oracle_step', sessionID, messageID: assistantID, type: 'step-start' },
            { id: 'prt_oracle_reasoning', sessionID, messageID: assistantID, type: 'reasoning', text: 'Think.', metadata: { reasoningField: 'reasoning_content' }, time: { start: now + 2, end: now + 3 } },
            { id: 'prt_oracle_answer', sessionID, messageID: assistantID, type: 'text', text: 'Done.', time: { start: now + 4, end: now + 5 } },
            { id: 'prt_oracle_bash', sessionID, messageID: assistantID, type: 'tool', tool: 'bash', callID: 'call_oracle_bash',
              state: { status: 'completed', input: { command: 'npm test', description: 'Run tests' }, output: 'ok\n', title: 'Run tests', metadata: { exit: 0 }, time: { start: now + 5, end: now + 6 } } },
            { id: 'prt_oracle_edit', sessionID, messageID: assistantID, type: 'tool', tool: 'edit', callID: 'call_oracle_edit',
              state: { status: 'error', input: { filePath: 'src/a.ts' }, error: 'No match', time: { start: now + 6, end: now + 7 } } },
            { id: 'prt_oracle_task', sessionID, messageID: assistantID, type: 'tool', tool: 'task', callID: 'call_oracle_task',
              state: { status: 'running', input: { subagent_type: 'explorer', description: 'Look around' }, metadata: { sessionId: 'ses_childx', sessionID: 'ses_childx' }, time: { start: now + 7 } } },
            { id: 'prt_oracle_patch', sessionID, messageID: assistantID, type: 'patch', hash: 'abc', files: ['a.ts'] },
            { id: 'prt_oracle_text2', sessionID, messageID: assistantID, type: 'text', text: 'Second text.', time: { start: now + 8, end: now + 8 } },
          ] },
        { info: { id: openID, sessionID, parentID: userID, role: 'assistant', agent: 'build', providerID: 'fixture', modelID: 'fixture-model', time: { created: now + 10 } },
          parts: [{ id: 'prt_oracle_open', sessionID, messageID: openID, type: 'text', text: 'Streaming…', time: { start: now + 10 } }] },
      ];
      const replay = fixture.replayRecoveryVisual({ sessionID, rows, status: 'busy' });
      const records = (await api.get(`/api/session/${sessionID}/message?order=asc`, { withLocation: false })).body.data;
      const byID = new Map(records.map((record) => [record.id, record]));

      // User: segment ids and texts restore the client's v1 text parts exactly.
      const user = byID.get(userID);
      assert.deepEqual(userTextSegments(userID, user.text, user.metadata), [
        { id: 'prt_oracle_text', kind: 'text', text: 'Fix the bug.' }, { id: 'prt_oracle_plan', kind: 'synthetic', text: '\nPlan mode preface.' }]);
      assert.deepEqual(user.files, [{ data: 'aGVsbG8=', mime: 'text/plain', source: { type: 'inline' }, name: 'a.txt' }]);
      assert.deepEqual(user.agents, [{ name: 'explorer' }]);
      assert.deepEqual({ agent: user.metadata.devryan.agent, modelID: user.metadata.devryan.modelID, variant: user.metadata.devryan.variant },
        { agent: 'build', modelID: 'fixture-model', variant: 'high' });
      assert.equal(replay.addresses.prt_oracle_file, `${userID}:file:0`);
      assert.equal(replay.addresses.prt_oracle_agent, `${userID}:agent:0`);

      // Assistant: the stored content's projected ids equal the address map, in order.
      const assistant = byID.get(assistantID);
      const domainContent = rows[1].parts.filter((part) => ['text', 'reasoning', 'tool'].includes(part.type));
      assert.deepEqual(assistantContentPartIds(assistantID, assistant.content), domainContent.map((part) => replay.addresses[part.id]));
      assert.deepEqual(assistant.content.map((item) => item.type === 'tool' ? item.state.status : item.text),
        ['Think.', 'Done.', 'completed', 'error', 'running', 'Second text.']);
      assert.deepEqual(assistant.content[0].state, { reasoningField: 'reasoning_content' });
      assert.deepEqual({ cost: assistant.cost, tokens: assistant.tokens, finish: assistant.finish, created: assistant.time.created, completed: assistant.time.completed },
        { cost: 0.5, tokens: rows[1].info.tokens, finish: 'stop', created: now + 1, completed: now + 9 });

      // Tools: the gen-2 tool projection (item 3) restores the domain tool parts.
      for (const domain of rows[1].parts.filter((part) => part.type === 'tool')) {
        const item = assistant.content.find((candidate) => candidate.type === 'tool' && candidate.id === domain.callID);
        const projected = toV1ToolPart(item, { messageID: assistantID, sessionID });
        assert.equal(projected.id, replay.addresses[domain.id]);
        assert.equal(projected.tool, domain.tool);
        assert.equal(projected.callID, domain.callID);
        assert.equal(projected.state.status, domain.state.status);
        for (const [key, value] of Object.entries(domain.state.input)) assert.deepEqual(projected.state.input[key], value, `${domain.tool} input ${key}`);
        if (domain.state.status === 'completed') {
          assert.equal(projected.state.output, domain.state.output);
          assert.deepEqual(projected.state.metadata, domain.state.metadata);
          assert.deepEqual(projected.state.time, domain.state.time);
        }
        if (domain.state.status === 'error') assert.equal(projected.state.error, domain.state.error);
      }
      // Running tool metadata is live-only in 2.0.20 (progress is ephemeral); the stream carries it.
      assert.ok(stream.events.some((event) => event.type === 'session.tool.progress' && event.data.metadata.sessionID === 'ses_childx'));

      // Open text: 2.0.20 stores text only at text.ended; the live delta carries it.
      assert.equal(textItems(byID.get(openID))[0].text, '');
      assert.deepEqual(replay.losses.map((loss) => [loss.partID, loss.type]), [['prt_oracle_patch', 'patch'], ['prt_oracle_open', 'text']]);
      fixture.appendVisualPartDelta({ sessionID, messageID: openID, partID: 'prt_oracle_open', delta: ' more' });
      fixture.appendVisualPartDelta({ sessionID, messageID: openID, partID: `${openID}:text:0`, delta: ' again' });
      assert.throws(() => fixture.appendVisualPartDelta({ sessionID, messageID: openID, partID: 'missing', delta: 'x' }), /existing text or reasoning/);
      await waitFor('open deltas', () => stream.events.filter((event) => event.type === 'session.text.delta' && event.data.assistantMessageID === openID).length === 3);
      assert.equal(textItems(fixture.wireMessages(sessionID).find((record) => record.id === openID))[0].text, '', 'deltas never reach REST');
      assert.equal(rows[2].parts[0].text, 'Streaming…', 'the caller snapshot is not mutated');

      // The wire builder alone: compaction pairs and synthetic-only users.
      const compactRows = [
        { info: { id: 'msg_c1', sessionID, role: 'user', time: { created: 1 } }, parts: [{ id: 'prt_c1', type: 'compaction', auto: true }] },
        { info: { id: 'msg_c1:summary', sessionID, role: 'assistant', parentID: 'msg_c1', summary: true, providerID: 'fixture', modelID: 'fixture-model', time: { created: 2, completed: 3 } },
          parts: [{ id: 'prt_c1_summary', type: 'text', text: 'Summary.' }] },
        { info: { id: 'msg_c2', sessionID, role: 'user', time: { created: 4 } }, parts: [{ id: 'prt_c2', type: 'text', text: 'Continue.', synthetic: true, metadata: { compaction_continue: true } }] },
      ];
      const wired = wireEventsForDomainRows(compactRows, { sessionID });
      assert.deepEqual(wired.events.map((event) => event.type), ['session.inbox.enqueued', 'session.inbox.delivered', 'session.compaction.started',
        'session.compaction.ended', 'session.inbox.enqueued', 'session.inbox.delivered']);
      assert.equal(wired.addresses.get('prt_c1_summary').projectedID, 'msg_c1:summary:text:0');
      assert.equal(wired.events[4].data.item.type, 'synthetic');
      assert.equal(wired.events[4].data.item.payload.metadata.compaction_continue, true);
      assert.deepEqual(wired.losses, []);
      for (const event of stream.events) validateFrame(event);
    } finally {
      await stream.close();
      await fixture.close();
    }
  });

  it('retains the fixture control semantics on the v2 wire', async () => {
    const directory = '/qa-v2-controls';
    const fixture = await createLoopbackOpenCodeV2Fixture({ directory, heartbeatMs: 50 });
    const api = client(fixture);
    const stream = await openStream(fixture);
    const sessionRoute = (id) => `/api/session/${id}`;
    try {
      const id = PERF_PARENT_SESSION_ID;
      const prompt = (body, target = id) => api.post(`${sessionRoute(target)}/prompt`, body, { withLocation: false });
      for (const canonicalUserDelayMs of [-1, 10_001, 1.5, '200']) {
        assert.throws(() => fixture.configureNextCreatedSessionPrompt({ canonicalUserDelayMs }), /Invalid fixture prompt/);
      }
      assert.throws(() => fixture.configureNextPrompt(id, { unknown: true }), /Invalid fixture prompt/);

      // Held reasoning, setPromptReasoning, queued delivery while busy, release.
      fixture.configureNextPrompt(id, { reasoning: 'delayed', tool: 'completed', hold: true, chunks: 2, intervalMs: 10 });
      const devryan = { v: 1, agent: 'orchestrator', providerID: 'fixture', modelID: 'fixture-model', variant: 'low', planMode: true,
        parts: [{ kind: 'text', length: 14, id: 'prt_client_1' }] };
      assert.equal((await prompt({ id: 'msg_controls_1', text: 'Plan this task', metadata: { devryan } })).status, 200);
      const assistantID = fixture.wireMessages(id).findLast((record) => record.type === 'assistant').id;
      fixture.setPromptReasoning(id, 'Read the current plan.');
      assert.throws(() => fixture.setPromptReasoning(id, 'Again'), /No active fixture reasoning/);
      assert.equal(fixture.wireMessages(id).find((record) => record.id === assistantID).content[0].text, 'Read the current plan.');
      assert.equal((await prompt({ id: 'msg_controls_queued', text: 'Queued while busy' })).status, 200, '2.0.20 admits prompts while busy');
      assert.equal((await prompt({ id: 'msg_controls_1', text: 'Duplicate' })).status, 409);
      assert.deepEqual((await api.get(`${sessionRoute(id)}/inbox`, { withLocation: false })).body.data.map((item) => item.id), ['msg_controls_queued']);
      assert.ok((await api.get('/api/session/active', { withLocation: false })).body.data[id]);

      // Suppression maps the gen-1 categories onto gen-2 events while REST keeps folding.
      fixture.suppressMessageEvents({ sessionID: id, messageID: assistantID, types: ['message.part.delta', 'message.part.updated', 'message.updated', 'session.status'], maximumEvents: 64, durationMs: 5000 });
      assert.throws(() => fixture.suppressMessageEvents({ sessionID: id, messageID: assistantID, types: ['message.updated'] }), /overlapping/);
      fixture.releasePrompt(id);
      await waitFor('first prompt settled', () => fixture.wireMessages(id).find((record) => record.id === assistantID)?.time.completed);
      fixture.clearMessageEventSuppression();
      const suppressed = fixture.getState().suppressedEvents;
      assert.ok(['message.part.delta', 'message.part.updated', 'message.updated'].every((type) => suppressed.some((event) => event.type === type)));
      assert.ok(suppressed.every((event) => event.sessionID === id && (event.messageID === assistantID || event.type === 'session.status')));
      assert.equal(stream.events.some((event) => suppressed.some((skipped) => skipped.eventID === event.id)), false);
      await waitFor('queued prompt delivered and idle', () => fixture.getState().activePrompts === 0 && !fixture.getState().executingSessions.includes(id));
      const records = fixture.wireMessages(id);
      assert.ok(records.findIndex((record) => record.id === 'msg_controls_queued') > records.findIndex((record) => record.id === assistantID));
      assert.equal(records.find((record) => record.id === assistantID).content.find((item) => item.type === 'text').text, 'QA response chunk 1. QA response chunk 2. ');
      const received = fixture.getState().receivedPrompts;
      assert.deepEqual(received[0], { sessionID: id, messageID: 'msg_controls_1', partTypes: ['text'], model: { providerID: 'fixture', modelID: 'fixture-model', variant: 'low' },
        agent: 'orchestrator', delivery: 'steer', variant: 'low', planMode: true });
      assert.equal(records.findLast((record) => record.type === 'assistant').agent, 'build');
      assert.equal(fixture.getState().rejectedPrompts[0].status, 409);

      // Configured rejection, interrupt, failure.
      fixture.configureNextPrompt(id, { rejectStatus: 400 });
      assert.equal((await prompt({ text: 'Reject me' })).status, 400);
      fixture.configureNextPrompt(id, { hold: true, tool: 'completed' });
      await prompt({ text: 'Abort me' });
      const permissionID = fixture.askPermission(id);
      assert.equal(fixture.getState().permissionCount, 1);
      assert.deepEqual((await api.post(`${sessionRoute(id)}/interrupt`, undefined, { withLocation: false })).body, { interrupted: true });
      assert.equal(fixture.getState().abortedPrompts, 1);
      assert.equal(fixture.getState().permissionCount, 0);
      await waitFor('permission rejected on interrupt', () => stream.events.some((event) => event.type === 'permission.replied'
        && event.data.requestID === permissionID && event.data.reply === 'reject'));
      const aborted = fixture.wireMessages(id).findLast((record) => record.type === 'assistant');
      assert.equal(aborted.error.type, 'aborted');
      assert.equal(aborted.content.find((item) => item.type === 'tool').state.status, 'error');
      assert.equal(fixture.wireMessages(id).at(-1).outcome, 'interrupted');

      // Question dismissal follows 05b; permission rejection fails only the tool.
      fixture.configureNextPrompt(id, { tool: 'completed', chunks: 2, intervalMs: 10 });
      await prompt({ text: 'Ask' });
      const formID = fixture.askQuestion(id);
      assert.equal((await api.del(`${sessionRoute(id)}/form/${formID}`, { withLocation: false })).status, 204);
      await waitFor('dismissed question interrupts with shutdown', () => stream.events.some((event) => event.type === 'session.execution.interrupted'
        && event.data.reason === 'shutdown'));
      fixture.configureNextPrompt(id, { tool: 'completed', chunks: 2, intervalMs: 10 });
      await prompt({ text: 'Permission' });
      const rejected = fixture.askPermission(id);
      await api.post(`${sessionRoute(id)}/permission/${rejected}/reply`, { decision: 'reject', message: 'not now' }, { withLocation: false });
      await waitFor('rejection idle', () => fixture.getState().activePrompts === 0 && !fixture.getState().executingSessions.includes(id));
      const rejectedTool = fixture.wireMessages(id).findLast((record) => record.type === 'assistant').content.find((item) => item.type === 'tool');
      assert.deepEqual(rejectedTool.state.error, { type: 'permission.rejected', message: 'not now' });

      // Delayed canonical user echo on a created session.
      fixture.configureNextCreatedSessionPrompt({ canonicalUserDelayMs: 100, hold: true, chunks: 1, intervalMs: 10 });
      assert.throws(() => fixture.configureNextCreatedSessionPrompt({}), /already configured/);
      const delayedSession = (await api.post('/api/session', { title: 'Delayed' })).body.data.id;
      await prompt({ id: 'msg_delayed_user', text: 'Keep Low' }, delayedSession);
      assert.equal(fixture.wireMessages(delayedSession).some((record) => record.id === 'msg_delayed_user'), false);
      await waitFor('delayed release', () => fixture.getState().canonicalUserDelays[0].releasedAt);
      assert.equal(fixture.wireMessages(delayedSession).filter((record) => record.id === 'msg_delayed_user').length, 1);
      fixture.releasePrompt(delayedSession);
      await waitFor('delayed idle', () => fixture.getState().activePrompts === 0);

      // History paging through 2.0.20 cursors.
      fixture.seedHistory(PERF_CHILD_SESSION_IDS[1], { turns: 113, textBytes: 256 });
      const seen = new Set();
      let cursor = null;
      do {
        const page = await api.get(`${sessionRoute(PERF_CHILD_SESSION_IDS[1])}/message?limit=50${cursor ? `&cursor=${cursor}` : ''}`, { withLocation: false });
        for (const record of page.body.data) { assert.equal(seen.has(record.id), false); seen.add(record.id); }
        cursor = page.body.data.length ? page.body.cursor.next : null;
      } while (cursor);
      assert.equal(seen.size, 227);
      // 2.0.20 returns a next cursor on every non-empty page, so the walk ends on one extra empty page.
      assert.equal(fixture.getState().olderMessageRequestCounts[PERF_CHILD_SESSION_IDS[1]], 5);
      assert.throws(() => fixture.seedHistory(PERF_CHILD_SESSION_IDS[1], { turns: 2000, textBytes: 65536 }), /history size/);

      // Compaction boundary records.
      const promptsBefore = fixture.getState().receivedPrompts.length;
      const boundary = fixture.appendCompactionBoundary(id, { autoContinue: true, summaryText: 'Saved plan.' });
      const compaction = fixture.wireMessages(id).find((record) => record.id === boundary.userMessageID);
      assert.deepEqual({ type: compaction.type, status: compaction.status, reason: compaction.reason, summary: compaction.summary },
        { type: 'compaction', status: 'completed', reason: 'auto', summary: 'Saved plan.' });
      assert.equal(boundary.summaryMessageID, `${boundary.userMessageID}:summary`);
      assert.equal(fixture.wireMessages(id).find((record) => record.id === boundary.continuationUserMessageID).type, 'synthetic');
      assert.equal(fixture.getState().receivedPrompts.length, promptsBefore, 'stored continuations never claim a provider request');

      // Managed-task visuals on a canonical root, a running child and a completed child.
      const now = Date.now();
      const children = [PERF_CHILD_SESSION_IDS[0], PERF_CHILD_SESSION_IDS[2]].map((sessionID, index) => ({ sessionID, parentSessionID: id,
        userMessageID: `msg_task_user_${index}`, assistantMessageID: `msg_task_asst_${index}`, status: index === 0 ? 'running' : 'completed' }));
      for (const [index, child] of children.entries()) {
        fixture.replayRecoveryVisual({ sessionID: child.sessionID, status: index === 0 ? 'busy' : 'idle', rows: [
          { info: { id: child.userMessageID, sessionID: child.sessionID, role: 'user', time: { created: now } }, parts: [{ id: `prt_task_user_${index}`, sessionID: child.sessionID, messageID: child.userMessageID, type: 'text', text: 'Child task' }] },
          { info: { id: child.assistantMessageID, sessionID: child.sessionID, role: 'assistant', providerID: 'fixture', modelID: 'fixture-model', time: index === 0 ? { created: now + 1 } : { created: now + 1, completed: now + 2 } },
            parts: [{ id: `prt_task_asst_${index}`, sessionID: child.sessionID, messageID: child.assistantMessageID, type: 'text', text: 'Child answer', time: { start: now + 1, end: now + 2 } }] },
        ] });
      }
      const model = createQaManagedTaskReadModel({ transport: 'fixture', directory, rootSessionID: id, children, now });
      const rootAssistant = fixture.wireMessages(id).findLast((record) => record.type === 'assistant').id;
      for (const record of model.records) {
        const visual = fixture.appendManagedTaskVisual({ sessionID: id, messageID: rootAssistant, task: record.task, resultEnvelope: record.resultEnvelope });
        assert.equal(visual.part.id, `${rootAssistant}:tool:${record.task.dispatchCallId}`);
        assert.equal(visual.part.tool, 'devryan_task');
        assert.equal(visual.part.state.status, 'completed');
        assert.throws(() => fixture.appendManagedTaskVisual({ sessionID: id, messageID: rootAssistant, task: record.task, resultEnvelope: record.resultEnvelope }), /unique dispatch/);
      }
      fixture.removeManagedTaskVisual(model.records[0].task);
      await waitFor('fixture-only frames', () => stream.events.filter((event) => DEVRYAN_FIXTURE_EVENT_TYPES.has(event.type)).length === 3);
      fixture.replaySessionFailure(id);
      assert.throws(() => fixture.replaySessionFailure(id, 'other'), /Invalid fixture failure/);
      await wait(20);
      for (const event of stream.events) validateFrame(event);
    } finally {
      await stream.close();
      await fixture.close();
    }
  });
});
