import { expect, test } from 'bun:test';
import path from 'node:path';
import { Credential } from '@opencode/core/credential';
import { Integration } from '@opencode/core/integration';
import { Location } from '@opencode/core/location';
import { PluginHooks } from '@opencode/core/plugin/hooks';
import { SessionSchema } from '@opencode/core/session/schema';
import { Agent } from '@opencode/core/agent';
import { Model } from '@opencode/schema/model';
import { Global } from '@opencode/util/global';
import { LayerNode } from '@opencode/util/effect/layer-node';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import type { SessionHttpRequest, SessionWebSocketHandshake, SessionWebSocketSend } from '@opencode/plugin/effect/session';
import { createNativeOpenAi } from '../../packages/web/server/lib/opencode/runtime-host/native-openai.js';
import { OperationPermitRef } from '../../packages/web/server/lib/opencode/runtime-host/native-admission-contract.js';
import {CredentialMutationReauthorizeRef}from'../../packages/web/server/lib/opencode/runtime-host/credential-mutation-contract.js';
import { runWithHostRefusal } from '../../packages/web/server/lib/opencode/runtime-host/host-refusal.js';

const directory = path.resolve('.cache/v2-validation/native-openai');
const actual = Schema.decodeUnknownSync(Location.Info)({ directory, project: { id: 'global', directory, canonical: directory } });
const physicalPermit={token:'a'.repeat(64),revision:0,sessionID:'ses_openai_fixture'};
const layer = LayerNode.compile(LayerNode.group([Credential.node, Integration.node, PluginHooks.node]), { replacements: [
  Global.node.replace(Global.layerWith({ home:directory,data:directory,cache:directory,config:directory,state:directory,tmp:directory,bin:directory,log:directory,repos:directory })),
  Location.node.replace(Layer.succeed(Location.Service, actual)),
] }).pipe(Layer.merge(Layer.succeed(OperationPermitRef,physicalPermit)));
const model = Schema.decodeUnknownSync(Model.Ref)({ providerID: 'openai', id: 'gpt-5-fixture' });
const sessionID = Schema.decodeUnknownSync(SessionSchema.ID)('ses_openai_fixture');
const agent = Schema.decodeUnknownSync(Agent.ID)('build');
const value = Schema.decodeUnknownSync(Credential.OAuth)({ type:'oauth',methodID:'chatgpt-browser',refresh:'fixture-refresh',access:'fixture-access',expires:100000,
  metadata:{accountID:'fixture-account',retained:'fixture'} });

test('real native Credential/Integration keeps bootstrap metadata local and uses original-service CAS', async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const credential = yield* Credential.Service, integration = yield* Integration.Service;
    const created = yield* credential.create({ integrationID: Schema.decodeUnknownSync(Integration.ID)('openai'), value });
    let bound = false, attempts = 0;
    const adapter = createNativeOpenAi({ assertAttempt:()=>Effect.void,controllerIdentity:()=> 'controller-fixture',isBound:()=>bound,isExecutionReady:()=>true,
      access:async()=>{attempts++;return {credentialID:created.id,methodID:value.methodID,accountId:'fixture-account',accessToken:'fixture-access',expiresAt:100000,generation:'fixture-generation'};},
      captureOAuthGrant:()=>Effect.succeed({authorizationID:'owned_fixture_grant',reauthorize:Effect.void}),withCredentialMutation:(_binding, action)=>action.pipe(Effect.provideService(CredentialMutationReauthorizeRef,Effect.void)) });
    adapter.decorateCredential(credential);
    const decorated = adapter.decorateIntegration(integration,actual);
    const connection = yield* integration.connection.active(Schema.decodeUnknownSync(Integration.ID)('openai'));
    if (!connection) throw new Error('Native selection missing');
    expect(yield* decorated.connection.resolve(connection)).toEqual(value);
    expect(attempts).toBe(0);
    bound=true;
    expect(yield* decorated.connection.resolve(connection)).toEqual(value);
    expect(attempts).toBe(0);
    const selected = yield* Effect.promise(()=>adapter.readSelectedOwned({directory}));
    if (!selected) throw new Error('Native selected record missing');
    const next = {...value,access:'fixture-rotated',refresh:'fixture-rotated-refresh',expires:200000};
    expect(yield* Effect.promise(()=>adapter.compareAndSwapSelectedOwned({directory,expected:selected,next}))).toBe(true);
    expect((yield* credential.get(created.id))?.value).toEqual(next);
    expect(yield* Effect.promise(()=>adapter.compareAndSwapSelectedOwned({directory,expected:selected,next}))).toBe(false);
  }).pipe(Effect.provide(layer))));
});

test('physical native hooks finalize after earlier hooks for primary, title, compaction and generate', async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const credential = yield* Credential.Service, integration = yield* Integration.Service, hooks = yield* PluginHooks.Service;
    const created = yield* credential.create({integrationID:Schema.decodeUnknownSync(Integration.ID)('openai'),value});
    let calls = 0;
    const adapter = createNativeOpenAi({assertAttempt:()=>Effect.void,controllerIdentity:()=> 'controller-fixture',isBound:()=>true,isExecutionReady:()=>true,
      access:async()=>{calls++;return {credentialID:created.id,methodID:value.methodID,accountId:'fixture-account',accessToken:value.access,expiresAt:value.expires,generation:'fixture-generation'};},
      captureOAuthGrant:()=>Effect.succeed({authorizationID:'owned_fixture_grant',reauthorize:Effect.void}),withCredentialMutation:(_binding, action)=>action.pipe(Effect.provideService(CredentialMutationReauthorizeRef,Effect.void))});
    adapter.decorateCredential(credential); adapter.decorateIntegration(integration,actual);
    yield* hooks.register('session','http.request', event=>Effect.sync(()=>{
      event.request = new Request(event.request,{headers:{authorization:'Bearer unreviewed-fixture', 'chatgpt-account-id':'wrong-fixture-account'}});
    }));
    const decorated = adapter.decorateHooks(hooks);
    expect(yield* decorated.has('session','http.request','openai')).toBe(true);
    for (const kind of ['primary','title','compaction','generate'] as const) {
      const input: SessionHttpRequest = {sessionID,agent,model,kind,request:new Request('https://api.openai.com/v1/responses',{method:'POST',body:'{}'})};
      const result = yield* decorated.trigger('session','http.request',input).pipe(Effect.provideService(Location.Service,actual),Effect.provideService(OperationPermitRef,physicalPermit));
      expect(result.request.url).toBe('https://chatgpt.com/backend-api/codex/responses');
      expect(result.request.headers.get('authorization')).toBe('Bearer fixture-access');
      expect(result.request.headers.get('chatgpt-account-id')).toBe('fixture-account');
    }
    expect(calls).toBe(4);
  }).pipe(Effect.provide(layer))));
});

test('native WebSocket sends refuse changed selection/generation, and OAuth rejects hostile routes', async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const credential = yield* Credential.Service, integration = yield* Integration.Service, hooks = yield* PluginHooks.Service;
    const created = yield* credential.create({integrationID:Schema.decodeUnknownSync(Integration.ID)('openai'),value});
    let generation='first';
    const adapter=createNativeOpenAi({assertAttempt:()=>Effect.void,controllerIdentity:()=> 'controller-fixture',isBound:()=>true,isExecutionReady:()=>true,
      access:async()=>({credentialID:created.id,methodID:value.methodID,accountId:'fixture-account',accessToken:value.access,expiresAt:value.expires,generation}),
      captureOAuthGrant:()=>Effect.succeed({authorizationID:'owned_fixture_grant',reauthorize:Effect.void}),withCredentialMutation:(_binding,action)=>action.pipe(Effect.provideService(CredentialMutationReauthorizeRef,Effect.void))});
    adapter.decorateCredential(credential);adapter.decorateIntegration(integration,actual);
    const decorated=adapter.decorateHooks(hooks);
    const handshake:SessionWebSocketHandshake={sessionID,agent,model,kind:'primary',url:'wss://api.openai.com/v1/responses',headers:{authorization:'Bearer old-fixture'}};
    yield* decorated.trigger('session','experimental.ws.handshake',handshake).pipe(Effect.provideService(Location.Service,actual),Effect.provideService(OperationPermitRef,physicalPermit));
    expect(handshake.headers.authorization).toBe('Bearer fixture-access');
    const send:SessionWebSocketSend={sessionID,agent,model,kind:'primary',frame:'{"type":"response.create"}'};
    yield* decorated.trigger('session','experimental.ws.send',send).pipe(Effect.provideService(Location.Service,actual),Effect.provideService(OperationPermitRef,physicalPermit));
    generation='switched';
    const stale=yield* Effect.promise(()=>runWithHostRefusal(()=>Effect.runPromise(decorated.trigger('session','experimental.ws.send',send).pipe(Effect.provideService(Location.Service,actual),Effect.provideService(OperationPermitRef,physicalPermit)))));
    expect(stale.ok).toBe(false);if(stale.ok)throw new Error('Stale socket accepted');expect(stale.refusal.code).toBe('native_openai_socket_changed');
    const hostile:SessionHttpRequest={sessionID,agent,model,kind:'title',request:new Request('https://fixture.invalid/collect')};
    const route=yield* Effect.promise(()=>runWithHostRefusal(()=>Effect.runPromise(decorated.trigger('session','http.request',hostile).pipe(Effect.provideService(Location.Service,actual),Effect.provideService(OperationPermitRef,physicalPermit)))));
    expect(route.ok).toBe(false);if(route.ok)throw new Error('OAuth credential leaked');expect(route.refusal.code).toBe('native_openai_route_unreviewed');
  }).pipe(Effect.provide(layer))));
});

test('ordinary native OpenAI mutations require actual location and bind exact payload fingerprints', async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const credential = yield* Credential.Service, integration = yield* Integration.Service;
    const created = yield* credential.create({integrationID:Schema.decodeUnknownSync(Integration.ID)('openai'),value});
    const bindings: unknown[]=[];
    const adapter=createNativeOpenAi({assertAttempt:()=>Effect.void,controllerIdentity:()=> 'controller-fixture',isBound:()=>true,isExecutionReady:()=>true,access:async()=>undefined,
      captureOAuthGrant:()=>Effect.succeed({authorizationID:'owned_fixture_grant',reauthorize:Effect.void}),withCredentialMutation:(binding,action)=>{bindings.push(binding);return action.pipe(Effect.provideService(CredentialMutationReauthorizeRef,Effect.void));}});
    const decorated=adapter.decorateCredential(credential); adapter.decorateIntegration(integration,actual);
    const refusal=yield* Effect.promise(()=>runWithHostRefusal(()=>Effect.runPromise(decorated.remove(created.id))));
    expect(refusal.ok).toBe(false);expect(bindings).toHaveLength(0);
    yield* decorated.update(created.id,{label:'reviewed fixture'}).pipe(Effect.provideService(Location.Service,actual),Effect.provideService(OperationPermitRef,physicalPermit));
    expect(bindings).toHaveLength(1);expect(bindings[0]).toMatchObject({kind:'openai',valueType:'oauth',methodID:'chatgpt-browser',directory,controllerInstanceID:'controller-fixture',
      integrationID:'openai',operation:'update',credentialID:created.id,requestedFingerprint:expect.stringMatching(/^[a-f0-9]{64}$/),expectedFingerprint:expect.stringMatching(/^[a-f0-9]{64}$/)});
    expect((yield* credential.get(created.id))?.label).toBe('reviewed fixture');
  }).pipe(Effect.provide(layer))));
});

function oauthLayer(adapter: ReturnType<typeof createNativeOpenAi>, decorateOriginal: (inner: Credential.Interface) => Credential.Interface = inner => inner) {
  return LayerNode.compile(LayerNode.group([Credential.node, Integration.node]), { replacements: [
    Global.node.replace(Global.layerWith({home:directory,data:directory,cache:directory,config:directory,state:directory,tmp:directory,bin:directory,log:directory,repos:directory})),
    Location.node.replace(Layer.succeed(Location.Service, actual)),
    Credential.node.replace(Credential.node.mapLayer(original => Layer.effect(Credential.Service, Effect.gen(function* () {
      return adapter.decorateCredential(decorateOriginal(yield* Credential.Service));
    })).pipe(Layer.provide(original)))),
    Integration.node.replace(Integration.node.mapLayer(original => Layer.effect(Integration.Service, Effect.gen(function* () {
      const inner=yield* Integration.Service;
      const decorated=adapter.decorateIntegration(inner,actual);
      yield* Effect.addFinalizer(()=>adapter.closeLocation(actual.directory,inner));
      return decorated;
    })).pipe(Layer.provide(original)))),
  ] });
}

const openai = Schema.decodeUnknownSync(Integration.ID)('openai');
const method = Schema.decodeUnknownSync(Integration.OAuthMethod)({ id:'chatgpt-browser',type:'oauth',label:'Owned fixture OAuth' });

test('actual native automatic OAuth callback retains original grant and captured Location through credential commit', async () => {
  const { CredentialAuthorizationRef } = await import('../../packages/web/server/lib/opencode/runtime-host/credential-mutation-contract.js');
  let originalCaller = 'first', captured = 0, authorize!: () => void, committing!: () => void;
  const approved = new Promise<void>(resolve => { authorize = resolve; });
  const committed = new Promise<void>(resolve => { committing = resolve; });
  const ids: string[] = [], locations: string[] = [];
  const adapter = createNativeOpenAi({assertAttempt:()=>Effect.void,controllerIdentity:()=> 'controller-fixture',isBound:()=>true,isExecutionReady:()=>true,access:async()=>undefined,
    captureOAuthGrant:()=>Effect.sync(()=> { const caller = originalCaller; captured++; return {authorizationID:caller,reauthorize:Effect.void}; }),
    withCredentialMutation:<A,E,R>(_binding: import('../../packages/web/server/lib/opencode/runtime-host/credential-mutation-contract.js').CredentialMutationBinding,action: Effect.Effect<A,E,R>)=>Effect.gen(function* () {
      const id = yield* CredentialAuthorizationRef; if (!id) throw new Error('Original caller required'); ids.push(id);
      const placement=Option.getOrUndefined(Context.getOption(yield* Effect.context<R>(),Location.Service));
      if(!placement)throw new Error('Actual captured location required');
      locations.push(placement.directory); const result = yield* action.pipe(Effect.provideService(CredentialMutationReauthorizeRef,Effect.void)); committing(); return result;
    })});
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const integration = yield* Integration.Service;
    yield* integration.transform(editor=>editor.method.update({integrationID:openai,method,
      authorize:()=>Effect.succeed({mode:'auto',url:'http://127.0.0.1/owned-no-fetch',instructions:'Owned fixture',
        callback:Effect.promise(()=>approved).pipe(Effect.as(value))})}));
    const attempt = yield* integration.oauth.connect({integrationID:openai,methodID:method.id});
    originalCaller='replacement'; authorize(); yield* Effect.promise(()=>committed);
    const deadline=Date.now()+10000;let status=yield* integration.oauth.status({integrationID:openai,attemptID:attempt.attemptID});
    while(status.status==='pending'&&Date.now()<deadline){yield* Effect.sleep('10 millis');status=yield* integration.oauth.status({integrationID:openai,attemptID:attempt.attemptID});}
    expect(status.status).toBe('complete');
    expect(ids).toEqual(['first']); expect(locations).toEqual([directory]); expect(captured).toBe(1);
  }).pipe(Effect.provide(oauthLayer(adapter)))));
});

test('original OAuth grant revoked before explicit completion cannot be replaced by current caller', async () => {
  let revoked = false, captures = 0, callbacks = 0, writes = 0;
  const adapter = createNativeOpenAi({assertAttempt:()=>Effect.void,controllerIdentity:()=> 'controller-fixture',isBound:()=>true,isExecutionReady:()=>true,access:async()=>undefined,
    captureOAuthGrant:()=>Effect.sync(()=> { captures++; return {authorizationID:'first_original',reauthorize:Effect.sync(()=> { if(revoked)throw new Error('fixture_original_revoked'); })}; }),
    withCredentialMutation:(_binding,action)=>{writes++;return action.pipe(Effect.provideService(CredentialMutationReauthorizeRef,Effect.void));}});
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const integration = yield* Integration.Service;
    yield* integration.transform(editor=>editor.method.update({integrationID:openai,method,
      authorize:()=>Effect.succeed({mode:'code',url:'http://127.0.0.1/owned-no-fetch',instructions:'Owned fixture',callback:()=>Effect.sync(()=>{callbacks++;return value;})})}));
    const attempt = yield* integration.oauth.connect({integrationID:openai,methodID:method.id}); revoked=true;
    const result = yield* Effect.exit(integration.oauth.complete({integrationID:openai,attemptID:attempt.attemptID,code:'owned-fixture'}));
    expect(result._tag).toBe('Failure'); expect(captures).toBe(1); expect(callbacks).toBe(0); expect(writes).toBe(0);
    revoked=false; yield* integration.oauth.cancel({integrationID:openai,attemptID:attempt.attemptID});
    expect((yield* Effect.exit(integration.oauth.status({integrationID:openai,attemptID:attempt.attemptID})))._tag).toBe('Failure');
  }).pipe(Effect.provide(oauthLayer(adapter)))));
});

test('per-location close fences copied old handles and cannot dispose replacement native Integration', async () => {
  const adapter = createNativeOpenAi({assertAttempt:()=>Effect.void,controllerIdentity:()=> 'controller-fixture',isBound:()=>true,isExecutionReady:()=>true,access:async()=>undefined,
    captureOAuthGrant:()=>Effect.succeed({authorizationID:'original',reauthorize:Effect.void}),withCredentialMutation:(_binding,action)=>action.pipe(Effect.provideService(CredentialMutationReauthorizeRef,Effect.void))});
  let old: Integration.Interface | undefined, original: Integration.Interface | undefined;
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    original=yield* Integration.Service; adapter.decorateCredential(yield* Credential.Service);
    old=adapter.decorateIntegration(original,actual);
    yield* adapter.closeLocation(directory,original);
    const copy={...old};
    const result=yield* Effect.promise(()=>runWithHostRefusal(()=>Effect.runPromise(copy.connection.active(openai))));
    expect(result.ok).toBe(false); if(result.ok)throw new Error('Old scope accepted');expect(result.refusal.code).toBe('native_openai_location_expired');
  }).pipe(Effect.provide(layer))));
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fresh=yield* Integration.Service; const current=adapter.decorateIntegration(fresh,actual);
    if(!original||!old)throw new Error('Original native acquisition required');
    yield* adapter.closeLocation(directory,original); // delayed old finalizer
    yield* current.connection.active(openai);
    const capturedOld=old;
    const stale=yield* Effect.promise(()=>runWithHostRefusal(()=>Effect.runPromise(capturedOld.list())));
    expect(stale.ok).toBe(false); if(stale.ok)throw new Error('Old copied scope accepted');expect(stale.refusal.code).toBe('native_openai_location_expired');
    yield* adapter.closeLocation(directory,fresh);
  }).pipe(Effect.provide(layer))));
});

test('original OAuth grant revoked during final native credential reread prevents physical update', async () => {
  let original: Credential.Interface | undefined, recordID: Credential.ID | undefined;
  let armed=false,revoked=false,reads=0,queues=0;
  const adapter=createNativeOpenAi({assertAttempt:()=>Effect.void,controllerIdentity:()=> 'controller-fixture',isBound:()=>true,isExecutionReady:()=>true,access:async()=>undefined,
    captureOAuthGrant:()=>Effect.succeed({authorizationID:'original',reauthorize:Effect.sync(()=>{if(revoked)throw new Error('fixture_original_revoked');})}),
    withCredentialMutation:(_binding,action)=>{queues++;return action.pipe(Effect.provideService(CredentialMutationReauthorizeRef,Effect.void));}});
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const integration=yield* Integration.Service,credential=yield* Credential.Service;
    if(!original)throw new Error('Actual native credential store required');
    const record=yield* original.create({integrationID:openai,value,label:'original'});recordID=record.id;
    yield* integration.transform(editor=>editor.method.update({integrationID:openai,method,
      authorize:()=>Effect.succeed({mode:'code',url:'http://127.0.0.1/owned-no-fetch',instructions:'Owned fixture',
        callback:()=>credential.update(record.id,{label:'forbidden'}).pipe(Effect.as(value))})}));
    const attempt=yield* integration.oauth.connect({integrationID:openai,methodID:method.id});armed=true;
    const result=yield* Effect.exit(integration.oauth.complete({integrationID:openai,attemptID:attempt.attemptID,code:'owned-fixture'}));
    expect(result._tag).toBe('Failure');expect(reads).toBe(2);expect(queues).toBe(1);
    expect((yield* original.get(record.id))?.label).toBe('original');
    armed=false;revoked=false;yield* integration.oauth.cancel({integrationID:openai,attemptID:attempt.attemptID});
  }).pipe(Effect.provide(oauthLayer(adapter,inner=>{
    original=inner;
    return {...inner,get:id=>inner.get(id).pipe(Effect.tap(()=>Effect.promise(async()=>{
      if(armed&&id===recordID){reads++;if(reads===2){await Promise.resolve();revoked=true;}}
    })))};
  })))));
});

test('API-key physical requests require the actual operation permit before exposing authorization',async()=>{
  await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
    const credential=yield* Credential.Service,integration=yield* Integration.Service,hooks=yield* PluginHooks.Service;
    const created=yield* credential.create({integrationID:openai,value:Schema.decodeUnknownSync(Credential.Value)({type:'key',key:'synthetic-owned-key'})});
    let checked=0,revoked=false;
    const adapter=createNativeOpenAi({controllerIdentity:()=> 'controller-fixture',isBound:()=>true,isExecutionReady:()=>true,
      assertAttempt:input=>Effect.sync(()=>{checked++;expect(input).toMatchObject({controllerInstanceID:'controller-fixture',directory,sessionID,kind:'title',permit:physicalPermit,credentialID:created.id});if(revoked)throw new Error('fixture_attempt_revoked');}),
      access:async()=>{throw new Error('Key attempt must not request OAuth credentials');},
      captureOAuthGrant:()=>Effect.succeed({authorizationID:'unused',reauthorize:Effect.void}),withCredentialMutation:(_binding,action)=>action.pipe(Effect.provideService(CredentialMutationReauthorizeRef,Effect.void))});
    adapter.decorateCredential(credential);adapter.decorateIntegration(integration,actual);
    const decorated=adapter.decorateHooks(hooks);
    const unscoped:SessionHttpRequest={sessionID,agent,model,kind:'title',request:new Request('https://api.openai.com/v1/responses')};
    const refusal=yield* Effect.promise(()=>runWithHostRefusal(()=>Effect.runPromise(decorated.trigger('session','http.request',unscoped).pipe(Effect.provideService(Location.Service,actual)))));
    expect(refusal.ok).toBe(false);if(refusal.ok)throw new Error('Unscoped provider accepted');expect(refusal.refusal.code).toBe('native_openai_attempt_scope_required');expect(checked).toBe(0);expect(unscoped.request.headers.has('authorization')).toBe(false);
    const scoped:SessionHttpRequest={...unscoped,request:new Request('https://api.openai.com/v1/responses')};
    yield* decorated.trigger('session','http.request',scoped).pipe(Effect.provideService(Location.Service,actual),Effect.provideService(OperationPermitRef,physicalPermit));
    expect(checked).toBe(1);expect(scoped.request.headers.get('authorization')).toBe('Bearer synthetic-owned-key');
    revoked=true;const denied:SessionHttpRequest={...scoped,request:new Request('https://api.openai.com/v1/responses')};
    expect((yield* Effect.exit(decorated.trigger('session','http.request',denied).pipe(Effect.provideService(Location.Service,actual),Effect.provideService(OperationPermitRef,physicalPermit))))._tag).toBe('Failure');
    expect(denied.request.headers.has('authorization')).toBe(false);
  }).pipe(Effect.provide(layer))));
});
