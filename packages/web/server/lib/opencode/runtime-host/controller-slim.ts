import {Effect} from 'effect';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createNativeSlimRuntime,currentNativeSlimHookAuthority,runNativeSlimOwnedHook,type NativeSlimRuntimeOptions,type NativeSlimHookAuthority,type NativeSlimLocationOwners} from './native-slim-runtime.js';
import {createReviewedSlimPathHooks} from './native-slim-paths.js';
import {createOwnedSlimInterviewBridge,type NativeSlimInterviewBridgeOwners} from './native-slim-interview-bridge.js';
import type {ExecutionRpc} from './worker-protocol.js';
import type {NativeSlimCommandInput,NativeSlimCommandOptions} from './native-slim-commands.js';
import type {ReviewedSlimHook} from '../../../../runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js';

const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const fail=(code:string)=>new Error(code);
export type ControllerSlimInterviewOwners=NativeSlimInterviewBridgeOwners;
export interface ControllerSlimOptions extends Pick<NativeSlimRuntimeOptions,'snapshot'|'origin'|'originals'|'ponytailCommand'|'executeOwned'|'withControl'> {
 readonly rpc:ExecutionRpc;
 readonly webfetchOwnersFor:NativeSlimLocationOwners['webfetch']['ownersFor'];
 readonly webfetchBinaryDirectory:(directory:string)=>string;
 readonly commands:Pick<NativeSlimCommandOptions,'assertCommand'|'executeCommand'>;
 readonly applyPonytailCommand:(input:NativeSlimCommandInput)=>Effect.Effect<void,unknown>;
 /** Node service is the original state machine, with actual owned IO. Event
  * callbacks bind constructor event provenance; they cannot borrow hook grants. */
 readonly interviewForDirectory:(directory:string)=>NativeSlimInterviewBridgeOwners;
 readonly observePrompt:(authority:NativeSlimHookAuthority,input:Record<string,unknown>,output?:Record<string,unknown>)=>Promise<void>;
 readonly observeLifecycle:(directory:string,event:unknown)=>Promise<void>;
 /** Compact canonical-image RPC/application is supplied by the existing image
  * owner. No messages/base64 are serialized by this composition adapter. */
 readonly transformImages:(authority:NativeSlimHookAuthority,input:Record<string,unknown>,output:Record<string,unknown>)=>Promise<void>;
 readonly disposeLocation:(directory:string)=>Promise<void>;
 readonly log:(directory:string,message:string)=>void;
}

/** A private placeholder keeps native file/media bytes out of taskboard RPC.
 * Only the original renderer's text/metadata changes are reapplied. */
function taskBoardProjection(messages:unknown[]) {
 const nativeIDs=new Set<string>();
 const originals=messages.map(message=>{
  if(!record(message)||!record(message.info)||!Array.isArray(message.parts))throw fail('native_slim_context_messages_invalid');
  if(message.info.id!==undefined){if(typeof message.info.id!=='string'||nativeIDs.has(message.info.id))throw fail('native_slim_context_messages_invalid');nativeIDs.add(message.info.id);}
  // Native Message.tool has no id. This key correlates only this private
  // presentation round trip; it is never a native message or session identity.
  const key=randomUUID(),retained=new Map<number,unknown>();
  const parts=message.parts.map((part,index)=>{if(record(part)&&part.type==='text')return structuredClone(part);retained.set(index,part);return {type:'devryan-owned-context-placeholder',key,position:index};});
  const {content,...info}=message.info;void content;
  return {key,info:message.info,projectedInfo:structuredClone(info),retained,parts};
 });
 return {projected:originals.map(original=>({devryanContextKey:original.key,info:structuredClone(original.projectedInfo),parts:original.parts})),apply:(result:unknown)=>{
  if(!record(result)||!Array.isArray(result.messages)||!Array.isArray(result.presentationInsertions)||Buffer.byteLength(JSON.stringify(result))>4*1024*1024)throw fail('native_slim_context_result_invalid');
  const insertions=new Map<number,string>();
  for(const insertion of result.presentationInsertions){
   if(!record(insertion)||Object.keys(insertion).sort().join(',')!=='baseKey,index'||typeof insertion.index!=='number'||!Number.isSafeInteger(insertion.index)||insertion.index<0||insertion.index>=result.messages.length||typeof insertion.baseKey!=='string'||insertions.has(insertion.index))throw fail('native_slim_context_result_invalid');
   insertions.set(insertion.index,insertion.baseKey);
  }
  let originalIndex=0;
  const restoredMessages=result.messages.map((message,index)=>{
   if(!record(message)||!record(message.info)||!Array.isArray(message.parts))throw fail('native_slim_context_result_invalid');
   const baseKey=insertions.get(index);
   if(baseKey!==undefined){
    const base=originals.find(value=>value.key===baseKey&&value.projectedInfo.role==='user');
    if(!base||Object.hasOwn(message,'devryanContextKey')||Object.keys(message).sort().join(',')!=='info,parts'||typeof message.info.id!=='string'||nativeIDs.has(message.info.id)||message.parts.length!==1)throw fail('native_slim_context_result_invalid');
    const {id:baseID,...baseInfo}=base.projectedInfo;
    const {id,...insertedInfo}=message.info;void baseID;
    if(!isDeepStrictEqual(baseInfo,insertedInfo))throw fail('native_slim_context_result_invalid');
    const part=message.parts[0];
    if(!record(part)||part.type!=='text'||typeof part.text!=='string'||part.synthetic!==true||!record(part.metadata)||part.metadata['oh-my-opencode-slim.backgroundJobBoard']!==true||Object.keys(part).some(key=>!['type','text','synthetic','metadata','cache'].includes(key))||Object.keys(part.metadata).some(key=>!['oh-my-opencode-slim.backgroundJobBoard','reopenCorrection','sessionID','snapshotID'].includes(key)))throw fail('native_slim_context_result_invalid');
    if(part.metadata.reopenCorrection!==undefined&&part.metadata.reopenCorrection!==true||part.metadata.sessionID!==undefined&&part.metadata.sessionID!==baseInfo.sessionID||part.metadata.snapshotID!==undefined&&(typeof part.metadata.snapshotID!=='string'||part.metadata.snapshotID!==id&&!(id.startsWith(part.metadata.snapshotID+':collision-')&&/^[1-9][0-9]*$/.test(id.slice(part.metadata.snapshotID.length+11)))))throw fail('native_slim_context_result_invalid');
    if(part.cache!==undefined&&(!record(part.cache)||part.cache.type!=='ephemeral'||Object.keys(part.cache).some(key=>!['type','ttlSeconds'].includes(key))||part.cache.ttlSeconds!==undefined&&(typeof part.cache.ttlSeconds!=='number'||!Number.isFinite(part.cache.ttlSeconds)||part.cache.ttlSeconds<=0)))throw fail('native_slim_context_result_invalid');
    // This original renderer ID exists only in the outgoing request context.
    // It is never persisted, admitted, or used to grant native message authority.
    nativeIDs.add(id);return {info:{...base.info,id},parts:message.parts};
   }
   const original=originals[originalIndex++];
   if(!original||message.devryanContextKey!==original.key)throw fail('native_slim_context_result_invalid');
   const {metadata:beforeMetadata,...beforeInfo}=original.projectedInfo;
   const {metadata:afterMetadata,...afterInfo}=message.info;void beforeMetadata;
   if(!isDeepStrictEqual(beforeInfo,afterInfo))throw fail('native_slim_context_result_invalid');
   const positions=[...original.retained.keys()];let restored=0;
   const parts=message.parts.map(part=>{
    if(record(part)&&part.type==='devryan-owned-context-placeholder'){
     if(Object.keys(part).sort().join(',')!=='key,position,type'||part.key!==original.key||typeof part.position!=='number'||part.position!==positions[restored])throw fail('native_slim_context_result_invalid');
     restored++;return original.retained.get(part.position);
    }
    if(!record(part)||part.type!=='text'||typeof part.text!=='string')throw fail('native_slim_context_result_invalid');return part;
   });
   if(restored!==positions.length)throw fail('native_slim_context_result_invalid');
   const info={...original.info};
   if(Object.hasOwn(message.info,'metadata'))info.metadata=afterMetadata;else delete info.metadata;
   return {info,parts};
  });
  if(originalIndex!==originals.length||result.messages.length!==originals.length+insertions.size)throw fail('native_slim_context_result_invalid');
  return restoredMessages;
 }};
}

export function createControllerSlim(options:ControllerSlimOptions) {
 const authority=(directory:string,sessionID?:string)=>{
  const current=currentNativeSlimHookAuthority();
  if(!current||current.directory!==directory||sessionID!==undefined&&current.sessionID!==sessionID)throw fail('native_slim_hook_authority_required');
  current.signal.throwIfAborted();return current;
 };
 const scope=(current:NativeSlimHookAuthority)=>({permit:current.permit,directory:current.directory,sessionID:current.sessionID,phase:current.phase,...current.messageID?{messageID:current.messageID}:{}});
 const call=(method:string,input:Readonly<Record<string,unknown>>,current:NativeSlimHookAuthority)=>runNativeSlimOwnedHook(()=>options.rpc(method,input,{signal:current.signal}));
 return createNativeSlimRuntime({...options,forDirectory:location=>{
  const directory=location.directory;
  const assertContext=async(input:{directory:string;sessionID:string})=>{const current=authority(directory,input.sessionID);if(input.directory!==directory)throw fail('native_slim_hook_authority_required');await call('native.slim.hook',{...scope(current),action:'assert'},current);};
  const pathCall=async(action:'assert'|'stat'|'realpath'|'readText',target?:string)=>{
   const current=authority(directory);
   if(current.domain!=='tool'||current.phase!=='execute.before'||!current.assertToolRead||!current.messageID||!current.callID||!current.toolID)throw fail('native_slim_path_authority_required');
   const assertToolRead=current.assertToolRead;
   if(target!==undefined)await runNativeSlimOwnedHook(()=>assertToolRead(target));
   const result=await call('native.slim.path',{...scope(current),phase:'execute.before',callID:current.callID,toolID:current.toolID,action,...target===undefined?{}:{target}},current);
   current.signal.throwIfAborted();return result;
  };
  const paths=createReviewedSlimPathHooks({originals:options.originals,directory,owners:{
   assertCurrent:async()=>{await pathCall('assert');},
   stat:async(_input,target)=>{const result=await pathCall('stat',target);if(record(result)&&result.kind==='missing')throw Object.assign(fail('native_slim_path_missing'),{code:'ENOENT'});if(!record(result)||!['file','directory','other'].includes(String(result.kind)))throw fail('native_slim_path_result_invalid');if(result.kind==='file')return {kind:'file'};if(result.kind==='directory')return {kind:'directory'};return {kind:'other'};},
   realpath:async(_input,target)=>{const result=await pathCall('realpath',target);if(typeof result!=='string')throw fail('native_slim_path_result_invalid');return result;},
   readText:async(_input,target)=>{const result=await pathCall('readText',target);if(typeof result!=='string')throw fail('native_slim_path_result_invalid');return result;},
  }});
  const interviewOwners=options.interviewForDirectory(directory);
  const interview=createOwnedSlimInterviewBridge({originals:options.originals,directory,owners:{...interviewOwners,
   assertAcceptedCommand:async input=>{const current=authority(directory,input.sessionID);await call('native.slim.accepted-command',{permit:current.permit,directory,sessionID:input.sessionID,messageID:input.messageID,name:'interview',arguments:input.args},current);await interviewOwners.assertAcceptedCommand(input);},
  }});
  const transformMessages:ReviewedSlimHook=async(input,output)=>{
   const current=authority(directory);if(current.domain!=='session'||current.phase!=='context')throw fail('native_slim_context_authority_required');
   await options.transformImages(current,input,output);current.signal.throwIfAborted();
   if(!Array.isArray(output.messages))throw fail('native_slim_context_messages_invalid');
   const projection=taskBoardProjection(output.messages);
   const result=await call('native.slim.context',{...scope(current),action:'transform',messages:projection.projected},current);
   current.signal.throwIfAborted();output.messages.splice(0,output.messages.length,...projection.apply(result));
  };
  return {log:message=>options.log(directory,message),commands:options.commands,
   webfetch:{binaryDirectory:options.webfetchBinaryDirectory(directory),ownersFor:options.webfetchOwnersFor},interviewBridge:interview,
   ponytail:{contextInstructions:async requested=>{const current=authority(directory);if(requested!==directory)throw fail('native_slim_hook_authority_required');const result=await call('native.slim.hook',{...scope(current),action:'ponytail'},current);if(typeof result!=='string')throw fail('native_ponytail_context_invalid');return result;},applyCommand:options.applyPonytailCommand},
   assertContext,readMessage:async input=>{const current=authority(directory,input.sessionID);if(input.directory!==directory)throw fail('native_slim_hook_authority_required');const result=await call('native.slim.hook',{...scope(current),action:'message',requestedMessageID:input.messageID},current);if(!record(result)||!Array.isArray(result.parts))throw fail('native_slim_message_result_invalid');return {parts:result.parts};},
   observePrompt:async(input,output)=>{const current=authority(directory,typeof input.sessionID==='string'?input.sessionID:undefined);await options.observePrompt(current,input,output);},
   observeLifecycle:event=>options.observeLifecycle(directory,event),
   retry:async event=>{const current=authority(directory,event.sessionID);if(current.phase!=='retry')throw fail('native_slim_retry_authority_required');const result=await call('native.slim.context',{...scope(current),action:'retry',event,attempt:current.attempt},current);if(!record(result)||!record(result.decision)||typeof result.decision.retry!=='boolean')throw fail('native_slim_retry_result_invalid');if(result.decision.retry===false)event.decision={retry:false};else if(typeof result.decision.delay==='number'&&Number.isFinite(result.decision.delay)&&result.decision.delay>=0)event.decision={retry:true,delay:result.decision.delay};else throw fail('native_slim_retry_result_invalid');},
   beforePaths:paths.before,transformMessages,dispose:()=>options.disposeLocation(directory),
  };
 }});
}
