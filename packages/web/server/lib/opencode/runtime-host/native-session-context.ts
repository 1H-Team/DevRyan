import { Effect, Schema } from 'effect';
import { Plugin } from '@opencode/plugin/effect';
import type {PluginHooks} from '@opencode/core/plugin/hooks';
import type {Location} from '@opencode/core/location';
import { Tool } from '@opencode/schema/tool';
import { OperationPermitRef } from './native-admission-contract.js';
import type {ExecuteOwned} from './native-admission-contract.js';
import type {RegistrationOrigin} from './registration-origin.js';
import type {ExecutionRpc} from './worker-protocol.js';

export const SESSION_CONTEXT_PLUGIN_ID='devryan.harness-context';
export const nativeTodoSchema=Schema.Struct({todos:Schema.Array(Schema.Struct({id:Schema.String,content:Schema.String,
  status:Schema.Literals(['pending','in_progress','completed','cancelled']),priority:Schema.Literals(['high','medium','low'])}))});
export const nativeSessionContextPlugin=Plugin.define({id:SESSION_CONTEXT_PLUGIN_ID,effect:({tool})=>tool.transform(editor=>{
  editor.add({name:'todoread',input:Schema.Struct({}),description:'Read the current ordered TODO list for this owned objective.',options:{codemode:false},execute:()=>Effect.fail(new Tool.Error({message:'native_todo_host_required'}))});
  editor.add({name:'todowrite',input:nativeTodoSchema,description:'Update the complete ordered TODO list for this owned objective. Preserve task IDs and use pending, in_progress, completed or cancelled; completion needs actual verification.',options:{codemode:false},execute:()=>Effect.fail(new Tool.Error({message:'native_todo_host_required'}))});
})});
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);

/** Composes into the one reviewed executor and final hook owner. */
export function createNativeSessionContext(options:{readonly origin:RegistrationOrigin;readonly rpc:ExecutionRpc;readonly executeOwned:ExecuteOwned}) {
  if(options.origin.kind!=='plugin'||options.origin.id!==SESSION_CONTEXT_PLUGIN_ID||!options.origin.capabilities.includes('control'))throw Error('native_context_origin_required');
  const executeOwned:ExecuteOwned=invocation=>{
    if(invocation.provenance.id!==SESSION_CONTEXT_PLUGIN_ID)return options.executeOwned(invocation);
    if(!['todoread','todowrite'].includes(invocation.toolID)||invocation.provenance.kind!=='plugin'
      ||invocation.provenance.manifestDigest!==options.origin.manifestDigest
      ||JSON.stringify(invocation.provenance.capabilities)!==JSON.stringify(options.origin.capabilities))return Effect.fail(new Tool.Error({message:'native_todo_origin_mismatch'}));
    return Effect.gen(function*(){
      const input=yield* Schema.decodeUnknownEffect(invocation.toolID==='todowrite'?nativeTodoSchema:Schema.Struct({}))(invocation.input,{onExcessProperty:'error'})
        .pipe(Effect.mapError(error=>new Tool.Error({message:String(error)})));
      yield* invocation.recheckPermit();
      const authorization={operation:'tool.execute',sessionID:invocation.nativeContext.sessionID,messageID:invocation.nativeContext.messageID,
        input:{toolID:invocation.toolID,...invocation.nativeToolID===undefined?{}:{nativeToolID:invocation.nativeToolID},callID:invocation.nativeContext.id,provenance:invocation.provenance,input:invocation.input}};
      const result=yield* Effect.tryPromise({try:signal=>options.rpc('native.session-context.tool',{directory:invocation.location.directory,
        sessionID:invocation.nativeContext.sessionID,messageID:invocation.nativeContext.messageID,callID:invocation.nativeContext.id,
        tool:invocation.nativeToolID??invocation.toolID,input,permit:invocation.existingPermit,authorization},{signal}),catch:error=>new Tool.Error({message:error instanceof Error?error.message:'native_todo_failed'})});
      yield* invocation.recheckPermit();return {content:JSON.stringify(result)};
    });
  };
  const withPrimaryToolExecution=(inner:ExecuteOwned):ExecuteOwned=>invocation=>Effect.gen(function*(){
    const authorization={operation:'tool.execute',sessionID:invocation.nativeContext.sessionID,messageID:invocation.nativeContext.messageID,
      input:{toolID:invocation.toolID,...invocation.nativeToolID===undefined?{}:{nativeToolID:invocation.nativeToolID},callID:invocation.nativeContext.id,provenance:invocation.provenance,input:invocation.input}};
    const observe=(phase:'tool_before'|'tool_after')=>Effect.gen(function*(){
      yield* invocation.recheckPermit();
      yield* Effect.tryPromise({try:signal=>options.rpc('native.session-context.observe-tool',{directory:invocation.location.directory,
        sessionID:invocation.nativeContext.sessionID,messageID:invocation.nativeContext.messageID,callID:invocation.nativeContext.id,
        tool:invocation.nativeToolID??invocation.toolID,input:invocation.input,permit:invocation.existingPermit,authorization,phase},{signal}),
        catch:error=>new Tool.Error({message:error instanceof Error?error.message:'native_primary_tool_unavailable'})});
      yield* invocation.recheckPermit();
    });
    yield* observe('tool_before');
    const result=yield* inner(invocation);
    yield* observe('tool_after');
    return result;
  });
  const decorateHooks=(inner:PluginHooks.Interface,location:Readonly<Location.Info>):PluginHooks.Interface=>({ ...inner,
    trigger:(domain,name,event)=>inner.trigger(domain,name,event).pipe(Effect.tap(updated=>{
      if(domain!=='session'||name!=='compaction')return Effect.void;
      // The generic hook declaration does not narrow correlated domain/name.
      // Decode the needed fields rather than cast an unrelated hook payload.
      return Effect.gen(function*(){
        const decoded=yield* Schema.decodeUnknownEffect(Schema.Struct({sessionID:Schema.String,system:Schema.Array(Schema.Unknown)}))(updated)
          .pipe(Effect.orDie);
        const permit=yield* OperationPermitRef;if(!permit)return yield* Effect.die(Error('native_context_permit_required'));
        const result=yield* Effect.tryPromise({try:signal=>options.rpc('native.session-context',{directory:location.directory,
          sessionID:decoded.sessionID,phase:'compaction',permit},{signal}),catch:error=>error}).pipe(Effect.orDie);
        if(!record(result)||typeof result.available!=='boolean')return yield* Effect.die(Error('native_context_result_invalid'));
        if(result.available){
          if(typeof result.text!=='string'||new TextEncoder().encode(result.text).length>12*1024)return yield* Effect.die(Error('native_context_anchor_invalid'));
          // Decode validates this actual array; append to the original in-place
          // hook payload consumed by native request preparation.
          const payload=updated;
          if(!record(payload)||!Array.isArray(payload.system))return yield* Effect.die(Error('native_context_payload_invalid'));
          payload.system.push({type:'text',text:result.text});
        }
      });
    })),
  });
  return {plugin:nativeSessionContextPlugin,executeOwned,decorateHooks,withPrimaryToolExecution};
}
