import {expect,test}from'bun:test';
import path from'node:path';
import {Credential}from'@opencode/core/credential';
import {Integration}from'@opencode/core/integration';
import {Location}from'@opencode/core/location';
import {Global}from'@opencode/util/global';
import {LayerNode}from'@opencode/util/effect/layer-node';
import {Effect,Layer,Schema}from'effect';
import {createCredentialMutationBridge}from'../../packages/web/server/lib/opencode/runtime-host/credential-mutation-bridge.js';
import {createControllerCursorCredentials}from'../../packages/web/server/lib/opencode/runtime-host/controller-cursor-credentials.js';
import {createNativeOpenAi}from'../../packages/web/server/lib/opencode/runtime-host/native-openai.js';
import {createNativeCredentialMutationOwner}from'../../packages/web/server/lib/opencode/runtime-host/native-credential-mutation-owner.js';

const instance='00000000-0000-4000-8000-000000000001';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
for(const kind of ['cursor','openai']as const)test(`${kind} key mutation rechecks original grant after the queued actual Credential CAS reread`,async()=>{
 const directory=path.resolve('.cache/v2-validation/credential-revocation-'+kind);
 const location=Schema.decodeUnknownSync(Location.Info)({directory,project:{id:'global',directory,canonical:directory}});
 const layer=LayerNode.compile(LayerNode.group([Credential.node,Integration.node]),{replacements:[
  Global.node.replace(Global.layerWith({home:directory,data:directory,cache:directory,config:directory,state:directory,tmp:directory,bin:directory,log:directory,repos:directory})),
  Location.node.replace(Layer.succeed(Location.Service,location)),
 ]});
 await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
  const credential=yield* Credential.Service,integration=yield* Integration.Service;
  const integrationID=Schema.decodeUnknownSync(Integration.ID)(kind==='cursor'?'cursor-acp':'openai');
  const created=yield* credential.create({integrationID,value:{type:'key',key:'isolated-fixture-key'}});
  const waiting=deferred(),gate=deferred();let revoked=false,reads=0,writes=0;
  const originalGrant=()=>{if(revoked)throw new Error('fixture_original_caller_revoked');};
  let queue:Promise<unknown>=Promise.resolve();
  const bridge=createCredentialMutationBridge({controllerInstanceID:instance,
   captureAuthorization:()=>Effect.succeed({authorizationID:'original_fixture_grant',reauthorize:Effect.sync(originalGrant)}),
   rpc:(method,input,options)=>owner.handleRpc(method,input,options)});
  const owner=createNativeCredentialMutationOwner({controllerInstanceID:instance,
   withMutationQueue:work=>{const next=queue.then(work);queue=next.catch(()=>{});return next;},
   resolveAuthorization:async()=>({reauthorize:originalGrant}),verifyBinding:async binding=>{expect(binding.kind).toBe(kind);expect(binding.credentialID).toBe(created.id);},
   commitOwned:bridge.commitOwned});
  const original:Credential.Interface={...credential,
   get:id=>Effect.gen(function*(){const row=yield* credential.get(id);reads++;if(reads===2){waiting.resolve();yield* Effect.promise(()=>gate.promise);}return row;}),
   update:(id,input)=>Effect.suspend(()=>{writes++;return credential.update(id,input);}),
  };
  let store:Credential.Interface;
  if(kind==='cursor')store=createControllerCursorCredentials({controllerInstanceID:instance,withCredentialMutation:bridge.withCredentialMutation,captureLocation:()=>()=>{}}).decorateCredential(original);
  else{
   const adapter=createNativeOpenAi({controllerIdentity:()=>instance,isBound:()=>true,isExecutionReady:()=>true,assertAttempt:()=>Effect.void,
    access:async()=>undefined,captureOAuthGrant:()=>Effect.succeed({authorizationID:'unused',reauthorize:Effect.void}),withCredentialMutation:bridge.withCredentialMutation});
   store=adapter.decorateCredential(original);adapter.decorateIntegration(integration,location);
  }
  const run=Effect.runPromise(store.update(created.id,{label:'must-not-commit'}).pipe(Effect.provideService(Location.Service,location)));
  const outcome=run.then(()=>undefined,error=>error);
  yield* Effect.promise(()=>waiting.promise);revoked=true;gate.resolve();
  const error=yield* Effect.promise(()=>outcome);expect(String(error)).toContain('fixture_original_caller_revoked');expect(writes).toBe(0);
  expect((yield* credential.get(created.id))?.label).not.toBe('must-not-commit');
  revoked=false;yield* store.update(created.id,{label:'fresh-authorized'}).pipe(Effect.provideService(Location.Service,location));
  expect(writes).toBe(1);expect((yield* credential.get(created.id))?.label).toBe('fresh-authorized');
  let unowned:Credential.Interface;
  if(kind==='cursor')unowned=createControllerCursorCredentials({controllerInstanceID:instance,withCredentialMutation:(_binding,action)=>action,captureLocation:()=>()=>{}}).decorateCredential(original);
  else{
   const adapter=createNativeOpenAi({controllerIdentity:()=>instance,isBound:()=>true,isExecutionReady:()=>true,assertAttempt:()=>Effect.void,
    access:async()=>undefined,captureOAuthGrant:()=>Effect.succeed({authorizationID:'unused',reauthorize:Effect.void}),withCredentialMutation:(_binding,action)=>action});
   unowned=adapter.decorateCredential(original);adapter.decorateIntegration(integration,location);
  }
  const absent=yield* Effect.promise(()=>Effect.runPromise(unowned.update(created.id,{label:'unowned'}).pipe(Effect.provideService(Location.Service,location))).then(()=>undefined,error=>error));
  expect(String(absent)).toContain('native_credential_mutation_authorization_required');expect(writes).toBe(1);
  yield* Effect.promise(async()=>{await bridge.close();await owner.close();});
 }).pipe(Effect.provide(layer))));
});
