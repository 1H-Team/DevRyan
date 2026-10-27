import { afterAll, afterEach, expect, test } from 'bun:test';
import { Cause, Effect, Exit, Fiber, Layer, Schema } from 'effect';
import { Form } from '@opencode/core/form';
import { Location } from '@opencode/core/location';
import { LayerNode } from '@opencode/util/effect/layer-node';
import { Global } from '@opencode/util/global';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createAdmissionGates } from '../../packages/web/server/lib/opencode/runtime-host/admission-gates.js';
import { createMcpElicitationCalls, isElicitationUrl, mcpElicitationEnabled, type McpElicitationCalls,
  type McpElicitationRefusalRecord } from '../../packages/web/server/lib/opencode/runtime-host/native-mcp-elicitation.js';
import type { NativeAdmissionBridge, OperationRequest } from '../../packages/web/server/lib/opencode/runtime-host/native-admission-contract.js';
import { runWithRequestPermit } from '../../packages/web/server/lib/opencode/runtime-host/native-admission-contract.js';
import { HostRefusal } from '../../packages/web/server/lib/opencode/runtime-host/host-refusal.js';

const roots: string[] = [];
afterAll(() => Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true }))));
const previousSwitch = process.env.DEVRYAN_MCP_ELICITATION;
afterEach(() => {
  if (previousSwitch === undefined) delete process.env.DEVRYAN_MCP_ELICITATION;
  else process.env.DEVRYAN_MCP_ELICITATION = previousSwitch;
});

const DIRECTORY = '/fixture/project';
const call = { sessionID: 'ses_attributed', messageID: 'msg_attributed', callID: 'call_attributed' };
const structured = (overrides: Partial<Form.CreateInput> = {}): Form.CreateInput => ({
  sessionID: 'global', title: 'linear is requesting input',
  metadata: { kind: 'mcp-elicitation', server: 'linear', message: 'Pick a team' },
  fields: [{ key: 'team', type: 'string', required: true }, { key: 'count', type: 'integer', minimum: 1, maximum: 5 }],
  ...overrides,
});
const url = (target: string, id = Form.ID.create()): Form.CreateInput => ({ id, sessionID: 'global', title: 'linear is requesting input',
  metadata: { kind: 'mcp-elicitation', server: 'linear', elicitationID: 'el_1', message: 'Sign in' },
  fields: [{ key: 'elicitation', type: 'external', url: target }] });

async function fixture(options: { readonly calls?: McpElicitationCalls; readonly deny?: (request: OperationRequest) => boolean } = {}) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-mcp-elicitation-')));
  roots.push(home);
  const requests: OperationRequest[] = [], refusals: McpElicitationRefusalRecord[] = [];
  const bridge: NativeAdmissionBridge = { awaitReady: async () => {},
    authorize: async request => {
      requests.push(request);
      if (options.deny?.(request)) throw new HostRefusal('native_permit_lineage_mismatch', 403, request.operation, request.sessionID);
      return { token: 'b'.repeat(64), sessionID: request.sessionID, revision: 0 };
    },
    recheck: async () => {}, release: async () => {}, sealPrompt: async () => ({}), verifyAccepted: async () => {},
    registerShellJob: async () => {}, sealSynthetic: async () => ({}), deferContinuation: async () => {},
    hold: async () => {}, releaseHold: async () => {}, isHeld: async () => false,
    mcpElicitationRefused: async record => { refusals.push(record); } };
  const calls = options.calls ?? createMcpElicitationCalls();
  const gates = createAdmissionGates({ bridge, nativePlugins: new Map(), executeOwned: invocation => invocation.executeNative(), mcpElicitationCalls: calls });
  await gates.controls.openStartup();
  const location = Schema.decodeUnknownSync(Location.Info)({ directory: DIRECTORY, project: { id: 'global', directory: DIRECTORY, canonical: DIRECTORY } });
  const layer = LayerNode.compile(Form.node, { replacements: [
    Global.node.replace(Global.layerWith({ home, data: home, cache: home, config: home, state: home, tmp: home, bin: home, log: home, repos: home })),
    Location.node.replace(Layer.succeed(Location.Service, location)), ...gates.overrides] });
  const run = <A, E>(effect: Effect.Effect<A, E, Form.Service>) => Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(layer))));
  return { calls, requests, refusals, run };
}

const pendingForm = (forms: Form.Interface) => Effect.gen(function* () {
  for (let attempt = 0; attempt < 200; attempt++) {
    const [form] = yield* forms.list();
    if (form) return form;
    yield* Effect.sleep('1 millis');
  }
  throw new Error('elicitation form was never created');
});

test('the in-flight registry attributes only an unambiguous call', () => {
  const calls = createMcpElicitationCalls();
  expect(calls.resolve(DIRECTORY, 'linear')).toEqual({ kind: 'unattributed' });
  const release = calls.track(DIRECTORY, 'linear', call);
  expect(calls.resolve(DIRECTORY, 'linear')).toEqual({ kind: 'attributed', attribution: call });
  expect(calls.resolve(DIRECTORY, 'github')).toEqual({ kind: 'unattributed' });
  expect(calls.resolve('/fixture/other', 'linear')).toEqual({ kind: 'unattributed' });
  const second = calls.track(DIRECTORY, 'linear', { ...call, sessionID: 'ses_other', callID: 'call_other' });
  expect(calls.resolve(DIRECTORY, 'linear')).toEqual({ kind: 'ambiguous' });
  second(); second();
  expect(calls.resolve(DIRECTORY, 'linear')).toEqual({ kind: 'attributed', attribution: call });
  release();
  expect(calls.resolve(DIRECTORY, 'linear')).toEqual({ kind: 'unattributed' });
  expect(mcpElicitationEnabled({})).toBe(true);
  for (const value of ['0', 'off', 'FALSE', ' 0 ']) expect(mcpElicitationEnabled({ DEVRYAN_MCP_ELICITATION: value })).toBe(false);
  expect(mcpElicitationEnabled({ DEVRYAN_MCP_ELICITATION: '1' })).toBe(true);
  for (const value of ['https://linear.app/oauth', 'http://127.0.0.1:3000/x']) expect(isElicitationUrl(value)).toBe(true);
  for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'https://u:p@example.com', 'relative/path', 7])
    expect(isElicitationUrl(value)).toBe(false);
});

test('one in-flight call: the form is stamped and its reply binds to that session permit', async () => {
  const f = await fixture();
  const release = f.calls.track(DIRECTORY, 'linear', call);
  const state = await f.run(Effect.gen(function* () {
    const forms = yield* Form.Service;
    const asking = yield* Effect.forkChild(forms.ask(structured({ metadata: { kind: 'mcp-elicitation', server: 'linear', message: 'm',
      devryan: { sessionID: 'ses_forged' } } })));
    const form = yield* pendingForm(forms);
    expect(form.sessionID).toBe('global');
    expect(form.metadata?.devryan).toEqual(call);
    yield* forms.reply({ id: form.id, answer: { team: 'core', count: 2 } });
    return yield* Fiber.join(asking);
  }));
  release();
  expect(state).toEqual({ status: 'answered', answer: { team: 'core', count: 2 } });
  expect(f.requests).toEqual([expect.objectContaining({ operation: 'form.reply', sessionID: call.sessionID,
    input: expect.objectContaining({ answer: { team: 'core', count: 2 }, pending: { sessionID: call.sessionID } }) })]);
  expect(f.refusals).toEqual([]);
});

test('a decline binds to the attributed session, and a refused permit leaves the form pending', async () => {
  const f = await fixture({ deny: request => request.operation === 'form.reply' });
  const release = f.calls.track(DIRECTORY, 'linear', call);
  const state = await f.run(Effect.gen(function* () {
    const forms = yield* Form.Service;
    const asking = yield* Effect.forkChild(forms.ask(structured()));
    const form = yield* pendingForm(forms);
    const refused = yield* Effect.exit(forms.reply({ id: form.id, answer: { team: 'core' } }));
    expect(Exit.isFailure(refused) && String(Cause.squash(refused.cause))).toMatch(/native_permit_lineage_mismatch/);
    expect(yield* forms.state(form.id)).toEqual({ status: 'pending' });
    yield* forms.cancel(form.id);
    return yield* Fiber.join(asking);
  }));
  release();
  expect(state.status).toBe('cancelled');
  expect(f.requests.map(request => [request.operation, request.sessionID])).toEqual([
    ['form.reply', call.sessionID], ['form.cancel', call.sessionID]]);
});

test('zero or several in-flight calls cancel at once without creating a form', async () => {
  const f = await fixture();
  const unattributed = await f.run(Effect.gen(function* () {
    const forms = yield* Form.Service;
    const state = yield* forms.ask(structured());
    expect(yield* forms.list()).toEqual([]);
    return state;
  }));
  expect(unattributed.status).toBe('cancelled');
  const first = f.calls.track(DIRECTORY, 'linear', call);
  const second = f.calls.track(DIRECTORY, 'linear', { ...call, sessionID: 'ses_second', callID: 'call_second' });
  const ambiguous = await f.run(Effect.gen(function* () { return yield* (yield* Form.Service).ask(structured()); }));
  first(); second();
  expect(ambiguous.status).toBe('cancelled');
  // A call on another server or location never owns this server's request.
  const other = f.calls.track(DIRECTORY, 'github', call);
  expect((await f.run(Effect.gen(function* () { return yield* (yield* Form.Service).ask(structured()); }))).status).toBe('cancelled');
  other();
  expect(f.requests).toEqual([]);
  expect(f.refusals).toEqual([
    { reason: 'unattributed', server: 'linear', fieldKinds: ['string', 'integer'] },
    { reason: 'ambiguous', server: 'linear', fieldKinds: ['string', 'integer'] },
    { reason: 'unattributed', server: 'linear', fieldKinds: ['string', 'integer'] },
  ]);
  expect(JSON.stringify(f.refusals)).not.toContain('Pick a team');
});

test('the kill switch, refused schemes and foreign global owners cancel even with one call', async () => {
  const f = await fixture();
  const release = f.calls.track(DIRECTORY, 'linear', call);
  process.env.DEVRYAN_MCP_ELICITATION = '0';
  const disabled = await f.run(Effect.gen(function* () { return yield* (yield* Form.Service).ask(structured()); }));
  delete process.env.DEVRYAN_MCP_ELICITATION;
  const refused = await f.run(Effect.gen(function* () {
    const forms = yield* Form.Service;
    const states = [yield* forms.ask(url('javascript:alert(1)')), yield* forms.ask(url('file:///etc/passwd'))];
    const foreign = yield* forms.ask(structured({ metadata: { kind: 'probe', server: 'linear' } }));
    const created = yield* Effect.exit(forms.create(structured()));
    expect(Exit.isFailure(created) && Cause.squash(created.cause)).toMatchObject({ _tag: 'Form.InvalidFormError' });
    expect(yield* forms.list()).toEqual([]);
    return [...states, foreign];
  }));
  release();
  expect([disabled, ...refused].map(state => state.status)).toEqual(['cancelled', 'cancelled', 'cancelled', 'cancelled']);
  expect(f.refusals.map(row => row.reason)).toEqual(['disabled', 'url_refused', 'url_refused', 'unsupported_owner']);
  expect(JSON.stringify(f.refusals)).not.toMatch(/javascript|passwd/);
});

test('an https URL request is answered by confirmation, or by the server completion while its call runs', async () => {
  const f = await fixture();
  const release = f.calls.track(DIRECTORY, 'linear', call);
  const [confirmed, completed, viaRequest] = await f.run(Effect.gen(function* () {
    const forms = yield* Form.Service;
    const first = yield* Effect.forkChild(forms.ask(url('https://linear.app/oauth?state=x')));
    const form = yield* pendingForm(forms);
    yield* forms.reply({ id: form.id, answer: { elicitation: true } });
    const confirmed = yield* Fiber.join(first);
    expect(f.requests).toEqual([]);
    // A request-scoped permit is a client answer and needs admission.
    const second = yield* Effect.forkChild(forms.ask(url('https://linear.app/oauth?state=y')));
    const next = yield* pendingForm(forms);
    yield* Effect.promise(() => runWithRequestPermit(new Headers({ 'x-devryan-native-permit': JSON.stringify({ token: 'c'.repeat(64), revision: 0, sessionID: call.sessionID }) }),
      () => Effect.runPromise(forms.reply({ id: next.id, answer: { elicitation: true } }))));
    return [confirmed, yield* Fiber.join(second), f.requests.length] as const;
  }));
  release();
  expect(confirmed).toEqual({ status: 'answered', answer: { elicitation: true } });
  expect(completed).toEqual({ status: 'answered', answer: { elicitation: true } });
  expect(viaRequest).toBe(1);
  expect(f.requests[0]).toMatchObject({ operation: 'form.reply', sessionID: call.sessionID });
});

test('ending the asking call (Stop) cancels its pending request; a late completion finds it settled', async () => {
  const f = await fixture();
  const release = f.calls.track(DIRECTORY, 'linear', call);
  await f.run(Effect.gen(function* () {
    const forms = yield* Form.Service;
    const asking = yield* Effect.forkChild(forms.ask(url('https://linear.app/oauth')));
    const form = yield* pendingForm(forms);
    release();
    expect((yield* Fiber.join(asking)).status).toBe('cancelled');
    expect((yield* forms.state(form.id)).status).toBe('cancelled');
    expect(yield* forms.list()).toEqual([]);
    const late = yield* Effect.exit(forms.reply({ id: form.id, answer: { elicitation: true } }));
    expect(Exit.isFailure(late) && Cause.squash(late.cause)).toMatchObject({ _tag: 'Form.AlreadySettledError' });
  }));
  expect(f.requests).toEqual([]);
});

test('session-owned forms keep their own admission and settled global forms answer natively', async () => {
  const f = await fixture();
  await f.run(Effect.gen(function* () {
    const forms = yield* Form.Service;
    const owned = yield* forms.create({ sessionID: 'ses_owner', title: 'Questions', fields: [{ key: 'q0', type: 'string' }] });
    yield* forms.reply({ id: owned.id, answer: { q0: 'yes' } });
    const release = f.calls.track(DIRECTORY, 'linear', call);
    const asking = yield* Effect.forkChild(forms.ask(structured()));
    const form = yield* pendingForm(forms);
    yield* forms.reply({ id: form.id, answer: { team: 'core' } });
    yield* Fiber.join(asking);
    release();
    const again = yield* Effect.exit(forms.reply({ id: form.id, answer: { team: 'core' } }));
    expect(Exit.isFailure(again) && Cause.squash(again.cause)).toMatchObject({ _tag: 'Form.AlreadySettledError' });
  }));
  expect(f.requests.map(request => [request.operation, request.sessionID])).toEqual([
    ['form.reply', 'ses_owner'], ['form.reply', call.sessionID]]);
});

test('a client reply under another session permit is refused in core before admission', async () => {
  const f = await fixture();
  const release = f.calls.track(DIRECTORY, 'linear', call);
  await f.run(Effect.gen(function* () {
    const forms = yield* Form.Service;
    const asking = yield* Effect.forkChild(forms.ask(structured()));
    const form = yield* pendingForm(forms);
    const foreign = new Headers({ 'x-devryan-native-permit': JSON.stringify({ token: 'd'.repeat(64), revision: 0, sessionID: 'ses_other' }) });
    for (const work of [forms.reply({ id: form.id, answer: { team: 'core' } }), forms.cancel(form.id)]) {
      const refused = yield* Effect.promise(() => runWithRequestPermit(foreign, () => Effect.runPromiseExit(work)));
      expect(Exit.isFailure(refused) && String(Cause.squash(refused.cause))).toMatch(/native_permit_lineage_mismatch/);
    }
    expect(yield* forms.state(form.id)).toEqual({ status: 'pending' });
    yield* Fiber.interrupt(asking);
  }));
  release();
  expect(f.requests).toEqual([]);
});
