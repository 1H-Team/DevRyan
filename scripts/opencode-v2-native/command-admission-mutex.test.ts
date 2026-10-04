import {expect,test} from 'bun:test';
import {Effect,Schema} from 'effect';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {LayerNode} from '@opencode/util/effect/layer-node';
import {Global} from '@opencode/util/global';
import {Bus} from '@opencode/core/bus';
import {Database} from '@opencode/core/database/database';
import {Project} from '@opencode/core/project';
import {SessionInbox} from '@opencode/core/session/inbox';
import {SessionProjector} from '@opencode/core/session/projector';
import {SessionStore} from '@opencode/core/session/store';
import {SessionEvent} from '@opencode/core/session/event';
import {SessionMessage} from '@opencode/core/session/message';
import {SessionSchema} from '@opencode/core/session/schema';
import {AbsolutePath} from '@opencode/schema/schema';
import {createSessionMutationRuntime} from '../../packages/harness-runtime/lib/session-mutations.js';
import {createPrimaryRecoveryHost} from '../../packages/harness-runtime/index.js';
import {createNativeAdmissionOwner} from '../../packages/web/server/lib/opencode/runtime-host/native-admission-owner.js';
import {createAdmissionGates} from '../../packages/web/server/lib/opencode/runtime-host/admission-gates.js';
import {OperationPermitRef,type NativeAdmissionBridge} from '../../packages/web/server/lib/opencode/runtime-host/native-admission-contract.js';

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
test('actual native promotion waits for sealed command primary reservation and committed verification can reenter the inbox',async()=>{
 const root=await fs.mkdtemp(path.resolve('.cache/v2-validation/command-admission-'));
 const directory=path.join(root,'project');await fs.mkdir(directory);execFileSync('git',['init','--quiet'],{cwd:directory});
 const runtime=createSessionMutationRuntime({directory:path.join(root,'ledger')});
 const unavailable=async()=>{throw Error('Unexpected observation in admission-only fixture');};
 const primary=createPrimaryRecoveryHost({dataDirectory:path.join(root,'primary'),isManaged:()=>true,mode:'observe',
  openCodeClient:{generation:()=>2,sessions:{get:unavailable,children:unavailable,status:unavailable,messages:unavailable,message:unavailable,todo:unavailable,abort:unavailable},
   interaction:{permissions:{list:unavailable},questions:{list:unavailable}},catalog:{tools:unavailable},prompts:{prompt:unavailable},health:{probe:unavailable,runtimeInfo:unavailable}},
  authorize:async()=>true,managedBarrier:async()=>({state:'clear'}),});
 await primary.initialize();
 const entered=deferred(),release=deferred(),promotionStarted=deferred();let promoted=false;
 let store:SessionStore.Interface|undefined;
 const sessionID=SessionSchema.ID.make('ses_command_mutex'),messageID=SessionMessage.ID.make('msg_commandmutex');
 const definition={template:'Reviewed $ARGUMENTS',agent:'orchestrator',model:{providerID:'fixture',model:'saved'}};
 const owner=createNativeAdmissionOwner({runtime,directory,ownerID:'fixture',reviewedConfiguration:{commands:{reviewed:definition},agents:{orchestrator:{mode:'primary'}}},
  getSession:async id=>{if(!store)throw Error('Native store not acquired');const row=await Effect.runPromise(store.get(SessionSchema.ID.make(id)));
   return row&&{id:row.id,directory:row.location.directory,parentID:row.parentID,agent:row.agent,model:row.model};},
  authorizeOperation:async()=>{throw Error('Unowned effect');},withSessionLock:async(_id,action)=>action(),captureWebAuthorization:async()=>async()=>{},
  captureCommandPromptAdmission:async()=>({admit:async(receipt,authorizeWrite)=>{
   entered.resolve();await release.promise;await primary.admitNativePrompt(receipt,{owner:null,authorizeWrite});
  },uncertain:receipt=>primary.markNativePromptUncertain(receipt)})});
 const rpc=(method:string,input:unknown)=>owner.handleRpc(`native.admission.${method}`,input);
 const bridge:NativeAdmissionBridge={awaitReady:async()=>{},authorize:async()=>{throw Error('Explicit permit required');},recheck:async(permit,request)=>{await rpc('recheck',{permit,request});},
  release:async()=>{},sealPrompt:async()=>({}),verifyAccepted:async(permit,accepted)=>{await rpc('verifyAccepted',{permit,accepted});
   if(accepted&&typeof accepted==='object'&&'phase'in accepted&&accepted.phase==='committed')await Effect.runPromise(SessionInbox.serialized(sessionID,Effect.void));},
  registerShellJob:async()=>{},sealSynthetic:async()=>({}),deferContinuation:async()=>{},hold:async()=>{},releaseHold:async()=>{},isHeld:async()=>false};
 const gates=createAdmissionGates({bridge,nativePlugins:new Map(),executeOwned:()=>Effect.die('No tool execution')});await gates.controls.openStartup();
 const layer=LayerNode.compile(LayerNode.group([SessionInbox.node,SessionStore.node,SessionProjector.node,Bus.node,Database.node,Project.node]),{replacements:[
  Global.node.replace(Global.layerWith({home:root,data:root,cache:root,config:root,state:root,tmp:root,bin:root,log:root,repos:root})),...gates.overrides]});
 try{await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
  const bus=yield* Bus.Service,database=yield* Database.Service,inbox=yield* SessionInbox.Service;store=yield* SessionStore.Service;
  const project=yield* (yield* Project.Service).resolve(AbsolutePath.make(directory));
  const created=Schema.decodeUnknownSync(SessionEvent.Created.data)({sessionID,projectID:project.id,location:{directory},slug:'command-mutex',agent:'orchestrator',model:{providerID:'fixture',id:'saved'},version:'2.0.20'});
  yield* bus.publish(SessionEvent.Created,created);
  yield* Effect.promise(()=>owner.withWebOperation({operation:'commands.execute',method:'POST',path:`/api/session/${sessionID}/command`,directory,body:{name:'reviewed',text:'original'}},async()=>{
   const permit=JSON.parse(owner.requestHeaders()['x-devryan-native-permit']);
   const derivation=await rpc('beginCommand',{permit,sessionID,name:'reviewed',definition,model:{providerID:'fixture',id:'saved'},invocation:{sessionID,prompt:{text:'original'},delivery:'steer'}});
   await rpc('authorize',{operation:'session.prompt',sessionID,existingPermit:permit,derivation,input:{id:messageID,sessionID,text:'Reviewed original',delivery:'steer'}});
   const metadata=await rpc('sealPrompt',{permit,input:{sessionID,messageID,prompt:{text:'Reviewed original'},delivery:'steer'}});
   const request={sessionID:created.sessionID,id:SessionMessage.ID.make(messageID),
    item:{type:'user' as const,delivery:'steer' as const,payload:Schema.decodeUnknownSync(SessionInbox.UserPayload)({text:'Reviewed original',metadata})}};
   const admitted=Effect.runPromise(inbox.admit(request).pipe(Effect.provideService(OperationPermitRef,permit))).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
   await entered.promise;
   const promotion=Effect.runPromise(Effect.sync(()=>promotionStarted.resolve()).pipe(Effect.andThen(SessionInbox.promote(database.db,bus,request.sessionID,'input')),
    Effect.tap(()=>Effect.sync(()=>{promoted=true;})))).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
   await promotionStarted.promise;await new Promise(done=>setTimeout(done,10));
   expect(promoted).toBe(false);expect(await primary.readRecord(sessionID)).toBeNull();
   release.resolve();const result=await admitted;if(result.error)throw result.error;expect((await primary.readRecord(sessionID))?.anchorID).toBe(messageID);
   const promotedResult=await promotion;if(promotedResult.error)throw promotedResult.error;expect(promotedResult.value).toBe(1);expect(promoted).toBe(true);
   const row=await Effect.runPromise(store!.message(request.id));expect(row?.message.type).toBe('user');expect(row?.message.id).toBe(messageID);
  }));
 }).pipe(Effect.provide(layer),Effect.timeout('10 seconds'))));}
 finally{release.resolve();owner.dispose();await primary.drain();await fs.rm(root,{recursive:true,force:true});}
});
