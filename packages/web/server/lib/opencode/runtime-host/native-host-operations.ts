import {createHash} from 'node:crypto';
import {Effect,Schema} from 'effect';
import {Plugin} from '@opencode/plugin/effect';
import {Tool} from '@opencode/schema/tool';
import type {ExecuteOwned} from './native-admission-contract.js';
import type {RegistrationOrigin} from './registration-origin.js';
import {ExecutionBatch,StartResult,type ExecutionRpc} from './worker-protocol.js';

export const HOST_OPERATION_ORIGIN='devryan.host-operations';
export interface HostOperationCatalogEntry {readonly id:string;readonly directory:string;readonly description:string;readonly purpose:'verification'|'deployment'}
export function createNativeHostOperations(options:{readonly catalog:readonly HostOperationCatalogEntry[];readonly origin:RegistrationOrigin;readonly rpc:ExecutionRpc;readonly executeOwned:ExecuteOwned}){
 const plugin=Plugin.define({id:HOST_OPERATION_ORIGIN,effect:context=>Effect.gen(function*(){
  const catalog=options.catalog.filter(row=>row.directory===context.location.directory);
  if(!catalog.length)return;
  yield* context.tool.transform(editor=>editor.add({name:'devryan_operation',description:`Run an administrator-registered host operation. Arguments, executable, environment, capabilities and deadline are fixed by the host. Available operations:\n${catalog.map(row=>`${row.id} (${row.purpose}): ${row.description}`).join('\n')}`,
   input:Schema.Struct({operationID:Schema.String}),options:{codemode:false},execute:()=>Effect.fail(new Tool.Error({message:'host_operation_owner_required'}))}));
 })});
 const executeOwned:ExecuteOwned=invocation=>{
  if(invocation.toolID!=='devryan_operation')return options.executeOwned(invocation);
  if(invocation.provenance.kind!==options.origin.kind||invocation.provenance.id!==options.origin.id||invocation.provenance.manifestDigest!==options.origin.manifestDigest
   ||JSON.stringify(invocation.provenance.capabilities)!==JSON.stringify(options.origin.capabilities))return Effect.fail(new Tool.Error({message:'host_operation_origin_required'}));
  return Effect.gen(function*(){
   const input=yield* Schema.decodeUnknownEffect(Schema.Struct({operationID:Schema.String}))(invocation.input,{onExcessProperty:'error'}).pipe(Effect.mapError(()=>new Tool.Error({message:'host_operation_input_invalid'})));
   if(!options.catalog.some(row=>row.id===input.operationID&&row.directory===invocation.location.directory))return yield* Effect.fail(new Tool.Error({message:'host_operation_unregistered'}));
   yield* invocation.recheckPermit();
   const specification={kind:'host-operation' as const,operationID:input.operationID};
   const authorization={operation:'tool.execute',sessionID:invocation.nativeContext.sessionID,messageID:invocation.nativeContext.messageID,
    input:{toolID:invocation.toolID,callID:invocation.nativeContext.id,provenance:invocation.provenance,input:invocation.input}};
   const call=(action:string,params:Record<string,unknown>)=>options.rpc(`execution.native.${action}`,params);
   const started=yield* Effect.tryPromise({try:()=>call('start',{...specification,directory:invocation.location.directory,sessionID:invocation.nativeContext.sessionID,
    messageID:invocation.nativeContext.messageID,callID:invocation.nativeContext.id,agent:invocation.nativeContext.agent,tool:invocation.toolID,
    permit:invocation.existingPermit,authorization,argsDigest:createHash('sha256').update(JSON.stringify(specification)).digest('hex')}),catch:error=>error});
   const {handle}=yield* Schema.decodeUnknownEffect(StartResult)(started);let settled=false,cursor=0,bytes=0;const output:string[]=[];
   return yield* Effect.gen(function*(){
    while(true){
     const batch=yield* Effect.promise(()=>call('read',{handle,cursor})).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ExecutionBatch)));
     for(const event of batch.events){cursor=event.cursor;
      if(event.type==='output'){
       const data=Buffer.from(event.data,'base64');if(bytes+data.length<=256*1024){output.push(data.toString('utf8'));bytes+=data.length;}
      }else if(event.type==='uncertain')return yield* Effect.fail(new Tool.Error({message:event.error.code}));
      else if(event.type==='settled'){
       settled=true;yield* Effect.promise(()=>call('read',{handle,cursor}));yield* invocation.recheckPermit();
       if(!event.ok||!event.receipt?.terminated||!event.receipt.confined)return yield* Effect.fail(new Tool.Error({message:event.error?.message??'host_operation_unsettled'}));
       return {content:output.join('')||`Operation finished with exit code ${event.receipt.exitCode}.`,metadata:{operationID:input.operationID,exitCode:event.receipt.exitCode}};
      }
     }
     if(batch.done&&!batch.events.length)return yield* Effect.fail(new Tool.Error({message:'host_operation_result_missing'}));
    }
   }).pipe(Effect.ensuring(Effect.promise(async()=>{if(!settled)await call('cancel',{handle});})));
  }).pipe(Effect.catchDefect(()=>Effect.fail(new Tool.Error({message:'host_operation_failed'}))),Effect.mapError(error=>error instanceof Tool.Error?error:new Tool.Error({message:error instanceof Error?error.message:'host_operation_failed'})));
 };
 return {plugin,executeOwned};
}
