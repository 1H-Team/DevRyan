import {execFile as nodeExecFile} from 'node:child_process';
// execFile's abort callback may precede close. Keep the credential queue until
// the exact spawned child closes; timeout and request cancellation use SIGKILL.
export function runNativeClaudeCredentialCommand(file,args,options){
 return new Promise((resolve,reject)=>{
  const {signal,...configuration}=options;
  if(signal?.aborted){reject(signal.reason);return;}
  let outcome;
  const child=nodeExecFile(file,args,{...configuration,timeout:5000,killSignal:'SIGKILL'},(error,stdout)=>{outcome={error,stdout};});
  const abort=()=>{child.kill('SIGKILL');};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  child.once('close',()=>{signal?.removeEventListener('abort',abort);if(signal?.aborted)reject(signal.reason);else if(outcome?.error)reject(outcome.error);else if(outcome)resolve({stdout:outcome.stdout});else reject(Object.assign(new Error('claude_credentials_unreadable'),{code:'claude_credentials_unreadable'}));});
 });
}
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {createNativeProviderProcess} from './native-provider-process.js';
import {credentialMutationFingerprint} from './native-credential-mutation-owner.js';
import {loadReviewedClaudeCredentials} from './reviewed-claude-host-credentials.js';
import {claudeKeychainService} from '../claude-credential-projection.js';
import {fetchSelectedClaudeQuota} from './native-claude-inspection.js';
import {emptyClaudeLifecycle,parseClaudeLifecycle,transitionClaudeLifecycle,claudeRecordFingerprint,claudeGrantFingerprint,hasLegacyClaudeFence,sameClaudeEnrollment} from './native-claude-lifecycle.js';
const fail=(code,status=403)=>Object.assign(new Error(code),{code,status,statusCode:status});
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
/** Called under the existing credential mutation queue by fresh enrollment only.
 * Adopt fences from configured services without rewriting their vendor records. */
export async function migrateNativeClaudeLegacyFences({profiles,home,asset,lifecycle,loadModule=()=>loadReviewedClaudeCredentials(asset),backend={}},{recheck,signal}){
 if(!lifecycle||['read','transition'].some(key=>typeof lifecycle[key]!=='function')||typeof recheck!=='function')throw fail('native_claude_lifecycle_owner_required',503);
 const check=async()=>{await recheck();signal?.throwIfAborted();};await check();
 let module,state,observed=0,adopted=0;
 for(const profile of profiles.length?profiles:[{id:'default',type:'claude-max'}]){
  if(profile.type&&profile.type!=='claude-max'||profile.oauthToken||profile.apiKey)continue;
  const configDirectory=profile.claudeConfigDir??path.join(home,'.claude');
  const service=profile.keychainService??claudeKeychainService(configDirectory,home);
  module??=await loadModule();await check();let commandFailure;
  const execute=async(file,args,options)=>{
   await check();
   try{const result=await (backend.execFile??runNativeClaudeCredentialCommand)(file,args,{...options,timeout:5000,killSignal:'SIGKILL',...signal?{signal}:{}});await check();return result;}
   catch(error){commandFailure=error;throw error;}
  };
  const current=await module.createPlatformCredentialStore({...backend,serviceName:service,execFile:execute}).read();await check();
  if(commandFailure){if(commandFailure.code===44)continue;throw fail('claude_credentials_unreadable',401);}
  if(!current)throw fail('claude_credentials_unreadable',401);
  if(!hasLegacyClaudeFence(current))continue;
  observed++;const grantFingerprint=claudeGrantFingerprint(current.claudeAiOauth?.refreshToken);
  state??=parseClaudeLifecycle(await lifecycle.read());await check();
  if(state.unresolved.some(row=>row.grantFingerprint===grantFingerprint||row.replacementGrantFingerprint===grantFingerprint))continue;
  const binding={profileID:profile.id,service,configDirectory};
  const account={...binding,enrollmentID:'legacy-'+claudeRecordFingerprint(binding),generation:current.devryanRefreshBlock.generation,
   grantFingerprint,recordFingerprint:claudeRecordFingerprint(current)};
  const operation={kind:'block-legacy',account,attemptID:'legacy-'+grantFingerprint};
  const expected=transitionClaudeLifecycle(state,state.revision,operation);await check();
  const saved=parseClaudeLifecycle(await lifecycle.transition(state.revision,operation));
  if(claudeRecordFingerprint(saved)!==claudeRecordFingerprint(expected))throw fail('native_claude_lifecycle_unverified',503);
  state=saved;adopted++;await check();
 }
 await check();return {observed,adopted};
}
/** Only a fresh-enrollment receipt in the original native KV authorizes renewal.
 * Shared CLI profiles keep their exact selected service and are access-only. */
export function createNativeClaudeCredentialOwner({profiles,home,withMutationQueue,asset,loadModule=()=>loadReviewedClaudeCredentials(asset),backend={},policy='renew',lifecycle,oauthTokenExpiries={},now=Date.now}){
 if(!['renew','access-only'].includes(policy)||typeof withMutationQueue!=='function'
  ||lifecycle&&['read','transition'].some(key=>typeof lifecycle[key]!=='function'))throw fail('native_claude_credential_owner_required',503);
 const accounts=new Map(structuredClone(profiles.length?profiles:[{id:'default',type:'claude-max'}]).map(profile=>[profile.id,profile]));let moduleWork;
 const access=value=>{
  const oauth=value?.claudeAiOauth;
  if(typeof oauth?.accessToken!=='string'||!oauth.accessToken||oauth.accessToken.length>60000||!Number.isSafeInteger(oauth.expiresAt))throw fail('claude_credentials_unreadable',401);
  return {accessToken:oauth.accessToken,expiresAt:oauth.expiresAt,fingerprint:credentialMutationFingerprint(oauth.accessToken)};
 };
 const enrollment=row=>({profileID:row.profileID,service:row.service,configDirectory:row.configDirectory,enrollmentID:row.enrollmentID,generation:row.generation});
 return (input,{recheck,signal,retried,readOnly=false},consume=async value=>value)=>withMutationQueue(async()=>{
  const check=async()=>{await recheck();signal?.throwIfAborted();};await check();
  const profile=accounts.get(input.profileID);
  if(profile?.type==='oauth-token'&&profile.credentialPolicy==='access-only'){
   const token=profile.oauthToken,expiresAt=oauthTokenExpiries[profile.id];
   if(typeof token!=='string'||!token||token.length>60000)throw fail('claude_credentials_missing',401);
   if(!Number.isSafeInteger(expiresAt)||expiresAt<=now()+60000||input.purpose==='authentication-retry')throw fail('claude_credentials_expired',401);
   const result=await consume({profileID:profile.id,accessToken:token,expiresAt,fingerprint:credentialMutationFingerprint(token)});
   await check();if(expiresAt<=now()+60000)throw fail('claude_credentials_expired',401);return result;
  }
  if(!profile||profile.type&&profile.type!=='claude-max'||profile.oauthToken||profile.apiKey)throw fail('native_claude_profile_unreviewed');
  const configDirectory=profile.claudeConfigDir??path.join(home,'.claude');
  const serviceName=profile.keychainService??claudeKeychainService(configDirectory,home);
  moduleWork??=loadModule();const module=await moduleWork;await check();
  let dispatched=false;
  const fetch=async(url,options)=>{await check();dispatched=true;
   const response=await (backend.fetch??globalThis.fetch)(url,{...options,...signal?{signal:options.signal?AbortSignal.any([signal,options.signal]):signal}:{}});
   await check();return response;
  };
  const execute=async(file,args,options)=>{await check();const result=await (backend.execFile??runNativeClaudeCredentialCommand)(file,args,{...options,timeout:5000,killSignal:'SIGKILL',...signal?{signal}:{}});await check();return result;};
  const store=module.createPlatformCredentialStore({...backend,execFile:execute,serviceName,fetch});
  // Settlement reads are authorized by the already-admitted physical operation,
  // not its now-cancelled caller. They never exchange or write a credential.
  const settlementStore=module.createPlatformCredentialStore({...backend,serviceName,execFile:(file,args,options)=>(backend.execFile??runNativeClaudeCredentialCommand)(file,args,{...options,timeout:5000,killSignal:'SIGKILL'})});
  let current=await store.read();await check();if(!current)throw fail('claude_credentials_missing',401);
  const legacyFence=hasLegacyClaudeFence(current);let token=access(current);
  let state=lifecycle?parseClaudeLifecycle(await lifecycle.read()):emptyClaudeLifecycle();await check();
  const currentRefresh=current.claudeAiOauth?.refreshToken;
  if(typeof currentRefresh==='string'&&state.unresolved.some(row=>row.phase==='enrollment-prepared'&&row.grantFingerprint===claudeGrantFingerprint(currentRefresh)))throw fail('native_claude_refresh_unsettled',401);
  const transition=async operation=>{
   if(!lifecycle)throw fail('native_claude_lifecycle_owner_required',503);
   const expected=transitionClaudeLifecycle(state,state.revision,operation);
   const saved=parseClaudeLifecycle(await lifecycle.transition(state.revision,operation));
   if(claudeRecordFingerprint(saved)!==claudeRecordFingerprint(expected))throw fail('native_claude_lifecycle_unverified',503);
   state=saved;return saved;
  };
  let authority=state.accounts.find(row=>row.profileID===profile.id);
  if(authority&&(authority.service!==serviceName||authority.configDirectory!==configDirectory))throw fail('native_claude_account_changed');
  let before=claudeRecordFingerprint(current);
  const grant=()=>claudeGrantFingerprint(current.claudeAiOauth?.refreshToken);
  if(authority){
   const grantFingerprint=grant();
   const pending=state.unresolved.find(row=>row.grantFingerprint===grantFingerprint||row.replacementGrantFingerprint===grantFingerprint||sameClaudeEnrollment(row,authority));
   if(pending){
    if(!readOnly&&pending.phase==='replacement-prepared'&&sameClaudeEnrollment(pending,authority)
     &&pending.replacementRecordFingerprint===before&&pending.replacementGrantFingerprint===grantFingerprint){
     await transition({kind:'settle',binding:enrollment(authority),attemptID:pending.attemptID,recordFingerprint:before});await check();
     authority=state.accounts.find(row=>row.profileID===profile.id);
    }else throw fail('native_claude_refresh_unsettled',401);
   }
   if(authority.recordFingerprint!==before||authority.grantFingerprint!==grantFingerprint)throw fail('native_claude_account_changed');
  }
  const forced=input.purpose==='authentication-retry'&&input.failedFingerprint===token.fingerprint;
  if(input.purpose==='authentication-retry'){
   if(retried.has(profile.id))throw fail('native_claude_retry_exhausted',401);retried.add(profile.id);
  }
  const due=token.expiresAt<=now()+300000;
  if(forced||due){
   if(readOnly||!authority||policy==='access-only'||legacyFence){
    if(forced||token.expiresAt<=now()+60000)throw fail('claude_credentials_expired',401);
   }else{
    const attemptID=randomUUID(),binding=enrollment(authority);let prepared=false,settled=false,committed=false,begun=false,failure;
    const settleReplacement=async()=>{
     const pending=state.unresolved.find(row=>row.attemptID===attemptID);
     if(!pending||pending.phase!=='replacement-prepared')throw fail('native_claude_refresh_unsettled',401);
     const written=await settlementStore.read();
     if(!written||hasLegacyClaudeFence(written)||claudeRecordFingerprint(written)!==pending.replacementRecordFingerprint
      ||claudeGrantFingerprint(written.claudeAiOauth?.refreshToken)!==pending.replacementGrantFingerprint)throw fail('native_claude_persistence_failed',503);
     access(written);await transition({kind:'settle',binding,attemptID,recordFingerprint:pending.replacementRecordFingerprint});
     current=written;settled=true;committed=true;
    };
    try{
     await check();await transition({kind:'begin',account:authority,attemptID});begun=true;
     await check();
     const guarded={...store,async read(){await check();const value=await store.read();if(!value||claudeRecordFingerprint(value)!==before)throw fail('native_claude_account_changed');return value;},async write(value){
      await check();const issued=access(value);if(hasLegacyClaudeFence(value)||issued.expiresAt<=now()+60000)throw fail('native_claude_refresh_failed',401);
      const recordFingerprint=claudeRecordFingerprint(value),grantFingerprint=claudeGrantFingerprint(value.claudeAiOauth?.refreshToken);
      const original=await store.read();if(!original||claudeRecordFingerprint(original)!==before)throw fail('native_claude_account_changed');
      await check();await transition({kind:'prepare',binding,attemptID,recordFingerprint,grantFingerprint});prepared=true;
      await check();const ok=await store.write(value);if(!ok)return false;
      await settleReplacement();await check();return true;
     }};
     const ok=forced?await module.refreshOAuthToken(guarded):await module.ensureFreshToken(guarded);
     await check();if(!ok||!committed)throw fail('native_claude_refresh_failed',401);
    }catch(error){failure=error;}
    // A dispatch may have consumed its refresh grant. Only a proved non-dispatch
    // or the exact prepared replacement can settle an intent, including on abort.
    try{
     if(!begun&&!dispatched){
      // A lost begin acknowledgement cannot have dispatched an issuer request.
      // Reconcile only this exact durable attempt under its physical owner.
      state=parseClaudeLifecycle(await lifecycle.read());
      const pending=state.unresolved.find(row=>row.attemptID===attemptID);
      if(pending){
       if(pending.phase!=='in-flight'||!sameClaudeEnrollment(pending,authority)||pending.recordFingerprint!==before||pending.grantFingerprint!==authority.grantFingerprint)throw fail('native_claude_refresh_unsettled',401);
       begun=true;
      }
     }
     if(begun&&!dispatched&&!prepared)await transition({kind:'cancel-before-dispatch',binding,attemptID});
     else if(prepared&&!settled)await settleReplacement();
    }catch(error){failure??=error;}
    if(failure)throw failure;
    token=access(current);before=claudeRecordFingerprint(current);
   }
  }
  await check();const verified=await store.read();if(!verified||claudeRecordFingerprint(verified)!==before)throw fail('native_claude_account_changed');
  if(token.expiresAt<=now()+60000)throw fail('claude_credentials_expired',401);
  const result=await consume({profileID:profile.id,...token});
  await check();const after=await store.read();if(!after||claudeRecordFingerprint(after)!==before)throw fail('native_claude_account_changed');
  await check();if(token.expiresAt<=now()+60000)throw fail('claude_credentials_expired',401);return result;
 });
}
/** Existing Cursor execution ownership and an accepted supervised Meridian worker;
 * catalog reads have a separate constructor-owned capability, never an inference permit. */
export function createNativeProviderRuntimeOwner({instanceID,snapshot,registrationOrigin,controller,isReady,withMutationQueue,admissionOwner,cursor,meridian,prepareMeridianProfiles,claudeCredentials,claudeSupported=false,fetchImpl=globalThis.fetch}){
  if(!snapshot||registrationOrigin?.kind!=='plugin'||registrationOrigin.id!=='devryan.provider-compat'||!/^[a-f0-9]{64}$/.test(registrationOrigin.manifestDigest)||typeof withMutationQueue!=='function')throw fail('native_provider_dependencies_required',503);
  const locations=new Map(structuredClone(snapshot.locations).map(location=>[location.directory,location]));let closed=false,worker,starting,closing;const catalogs=new Set();const catalogControllers=new Set();const attempts=new Map();const attemptWork=new Set(),workerStartCancel=new AbortController();
  const credentialProfiles=claudeCredentials?.profiles??meridian?.boot.profiles;
  const resolveClaude=meridian?createNativeClaudeCredentialOwner({...claudeCredentials,profiles:credentialProfiles,home:meridian.boot.globals.home,withMutationQueue}):undefined;
  const inspectClaude=async(input,{recheck,signal}={})=>{
    if(!claudeSupported)throw fail('native_claude_update_required',503);
    live();if(!record(input)||Object.keys(input).some(key=>!['directory','kind'].includes(key))||!locations.has(input.directory)||!['status','quota'].includes(input.kind)||typeof recheck!=='function')throw fail('native_claude_inspection_invalid');
    // Inference owns active/priority/sticky routing. Without an exact selected
    // account receipt, inspection must not choose among several accounts.
    const profiles=credentialProfiles;
    if(!profiles?.length||!resolveClaude)throw fail('claude_credentials_missing',401);
    if(profiles.length!==1)throw fail('native_claude_account_ambiguous',409);
    const profile=profiles[0];
    if(profile.type==='api'||profile.type==='oauth-token'&&profile.credentialPolicy!=='access-only'||profile.oauthToken&&profile.type!=='oauth-token')throw fail('native_claude_profile_unreviewed',409);
    const cancel=new AbortController();catalogControllers.add(cancel);
    const currentSignal=signal?AbortSignal.any([signal,cancel.signal]):cancel.signal;
    const check=async()=>{live();currentSignal.throwIfAborted();await recheck();live();currentSignal.throwIfAborted();};
    const work=resolveClaude({profileID:profile.id,purpose:'request'},{recheck:check,signal:currentSignal,retried:new Set(),readOnly:true},async credential=>{
      await check();
      const result=input.kind==='status'?{installed:true,path:null,loggedIn:true,authStatus:'authenticated',authMethod:'oauth'}:
        await fetchSelectedClaudeQuota({accessToken:credential.accessToken,signal:currentSignal,fetchImpl});
      await check();return result;
    }).catch(async error=>{await check();throw error;});
    catalogs.add(work);void work.finally(()=>{catalogs.delete(work);catalogControllers.delete(cancel);}).catch(()=>{});return work;
  };
  const credentialRequest=async(request,{signal:workerSignal})=>{
    if(!claudeSupported)throw fail('native_claude_update_required',503);
    live();const attempt=attempts.get(request.attemptID);
    if(!attempt||attempt.input.sessionID!==request.sessionID||attempt.input.directory!==request.directory||!resolveClaude)throw fail('native_provider_attempt_expired');
    const signal=attempt.signal?AbortSignal.any([attempt.signal,workerSignal]):workerSignal;
    return resolveClaude(request,{recheck:async()=>{signal.throwIfAborted();await attempt.recheck();signal.throwIfAborted();},signal,retried:attempt.retried});
  };
  const live=()=>{if(closed||!isReady()||controller().instanceID!==instanceID)throw fail('native_provider_owner_expired');};
  const catalogBinding=input=>{
    live();const location=locations.get(input?.directory);
    if(!record(input)||Object.keys(input).some(key=>!['directory','controllerInstanceID','integrationID','acquisitionID','configurationDigest','origin'].includes(key))||!location||input.controllerInstanceID!==instanceID||input.integrationID!=='github-copilot'||typeof input.acquisitionID!=='string'||!input.acquisitionID||input.acquisitionID.length>256||input.configurationDigest!==credentialMutationFingerprint(location.configuration.providers?.['github-copilot']??{})||input.origin?.id!==registrationOrigin.id||input.origin?.manifestDigest!==registrationOrigin.manifestDigest||Object.keys(input.origin).some(key=>!['id','manifestDigest'].includes(key)))throw fail('native_provider_catalog_binding_invalid');
    return input;
  };
  const read=async binding=>{
    live();const selected=await controller().call({action:'provider-catalog-selection-owned',...binding});live();
    if(selected===null||selected===undefined)return undefined;
    if(!record(selected)||selected.controllerInstanceID!==instanceID||selected.directory!==binding.directory||selected.integrationID!=='github-copilot'||selected.acquisitionID!==binding.acquisitionID||selected.configurationDigest!==binding.configurationDigest||!record(selected.credential)||selected.credential.integrationID!=='github-copilot'||typeof selected.credential.id!=='string'||!record(selected.credential.value))throw fail('native_provider_catalog_selection_invalid');
    return selected;
  };
  const catalog=async(input,{signal}={})=>{
    const binding=catalogBinding(input),cancel=new AbortController();catalogControllers.add(cancel);
    const currentSignal=signal?AbortSignal.any([signal,cancel.signal]):cancel.signal;
    const work=withMutationQueue(async()=>{
      catalogBinding(binding);currentSignal.throwIfAborted();const before=await read(binding);if(!before)return null;
      const value=before.credential.value;
      // Native device OAuth stores the durable GitHub token as refresh (expires=0).
      // Access-only expired OAuth cannot be refreshed by a guessed issuer path.
      if(value.type!=='oauth'||value.methodID!=='device')throw fail('native_copilot_method_unsupported');
      const token=typeof value.refresh==='string'&&value.refresh.trim()?value.refresh.trim():typeof value.access==='string'?value.access.trim():'';
      if(!token||(!value.refresh&&(!Number.isSafeInteger(value.expires)||value.expires<=Date.now())))throw fail('native_copilot_refresh_required',401);
      const timeout=AbortSignal.timeout(5000),abort=AbortSignal.any([currentSignal,timeout]);
      const response=await fetchImpl('https://api.githubcopilot.com/models',{method:'GET',redirect:'error',signal:abort,headers:{Authorization:`Bearer ${token}`,Accept:'application/json','User-Agent':'opencode/devryan','X-GitHub-Api-Version':'2026-06-01'}});
      if(!response.ok)throw fail('native_copilot_catalog_fetch_failed',502);
      const chunks=[];let size=0;const reader=response.body?.getReader();if(!reader)throw fail('native_copilot_catalog_invalid',502);
      try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>1024*1024)throw fail('native_copilot_catalog_overflow',502);chunks.push(part.value);}}finally{await reader.cancel();reader.releaseLock();}
      const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!record(payload)||!Array.isArray(payload.data)||payload.data.length>4096)throw fail('native_copilot_catalog_invalid',502);
      catalogBinding(binding);currentSignal.throwIfAborted();const after=await read(binding);
      if(!after||credentialMutationFingerprint(before)!==credentialMutationFingerprint(after))throw fail('native_provider_catalog_selection_changed');
      return payload.data;
    });
    catalogs.add(work);void work.finally(()=>{catalogs.delete(work);catalogControllers.delete(cancel);}).catch(()=>{});return work;
  };
  const startMeridian=async()=>{
    if(!claudeSupported)throw fail('native_claude_update_required',503);
    live();if(!meridian)throw fail('native_meridian_unavailable',503);
    if(worker&&!worker.isFailed())return worker;
    if(!starting)starting=(async()=>{
      if(worker){
        const previous=worker;
        // Retirement shares the launch promise so concurrent callers cannot
        // replace a failed worker twice or bypass its termination receipt.
        await previous.killAndWaitForExit();live();
        if(worker===previous)worker=undefined;
      }
      const profiles=prepareMeridianProfiles?await prepareMeridianProfiles({recheck:async()=>{live();},signal:workerStartCancel.signal}):meridian.boot.profiles;
      live();workerStartCancel.signal.throwIfAborted();
      const result=await createNativeProviderProcess({...meridian,boot:{...meridian.boot,profiles},resolveCredential:credentialRequest});
      try{live();if(result.isFailed())throw fail('native_provider_exited',503);worker=result;return result;}
      catch(error){await result.killAndWaitForExit();throw error;}
    })().finally(()=>{starting=undefined;});
    return starting;
  };
  const withMeridian=(input,action)=>admissionOwner.withProviderAttempt(input,async recheck=>{live();if(!path.isAbsolute(input.directory)||!locations.has(input.directory))throw fail('native_provider_directory_unreviewed');const target=await startMeridian();input.signal?.throwIfAborted();live();const result=await action({origin:target.bound.url,health:target.bound.health,instanceID:target.bound.instanceID,authorization:meridian.boot.requestAuthorization,authorizeAttempt:target.authorizeAttempt,releaseAttempt:target.releaseAttempt,recheck});input.signal?.throwIfAborted();live();return result;});
  const validateAttempt=input=>{
    live();if(!record(input)||Object.keys(input).some(key=>!['directory','controllerInstanceID','sessionID','kind','permit'].includes(key))||input.controllerInstanceID!==instanceID||!locations.has(input.directory)||typeof input.sessionID!=='string'||!['primary','title','compaction','generate'].includes(input.kind))throw fail('native_provider_attempt_invalid');
    return input;
  };
  const beginMeridian=async(input,{signal}={})=>{
    input=validateAttempt(input);let ready,failed,attemptID;const result=new Promise((resolve,reject)=>{ready=resolve;failed=reject;});
    const work=withMeridian({...input,signal},async target=>{
      signal?.throwIfAborted();attemptID=randomBytes(32).toString('hex');let finish;
      const settled=new Promise(resolve=>{finish=resolve;});
      const workerBinding={attemptID,sessionID:input.sessionID,directory:input.directory};await target.authorizeAttempt(workerBinding);
      // Authorization can suspend in the worker. A canceled caller or closed
      // owner must not publish an attempt that nobody can subsequently settle.
      try{signal?.throwIfAborted();live();}catch(error){await target.releaseAttempt(workerBinding);throw error;}
      const attempt={attemptID,input,finish,work:undefined,signal,retried:new Set(),recheck:async()=>{live();signal?.throwIfAborted();await target.recheck();live();if(attempts.get(attemptID)!==attempt)throw fail('native_provider_attempt_expired');},release:()=>target.releaseAttempt(workerBinding)};attempts.set(attemptID,attempt);
      ready({attemptID,controllerInstanceID:instanceID,directory:input.directory,sessionID:input.sessionID,origin:target.origin,authorization:target.authorization});
      const abort=()=>{void attempt.release().finally(finish).catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
      try{await settled;}finally{signal?.removeEventListener('abort',abort);}
    });
    attemptWork.add(work);void work.catch(failed).finally(()=>{attemptWork.delete(work);if(attemptID)attempts.delete(attemptID);}).catch(()=>{});
    const binding=await result;const attempt=attempts.get(binding.attemptID);if(!attempt)throw fail('native_provider_attempt_expired');attempt.work=work;return binding;
  };
  const boundAttempt=input=>{
    if(!record(input)||Object.keys(input).some(key=>!['attemptID','controllerInstanceID','directory','sessionID'].includes(key))||input.controllerInstanceID!==instanceID||typeof input.attemptID!=='string')throw fail('native_provider_attempt_invalid');
    const attempt=attempts.get(input.attemptID);if(!attempt||attempt.input.directory!==input.directory||attempt.input.sessionID!==input.sessionID)throw fail('native_provider_attempt_expired');return attempt;
  };
  const assertMeridian=input=>{const attempt=boundAttempt(input);live();return admissionOwner.withProviderAttempt(attempt.input,async()=>{live();});};
  // Settlement itself must remain callable after holds/revocation. The original
  // withProviderAttempt still checks its caller again before completing.
  const endMeridian=async input=>{const attempt=boundAttempt(input);try{await attempt.release();}finally{attempt.finish();await attempt.work;attempts.delete(input.attemptID);}return null;};
  const cursorPrompt=(input,body)=>admissionOwner.withProviderAttempt(input,async()=>{live();if(!cursor||!locations.has(input.directory))throw fail('native_cursor_unavailable',503);input.signal?.throwIfAborted();const result=await cursor.handlePromptAsync({sessionID:input.sessionID,directory:input.directory,body});input.signal?.throwIfAborted();live();return result;});
  return {catalog,inspectClaude,withMeridian,beginMeridian,assertMeridian,endMeridian,cursorPrompt,abortCursor:async sessionID=>{if(!cursor)throw fail('native_cursor_unavailable',503);return cursor.abortAndWait(sessionID);},
    handleRpc:(method,input,context)=>{if(method==='provider.catalog')return catalog(input,context);if(method==='provider.meridian.begin')return beginMeridian(input,context);if(method==='provider.meridian.assert')return assertMeridian(input);if(method==='provider.meridian.end')return endMeridian(input);throw fail('native_provider_operation_invalid');},
    close:()=>closing??=(async()=>{closed=true;workerStartCancel.abort(fail('native_provider_owner_expired'));for(const cancel of catalogControllers)cancel.abort(fail('native_provider_owner_expired'));await Promise.allSettled([...attempts.values()].map(async attempt=>{try{await attempt.release();}finally{attempt.finish();}}));await Promise.allSettled([...catalogs,...attemptWork]);attempts.clear();let target=worker;try{target??=await starting;}catch{ /* Launch failure already settled its child. */ }if(target){if(target.isFailed())return target.killAndWaitForExit();try{return await target.close();}catch(error){if(!target.isFailed())throw error;return target.killAndWaitForExit();}}})()};
}
