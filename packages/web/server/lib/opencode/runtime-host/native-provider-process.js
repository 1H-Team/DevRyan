import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import {prepareSupervisedController} from './native-process.js';
import {parseProviderBoot,parseProviderBound,parseProviderCommand,parseProviderCredentialRequest,parseProviderCredentialResult,NATIVE_CLAUDE_CREDENTIAL_ERRORS} from './native-provider-worker-protocol.js';
import {startParentDeathWatchdog} from '../parent-death-watchdog.js';
import {registerManagedOpenCodeProcess,unregisterManagedOpenCodeProcess,reapOrphanedManagedOpenCodeProcesses} from '../managed-process-registry.js';
const fail=code=>Object.assign(new Error(code),{code,status:503});
/** Finite private worker commands run under the same accepted launcher and nonce ownership as the controller. */
export async function createNativeProviderProcess({binary,cwd,environment,boot:input,databasePath,supervisor,timeoutMs=30000,onExit,resolveCredential}){
  const boot=parseProviderBoot(input);
  if(!path.isAbsolute(binary??'')||!path.isAbsolute(cwd??'')||!path.isAbsolute(databasePath??'')||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>300000||!(await fs.stat(binary)).isFile())throw fail('native_provider_launch_invalid');
  const registry={registryPath:path.join(boot.globals.state,'managed-native-provider-processes.json')};
  const previous=await reapOrphanedManagedOpenCodeProcesses(registry);
  if(previous.kept.length||previous.reaped.some(row=>!row.terminated))throw fail('native_provider_owner_unsettled');
  const prepared=await prepareSupervisedController({...boot,databasePath},supervisor);
  const child=spawn(supervisor.launcher,[...prepared.arguments,binary,'--provider-worker','--native-instance',boot.instanceID],{cwd,env:{...environment,DEVRYAN_EXECUTION_WORKER:'1',DEVRYAN_EXECUTION_CWD:cwd,DYLD_INSERT_LIBRARIES:`${supervisor.launcher}-spawn.dylib`},stdio:['pipe','pipe','pipe'],detached:true});
  const credentialAbort=new AbortController();
  const decoder=new StringDecoder('utf8'),pending=new Map(),credentialWork=new Map();let buffer='',bound,stopped=false,fatal,closeWork;
  let resolveBound,rejectBound,resolveExit,rejectExit;
  const binding=new Promise((resolve,reject)=>{resolveBound=resolve;rejectBound=reject;});void binding.catch(()=>{});
  const exited=new Promise((resolve,reject)=>{resolveExit=resolve;rejectExit=reject;});void exited.catch(()=>{});
  const terminate=()=>{if(!stopped)child.kill('SIGTERM');return exited;};
  const failed=cause=>{fatal??=cause;credentialAbort.abort(fail('native_provider_owner_expired'));rejectBound(fatal);for(const item of pending.values())item.reject(fatal);pending.clear();void terminate().catch(()=>{});};
  child.on('error',failed);child.stdin.on('error',failed);
  const watchdog=startParentDeathWatchdog({childPid:child.pid,providerInstanceID:boot.instanceID});
  let stderrBytes=0;child.stderr.on('data',chunk=>{stderrBytes+=chunk.byteLength;});
  child.on('exit',()=>watchdog.dispose());
  child.on('close',(code,signal)=>{stopped=true;watchdog.dispose();failed(fail('native_provider_exited'));void(async()=>{
    const stat=await fs.lstat(prepared.receiptPath);
    if(!stat.isFile()||stat.size>1024)throw fail('native_provider_termination_unconfirmed');
    const receipt=JSON.parse(await fs.readFile(prepared.receiptPath,'utf8'));
    if(receipt.terminated!==true||receipt.confined!==true||receipt.exitCode!==code||typeof receipt.cancelled!=='boolean'||signal!==null)throw fail('native_provider_termination_unconfirmed');
    if(child.pid)unregisterManagedOpenCodeProcess(child.pid,registry);
    await fs.rm(prepared.profile);
    await Promise.allSettled(credentialWork.values());
    const result={pid:child.pid,instanceID:boot.instanceID,code,signal,receipt:{path:prepared.receiptPath,...receipt},stderrBytes};
    await onExit?.(result);resolveExit(result);
  })().catch(rejectExit);});
  child.stdout.on('data',chunk=>{if(fatal)return;try{
    buffer+=decoder.write(chunk);if(Buffer.byteLength(buffer)>65536)throw fail('native_provider_protocol_overflow');let newline;
    while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);const reply=JSON.parse(line);
      if(reply.type==='provider-bound'){if(bound)throw fail('native_provider_duplicate_bind');bound=parseProviderBound(reply);if(bound.instanceID!==boot.instanceID||bound.buildId!==boot.buildId)throw fail('native_provider_identity_mismatch');resolveBound(bound);continue;}
      if(reply.type==='credential-request'){
        if(!bound||!resolveCredential||credentialWork.size>=64||credentialWork.has(reply.id))throw fail('native_provider_response_uncorrelated');
        const request=parseProviderCredentialRequest(reply);
        const work=(async()=>{
          let response;try{const result=parseProviderCredentialResult(await resolveCredential(request,{signal:credentialAbort.signal}));if(result.profileID!==request.profileID)throw fail('native_claude_profile_unreviewed');response={protocol:1,id:request.id,action:'credential-reply',ok:true,result};}
          catch(error){response={protocol:1,id:request.id,action:'credential-reply',ok:false,error:{code:NATIVE_CLAUDE_CREDENTIAL_ERRORS.includes(error?.code)?error.code:'native_claude_credential_failed'}};}
          if(!stopped&&!fatal)child.stdin.write(JSON.stringify(response)+'\n',error=>{if(error)failed(error);});
        })();credentialWork.set(request.id,work);void work.finally(()=>credentialWork.delete(request.id)).catch(failed);continue;
      }
      const request=pending.get(reply.id);
      if(!bound||!request||reply.protocol!==1||typeof reply.ok!=='boolean'||Object.keys(reply).some(key=>!['protocol','id','ok','result','error'].includes(key)))throw fail('native_provider_response_uncorrelated');
      pending.delete(reply.id);if(reply.ok){if(request.action!=='health'?reply.result!==null:reply.result?.health!=='healthy'&&reply.result?.health!=='degraded')throw fail('native_provider_result_invalid');request.resolve(reply.result);}else request.reject(fail(typeof reply.error?.code==='string'&&/^[a-z][a-z0-9_]{0,95}$/.test(reply.error.code)?reply.error.code:'native_provider_command_failed'));
    }
  }catch(cause){failed(cause);}});
  const deadline=async(work,code)=>{let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>{const error=fail(code);failed(error);reject(error);},timeoutMs);})]);}finally{clearTimeout(timer);}};
  let commands=Promise.resolve();
  const dispatch=async(action,input={})=>{
    if(fatal||stopped||!bound||pending.size)throw fatal??fail('native_provider_unavailable');
    const command=parseProviderCommand({protocol:1,id:randomUUID(),action,...input});
    return deadline(new Promise((resolve,reject)=>{pending.set(command.id,{resolve,reject,action});child.stdin.write(JSON.stringify(command)+'\n',error=>{if(error)failed(error);});}),'native_provider_command_timeout');
  };
  const call=(action,input)=>{const work=commands.then(()=>dispatch(action,input));commands=work.then(()=>undefined,()=>undefined);return work;};
  try{
    if(watchdog.error)throw fail(watchdog.error.code);
    if(child.pid)registerManagedOpenCodeProcess({childPid:child.pid,binary,providerInstanceID:boot.instanceID,ownerPid:process.pid,workingDirectory:cwd,hostRuntime:'web',hostname:'127.0.0.1'},registry);
    child.stdin.write(JSON.stringify(boot)+'\n',error=>{if(error)failed(error);});
    await deadline(binding,'native_provider_boot_timeout');
  }catch(error){try{await terminate();}catch(cleanup){throw new AggregateError([error,cleanup],'native_provider_launch_unsettled');}throw error;}
  return {bound,pid:child.pid,health:()=>call('health'),authorizeAttempt:input=>call('authorize-attempt',input),releaseAttempt:input=>call('release-attempt',input),killAndWaitForExit:terminate,
    close:()=>closeWork??=(async()=>{try{await call('close');child.stdin.end();const result=await deadline(exited,'native_provider_exit_unconfirmed');if(result.code!==0||result.signal)throw fail('native_provider_close_unconfirmed');return result;}catch(error){await terminate();throw error;}})()};
}
