import {expect,test} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Credential} from '@opencode/core/credential';
import {Integration} from '@opencode/core/integration';
import {PluginHooks} from '@opencode/core/plugin/hooks';
import {Location} from '@opencode/core/location';
import {OpencodePlugin} from '@opencode/core/plugin/provider/opencode';
import {Bus} from '@opencode/core/bus';
import {ManagedPolicy} from '@opencode/core/managed-policy';
import {FetchHttpClient} from 'effect/unstable/http';
import {XAIPlugin} from '@opencode/core/plugin/provider/xai';
import {Global} from '@opencode/util/global';
import {LayerNode} from '@opencode/util/effect/layer-node';
import {Cause,Effect,Fiber,Layer,Schema,Semaphore} from 'effect';
import {createControllerProviderCredentials} from '../../packages/web/server/lib/opencode/runtime-host/controller-provider-credentials.ts';
import {CredentialMutationReauthorizeRef} from '../../packages/web/server/lib/opencode/runtime-host/credential-mutation-contract.ts';
import {OperationPermitRef} from '../../packages/web/server/lib/opencode/runtime-host/native-admission-contract.ts';
import {provideRegistrationOrigin} from '../../packages/web/server/lib/opencode/runtime-host/registration-origin.ts';
import {runWithHostRefusal} from '../../packages/web/server/lib/opencode/runtime-host/host-refusal.ts';

const origin={kind:'native',id:'opencode.provider.xai',manifestDigest:'c'.repeat(64),capabilities:['provider']};
const id=Schema.decodeUnknownSync(Integration.ID);
const value=Schema.decodeUnknownSync(Credential.Value);
const permit={token:'a'.repeat(64),revision:0,sessionID:'ses_fixture'};
const stale=value({type:'oauth',methodID:'device',access:'fixture-access',refresh:'fixture-refresh',expires:1});
async function fixture(action,{fetchResponse,reauthorize,beforeRead,beforeResolution,allowConsole=false,refreshScope=true}={}){
  const root=await fs.mkdtemp(path.resolve('.cache/v2-validation/provider-native-'));
  const location=Schema.decodeUnknownSync(Location.Info)({directory:root,project:{id:'global',directory:root,canonical:root}});
  let raw,originalIntegration,reads=0,checks=0,current=true,allowed=true,fetches=0,queued=0,generation=0;
  const resolutionQueue=Semaphore.makeUnsafe(1);
  const actualFetch=globalThis.fetch;
  // Exact original XAI endpoints only. Any unexpected native/network behavior
  // fails this fixture; no installed authentication or provider is consulted.
  globalThis.fetch=async(input,options)=>{
    const url=String(input instanceof Request?input.url:input);
    if(!['https://auth.x.ai/oauth2/token','https://auth.x.ai/oauth2/device/code'].includes(url) && !(allowConsole&&url.endsWith('/api/v2/config')))throw Error('fixture_network_forbidden');
    fetches++;
    return fetchResponse?fetchResponse({url,options}):Response.json({access_token:'fixture-rotated',refresh_token:'fixture-next',expires_in:3600});
  };
  const assert=Effect.promise(async()=>{checks++;if(!allowed)throw Error('fixture_revoked');await reauthorize?.();});
  const adapter=createControllerProviderCredentials({controllerInstanceID:'fixture-controller',reviewedNativeProviderOrigin:origin,
    withCredentialMutation:(_binding,body)=>body.pipe(Effect.provideService(CredentialMutationReauthorizeRef,assert)),
    withCredentialResolution:(_binding,check,body)=>{
      const ordinal=++queued;
      return resolutionQueue.withPermits(1)(Effect.promise(async()=>{await beforeResolution?.(ordinal);}).pipe(Effect.andThen(check),Effect.andThen(body),Effect.tap(()=>check)));
    },
    captureLocation:()=>{const captured=generation;return {acquisitionID:'fixture-acquisition-'+captured,configurationDigest:'d'.repeat(64),assertCurrent:()=>{if(!current||generation!==captured)throw Error('fixture_acquisition_expired');}};},
    assertAttempt:()=>assert,assertResolution:()=>assert,captureOAuthGrant:()=>Effect.succeed({authorizationID:'fixture-caller',reauthorize:assert}),
    ownsDelegatedIntegration:()=>false});
  const layer=LayerNode.compile(LayerNode.group([Credential.node,Integration.node,PluginHooks.node,Bus.configured({persist:false}),ManagedPolicy.node]),{replacements:[
    Global.node.replace(Global.layerWith({home:root,data:root,state:root,config:root,tmp:root,cache:root,bin:root,log:root,repos:root})),
    Credential.node.replace(Credential.node.mapLayer(original=>Layer.effect(Credential.Service,Effect.gen(function*(){
      raw=yield* Credential.Service;const store=raw;return adapter.decorateCredential({...store,get:id=>Effect.gen(function*(){const result=yield* store.get(id);reads++;yield* Effect.promise(async()=>{await beforeRead?.(reads);});return result;})});
    })).pipe(Layer.provide(original)))),
    Integration.node.replace(Integration.node.mapLayer(original=>Layer.effect(Integration.Service,Effect.gen(function*(){
      originalIntegration=yield* Integration.Service;return adapter.decorateIntegration(originalIntegration,location);
    })).pipe(Layer.provide(original))))]});
  const state={get originalIntegration(){return originalIntegration;},get raw(){return raw;},get fetches(){return fetches;},get checks(){return checks;},get queued(){return queued;},permit,revoke:()=>{allowed=false;},replace:()=>{current=false;},reacquire:()=>{generation++;},location,adapter};
  try{
    return await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
      const credentials=yield* Credential.Service,integration=yield* Integration.Service,hooks=adapter.decorateHooks(yield* PluginHooks.Service);
      // These are the exact domains used by the original XAI plugin. The native
      // Credential/Integration graph, OAuth authorizer and refresher are real.
      yield* provideRegistrationOrigin(origin,XAIPlugin.effect({app:{name:'DevRyan',version:'2.0.20',channel:'test'},
        integration:{transform:integration.transform},provider:{transform:()=>Effect.void}}));
      const runner=provider=>adapter.decorateSessionRunnerModel({resolve:()=>Effect.gen(function*(){
        const selected=yield* integration.connection.active(id(provider));
        if(!selected)throw Error('fixture_selection_missing');
        return yield* integration.connection.resolve(selected);
      })},location);
      const resolve=(provider='xai')=>runner(provider).resolve({id:'ses_fixture',location},()=>Effect.succeed([]))
        .pipe(refreshScope?Effect.provideService(OperationPermitRef,permit):effect=>effect);
      return yield* action(Object.assign(state,{credentials,integration,resolve,hooks}));
    }).pipe(Effect.provide(layer),Effect.provide(FetchHttpClient.layer),Effect.provideService(Location.Service,location))));
  }finally{globalThis.fetch=actualFetch;await fs.rm(root,{recursive:true,force:true});}
}
const refusal=effect=>Effect.promise(()=>runWithHostRefusal(()=>Effect.runPromise(Effect.scoped(effect))));

test('original native XAI refresh persists only exact selected OAuth under admitted model resolution',async()=>{
  await fixture(({credentials,integration,resolve,raw})=>Effect.gen(function*(){
    const created=yield* raw.create({integrationID:id('xai'),value:stale});
    const selected=yield* integration.connection.active(id('xai'));
    const denied=yield* Effect.result(integration.connection.resolve(selected));expect(denied._tag).toBe('Failure');
    if(denied._tag==='Success')throw Error('sessionless refresh accepted');
    expect(denied.failure).toBeInstanceOf(Integration.AuthorizationError);
    expect(denied.failure.cause.code).toBe('native_provider_resolution_scope_required');
    expect(yield* resolve()).toMatchObject({type:'oauth',access:'fixture-rotated',refresh:'fixture-next',methodID:'device'});
    expect((yield* credentials.get(created.id)).value).toMatchObject({access:'fixture-rotated',refresh:'fixture-next'});
    expect(yield* resolve()).toMatchObject({access:'fixture-rotated'});
  }));
});

test('concurrent title and primary XAI resolutions reuse only the refresh committed by their queue',async()=>{
  let entered,release;
  const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  await fixture(state=>Effect.gen(function*(){
    const created=yield* state.raw.create({integrationID:id('xai'),value:stale});
    const title=yield* Effect.forkChild(state.resolve().pipe(Effect.exit));
    yield* Effect.promise(()=>started);
    const primary=yield* Effect.forkChild(state.resolve().pipe(Effect.exit));
    while(state.queued<2)yield* Effect.sleep('1 millis');
    release();
    expect((yield* Fiber.join(title))._tag).toBe('Success');
    expect((yield* Fiber.join(primary))._tag).toBe('Success');
    expect(state.fetches).toBe(1);
    expect((yield* state.credentials.get(created.id)).value.access).toBe('fixture-rotated');
    for(const kind of ['title','primary']){
      yield* state.hooks.trigger('session','model.request',{sessionID:'ses_fixture',agent:'builder',model:{providerID:'xai',id:'grok-4.6'},kind,headers:{}})
        .pipe(Effect.provideService(OperationPermitRef,permit));
    }
  }),{fetchResponse:async()=>{entered();await gate;return Response.json({access_token:'fixture-rotated',refresh_token:'fixture-next',expires_in:3600});}});
});

for(const change of ['replace','switch','revoke'])test('waiting XAI resolution refuses '+change+' after an authorized refresh',async()=>{
  let store,credentialID,revoke;
  await fixture(state=>Effect.gen(function*(){
    store=state.raw;revoke=state.revoke;
    credentialID=(yield* store.create({integrationID:id('xai'),value:stale})).id;
    const [first,second]=yield* Effect.all([state.resolve().pipe(Effect.exit),state.resolve().pipe(Effect.exit)],{concurrency:'unbounded'});
    expect(first._tag).toBe('Success');expect(second._tag).toBe('Failure');
    if(second._tag!=='Failure')throw Error('Changed credential was accepted');
    expect(String(Cause.squash(second.cause))).toContain(change==='revoke'?'fixture_revoked':'native_credential_changed');
    expect(state.fetches).toBe(1);
    if(change==='replace')expect((yield* store.get(credentialID)).value.access).toBe('fixture-unrelated');
    if(change==='switch')expect((yield* state.integration.connection.active(id('xai'))).id).not.toBe(credentialID);
  }),{
    fetchResponse:async()=>{await new Promise(resolve=>setTimeout(resolve,20));return Response.json({access_token:'fixture-rotated',refresh_token:'fixture-next',expires_in:3600});},
    beforeResolution:async ordinal=>{
      if(ordinal!==2)return;
      if(change==='revoke'){revoke();return;}
      const replacement=value({...stale,access:'fixture-unrelated',refresh:'fixture-unrelated-refresh',expires:Date.now()+3600000});
      if(change==='replace')await Effect.runPromise(store.update(credentialID,{value:replacement}));
      else await Effect.runPromise(store.create({integrationID:id('xai'),value:replacement}));
    },
  });
});

test('concurrent unchanged provider key resolutions remain read-only and dispatch normally',async()=>{
  await fixture(state=>Effect.gen(function*(){
    yield* state.raw.create({integrationID:id('xai'),value:value({type:'key',key:'fixture-key'})});
    const results=yield* Effect.all([state.resolve(),state.resolve()],{concurrency:'unbounded'});
    expect(results.map(result=>result.type)).toEqual(['key','key']);
    expect(state.queued).toBe(0);expect(state.fetches).toBe(0);
    yield* state.hooks.trigger('session','http.request',{sessionID:'ses_fixture',agent:'builder',model:{providerID:'xai',id:'grok-4.6'},kind:'primary',request:new Request('https://fixture.invalid/responses')})
      .pipe(Effect.provideService(OperationPermitRef,permit));
  }));
});

test('provider key accounts use native mutation/selection and unsupported raw credential writes refuse',async()=>{
  await fixture(({credentials,integration})=>Effect.gen(function*(){
    for(const provider of ['xai','opencode','opencode-go']){
      const created=yield* credentials.create({integrationID:id(provider),value:value({type:'key',key:'fixture-'+provider})});
      expect((yield* credentials.get(created.id)).integrationID).toBe(provider);
      yield* credentials.update(created.id,{label:'Account one'});
      const second=yield* credentials.create({integrationID:id(provider),value:value({type:'key',key:'fixture-second'})});
      yield* credentials.activate(second.id);
      expect((yield* integration.connection.active(id(provider)))?.id).toBe(second.id);
      yield* credentials.remove(created.id);
      expect(yield* credentials.get(created.id)).toBeUndefined();
    }
    for(const [provider,token] of [['foreign',value({type:'key',key:'fixture'})],['opencode',stale],['xai',value({...stale,methodID:'browser'})]]){
      const result=yield* refusal(credentials.create({integrationID:id(provider),value:token}));expect(result.ok).toBe(false);
    }
    const forged=yield* refusal(integration.transform(editor=>editor.method.update({integrationID:id('xai'),method:{type:'oauth',id:'device',label:'forged'},authorize:()=>Effect.die('must not execute')})));
    expect(forged.ok).toBe(false);if(forged.ok)throw Error('unreviewed implementation accepted');
    expect(forged.refusal.code).toBe('native_provider_registration_unreviewed');
  }));
});

for(const failure of ['revoke','replace','switch'])test('original native refresh refuses '+failure+' while token request is pending',async()=>{
  let pendingResolve,startedResolve;
  const pending=new Promise(resolve=>{pendingResolve=resolve;}),started=new Promise(resolve=>{startedResolve=resolve;});
  await fixture(({raw,credentials,resolve,revoke,replace})=>Effect.gen(function*(){
    const created=yield* raw.create({integrationID:id('xai'),value:stale});
    const attempt=yield* Effect.forkChild(resolve().pipe(Effect.exit));
    yield* Effect.promise(()=>started);
    if(failure==='revoke')revoke();else if(failure==='replace')replace();else{
      const other=yield* raw.create({integrationID:id('xai'),value:value({type:'key',key:'fixture-other'})});yield* raw.activate(other.id);
    }
    pendingResolve(Response.json({access_token:'must-not-persist',refresh_token:'must-not-persist',expires_in:3600}));
    const {Fiber}=yield* Effect.promise(()=>import('effect'));const result=yield* Fiber.join(attempt);expect(result._tag).toBe('Failure');
    expect((yield* credentials.get(created.id)).value).toEqual(stale);
  }),{fetchResponse:async()=>{startedResolve();return pending;}});
});

test('original XAI automatic device OAuth keeps original caller through native commit and status',async()=>{
  let tokenEntered,finishToken;
  const entered=new Promise(resolve=>{tokenEntered=resolve;}),token=new Promise(resolve=>{finishToken=resolve;});
  await fixture(({credentials,integration,originalIntegration,revoke})=>Effect.gen(function*(){
    const attempt=yield* integration.oauth.connect({integrationID:id('xai'),methodID:'device'});
    expect(attempt.mode).toBe('auto');expect(attempt.url).toBe('https://fixture.invalid/device');
    yield* Effect.promise(()=>entered);
    revoke();finishToken(Response.json({access_token:'revoked-do-not-persist',refresh_token:'revoked-do-not-persist',expires_in:3600}));
    let status;
    for(let i=0;i<100;i++){
      status=yield* originalIntegration.oauth.status({integrationID:id('xai'),attemptID:attempt.attemptID});
      if(status.status!=='pending')break;yield* Effect.sleep('1 millis');
    }
    expect(status.status).toBe('failed');expect(yield* credentials.list(id('xai'))).toHaveLength(0);
    const denied=yield* Effect.exit(integration.oauth.status({integrationID:id('xai'),attemptID:attempt.attemptID}));
    expect(denied._tag).toBe('Failure');
  }),{fetchResponse:async({url})=>{
    if(url.endsWith('/device/code'))return Response.json({device_code:'fixture-device',user_code:'fixture-code',verification_uri:'https://fixture.invalid/device',expires_in:300,interval:1});
    tokenEntered();return token;
  }});
});

test('aborting original refresh settles its fetch signal and never persists a partial token',async()=>{
  let entered,aborted;
  const started=new Promise(resolve=>{entered=resolve;}),settled=new Promise(resolve=>{aborted=resolve;});
  await fixture(({raw,credentials,resolve})=>Effect.gen(function*(){
    const created=yield* raw.create({integrationID:id('xai'),value:stale});
    const fiber=yield* Effect.forkChild(resolve());yield* Effect.promise(()=>started);
    const {Fiber}=yield* Effect.promise(()=>import('effect'));yield* Fiber.interrupt(fiber);yield* Effect.promise(()=>settled);
    expect((yield* credentials.get(created.id)).value).toEqual(stale);
  }),{fetchResponse:({options})=>new Promise((resolve,reject)=>{
    entered();options.signal.addEventListener('abort',()=>{aborted();reject(options.signal.reason);},{once:true});
  })});
});

test('every finite physical provider hook rechecks original caller after resolution and prior hooks',async()=>{
  await fixture(({raw,resolve,hooks,revoke})=>Effect.gen(function*(){
    yield* raw.create({integrationID:id('xai'),value:stale});yield* resolve();
    for(const providerID of ['opencode','opencode-go']){yield* raw.create({integrationID:id(providerID),value:value({type:'key',key:'fixture-'+providerID})});yield* resolve(providerID);}
    for(const providerID of ['xai','opencode','opencode-go'])for(const kind of ['primary','title','compaction','generate']){
      for(const [name,extra] of [['model.request',{headers:{}}],['http.request',{request:new Request('https://fixture.invalid/responses')}],
        ['experimental.ws.handshake',{url:'wss://fixture.invalid/responses',headers:{}}],['experimental.ws.send',{frame:'{}'}]]){
        yield* hooks.trigger('session',name,{sessionID:'ses_fixture',agent:'build',model:{providerID,id:'fixture-model'},kind,...extra})
          .pipe(Effect.provideService(OperationPermitRef,permit));
      }
    }
    revoke();
    const blocked=yield* Effect.exit(hooks.trigger('session','model.request',{sessionID:'ses_fixture',agent:'build',model:{providerID:'xai',id:'fixture-model'},kind:'primary',headers:{}})
      .pipe(Effect.provideService(OperationPermitRef,permit)));
    expect(blocked._tag).toBe('Failure');
  }));
});

test('refresh rechecks original policy AFTER the final selected-account reread before commit',async()=>{
  let entered,release;
  const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  await fixture(({raw,credentials,resolve,revoke})=>Effect.gen(function*(){
    const created=yield* raw.create({integrationID:id('xai'),value:stale});
    const work=yield* Effect.forkChild(resolve().pipe(Effect.exit));yield* Effect.promise(()=>started);
    revoke();release();const {Fiber}=yield* Effect.promise(()=>import('effect'));expect((yield* Fiber.join(work))._tag).toBe('Failure');
    expect((yield* credentials.get(created.id)).value).toEqual(stale);
  }),{beforeRead:async reads=>{if(reads===5){entered();await gate;}}});
});

test('original OpenCode builtin can activate with a key while Console OAuth remains refused',async()=>{
  let requests=0;
  await fixture(({raw,integration,hooks})=>Effect.gen(function*(){
    yield* raw.create({integrationID:id('opencode'),value:value({type:'key',key:'fixture-console-key'})});
    const emptyTransform=callback=>Effect.sync(()=>callback({get:()=>undefined,provider:{get:()=>undefined}}));
    yield* OpencodePlugin.effect({app:{name:'DevRyan',version:'2.0.20',channel:'test'},
      integration,provider:{transform:emptyTransform},model:{transform:emptyTransform},websearch:{transform:emptyTransform},
      mcp:{transform:emptyTransform},session:{hook:(name,callback,options)=>hooks.register('session',name,callback,options)}});
    const methods=(yield* integration.get(id('opencode'))).methods;
    expect(methods.some(method=>method.type==='key')).toBe(true);
    const oauth=methods.find(method=>method.type==='oauth');expect(oauth).toBeDefined();
    const rejected=yield* refusal(integration.oauth.connect({integrationID:id('opencode'),methodID:oauth.id}));
    expect(rejected.ok).toBe(false);if(rejected.ok)throw Error('Console OAuth unexpectedly enabled');
    expect(rejected.refusal.code).toBe('native_provider_method_unsupported');expect(requests).toBe(0);
    expect((yield* integration.connection.active(id('opencode'))).type).toBe('credential');
  }),{allowConsole:true,fetchResponse:async({url})=>{if(!url.endsWith('/api/v2/config'))throw Error('unexpected_token_request');requests++;return new Response('',{status:404});}});
});


test('key resolution is scope-bound, read-only and rejects switched accounts or cloned permits at physical dispatch',async()=>{
  await fixture(state=>Effect.gen(function*(){
    const {raw,integration,resolve,hooks,permit}=state;
    for(const provider of ['xai','opencode','opencode-go']){
      const created=yield* raw.create({integrationID:id(provider),value:value({type:'key',key:'fixture-key'})});
      const selected=yield* integration.connection.active(id(provider));
      expect((yield* Effect.result(integration.connection.resolve(selected)))._tag).toBe('Failure');
      expect((yield* resolve(provider)).type).toBe('key');expect(state.queued).toBe(0);
      const dispatch=actualPermit=>hooks.trigger('session','http.request',{sessionID:'ses_fixture',agent:'build',
        model:{providerID:provider,id:'fixture-model'},kind:'primary',request:new Request('https://fixture.invalid/responses')})
        .pipe(Effect.provideService(OperationPermitRef,actualPermit));
      yield* dispatch(permit);
      expect((yield* Effect.exit(dispatch({...permit})))._tag).toBe('Failure');
      const other=yield* raw.create({integrationID:id(provider),value:value({type:'key',key:'fixture-other'})});
      expect((yield* Effect.exit(dispatch(permit)))._tag).toBe('Failure');
      yield* raw.remove(other.id);yield* raw.remove(created.id);
      expect((yield* Effect.exit(dispatch(permit)))._tag).toBe('Failure');
    }
  }));
});

test('physical fence reauthorizes original caller after final selected-account read',async()=>{
  let entered,release,armed=false;
  const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  await fixture(({raw,resolve,hooks,revoke,permit})=>Effect.gen(function*(){
    yield* raw.create({integrationID:id('xai'),value:value({type:'key',key:'fixture'})});yield* resolve();armed=true;
    const work=yield* Effect.forkChild(hooks.trigger('session','http.request',{sessionID:'ses_fixture',agent:'build',
      model:{providerID:'xai',id:'fixture-model'},kind:'primary',request:new Request('https://fixture.invalid/responses')})
      .pipe(Effect.provideService(OperationPermitRef,permit),Effect.exit));
    yield* Effect.promise(()=>started);revoke();release();const {Fiber}=yield* Effect.promise(()=>import('effect'));
    expect((yield* Fiber.join(work))._tag).toBe('Failure');
  }),{beforeRead:async()=>{if(armed){armed=false;entered();await gate;}}});
});


test('old native Integration cannot borrow a replacement location acquisition for a new key resolution',async()=>{
  await fixture(({raw,resolve,reacquire})=>Effect.gen(function*(){
    yield* raw.create({integrationID:id('xai'),value:value({type:'key',key:'fixture'})});
    reacquire();expect((yield* Effect.exit(resolve()))._tag).toBe('Failure');
  }));
});
