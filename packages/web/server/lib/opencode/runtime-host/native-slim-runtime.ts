import {Effect,Exit} from 'effect';
import {AsyncLocalStorage} from 'node:async_hooks';
import type {PluginHooks} from '@opencode/core/plugin/hooks';
import type {Location} from '@opencode/core/location';
import type {Plugin} from '@opencode/plugin/effect/plugin';
import type {SessionRetry} from '@opencode/plugin/effect/session';
import {Tool} from '@opencode/schema/tool';
import type * as ReviewedSlim from '../../../../runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js';
import type {NativeConfigurationSnapshot,NativeConfigurationLocation} from './native-configuration-snapshot.js';
import {nativeSlimPlugin,REVIEWED_SLIM_HOOK_INVENTORY} from './native-slim.js';
import {nativeSlimCommandBehaviorsPlugin,reviewedSlimCommandDeclarations} from './native-slim-commands.js';
import type {NativeSlimCommandOptions,NativeSlimCommandInput} from './native-slim-commands.js';
import {createOwnedSlimWebfetch,parseReviewedWebfetchInput} from './native-slim-webfetch.js';
import type {OwnedSlimWebfetchOwners} from './native-slim-webfetch.js';
import type {ExecuteOwned,OwnedToolInvocation} from './native-admission-contract.js';
import {OperationPermitRef} from './native-admission-contract.js';
import {RegistrationOriginRef,type RegistrationOrigin} from './registration-origin.js';
import type {OperationPermit} from './native-admission-contract.js';
import type {NativePonytailOwner} from './native-ponytail.js';
import {currentNativeAttemptIdentity,type NativeAttemptIdentity} from './native-observation.js';

export interface NativeSlimHookAuthority {
 readonly permit:OperationPermit;readonly directory:string;readonly sessionID:string;readonly signal:AbortSignal;
 readonly domain:'session'|'tool';readonly phase:string;readonly event:unknown;
 readonly origin?:RegistrationOrigin;readonly callID?:string;readonly messageID?:string;readonly toolID?:string;
 readonly assertToolRead?:(target:string)=>Promise<void>;
 readonly attempt?:NativeAttemptIdentity;
}
const hookAuthority=new AsyncLocalStorage<{readonly authority:NativeSlimHookAuthority;failure?:{readonly cause:unknown}}>();
/** Constructor-owned callback bridge only; no public binder or session-current map. */
export function currentNativeSlimHookAuthority():NativeSlimHookAuthority|undefined{return hookAuthority.getStore()?.authority;}
/** Preserve owned failures even when an original compatibility bridge catches them. */
export async function runNativeSlimOwnedHook<A>(action:()=>Promise<A>):Promise<A>{
 try{return await action();}catch(error){const current=hookAuthority.getStore();if(current&&current.failure===undefined)current.failure={cause:error};throw error;}
}
export type NativeSlimOriginals=typeof ReviewedSlim;
export interface NativeSlimLocationOwners {
 readonly log:(entry:string)=>void;
 readonly interviewBridge:ReviewedSlim.ReviewedSlimHostBinding['interviewBridge'];
 readonly webfetch:{readonly binaryDirectory:string;readonly ownersFor:(invocation:OwnedToolInvocation,context:ReviewedSlim.ReviewedWebfetchContext)=>Promise<OwnedSlimWebfetchOwners>};
 readonly commands:Pick<NativeSlimCommandOptions,'assertCommand'|'executeCommand'>;
 readonly ponytail:{readonly contextInstructions:NativePonytailOwner['contextInstructions'];readonly applyCommand:(input:NativeSlimCommandInput)=>Effect.Effect<void,unknown>};
 /** Fresh actual native hook permit/canonical scope, including cached header paths. */
 readonly assertContext:(input:{readonly directory:string;readonly sessionID:string})=>Promise<void>;
 readonly readMessage:(input:{readonly directory:string;readonly sessionID:string;readonly messageID:string})=>Promise<{readonly parts:readonly unknown[]}>;
 /** Existing host lifecycle/recovery owner, never a second Slim scheduler. */
 readonly observeLifecycle:(event:unknown)=>Promise<void>;
 readonly observePrompt:(input:Record<string,unknown>,output?:Record<string,unknown>)=>Promise<void>;
 readonly retry:(event:SessionRetry)=>Promise<void>;
 /** Original path rewrite/rescue/stat algorithms run in their owned read context. */
 readonly beforePaths:(input:ReviewedSlim.ReviewedSlimToolInput,output:ReviewedSlim.ReviewedSlimToolOutput)=>Promise<void>;
 /** Existing owned image/context path; pure filtering/reminders are composed below. */
 readonly transformMessages:ReviewedSlim.ReviewedSlimHook;
 readonly dispose:()=>Promise<void>;
}
export interface NativeSlimRuntimeOptions {
 readonly snapshot:NativeConfigurationSnapshot;
 readonly originals:NativeSlimOriginals;
 readonly origin:RegistrationOrigin;
 readonly ponytailCommand:{readonly description:string;readonly template:string};
 readonly executeOwned:ExecuteOwned;
 readonly withControl:<A,E,R>(invocation:OwnedToolInvocation,execute:Effect.Effect<A,E,R>)=>Effect.Effect<A,E,R>;
 readonly forDirectory:(location:NativeConfigurationLocation)=>NativeSlimLocationOwners;
}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const required=<T extends object>(owner:T,keys:readonly (keyof T)[])=>{for(const key of keys)if(typeof owner[key]!=='function')throw new Error('native_slim_owner_required:'+String(key));};
const sameOrigin=(a:RegistrationOrigin,b:RegistrationOrigin)=>a.kind===b.kind&&a.id===b.id&&a.manifestDigest===b.manifestDigest&&a.capabilities.length===b.capabilities.length&&a.capabilities.every(value=>b.capabilities.includes(value));
const toolInput=(input:Record<string,unknown>):ReviewedSlim.ReviewedSlimToolInput=>{
 if(typeof input.tool!=='string'||typeof input.sessionID!=='string')throw new Error('native_slim_hook_identity_invalid');
 return {...input,tool:input.tool,sessionID:input.sessionID,...typeof input.callID==='string'?{callID:input.callID}:{}};
};
const definitions=(options:NativeSlimRuntimeOptions)=>({deepwork:options.originals.createDeepworkCommandHook,loop:options.originals.createLoopCommandHook,reflect:options.originals.createReflectCommandHook});

/** Composition of the real pinned setup, pure factories and existing host owners. No ambient legacy factory. */
export function createNativeSlimRuntime(options:NativeSlimRuntimeOptions){
 if(typeof options.withControl!=='function')throw new Error('native_slim_control_owner_required');
 if(options.origin.kind!=='plugin'||options.origin.id!=='devryan.slim'||!options.origin.capabilities.includes('network'))throw new Error('native_slim_origin_required');
 const owners=new Map<string,NativeSlimLocationOwners>();
 for(const location of options.snapshot.locations){
  if(location.activeRegistrationIDs&&!location.activeRegistrationIDs.some(id=>id==='devryan.slim'||id==='devryan.ponytail'))continue;
  const owner=options.forDirectory(location);
  required(owner,['log','assertContext','readMessage','observeLifecycle','observePrompt','retry','beforePaths','transformMessages','dispose']);
  required(owner.interviewBridge,['registerCommand','handleContext','handleEvent','dispose']);
  required(owner.webfetch,['ownersFor']);required(owner.commands,['assertCommand','executeCommand']);required(owner.ponytail,['contextInstructions','applyCommand']);
  if(owners.has(location.directory))throw new Error('native_slim_location_duplicate');
  owners.set(location.directory,{...owner,
   assertContext:input=>runNativeSlimOwnedHook(()=>owner.assertContext(input)),
   readMessage:input=>runNativeSlimOwnedHook(()=>owner.readMessage(input)),
   observePrompt:(input,output)=>runNativeSlimOwnedHook(()=>owner.observePrompt(input,output)),
   retry:event=>runNativeSlimOwnedHook(()=>owner.retry(event)),
   beforePaths:(input,output)=>runNativeSlimOwnedHook(()=>owner.beforePaths(input,output)),
   transformMessages:(input,output)=>runNativeSlimOwnedHook(()=>owner.transformMessages(input,output)),
   ponytail:{...owner.ponytail,contextInstructions:directory=>runNativeSlimOwnedHook(()=>owner.ponytail.contextInstructions(directory))},
   interviewBridge:{...owner.interviewBridge,handleContext:event=>runNativeSlimOwnedHook(()=>owner.interviewBridge.handleContext(event)),handleEvent:event=>runNativeSlimOwnedHook(()=>owner.interviewBridge.handleEvent(event))},
  });
 }
 const locationFor=(directory:string)=>{const location=options.snapshot.locations.find(value=>value.directory===directory);if(!location)throw new Error('native_slim_location_unreviewed');return location;};
 const ownerFor=(directory:string)=>{const owner=owners.get(directory);if(!owner)throw new Error('native_slim_location_unreviewed');return owner;};
 const webfetchFor=(directory:string,invocation?:OwnedToolInvocation)=>{
  const location=locationFor(directory),owner=ownerFor(directory);
  const saved=location.compatibility.slim;
  if(!record(saved)||!record(saved.mergedConfig))throw new Error('native_slim_snapshot_invalid');
  const config=saved.mergedConfig,webfetch=record(config.webfetch)?config.webfetch:{};
  const model=webfetch.model,entries=Array.isArray(model)?model:model===undefined?[]:[model];
  const webfetchModels=entries.map(entry=>typeof entry==='string'?{id:entry}:record(entry)&&typeof entry.id==='string'?{id:entry.id,...typeof entry.variant==='string'?{variant:entry.variant}:{}}:(()=>{throw new Error('native_slim_webfetch_model_invalid');})());
  const agentModel=(name:string)=>{const agent=location.compatibility.agents[name];if(!record(agent))return;const value=agent.model;return typeof value==='string'?value:undefined;};
  const smallModel=location.compatibility.legacy.small_model;
  return createOwnedSlimWebfetch({originals:options.originals,binaryDirectory:owner.webfetch.binaryDirectory,ownersFor:context=>{if(!invocation)throw new Error('native_webfetch_invocation_required');return owner.webfetch.ownersFor(invocation,context);},
   configuration:{...(webfetchModels.length?{webfetchModels}:{}),explorerModel:agentModel('explorer'),librarianModel:agentModel('librarian')},smallModelRef:()=>typeof smallModel==='string'?smallModel:undefined});
 };
 const toolsFor=(directory:string)=>{
  const location=locationFor(directory);if(location.activeRegistrationIDs&&!location.activeRegistrationIDs.includes('devryan.slim'))return [];
  const saved=location.compatibility.slim;if(!record(saved)||!record(saved.mergedConfig))throw new Error('native_slim_snapshot_invalid');
  const config=saved.mergedConfig,disabled=Array.isArray(config.disabled_tools)?config.disabled_tools:[];
  if(record(config.acpAgents)&&Object.keys(config.acpAgents).length)throw new Error('native_slim_acp_owner_required');
  return ['webfetch','ast_grep_search','ast_grep_replace'].filter(name=>!disabled.includes(name)&&!(name==='webfetch'&&record(config.webfetch)&&config.webfetch.enabled===false));
 };
 const plugin=nativeSlimPlugin({snapshot:options.snapshot,setup:options.originals.default.setup,contextTransforms:true,assertSessionHook:(directory,sessionID)=>ownerFor(directory).assertContext({directory,sessionID}),
  bindConfiguration:options.originals.bindReviewedSlimConfiguration,bindHost:options.originals.bindReviewedSlimHost,
  tools:['webfetch','ast_grep_search','ast_grep_replace'],toolsForDirectory:toolsFor,delegatedTools:['task_cancel','task_message','task_reply','task_result','task_revive','task_status','wait_for_user'],
  delegatedCommands:['interview','deepwork','loop','reflect','review'],hostBindings:directory=>{
   const location=locationFor(directory),owner=ownerFor(directory),loop=options.originals.createToolLoopGuardHook();
   const json=options.originals.createJsonErrorRecoveryHook({});
   const phase=options.originals.createPhaseReminderHook();
   const saved=location.compatibility.slim;
   if(!record(saved)||!record(saved.mergedConfig))throw new Error('native_slim_snapshot_invalid');
   const config=saved.mergedConfig;
   const rewriteMentions=options.originals.createDisplayNameMentionRewriter({customAgentNames:Object.keys(location.compatibility.agents),agents:()=>location.compatibility.agents});
   const filter=options.originals.createFilterAvailableSkillsHook({}, {agents:()=>location.compatibility.agents,disabledSkills:Array.isArray(config.disabled_skills)?config.disabled_skills.filter((value:unknown):value is string=>typeof value==='string'):[]});
   const headers=options.originals.createChatHeadersHook({directory,client:{session:{message:async input=>({data:await owner.readMessage({directory,sessionID:input.path.id,messageID:input.path.messageID})})}}});
   return {directory,requiredHooks:REVIEWED_SLIM_HOOK_INVENTORY,log:owner.log,interviewBridge:owner.interviewBridge,hooks:async()=>({
    agent:location.compatibility.agents,mcp:location.compatibility.mcp,
    config:async(draft:Record<string,unknown>)=>{draft.agent=structuredClone(location.compatibility.agents);draft.mcp=structuredClone(location.compatibility.mcp);},
    tool:Object.fromEntries(toolsFor(directory).map(name=>[name,name==='webfetch'?webfetchFor(directory):name==='ast_grep_search'?options.originals.ast_grep_search:options.originals.ast_grep_replace])),
    event:async(input:{readonly event:unknown})=>{
     const event=input.event;
     if(record(event)){
      const props=record(event.properties)?event.properties:record(event.data)?event.data:{};
      const id=typeof props.sessionID==='string'?props.sessionID:record(props.info)&&typeof props.info.id==='string'?props.info.id:undefined;
      if(id&&event.type==='session.deleted')loop.resetSession(id);
      if(id&&(event.type==='session.idle'||event.type==='session.status'&&(props.status==='idle'||record(props.status)&&props.status.type==='idle')))loop.resetTurn(id);
     }
     await owner.observeLifecycle(event);
    },
    dispose:owner.dispose,
    'v2.session.retry':owner.retry,
    'tool.execute.before':async(input:Record<string,unknown>,output:Record<string,unknown>)=>{const identity=toolInput(input);await runNativeSlimOwnedHook(()=>owner.beforePaths(identity,output));await loop['tool.execute.before'](identity,output);},
    'tool.execute.after':async(input:Record<string,unknown>,output:Record<string,unknown>)=>{await json['tool.execute.after'](input,output);await loop['tool.execute.after'](toolInput(input),output);},
    // Interactive command execution belongs to the native command registration below.
    'command.execute.before':async()=>{throw new Error('native_slim_unowned_command_context');},
    'chat.headers':async(input:Record<string,unknown>,output:Record<string,unknown>)=>{if(typeof input.sessionID!=='string')throw new Error('native_slim_hook_identity_invalid');await owner.assertContext({directory,sessionID:input.sessionID});await headers['chat.headers'](input,output);},
    'experimental.session.compacting':async()=>{throw new Error('native_slim_compaction_owner_required');},
    'chat.message':async(input:Record<string,unknown>,output?:Record<string,unknown>)=>{if(typeof input.sessionID==='string'&&typeof input.messageID==='string')loop.observeNewUserMessage(input.sessionID,input.messageID);await owner.observePrompt(input,output);},
    'experimental.chat.system.transform':async(_input:Record<string,unknown>,output:Record<string,unknown>)=>{if(!Array.isArray(output.system)||!output.system.every((value:unknown)=>typeof value==='string'))throw new Error('native_slim_system_invalid');options.originals.collapseSystemInPlace(output.system);},
    'experimental.chat.messages.transform':async(input:Record<string,unknown>,output:Record<string,unknown>)=>{
     if(Array.isArray(output.messages))for(const message of output.messages){if(!record(message)||!record(message.info)||message.info.role!=='user'||!Array.isArray(message.parts))continue;
      for(const part of message.parts)if(record(part)&&part.type==='text'&&typeof part.text==='string')part.text=rewriteMentions(part.text);
     }
     await runNativeSlimOwnedHook(()=>owner.transformMessages(input,output));await phase['experimental.chat.messages.transform'](input,output);await filter['experimental.chat.messages.transform'](input,output);},
   })};
  }});
 const commands=nativeSlimCommandBehaviorsPlugin({snapshot:options.snapshot,factories:definitions(options),interviewDeclaration:options.originals.reviewedSlimInterviewCommandDeclaration,assertCommand:input=>ownerFor(input.directory).commands.assertCommand(input),executeCommand:input=>ownerFor(input.directory).commands.executeCommand(input)});
 const lifecycle:Plugin={id:'devryan.slim-lifecycle',effect:context=>Effect.gen(function*(){
  const location=locationFor(context.location.directory);if(location.activeRegistrationIDs&&!location.activeRegistrationIDs.includes('devryan.slim'))return;
  const owner=ownerFor(context.location.directory);
  yield* context.session.hook('retry',event=>Effect.tryPromise({try:async()=>{await owner.assertContext({directory:context.location.directory,sessionID:event.sessionID});await owner.retry(event);await owner.assertContext({directory:context.location.directory,sessionID:event.sessionID});},catch:error=>error}).pipe(Effect.orDie));
 })};
 const ponytail:Plugin={id:'devryan.ponytail',effect:context=>Effect.gen(function*(){
  const directory=context.location.directory,location=locationFor(directory);if(location.activeRegistrationIDs&&!location.activeRegistrationIDs.includes('devryan.ponytail'))return;const owner=ownerFor(directory);
  yield* context.session.hook('context',event=>Effect.tryPromise({try:async()=>{await owner.assertContext({directory,sessionID:event.sessionID});const text=await owner.ponytail.contextInstructions(directory);await owner.assertContext({directory,sessionID:event.sessionID});if(text)event.system.push({type:'text',text});},catch:error=>error}).pipe(Effect.orDie));
  if(!Object.hasOwn(location.compatibility.commands,'ponytail'))yield* context.command.transform(editor=>editor.add({name:'ponytail',description:options.ponytailCommand.description,execute:invocation=>Effect.gen(function*(){
   const permit=yield* OperationPermitRef;if(!permit)return yield* Effect.die(new Error('native_ponytail_permit_required'));
   const input:NativeSlimCommandInput={directory,name:'ponytail',invocation};yield* owner.commands.assertCommand(input);
   yield* owner.ponytail.applyCommand(input);
  })}));
 })};
 const executeOwned:ExecuteOwned=invocation=>{
  if(invocation.provenance.id!==options.origin.id)return options.executeOwned(invocation);
  if(!sameOrigin(invocation.provenance,options.origin))return Effect.fail(new Tool.Error({message:'native_slim_origin_mismatch'}));
  if(!toolsFor(invocation.location.directory).includes(invocation.toolID))return Effect.fail(new Tool.Error({message:'native_slim_tool_disabled'}));
  if(invocation.toolID!=='webfetch')return options.executeOwned(invocation);
  return options.withControl(invocation,Effect.suspend(()=>{
   let running:Promise<string>|undefined;
   const progress=new Set<Promise<void>>();let progressFailure:unknown;
   const drainProgress=async()=>{while(progress.size)await Promise.all([...progress]);if(progressFailure!==undefined)throw progressFailure;};
   const operation=Effect.gen(function*(){
    yield* invocation.recheckPermit();
    const tool=webfetchFor(invocation.location.directory,invocation);
    const result=yield* Effect.tryPromise({try:signal=>{
     running=(async()=>{
      const result=await tool.execute(parseReviewedWebfetchInput(invocation.input,tool),{sessionID:invocation.nativeContext.sessionID,abort:signal,
       ask:request=>Effect.runPromise(invocation.nativePermissionAssert({sessionID:invocation.nativeContext.sessionID,agent:invocation.nativeContext.agent,action:request.permission,resources:[...request.patterns],source:{type:'tool',messageID:invocation.nativeContext.messageID,id:invocation.nativeContext.id}}),{signal}),
       metadata:update=>{
        // Start actual native progress immediately; retain and drain every
        // callback before the control lease can settle, including cancellation.
        const pending=Effect.runPromise(invocation.recheckPermit().pipe(Effect.andThen(invocation.nativeContext.progress(update))));
        const observed=pending.then(()=>{progress.delete(observed);},error=>{progressFailure=error;progress.delete(observed);});
        progress.add(observed);
       }});
      await drainProgress();return result;
     })();return running;
    },catch:error=>new Tool.Error({message:error instanceof Error?error.message:'native_webfetch_failed'})});
    yield* invocation.recheckPermit();return {content:result};
   });
   // Effect interruption aborts the Promise signal. It must still wait for the
   // original algorithm and owned IO/progress callbacks to actually settle.
   return operation.pipe(Effect.ensuring(Effect.promise(async()=>{if(running)await running.catch(()=>{});await drainProgress();})));
  }));
 };
 const decorateHooks=(inner:PluginHooks.Interface,location:Readonly<Location.Info>,hookOwners?:{readonly assertToolRead:(event:unknown,target:string)=>Effect.Effect<void>}):PluginHooks.Interface=>({...inner,
  trigger:(domain,name,event)=>Effect.gen(function*(){
   if(domain!=='session'&&domain!=='tool')return yield* inner.trigger(domain,name,event);
   const permit=yield* OperationPermitRef;if(!permit)return yield* Effect.die(new Error('native_slim_hook_permit_required:'+domain+':'+String(name)));
   if(!record(event)||typeof event.sessionID!=='string'||permit.sessionID!==event.sessionID)return yield* Effect.die(new Error('native_slim_hook_identity_invalid'));
   const origin=yield* RegistrationOriginRef;
   const attempt=domain==='session'&&name==='retry'?yield* currentNativeAttemptIdentity:null;
   const context=yield* Effect.context();let active=true;let activeSignal:AbortSignal|undefined;
   const capturedEvent=domain==='tool'?structuredClone(event):event;
   const assertToolRead=domain==='tool'&&name==='execute.before'&&hookOwners?async(target:string)=>{
    if(!active)throw new Error('native_slim_hook_authority_settled');activeSignal?.throwIfAborted();
    await Effect.runPromiseWith(context)(hookOwners.assertToolRead(capturedEvent,target));
    if(!active)throw new Error('native_slim_hook_authority_settled');activeSignal?.throwIfAborted();
   }:undefined;
   const authority:Omit<NativeSlimHookAuthority,'signal'>=Object.freeze({permit:Object.freeze({...permit}),directory:location.directory,sessionID:event.sessionID,domain:domain==='session'?'session':'tool',phase:String(name),event:capturedEvent,...assertToolRead?{assertToolRead}:{},...attempt?{attempt:Object.freeze({...attempt})}:{},
    ...(origin?{origin:Object.freeze({...origin,capabilities:Object.freeze([...origin.capabilities])})}:{}),
    ...(typeof event.id==='string'?{callID:event.id}:{}),...(typeof event.messageID==='string'?{messageID:event.messageID}:{}),...(typeof event.tool==='string'?{toolID:event.tool}:{})});
   // Capture at execution, not registration. The Promise adapter's saved SDK
   // context does not carry detached runner permits; invocation-local ALS does.
   const state:{failure?:{readonly cause:unknown}}={};
   const exit=yield* Effect.promise(signal=>{activeSignal=signal;const captured:{readonly authority:NativeSlimHookAuthority;failure?:{readonly cause:unknown}}={authority:Object.freeze({...authority,signal})};return hookAuthority.run(captured,async()=>{try{return await Effect.runPromiseWith(context)(Effect.exit(inner.trigger(domain,name,event)),{signal});}finally{state.failure=captured.failure;active=false;}});});
   if(state.failure!==undefined)return yield* Effect.die(state.failure.cause);
   return Exit.isSuccess(exit)?exit.value:yield* Effect.failCause(exit.cause);
  }),
 });
 return {plugin,commands,lifecycle,ponytail,executeOwned,decorateHooks,commandDeclarations:Object.freeze({...reviewedSlimCommandDeclarations(definitions(options)),interview:options.originals.reviewedSlimInterviewCommandDeclaration}),ponytailCommandDeclaration:Object.freeze({...options.ponytailCommand})};
}
