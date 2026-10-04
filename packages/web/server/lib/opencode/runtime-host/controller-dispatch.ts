import type { NativeProcessCommand } from './native-process-protocol.js';
import { NATIVE_PROCESS_LIMITS } from './native-process-protocol.js';

/** Correlation is concurrent; a settlement RPC must never queue behind close. */
export function createNativeCommandDispatcher(options:{ readonly run:(command:NativeProcessCommand)=>Promise<unknown>;
  readonly closeStartup:()=>void;readonly respond:(id:string,result:{ok:true;result:unknown}|{ok:false;error:{code:string;status:number;message:string}})=>void }) {
  const active = new Map<string,Promise<void>>();
  let closing = false;
  const fail=(id:string,code:string,status:number)=>options.respond(id,{ok:false,error:{code,status,message:code}});
  return {
    dispatch(command:NativeProcessCommand) {
      if(active.has(command.id)) { fail(command.id,'native_command_duplicate',409);return; }
      if(active.size>=NATIVE_PROCESS_LIMITS.inFlight) { fail(command.id,'native_command_capacity',503);return; }
      if(closing && ['open','open-recovery','release','recover-shell-owned','remove-leaf-owned','openai-cas-selected-owned','credential-commit-owned','credential-operation-owned','claude-lifecycle-read-owned','claude-lifecycle-transition-owned'].includes(command.action)) {fail(command.id,'native_controller_stopping',409);return;}
      if(command.action==='close') closing=true;
      if(['close','quiesce','close-startup'].includes(command.action)) options.closeStartup();
      const task=Promise.resolve().then(()=>options.run(command)).then(result=>options.respond(command.id,{ok:true,result}),error=>{
        const code = error && typeof error==='object' && 'code' in error && typeof error.code==='string' && /^[a-z][a-z0-9_]{0,95}$/.test(error.code) ? error.code : 'native_control_failed';
        const status = error && typeof error==='object' && 'status' in error && typeof error.status==='number' && Number.isInteger(error.status) && error.status>=400 && error.status<=599 ? error.status : 503;
        // Wire errors contain identifiers, never arbitrary native payloads/tokens.
        fail(command.id,code,status);
      }).finally(()=>active.delete(command.id));
      active.set(command.id,task);
    },
    drain:async()=>{await Promise.all([...active.values()]);},
  };
}
