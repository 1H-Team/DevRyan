import { Effect, Schema } from 'effect';
import { Plugin } from '@opencode/plugin/effect';
import { Tool } from '@opencode/schema/tool';
import type { ExecuteOwned } from './native-admission-contract.js';
import type { RegistrationOrigin } from './registration-origin.js';
import type { ExecutionRpc } from './worker-protocol.js';

export const COUNCIL_PLUGIN_ID = 'devryan.council';
export const councilInputSchema = Schema.Struct({ prompt: Schema.String, preset: Schema.optional(Schema.String) });
export const councilPlugin = Plugin.define({ id: COUNCIL_PLUGIN_ID,
  effect: ({tool}) => tool.transform(editor => editor.add({name:'council_session',input:councilInputSchema,
    description:'Run the prompt independently through the saved ordered Council members and return their collected responses for synthesis. Only prompt and saved preset are inputs; member models come from reviewed configuration. Partial failures retain their managed tasks for explicit collection and recovery.',
    options:{codemode:false},execute:()=>Effect.fail(new Tool.Error({message:'council_host_required'}))})),
});
export function withCouncilExecution(options:{readonly origin:RegistrationOrigin;readonly rpc:ExecutionRpc;readonly executeOwned:ExecuteOwned}):ExecuteOwned {
  if (options.origin.kind!=='plugin'||options.origin.id!==COUNCIL_PLUGIN_ID||!options.origin.capabilities.includes('managed-task')) throw new Error('Reviewed Council origin required');
  return invocation=>{
    if (invocation.provenance.id!==COUNCIL_PLUGIN_ID) return options.executeOwned(invocation);
    if (invocation.toolID!=='council_session'||invocation.provenance.kind!=='plugin'
      ||invocation.provenance.manifestDigest!==options.origin.manifestDigest
      ||JSON.stringify(invocation.provenance.capabilities)!==JSON.stringify(options.origin.capabilities)) return Effect.fail(new Tool.Error({message:'council_origin_mismatch'}));
    return Effect.gen(function*(){
      const input=yield* Schema.decodeUnknownEffect(councilInputSchema)(invocation.input,{onExcessProperty:'error'})
        .pipe(Effect.mapError(error=>new Tool.Error({message:String(error)})));
      yield* invocation.recheckPermit();
      const authorization={operation:'tool.execute',sessionID:invocation.nativeContext.sessionID,messageID:invocation.nativeContext.messageID,
        input:{toolID:invocation.toolID,callID:invocation.nativeContext.id,provenance:invocation.provenance,input:invocation.input}};
      const result=yield* Effect.tryPromise({try:signal=>options.rpc('native.council',{directory:invocation.location.directory,
        sessionID:invocation.nativeContext.sessionID,messageID:invocation.nativeContext.messageID,callID:invocation.nativeContext.id,
        tool:invocation.toolID,input,permit:invocation.existingPermit,authorization},{signal}),
        catch:error=>new Tool.Error({message:error instanceof Error?error.message:'council_failed'})});
      return {content:JSON.stringify(result)};
    });
  };
}
