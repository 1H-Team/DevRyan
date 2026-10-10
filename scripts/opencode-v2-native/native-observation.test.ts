import {expect,test} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Effect,Schema} from 'effect';
import {Location} from '@opencode/core/location';
import {PluginHooks} from '@opencode/core/plugin/hooks';
import {SessionSchema} from '@opencode/core/session/schema';
import {Agent} from '@opencode/core/agent';
import {Model} from '@opencode/schema/model';
import {parseNativeObservation,parseNativeJournalObservation,type NativeObservation} from '../../packages/shared-runtime/lib/native-observation.js';
import {createNativeObservationOwner} from '../../packages/web/server/lib/opencode/runtime-host/native-observation-owner.js';
import {createNativeObservation,projectNativeWireReasoningOptions,NATIVE_OBSERVATION_WIRE_BYTES} from '../../packages/web/server/lib/opencode/runtime-host/native-observation.js';
import {HostRefusal} from '../../packages/web/server/lib/opencode/runtime-host/host-refusal.js';
import {OperationPermitRef} from '../../packages/web/server/lib/opencode/runtime-host/native-admission-contract.js';
import {registerNativeCompactionObservation,observeNativeCompactionBudget} from '../../packages/web/server/lib/opencode/runtime-host/native-compaction-observation.js';
import {rewriteNativeCompactionObservation,NATIVE_COMPACTION_SOURCE_SHA256} from '../native-compaction-observation-transform.mjs';
const common={schema:1 as const,controllerInstanceID:'controller_1',configurationDigest:'a'.repeat(64),sessionID:'ses_1',directory:'/owned/project'};
const budget={auto:true,buffer:7500,keep:15000,ceiling:8884,budget:8884,estimatePrompt:{measured:100,estimated:200},estimateContext:300,
 limits:{context:32768,input:16384,output:4096},anchorIndex:0,checkpointIndex:-1,stateRevision:1,due:false};
const trigger:Extract<NativeObservation,{stage:'compaction-trigger'}>={...common,stage:'compaction-trigger',triggerID:'trigger_1',reason:'manual',inputID:'msg_1',entered:10,orderedInputDigest:'b'.repeat(64),inputCount:1,budget,anchorMessageID:'msg_0',checkpointMessageID:null};
test('finite private and sanitized contracts retain exact witnesses and reject alternate paths/raw controls',()=>{
 expect(parseNativeObservation(trigger)).toEqual(trigger);
 expect(parseNativeJournalObservation({...trigger,directory:'<WORKTREE_123456abcdef>'}).directory).toBe('<WORKTREE_123456abcdef>');
 for(const directory of ['~','relative','<WORKTREE_notahash>','/owned/project'])expect(()=>parseNativeJournalObservation({...trigger,directory})).toThrow('native_observation_invalid');
 for(const changed of [{rawContext:'private'}, {budget:{...budget,prompt:'private'}},{budget:{...budget,anchorIndex:1}},{reason:'auto'}])expect(()=>parseNativeObservation({...trigger,...changed})).toThrow('native_observation_invalid');
 expect(()=>parseNativeObservation({...common,stage:'physical',requestID:'req_1',kind:'primary',transport:'http',ordinal:1,attempt:null,wireOptions:{authorization:'private'}})).toThrow('native_observation_invalid');
});
test('provider refusals preserve only finite kind, hook and local code through the observation owner',async()=>{
 const observation:Extract<NativeObservation,{stage:'provider-refusal'}>={...common,stage:'provider-refusal',kind:'primary',hook:'experimental.ws.handshake',code:'native_openai_route_unreviewed'};
 expect(parseNativeObservation(observation)).toEqual(observation);
 expect(parseNativeJournalObservation({...observation,directory:'<WORKTREE_123456abcdef>'})).toMatchObject({code:observation.code});
 for(const changed of [{code:'native_openai_private_secret'},{code:'private error details'},{hook:'experimental.ws.receive'},{kind:'private'},{url:'https://private.example'},{stack:'private'},{headers:{authorization:'private'}}])
  expect(()=>parseNativeObservation({...observation,...changed})).toThrow('native_observation_invalid');
 const records:unknown[]=[],kinds:string[]=[];
 const owner=createNativeObservationOwner({instanceID:common.controllerInstanceID,snapshot:{digest:common.configurationDigest,locations:[{directory:common.directory}]},
  controller:()=>({instanceID:common.controllerInstanceID}),isReady:()=>true,
  admissionOwner:{withProviderAttempt:async<A>(input:{kind:string},action:(recheck:()=>Promise<void>)=>Promise<A>)=>{kinds.push(input.kind);return action(async()=>{});}},
  openCodeClient:{sessions:{message:async()=>{throw Error('Refusal must not read message content');}}},recordDiagnostic:(entry:unknown)=>records.push(entry)});
 await owner.handleRpc('native.observation',{controllerInstanceID:common.controllerInstanceID,permit:{},observation});
 expect(kinds).toEqual(['primary']);expect(records).toEqual([{type:'lifecycle',event:'native_observation',sessionID:common.sessionID,directory:common.directory,payload:observation}]);
});
test('outer provider hooks record known local refusals before wrapping and preserve original defects when diagnostics fail',async()=>{
 const records:NativeObservation[]=[];let failObserver=false;
 let fault:Error=new HostRefusal('native_openai_route_unreviewed',503,'provider.openai');
 const observation=createNativeObservation({controllerInstanceID:common.controllerInstanceID,configurationDigest:common.configurationDigest,
  rpc:async(method,input)=>{expect(method).toBe('native.observation');records.push(parseNativeObservation(input.observation));if(failObserver)throw Error('journal unavailable');return null;}});
 const hooks=observation.decorateHooks(PluginHooks.Service.of({has:()=>Effect.succeed(true),register:()=>Effect.die(Error('unused registration')),trigger:()=>Effect.die(fault)}));
 const actual=Schema.decodeUnknownSync(Location.Info)({directory:common.directory,project:{id:'global',directory:common.directory,canonical:common.directory}});
 const sessionID=Schema.decodeUnknownSync(SessionSchema.ID)(common.sessionID),agent=Schema.decodeUnknownSync(Agent.ID)('build'),model=Schema.decodeUnknownSync(Model.Ref)({providerID:'openai',id:'fixture-model'});
 const run=(kind:'primary'|'title')=>Effect.runPromise(hooks.trigger('session','experimental.ws.handshake',{sessionID,agent,model,kind,url:'wss://private.example',headers:{authorization:'private'}})
  .pipe(Effect.provideService(Location.Service,actual),Effect.provideService(OperationPermitRef,{token:'a'.repeat(64),revision:0,sessionID}),Effect.exit));
 for(const kind of ['primary','title'] as const){
  const exit=await run(kind);expect(exit._tag).toBe('Failure');
  if(exit._tag==='Failure'){const reason=exit.cause.reasons[0];expect(reason._tag).toBe('Die');if(reason._tag==='Die')expect(reason.defect).toBe(fault);}
  expect(records.at(-1)).toEqual({...common,stage:'provider-refusal',kind,hook:'experimental.ws.handshake',code:'native_openai_route_unreviewed'});
 }
 expect(JSON.stringify(records)).not.toContain('private');
 failObserver=true;const failed=await run('primary');
 expect(failed._tag).toBe('Failure');if(failed._tag==='Failure'){const reason=failed.cause.reasons[0];expect(reason._tag).toBe('Die');if(reason._tag==='Die')expect(reason.defect).toBe(fault);}
 const count=records.length;
 for(const error of [new HostRefusal('native_openai_private_secret',503,'provider.openai'),new Error('native_openai_route_unreviewed')]){
  fault=error;await run('primary');expect(records).toHaveLength(count);
 }
});
test('only the exact native source gets one observation insertion; removal reproduces original bytes',async()=>{
 const original=await fs.readFile(path.resolve(import.meta.dirname,'../../node_modules/@opencode/core/dist/chunks/location-services-qhaz1dgr.js'),'utf8');
 const helper=path.resolve(import.meta.dirname,'../../packages/web/server/lib/opencode/runtime-host/native-compaction-observation.ts');const result=rewriteNativeCompactionObservation(original,helper);
 expect(result.originalSha256).toBe(NATIVE_COMPACTION_SOURCE_SHA256);
 expect(result.transformedSha256).toBe(createHash('sha256').update(result.contents).digest('hex'));
 const restored=result.contents.replace(`import { observeNativeCompactionBudget } from ${JSON.stringify(helper)};\n`,'')
  .replace(/    try \{ observeNativeCompactionBudget\(trigger, \{[\s\S]*?    \}\); \} catch \{ \/\* Read-only evidence must not alter native compaction\. \*\/ \}\n/,'');
 expect(restored).toBe(original);expect(result.contents.match(/observeNativeCompactionBudget\(trigger,/g)?.length).toBe(1);
 expect(()=>rewriteNativeCompactionObservation(original+'\n',helper)).toThrow('native_compaction_observation_source_changed');
 for(const invalid of ['relative','C:relative',helper+'\0',helper+'\r',helper+'\n'])expect(()=>rewriteNativeCompactionObservation(original,invalid)).toThrow('native_compaction_observation_source_changed');
});
test('budget observation is actual-trigger scoped, frozen, removed and cannot fail native compaction',()=>{
 const triggerObject={},other={};let count=0;
 const unregister=registerNativeCompactionObservation(triggerObject,snapshot=>{expect(Object.isFrozen(snapshot)).toBe(true);count++;throw Error('observer failure');});
 expect(()=>observeNativeCompactionBudget(triggerObject,budget)).not.toThrow();expect(count).toBe(1);
 observeNativeCompactionBudget(other,budget);expect(count).toBe(1);
 expect(()=>registerNativeCompactionObservation(triggerObject,()=>{})).toThrow('native_compaction_observer_duplicate');
 unregister();unregister();observeNativeCompactionBudget(triggerObject,budget);expect(count).toBe(1);
});
test('Node canonical step binding requires variant and fresh authority after suspended read',async()=>{
 let active=true,controller=true,release:()=>void=()=>{},entered:()=>void=()=>{};
 const paused=new Promise<void>(resolve=>{release=resolve;}),reading=new Promise<void>(resolve=>{entered=resolve;});const records:unknown[]=[];
 const owner=createNativeObservationOwner({instanceID:common.controllerInstanceID,snapshot:{digest:common.configurationDigest,locations:[{directory:common.directory}]},controller:()=>controller?{instanceID:common.controllerInstanceID}:undefined,isReady:()=>controller,
 admissionOwner:{withProviderAttempt:async<A>(_input:unknown,action:(recheck:()=>Promise<void>)=>Promise<A>)=>{const recheck=async()=>{if(!active)throw Error('revoked');};await recheck();const result=await action(recheck);await recheck();return result;}},
 openCodeClient:{sessions:{message:async()=>{entered();await paused;return {info:{id:'msg_a',sessionID:common.sessionID,role:'assistant',parentID:'msg_u',agent:'build',providerID:'openai',modelID:'model',variant:'high'},turnOwnership:{source:'native-sequence',userMessageID:'msg_u'}};}}},recordDiagnostic:(entry:unknown)=>records.push(entry)});
 const event={...common,stage:'step-link',eventID:'evt_1',sequence:1,created:100,assistantMessageID:'msg_a',execution:{agent:'build',providerID:'openai',modelID:'model',variant:'high'},attempt:{traceID:'trace_1',spanID:'span_1'}};
 const pending=owner.handleRpc('native.observation',{controllerInstanceID:common.controllerInstanceID,permit:{},observation:event});await reading;active=false;release();await expect(pending).rejects.toThrow('revoked');
 expect(records).toHaveLength(1);expect(records[0]).toMatchObject({type:'gap',event:'native_observation_gap'});
 active=true;await owner.handleRpc('native.observation',{controllerInstanceID:common.controllerInstanceID,permit:{},observation:event});expect(records[1]).toMatchObject({payload:{userMessageID:'msg_u'}});
 await expect(owner.handleRpc('native.observation',{controllerInstanceID:common.controllerInstanceID,permit:{},observation:{...event,execution:{...event.execution,variant:null}}})).rejects.toThrow('native_observation_step_invalid');
 controller=false;await expect(owner.handleRpc('native.observation',{controllerInstanceID:common.controllerInstanceID,permit:{},observation:event})).rejects.toThrow('native_observation_controller_expired');
});

test('wire evidence is finite named JSON controls, bounded by actual bytes, without consuming unsupported bodies',()=>{
 expect(projectNativeWireReasoningOptions(JSON.stringify({input:'private prompt',authorization:'private key',reasoning:{effort:'high',summary:'auto'}}))).toEqual({reasoning:{effort:'high',summary:'auto'}});
 expect(projectNativeWireReasoningOptions(new TextEncoder().encode('{"reasoning_effort":"high"}'))).toEqual({reasoning_effort:'high'});
 expect(projectNativeWireReasoningOptions(new Uint8Array(NATIVE_OBSERVATION_WIRE_BYTES+1))).toBeNull();
 expect(projectNativeWireReasoningOptions('€'.repeat(Math.floor(NATIVE_OBSERVATION_WIRE_BYTES/3)+1))).toBeNull();
 expect(projectNativeWireReasoningOptions('malformed')).toBeNull();let consumed=false;
 expect(projectNativeWireReasoningOptions({async *[Symbol.asyncIterator](){consumed=true;yield '{}';}})).toBeNull();expect(consumed).toBe(false);
});
