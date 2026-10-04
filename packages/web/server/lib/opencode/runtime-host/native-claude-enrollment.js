import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes, randomUUID, createHash} from 'node:crypto';
import {userInfo} from 'node:os';
import {claudeKeychainService} from '../claude-credential-projection.js';
import {loadReviewedClaudeCredentials} from './reviewed-claude-host-credentials.js';
import {runNativeClaudeCredentialCommand} from './native-provider-runtime-owner.js';
import {claudeRecordFingerprint, claudeGrantFingerprint} from './native-claude-lifecycle.js';

// Captured Meridian profileCli.ts manual OAuth flow. This does not discover a
// CLI, import an existing account, or execute a model request.
const authorizeURL='https://claude.com/cai/oauth/authorize';
const tokenURL='https://platform.claude.com/v1/oauth/token';
const clientID='9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const redirectURI='https://platform.claude.com/oauth/code/callback';
const scopes=['org:create_api_key','user:profile','user:inference','user:sessions:claude_code','user:mcp_servers','user:file_upload'];
const fail=(code,status=409)=>Object.assign(new Error(code),{code,status});
const finite=value=>typeof value==='string'&&value.length>0&&value.length<=60000;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));

async function readTokenResponse(response,signal){
 if(!response.ok){await response.body?.cancel();throw fail('native_claude_enrollment_exchange_failed');}
 const reader=response.body?.getReader();if(!reader)throw fail('native_claude_enrollment_exchange_failed');
 const chunks=[];let length=0;
 try{for(;;){const part=await reader.read();signal.throwIfAborted();if(part.done)break;length+=part.value.byteLength;if(length>65536)throw fail('native_claude_enrollment_exchange_failed');chunks.push(part.value);}}
 finally{try{await reader.cancel();}finally{reader.releaseLock();}}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail('native_claude_enrollment_exchange_failed');}
}

/** Only this completed, freshly issued code exchange can publish enrollment
 * authority. Neither a service name nor an imported credential is a receipt. */
export function createNativeClaudeEnrollmentOwner({controlRoot,home,asset,lifecycle,withMutationQueue,captureBinding,recheckBinding,publishProfile,beforeEnrollment,
 loadModule=()=>loadReviewedClaudeCredentials(asset),fetchImpl=globalThis.fetch,execute=runNativeClaudeCredentialCommand,account=userInfo().username,now=Date.now}){
 if(!path.isAbsolute(controlRoot??'')||!path.isAbsolute(home??'')||[withMutationQueue,captureBinding,recheckBinding,publishProfile].some(fn=>typeof fn!=='function')
  ||typeof lifecycle?.read!=='function'||typeof lifecycle?.transition!=='function')throw fail('native_claude_enrollment_owner_required',503);
 const root=path.join(controlRoot,'claude-enrollments'),pending=new Map(),work=new Set();let closed=false;
 const live=()=>{if(closed)throw fail('native_claude_enrollment_closed',503);};
 const guarded=(action)=>{live();const operation=withMutationQueue(action);work.add(operation);void operation.finally(()=>work.delete(operation)).catch(()=>{});return operation;};
 const check=async(item,context)=>{live();if(now()>item.deadline)throw fail('native_claude_enrollment_expired');await recheckBinding(item.binding,context);live();};
 const storeFor=async(item,context,signal)=>{
  await check(item,context);const module=await loadModule();await check(item,context);
  return module.createPlatformCredentialStore({serviceName:item.service,execFile:async(file,args,options)=>{
   await check(item,context);signal?.throwIfAborted();
   // The original store serializes the credential. First enrollment is an
   // exclusive add, never its ordinary update (-U), including the probe race.
   if(args[0]==='add-generic-password'){
    if(file!=='/usr/bin/security'||args.length!==8||args[1]!=='-U'||args[2]!=='-s'||args[3]!==item.service||args[4]!=='-a'||args[5]!==account||args[6]!=='-w'
      ||args.filter(value=>value==='-U').length!==1||item.status!=='exchanging')throw fail('native_claude_enrollment_store_unavailable');
    args=[args[0],...args.slice(2)];
   }
   const result=await execute(file,args,{...options,...signal?{signal}:{}});await check(item,context);return result;
  }});
 };
 const unused=async(item,context,signal)=>{
  await check(item,context);
  try{await execute('/usr/bin/security',['find-generic-password','-s',item.service,'-a',account],{timeout:5000,signal});}
  catch(error){await check(item,context);signal?.throwIfAborted();if(error?.code===44)return;throw fail('native_claude_enrollment_store_unavailable');}
  throw fail('native_claude_enrollment_collision');
 };
 const get=id=>{const item=pending.get(id);if(!item)throw fail('native_claude_enrollment_unknown',404);return item;};
 const privateRoot=async()=>{
  const stat=await fs.lstat(root);
  if(await fs.realpath(controlRoot)!==controlRoot||await fs.realpath(root)!==root||!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700||stat.uid!==process.getuid?.())throw fail('native_claude_enrollment_root_invalid');
 };
 const ownedDirectory=async(row)=>{
  await privateRoot();
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.enrollmentID)||row.configDirectory!==path.join(root,row.enrollmentID)
   ||row.profileID!==`devryan-${row.enrollmentID}`||row.service!==claudeKeychainService(row.configDirectory,home)
   ||await fs.realpath(row.configDirectory)!==row.configDirectory)throw fail('native_claude_enrollment_receipt_invalid');
  const stat=await fs.lstat(row.configDirectory);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700||stat.uid!==process.getuid?.())throw fail('native_claude_enrollment_receipt_invalid');
 };
 return {
  list:context=>guarded(async()=>{
   const binding=await captureBinding(context),state=await lifecycle.read();await recheckBinding(binding,context);live();
   const result=[];for(const row of state.accounts){if(row.configDirectory!==path.join(root,row.enrollmentID))continue;await ownedDirectory(row);result.push({enrollmentID:row.enrollmentID,profileID:row.profileID,status:'enrolled'});}
   await recheckBinding(binding,context);live();return result;
  }),
  begin:context=>guarded(async()=>{
   for(const [id,item]of pending)if(now()>item.deadline)pending.delete(id);
   if(pending.size>=16)throw fail('native_claude_enrollment_capacity');
   const binding=await captureBinding(context);live();
   if(await fs.realpath(controlRoot)!==controlRoot)throw fail('native_claude_enrollment_root_invalid');
   await fs.mkdir(root,{recursive:true,mode:0o700});await privateRoot();
   const id=randomUUID(),configDirectory=path.join(root,id);await fs.mkdir(configDirectory,{mode:0o700});
   const verifier=randomBytes(32).toString('base64url'),state=randomBytes(32).toString('base64url');
   const item={id,binding,configDirectory,service:claudeKeychainService(configDirectory,home),profileID:`devryan-${id}`,generation:randomUUID(),verifier,state,deadline:now()+600000,status:'pending',cancel:new AbortController()};
   await beforeEnrollment?.({recheck:()=>check(item,context),signal:item.cancel.signal});await check(item,context);
   await unused(item,context,item.cancel.signal);
   const url=new URL(authorizeURL);for(const [key,value]of Object.entries({code:'true',client_id:clientID,response_type:'code',redirect_uri:redirectURI,scope:scopes.join(' '),code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',state}))url.searchParams.set(key,value);
   pending.set(id,item);return {enrollmentID:id,status:'pending',url:url.toString()};
  }),
  complete:(id,input,context)=>guarded(async()=>{
   const item=get(id);await check(item,context);
   if(item.status!=='pending'||!exact(input,['code','state'])||!finite(input.code)||input.code.length>8192||input.state!==item.state)throw fail('native_claude_enrollment_callback_invalid');
   // Consume once before issuer dispatch; an ambiguous exchange is never retried.
   item.status='exchanging';const signal=AbortSignal.any([item.cancel.signal,AbortSignal.timeout(30000)]);
   try{
    await unused(item,context,signal);await check(item,context);signal.throwIfAborted();
    const response=await fetchImpl(tokenURL,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'authorization_code',client_id:clientID,code:input.code,redirect_uri:redirectURI,code_verifier:item.verifier,state:item.state}),signal});
    const token=await readTokenResponse(response,signal);await check(item,context);signal.throwIfAborted();
    if(!token||typeof token!=='object'||Array.isArray(token)||!finite(token.access_token)||!finite(token.refresh_token)
      ||token.expires_at!==undefined&&!Number.isSafeInteger(token.expires_at)
      ||token.expires_in!==undefined&&(typeof token.expires_in!=='number'||!Number.isFinite(token.expires_in)||token.expires_in<=0)
      ||token.scope!==undefined&&!finite(token.scope))throw fail('native_claude_enrollment_response_invalid');
    const expiresAt=token.expires_at??now()+(token.expires_in??8*60*60)*1000;
    if(!Number.isSafeInteger(expiresAt)||expiresAt<=now()+60000)throw fail('native_claude_enrollment_response_invalid');
    const value={claudeAiOauth:{accessToken:token.access_token,refreshToken:token.refresh_token,expiresAt,scopes:token.scope?.split(' ').filter(Boolean)??scopes}};
    await beforeEnrollment?.({recheck:()=>check(item,context),signal});await check(item,context);signal.throwIfAborted();
    await ownedDirectory({...item,enrollmentID:id});
    const store=await storeFor(item,context,signal);await unused(item,context,signal);await check(item,context);
    const prior=await lifecycle.read();await check(item,context);
    const enrollment={profileID:item.profileID,service:item.service,configDirectory:item.configDirectory,enrollmentID:id,generation:item.generation,grantFingerprint:claudeGrantFingerprint(token.refresh_token),recordFingerprint:claudeRecordFingerprint(value)};
    if(prior.accounts.some(row=>row.grantFingerprint===enrollment.grantFingerprint)||prior.unresolved.some(row=>row.grantFingerprint===enrollment.grantFingerprint||row.replacementGrantFingerprint===enrollment.grantFingerprint))throw fail('native_claude_enrollment_collision');
    if(!await store.write(value)||claudeRecordFingerprint(await store.read())!==enrollment.recordFingerprint)throw fail('native_claude_enrollment_persistence_failed');
    await check(item,context);await ownedDirectory(enrollment);signal.throwIfAborted();
    const state=await lifecycle.transition(prior.revision,{kind:'enroll',account:enrollment});await check(item,context);
    if(!state.accounts.some(row=>Object.keys(enrollment).every(key=>row[key]===enrollment[key])))throw fail('native_claude_enrollment_receipt_invalid');
    item.status='enrolled';item.enrollment=enrollment;delete item.verifier;delete item.state;
    return {enrollmentID:id,status:'enrolled',profileID:item.profileID};
   }catch(error){item.status='failed';delete item.verifier;delete item.state;if(closed)throw fail('native_claude_enrollment_closed',503);throw /^native_claude_enrollment_[a-z_]+$/.test(error?.code??'')?error:fail(error?.status===403?'native_claude_enrollment_refused':'native_claude_enrollment_failed',error?.status===403?403:409);}
  }),
  select:(id,context)=>guarded(async()=>{
   // Selection is a new authorized mutation, including after host restart or
   // another configuration change. Pending OAuth state is never its authority.
   const binding=await captureBinding(context),snapshot=await lifecycle.read();await recheckBinding(binding,context);live();
   const row=snapshot.accounts.find(row=>row.enrollmentID===id);if(!row)throw fail('native_claude_enrollment_unknown',404);await ownedDirectory(row);
   const item={id,binding,configDirectory:row.configDirectory,service:row.service,profileID:row.profileID,generation:row.generation,deadline:now()+600000,status:'enrolled',cancel:new AbortController()};pending.set(id,item);
   await check(item,context);if(item.status!=='enrolled')throw fail('native_claude_enrollment_not_ready');
   const state=await lifecycle.read(),enrollment=state.accounts.find(row=>row.enrollmentID===id);await check(item,context);
   if(!enrollment||['profileID','service','configDirectory','enrollmentID','generation'].some(key=>enrollment[key]!==({...item,enrollmentID:id})[key]))throw fail('native_claude_enrollment_receipt_invalid');
   const store=await storeFor(item,context,item.cancel.signal);if(claudeRecordFingerprint(await store.read())!==enrollment.recordFingerprint)throw fail('native_claude_enrollment_account_changed');
   await check(item,context);await publishProfile({id:item.profileID,type:'claude-max',claudeConfigDir:item.configDirectory,keychainService:item.service},item.binding,context);
   item.status='selected';return {enrollmentID:id,status:'selected',profileID:item.profileID};
  }),
  close:async()=>{closed=true;for(const item of pending.values())item.cancel.abort();await Promise.allSettled([...work]);pending.clear();},
 };
}
