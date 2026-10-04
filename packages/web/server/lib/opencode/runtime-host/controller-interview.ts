import {randomUUID} from 'node:crypto';
import type {ControllerSlimInterviewOwners} from './controller-slim.js';
import {currentNativeSlimHookAuthority,type NativeSlimHookAuthority} from './native-slim-runtime.js';
import type {ExecutionRpc} from './worker-protocol.js';

const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function createControllerInterview(options:{controllerInstanceID:string;rpc:ExecutionRpc;isCurrent:()=>boolean}){
 const proofs=new WeakMap<NativeSlimHookAuthority,{sessionID:string;messageID:string;args:string}>();
 const assert=()=>{if(!options.isCurrent())throw new Error('native_interview_location_expired');};
 const base=(directory:string)=>({directory,controllerInstanceID:options.controllerInstanceID});
 const event=async(directory:string,value:unknown)=>{
  assert();if(!record(value)||typeof value.type!=='string')throw new Error('native_interview_event_invalid');
  const properties=record(value.properties)?value.properties:record(value.data)?value.data:{};
  const sessionID=typeof properties.sessionID==='string'?properties.sessionID:record(properties.info)&&typeof properties.info.sessionID==='string'?properties.info.sessionID:record(properties.info)&&typeof properties.info.id==='string'?properties.info.id:undefined;
  if(!sessionID)return;
  await options.rpc('native.slim.interview.event',{...base(directory),sessionID,event:{type:value.type,properties}});assert();
 };
 const forDirectory=(directory:string):ControllerSlimInterviewOwners=>({runtime:{},
  assertCurrent:async()=>{assert();const authority=currentNativeSlimHookAuthority();if(authority){
   if(authority.directory!==directory)throw new Error('native_interview_scope_invalid');authority.signal.throwIfAborted();
   await options.rpc('native.slim.hook',{permit:authority.permit,directory,sessionID:authority.sessionID,phase:authority.phase,...authority.messageID?{messageID:authority.messageID}:{},action:'assert'},{signal:authority.signal});
  }},
  assertAcceptedCommand:async input=>{
   const authority=currentNativeSlimHookAuthority();assert();
   if(!authority||authority.directory!==directory||authority.sessionID!==input.sessionID||authority.phase!=='context')throw new Error('native_interview_scope_invalid');
   proofs.set(authority,{sessionID:input.sessionID,messageID:input.messageID,args:input.args});
  },
  service:{getActiveInterviewId:async sessionID=>{
   assert();const authority=currentNativeSlimHookAuthority();
   if(authority&&(authority.directory!==directory||authority.sessionID!==sessionID))throw new Error('native_interview_scope_invalid');
   authority?.signal.throwIfAborted();
   const result=await options.rpc('native.slim.interview.active',{...base(directory),sessionID},authority?{signal:authority.signal}:undefined);
   authority?.signal.throwIfAborted();
   if(result!==null&&typeof result!=='string')throw new Error('native_interview_result_invalid');assert();return result;
  },handleCommandExecuteBefore:async(input,output)=>{
   const authority=currentNativeSlimHookAuthority(),proof=authority&&proofs.get(authority);assert();
   if(!authority||!proof||authority.directory!==directory||proof.sessionID!==input.sessionID||proof.args!==input.arguments||input.command!=='interview')throw new Error('native_interview_scope_invalid');
   const scope={requestID:randomUUID(),directory,sessionID:proof.sessionID,permit:authority.permit};
   try{
    const parts=await options.rpc('native.slim.interview.command',{...scope,controllerInstanceID:options.controllerInstanceID,messageID:proof.messageID,args:proof.args},{signal:authority.signal});
    authority.signal.throwIfAborted();if(!Array.isArray(parts)||parts.some(part=>!record(part)||part.type!=='text'||typeof part.text!=='string'))throw new Error('native_interview_result_invalid');
    output.parts.splice(0,output.parts.length,...parts.map(part=>({type:'text' as const,text:part.text as string})));
   }finally{proofs.delete(authority);await options.rpc('native.slim.interview.settle',scope);}
  },handleEvent:input=>event(directory,input.event)},
  // Command registration is delegated to the native reviewed command owner.
  submitCommand:async()=>{throw new Error('native_command_derivation_required');},dispose:async()=>{},
 });
 return {forDirectory,event};
}
