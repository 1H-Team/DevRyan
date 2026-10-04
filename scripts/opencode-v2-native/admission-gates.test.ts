import { expect, test } from 'bun:test';
import { Cause, Effect, Layer, Schema } from 'effect';
import { Tool } from '@opencode/core/tool';
import { Model } from '@opencode/core/model';
import { Image } from '@opencode/core/image';
import { Job } from '@opencode/core/job';
import { Location } from '@opencode/core/location';
import { Form } from '@opencode/core/form';
import { KV } from '@opencode/core/kv';
import { PluginHooks } from '@opencode/core/plugin/hooks';
import { SessionSchema } from '@opencode/core/session/schema';
import { SessionMessage } from '@opencode/core/session/message';
import { Agent } from '@opencode/core/agent';
import { LayerNode } from '@opencode/util/effect/layer-node';
import { Global } from '@opencode/util/global';
import path from 'node:path';
import { createAdmissionGates, createChildThroughSession, observeDeferredNativeWake, observeOwnedShellNotification, observeOwnedPrimaryInput } from '../../packages/web/server/lib/opencode/runtime-host/admission-gates.js';
import { SessionExecution } from '@opencode/core/session/execution';
import { SessionInbox } from '@opencode/core/session/inbox';
import { SessionStore } from '@opencode/core/session/store';
import { provideRegistrationOrigin } from '../../packages/web/server/lib/opencode/runtime-host/registration-origin.js';
import type { NativeAdmissionBridge, OperationRequest } from '../../packages/web/server/lib/opencode/runtime-host/native-admission-contract.js';
import { OperationPermitRef, requestPermit, runWithRequestPermit } from '../../packages/web/server/lib/opencode/runtime-host/native-admission-contract.js';
import { HostRefusal, refuseHost, runWithHostRefusal } from '../../packages/web/server/lib/opencode/runtime-host/host-refusal.js';

const origin = { kind: 'plugin', id: 'fixture.reviewed', manifestDigest: 'a'.repeat(64), capabilities: ['read'] } as const;
const invocation: Parameters<Tool.Snapshot['execute']>[0] = { sessionID: Schema.decodeUnknownSync(SessionSchema.ID)('ses_fixture'),
  messageID: Schema.decodeUnknownSync(SessionMessage.ID)('msg_fixture'), agent: Schema.decodeUnknownSync(Agent.ID)('fixture'),
  call: { type: 'tool-call', id: 'call_fixture', name: 'fixture', input: { value: 'original' } } };

test('shell reconciliation observes exact raw native sequence and never revives a displaced objective', async () => {
  const sessionID = SessionSchema.ID.make('ses_fixture');
  const decode = Schema.decodeUnknownSync(SessionMessage.Info);
  const notice = decode({ type: 'synthetic', id: 'msg_notice', text: 'terminal shell', time: { created: 1 } });
  const user = decode({ type: 'user', id: 'msg_new_user', text: 'new objective', time: { created: 2 } });
  const assistant = decode({ type: 'assistant', id: 'msg_actual_step', agent: 'fixture',
    model: { providerID: 'sim', id: 'm1' }, content: [], time: { created: 3 } });
  let promoted = true;
  let following: SessionMessage.Info[] = [];
  const store: Pick<SessionStore.Interface, 'message' | 'messages'> = {
    message: () => Effect.succeed(promoted ? { sessionID, message: notice } : undefined),
    messages: input => {
      expect(input).toMatchObject({ sessionID, order: 'asc', cursor: { id: notice.id, direction: 'next' }, limit: 10_001 });
      return Effect.succeed(following);
    },
  };
  const queued = Schema.decodeUnknownSync(SessionInbox.Synthetic)({ type: 'synthetic', id: 'msg_notice', sessionID,
    payload: { text: 'terminal shell' }, delivery: 'steer', time: { created: 1 } });
  let pending: SessionInbox.Info[] = [queued];
  const inbox: Pick<SessionInbox.Interface, 'list'> = { list: () => Effect.succeed(pending) };
  const observe = () => observeOwnedShellNotification(store, inbox, { sessionID, messageID: notice.id });
  expect(await observe()).toEqual({ kind: 'pending', messageID: notice.id, location: 'promoted' });
  following = [user];
  expect(await observe()).toEqual({ kind: 'blocked', messageID: notice.id });
  following = [decode({ type: 'synthetic', id: 'msg_later_notice', text: 'later shell', time: { created: 2 } })];
  expect(await observe()).toEqual({ kind: 'blocked', messageID: notice.id });
  following = [user, assistant];
  expect(await observe()).toEqual({ kind: 'consumed', messageID: notice.id, assistantMessageID: assistant.id });
  // The notice was folded in REST, but remains an exact native Store record.
  following = [assistant];
  expect(await observe()).toEqual({ kind: 'consumed', messageID: notice.id, assistantMessageID: assistant.id });
  promoted = false;
  expect(await observe()).toEqual({ kind: 'pending', messageID: notice.id, location: 'queued' });
  promoted = true; following = [];
  const newInput = Schema.decodeUnknownSync(SessionInbox.User)({ type: 'user', id: 'msg_new_user', sessionID,
    payload: { text: 'new objective' }, delivery: 'queue', time: { created: 2 } });
  pending = [newInput];
  expect(await observe()).toEqual({ kind: 'blocked', messageID: notice.id });
  pending = [];
  expect(await observe()).toEqual({ kind: 'pending', messageID: notice.id, location: 'promoted' });
  promoted = false;
  pending = [];
  await expect(observe()).rejects.toMatchObject({ code: 'native_continuation_notification_unavailable' });
});

test('primary reconciliation requires the exact native user input and rejects newer objective adoption', async () => {
  const sessionID = invocation.sessionID, decode = Schema.decodeUnknownSync(SessionMessage.Info);
  const user = decode({ type: 'user', id: 'msg_todo', text: 'Continue the same open TODO', time: { created: 1 } });
  const assistant = decode({ type: 'assistant', id: 'msg_todo_step', agent: 'fixture', model: { providerID: 'fixture', id: 'm1' }, content: [], time: { created: 2 } });
  let message: Awaited<Effect.Success<ReturnType<SessionStore.Interface['message']>>> = {sessionID,message:user};
  let following: SessionMessage.Info[] = [], pending: SessionInbox.Info[] = [];
  const store: Pick<SessionStore.Interface, 'message' | 'messages'> = {message:()=>Effect.succeed(message),messages:()=>Effect.succeed(following)};
  const inbox: Pick<SessionInbox.Interface, 'list'> = {list:()=>Effect.succeed(pending)};
  const observe = ()=>observeOwnedPrimaryInput(store,inbox,{sessionID,messageID:user.id});
  expect(await observe()).toEqual({kind:'pending',messageID:user.id,location:'promoted'});
  following=[assistant];expect(await observe()).toEqual({kind:'consumed',messageID:user.id,assistantMessageID:assistant.id});
  following=[decode({type:'user',id:'msg_new_user',text:'A different objective',time:{created:2}}),assistant];
  expect(await observe()).toEqual({kind:'blocked',messageID:user.id});
  following=[];
  message=undefined;
  pending=[Schema.decodeUnknownSync(SessionInbox.User)({type:'user',id:user.id,sessionID,payload:{text:'Continue the same open TODO'},delivery:'queue',time:{created:1}})];
  expect(await observe()).toEqual({kind:'pending',messageID:user.id,location:'queued'});
  pending.push(Schema.decodeUnknownSync(SessionInbox.User)({type:'user',id:'msg_new_user',sessionID,payload:{text:'New objective'},delivery:'queue',time:{created:2}}));
  expect(await observe()).toEqual({kind:'blocked',messageID:user.id});
  pending=[Schema.decodeUnknownSync(SessionInbox.Synthetic)({type:'synthetic',id:user.id,sessionID,payload:{text:'A shell notification'},delivery:'steer',time:{created:1}})];
  await expect(observe()).rejects.toMatchObject({code:'native_continuation_notification_unavailable',operation:'primary.continue'});
  message={sessionID,message:decode({type:'synthetic',id:user.id,text:'A shell notification',time:{created:1}})};
  await expect(observe()).rejects.toMatchObject({code:'native_continuation_notification_unavailable'});
  message={sessionID:SessionSchema.ID.make('ses_other'),message:user};
  await expect(observe()).rejects.toMatchObject({code:'native_continuation_notification_unavailable'});
});

test('deferred wake uses current native inbox/activity and never resurrects consumed history', async () => {
  let active = false, pending: SessionInbox.Info[] = [];
  const inbox: Pick<SessionInbox.Interface, 'list'> = { list: id => {
    expect(id).toBe(invocation.sessionID); return Effect.succeed(pending);
  } };
  const execution: Pick<SessionExecution.Interface, 'isActive'> = { isActive: id => {
    expect(id).toBe(invocation.sessionID); return Effect.succeed(active);
  } };
  const observe = () => Effect.runPromise(observeDeferredNativeWake(inbox, execution, invocation.sessionID));
  expect(await observe()).toBe('idle');
  active = true;
  expect(await observe()).toBe('active');
  pending = [Schema.decodeUnknownSync(SessionInbox.User)({ type: 'user', id: 'msg_deferred', sessionID: invocation.sessionID,
    payload: { text: 'current admitted input' }, delivery: 'queue', time: { created: 1 } })];
  expect(await observe()).toBe('pending');
  active = false;
  expect(await observe()).toBe('pending');
  // Once native promotion consumes the inbox, old transcript messages are
  // intentionally not consulted and cannot turn wake into a forced resume.
  pending = [];
  expect(await observe()).toBe('idle');
});
function fixture() {
  const requests: OperationRequest[] = [], dispatched: unknown[] = [];
  let unguarded = 0;
  const bridge: NativeAdmissionBridge = { awaitReady: async () => {},
    authorize: async request => { requests.push(request); return { token: 'b'.repeat(64), sessionID: request.sessionID, revision: 0 }; },
    recheck: async () => {}, release: async () => {}, sealPrompt: async () => ({}), verifyAccepted: async () => {},
    registerShellJob: async () => {}, sealSynthetic: async () => ({}),
    deferContinuation: async () => {}, hold: async () => {}, releaseHold: async () => {}, isHeld: async () => false };
  const gates = createAdmissionGates({ bridge, nativePlugins: new Map(), executeOwned: call => {
    dispatched.push(call.input); return call.executeNative();
  } });
  const image: Image.Interface = { normalize: (_resource, content) => Effect.succeed(content),
    transform: () => Effect.succeed({ dispose: Effect.void }), reload: () => Effect.void };
  const competing = Tool.Service.of({ list: () => Effect.succeed([]), reload: () => Effect.void,
    transform: () => Effect.succeed({ dispose: Effect.void }),
    snapshot: () => Effect.succeed({ definitions: [], execute: () => Effect.sync(() => { unguarded++; return { content: [] }; }) }) });
  const models: Model.Interface = { get: () => Effect.succeed(undefined), all: () => Effect.succeed([]),
    available: () => Effect.succeed([]), default: () => Effect.succeed(undefined), small: () => Effect.succeed(undefined),
    reload: () => Effect.void, transform: () => Effect.succeed({ dispose: Effect.void }) };
  const location = Schema.decodeUnknownSync(Location.Info)({ directory: '/fixture/project',
    project: { id: 'global', directory: '/fixture/project', canonical: '/fixture/project' } });
  const layer = LayerNode.compile(LayerNode.group([Tool.node, PluginHooks.node]), {
    replacements: [Tool.node.replace(Layer.succeed(Tool.Service, competing)), Image.node.replace(Layer.succeed(Image.Service, image)),
      Model.node.replace(Layer.succeed(Model.Service, models)), Location.node.replace(Layer.succeed(Location.Service, location)), ...gates.overrides],
  });
  return { gates, layer, bridge, requests, dispatched, unguarded: () => unguarded };
}

test('committed native inbox verification releases its lock before synchronous reconciliation and propagates refusal', async () => {
  const f = fixture(); await f.gates.controls.openStartup();
  const permit = { token: 'b'.repeat(64), sessionID: invocation.sessionID, revision: 7 };
  const phases: string[] = [];
  let refused = false;
  Object.assign(f.bridge, { verifyAccepted: async (actual: typeof permit, value: unknown) => {
    expect(actual).toBe(permit);
    expect(value).toBeObject();
    if (value === null || typeof value !== 'object' || !('phase' in value)) throw new Error('Missing verification phase');
    phases.push(String(value.phase));
    if (value.phase === 'committed') {
      // This runs in a separate fiber, just as the owned Node callback returns
      // through the controller's private bridge. The real pinned mutex must be
      // available before any continuation can acquire it.
      await Effect.runPromise(SessionInbox.serialized(invocation.sessionID,
        Effect.sync(() => { phases.push('reconciled'); })).pipe(Effect.timeout('1 second')));
      if (refused) throw new HostRefusal('native_permit_invalid', 403, 'inbox.verify', invocation.sessionID);
    }
  } });
  const home = path.resolve('.cache/v2-validation/client-tmp/native-inbox-lock');
  const layer = LayerNode.compile(SessionInbox.node, { replacements: [
    Global.node.replace(Global.layerWith({ home, data: home, cache: home, config: home, state: home, tmp: home,
      bin: home, log: home, repos: home })), ...f.gates.overrides,
  ] });
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const inbox = yield* SessionInbox.Service;
    const request = { id: SessionMessage.ID.make('msg_committed_lock'), sessionID: invocation.sessionID,
      item: { type: 'synthetic' as const, delivery: 'steer' as const, payload: { text: 'owned completion' } } };
    const accepted = yield* inbox.admit(request).pipe(Effect.provideService(OperationPermitRef, permit));
    expect(accepted.id).toBe(request.id);
    expect(accepted.sessionID).toBe(invocation.sessionID);
    expect(phases).toEqual(['preflight', 'committed', 'reconciled']);
    refused = true;
    const failed = yield* Effect.exit(inbox.admit({ ...request, id: SessionMessage.ID.make('msg_refused_lock') })
      .pipe(Effect.provideService(OperationPermitRef, permit)));
    expect(failed._tag).toBe('Failure');
    if (failed._tag === 'Failure') expect(Cause.squash(failed.cause)).toMatchObject({ code: 'native_permit_invalid' });
    expect(phases).toEqual(['preflight', 'committed', 'reconciled', 'preflight', 'committed', 'reconciled']);
  }).pipe(Effect.provide(layer))));
});

test('missing Job cancellation remains a native no-op, while actual and later jobs retain their scopes', async () => {
  const f = fixture(); await f.gates.controls.openStartup();
  let writes = 0;
  const kv: KV.Interface = { get: () => Effect.succeed(undefined),
    set: () => Effect.sync(() => { writes++; }), remove: () => Effect.sync(() => { writes++; }),
    scan: () => Effect.succeed({ entries: [] }) };
  const layer = LayerNode.compile(Job.node, { replacements: [KV.node.replace(Layer.succeed(KV.Service, kv)), ...f.gates.overrides] });
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const jobs = yield* Job.Service;
    expect(yield* jobs.cancel(invocation.sessionID)).toBeUndefined();
    expect(yield* jobs.cancel('sh_later')).toBeUndefined();
    expect(f.requests).toEqual([]); expect(writes).toBe(0);
    // A later registration using the earlier missing ID cannot be hit by a
    // delayed cancellation effect. This is the real native Job implementation.
    const actual = yield* jobs.start({ id: 'sh_later', type: 'shell', title: 'owned fixture',
      recovery: { kind: 'shell', sessionID: invocation.sessionID, shellID: 'sh_later', command: 'owned fixture' }, run: Effect.never });
    expect(actual.status).toBe('running');
    const denied = yield* Effect.exit(jobs.cancel(actual.id));
    expect(denied._tag).toBe('Failure');
    if (denied._tag === 'Failure') expect(Cause.squash(denied.cause)).toMatchObject({ code: 'native_job_owner_required', operation: 'job.mutate' });
    expect((yield* jobs.get(actual.id))?.status).toBe('running');
    expect(writes).toBe(0);
    expect(f.requests.map(request => request.operation)).toEqual(['job.shell.start']);
  }).pipe(Effect.provide(layer))));
});
const registration = (tools: Tool.Interface, name = 'fixture') => tools.transform(editor => editor.add({ name,
  input: Schema.Struct({ value: Schema.String }), description: 'Owned fixture tool', options: { codemode: true },
  execute: input => Effect.succeed({ content: JSON.stringify(input) }) })).pipe(Effect.provideService(Location.Service, Schema.decodeUnknownSync(Location.Info)({ directory:'/fixture/project', project:{id:'global',directory:'/fixture/project',canonical:'/fixture/project'} })));

test('the mandatory native Tool override beats competing replacement and gates final post-hook input without Code Mode', async () => {
  const f = fixture(); await f.gates.controls.openStartup();
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const tools = yield* Tool.Service, hooks = yield* PluginHooks.Service;
    yield* provideRegistrationOrigin(origin, registration(tools));
    yield* provideRegistrationOrigin(origin, registration(tools, 'execute'));
    yield* hooks.register('tool', 'execute.before', event => Effect.sync(() => { event.input = { value: 'rewritten' }; }));
    const snapshot = yield* tools.snapshot();
    expect(snapshot.definitions.map(value => value.name)).toEqual(['fixture']);
    expect(snapshot.codeModeCatalog).toBeUndefined();
    expect((yield* tools.list())[0]?.options?.codemode).toBe(false);
    yield* snapshot.execute(invocation);
    expect(f.dispatched).toEqual([{ value: 'rewritten' }]);
    expect(f.requests[0]?.input).toEqual({ toolID: 'fixture', callID: 'call_fixture', provenance: origin, input: { value: 'rewritten' } });
    expect(f.unguarded()).toBe(0);
  }).pipe(Effect.provide(f.layer))));
});

test('unknown registrations and stale retained snapshots cannot dispatch a native executor', async () => {
  const f = fixture(); await f.gates.controls.openStartup();
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const tools = yield* Tool.Service;
    const old = yield* provideRegistrationOrigin(origin, registration(tools));
    const snapshot = yield* tools.snapshot();
    yield* old.dispose;
    yield* provideRegistrationOrigin(origin, registration(tools));
    const stale = yield* Effect.exit(snapshot.execute(invocation));
    expect(stale._tag).toBe('Failure'); expect(f.dispatched).toEqual([]);
    yield* registration(tools, 'unknown');
    const unknown = yield* tools.snapshot();
    const denied = yield* Effect.exit(unknown.execute({ ...invocation, call: { ...invocation.call, name: 'unknown' } }));
    expect(denied._tag).toBe('Failure'); expect(f.dispatched).toEqual([]);
  }).pipe(Effect.provide(f.layer))));
});

test('request-local known refusal translation cannot leak between concurrent requests', async () => {
  const failure = new HostRefusal('held', 409, 'session.prompt', 'ses_fixture');
  const [denied, allowed] = await Promise.all([
    runWithHostRefusal(() => Effect.runPromise(refuseHost(failure))),
    runWithHostRefusal(async () => { await Promise.resolve(); return 'allowed'; }),
  ]);
  expect(denied).toEqual({ ok: false, refusal: failure }); expect(allowed).toEqual({ ok: true, value: 'allowed' });
});

test('private headers validate their bounded shape and retain permits only in the owning request', async () => {
  for (const value of ['{', JSON.stringify({ token: 'a'.repeat(64), revision: -1 }),
    JSON.stringify({ token: 'a'.repeat(64), revision: 0, sessionID: 'other' }), 'a'.repeat(2049)]) {
    const result = await runWithHostRefusal(() => runWithRequestPermit(new Headers({ 'x-devryan-native-permit': value }), async () => 'unreachable'));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Malformed header admitted');
    expect(result.refusal.code).toBe('native_permit_header_invalid');
  }
  const permit = { token: 'a'.repeat(64), revision: 0, sessionID: 'ses_fixture' };
  const [owned, unowned] = await Promise.all([
    runWithRequestPermit(new Headers({ 'x-devryan-native-permit': JSON.stringify(permit) }), async () => { await Promise.resolve(); return requestPermit(); }),
    runWithRequestPermit(new Headers(), async () => requestPermit()),
  ]);
  expect(owned).toEqual(permit); expect(unowned).toBeUndefined(); expect(requestPermit()).toBeUndefined();
});

test('the host child control preserves request authority and rejects directory and foreign existing-ID mismatches', async () => {
  const parentID = SessionSchema.ID.make('ses_parent'), childID = SessionSchema.ID.make('ses_child');
  const info = (id: string, parentID?: string) => Schema.decodeUnknownSync(SessionSchema.Info)({ id, ...(parentID ? { parentID } : {}), projectID: 'prj_fixture',
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 }, location: { directory: '/fixture' } });
  const parent = info(parentID), child = info(childID, parentID), foreign = info(childID, 'ses_foreign');
  let creates = 0, returned = child;
  const service = { get: () => Effect.succeed(parent), create: () => Effect.gen(function* () {
    expect((yield* OperationPermitRef)?.sessionID).toBe(parentID); creates++; return returned;
  }) };
  await expect(createChildThroughSession(service, { parentID, id: childID })).rejects.toMatchObject({ code: 'native_child_capability_required' });
  const permit = { token: 'b'.repeat(64), revision: 0, sessionID: parentID };
  await runWithRequestPermit(new Headers({ 'x-devryan-native-permit': JSON.stringify(permit) }), async () => {
    await expect(createChildThroughSession(service, { parentID, id: childID }, '/other')).rejects.toMatchObject({ code: 'native_session_directory_mismatch' });
    expect(creates).toBe(0);
    expect(await createChildThroughSession(service, { parentID, id: childID }, '/fixture')).toEqual(child);
    returned = foreign;
    await expect(createChildThroughSession(service, { parentID, id: childID })).rejects.toMatchObject({ code: 'native_child_identity_mismatch' });
  });
});

test('public form effects bind actual pending session while native scope cleanup stays internal', async()=>{
  const f=fixture();await f.gates.controls.openStartup();
  let denied=false;
  const authorize=f.bridge.authorize;
  Object.assign(f.bridge,{authorize:async (request:OperationRequest)=>{if(denied) throw new HostRefusal('native_permit_invalid',403,request.operation,request.sessionID);return authorize(request);}});
  const home=path.resolve('.cache/v2-validation/client-tmp/native-form-gate');
  const layer=LayerNode.compile(Form.node,{replacements:[Global.node.replace(Global.layerWith({home,data:home,cache:home,config:home,state:home,tmp:home,bin:home,log:home,repos:home})),...f.gates.overrides]});
  await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
    const forms=yield* Form.Service;
    const input={sessionID:invocation.sessionID,title:'owned fixture',fields:[{key:'answer',type:'string' as const}] as const};
    const answered=yield* forms.create(input);
    yield* forms.reply({id:answered.id,answer:{answer:'yes'}});
    expect(f.requests.at(-1)).toMatchObject({operation:'form.reply',sessionID:invocation.sessionID,input:{id:answered.id,pending:{sessionID:invocation.sessionID}}});
    const pending=yield* forms.create(input);denied=true;
    const failure=yield* Effect.exit(forms.cancel(pending.id));expect(failure._tag).toBe('Failure');
    expect(yield* forms.state(pending.id)).toEqual({status:'pending'});
    // Form.close uses the pinned local cancellation closure rather than a
    // public reply/cancel capability; shutdown must still settle the waiter.
    yield* forms.close;
    expect(yield* forms.state(pending.id)).toEqual({status:'cancelled'});
    expect(f.requests.map(request=>request.operation)).toEqual(['form.reply']);
  }).pipe(Effect.provide(layer))));
});

test('a controller close permanently fences readiness work that was already awaiting hydration',async()=>{
  const f=fixture();let ready:()=>void=()=>{};
  const wait=new Promise<void>(resolve=>{ready=resolve;});
  Object.assign(f.bridge,{awaitReady:()=>wait});
  const opening=f.gates.controls.openStartup();
  f.gates.controls.closePermanently();ready();
  await expect(opening).rejects.toMatchObject({code:'native_controller_stopping'});
  await expect(f.gates.controls.openStartup()).rejects.toMatchObject({code:'native_controller_stopping'});
});
