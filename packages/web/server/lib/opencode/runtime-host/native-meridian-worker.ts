import fs from 'node:fs/promises';
import path from 'node:path';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {REVIEWED_CLAUDE_ASSETS,REVIEWED_CLAUDE_STARTUP} from './reviewed-claude-transform.js';
import {parseProviderBoot,parseProviderCommand,parseProviderBound,parseProviderCredentialRequest,parseProviderCredentialReply,parseProviderCredentialResult} from './native-provider-worker-protocol.js';
import type {NativeProviderBoot,NativeMeridianProfile,NativeProviderCredentialRequest,NativeProviderCredentialResult} from './native-provider-worker-protocol.js';
export interface ReviewedClaudeStartup {
  readonly startReviewedProxy:(input:{port:0;profiles:readonly NativeMeridianProfile[];defaultProfile?:string;log:(level:string,message:string)=>void})=>Promise<{port:number;close:()=>Promise<void>}>;
  readonly checkReviewedProxy:(port:number,log:(level:string,message:string)=>void)=>Promise<{ok:boolean;version?:string;message?:string;availability?:'credential-unavailable'}>;
}
const failure=(code:string)=>Object.assign(new Error(code),{code,status:503});
/** The provider's existing stdin/stdout channel carries finite replies, never
 * ambient file/service names or refresh credentials. */
export function createProviderCredentialChannel(write:(value:NativeProviderCredentialRequest)=>void,timeoutMs=30000){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>300000)throw failure('native_provider_protocol_invalid');
 const pending=new Map<string,{profileID:string;resolve:(value:NativeProviderCredentialResult)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();let closed=false;
 const retired=new Map<string,{profileID:string}>();
 const retire=(id:string,entry:NonNullable<ReturnType<typeof pending.get>>,code:string)=>{
  if(pending.get(id)!==entry)return;
  clearTimeout(entry.timer);pending.delete(id);retired.set(id,{profileID:entry.profileID});entry.reject(failure(code));
 };
 return {request(input:Omit<NativeProviderCredentialRequest,'protocol'|'type'|'id'>){
  if(closed||pending.size+retired.size>=64)return Promise.reject(failure('native_claude_credential_failed'));
  const request=parseProviderCredentialRequest({protocol:1,type:'credential-request',id:randomUUID(),...input});
  return new Promise<NativeProviderCredentialResult>((resolve,reject)=>{
   const timer=setTimeout(()=>{const entry=pending.get(request.id);if(entry)retire(request.id,entry,'native_claude_credential_failed');},timeoutMs);
   pending.set(request.id,{profileID:request.profileID,resolve,reject,timer});
   try{write(request);}catch{const entry=pending.get(request.id);if(entry)retire(request.id,entry,'native_claude_credential_failed');}
  });
 },accept(value:unknown){
  const reply=parseProviderCredentialReply(value),entry=pending.get(reply.id),previous=retired.get(reply.id);
  if(!entry&&!previous)throw failure('native_provider_response_uncorrelated');
  if(reply.ok&&reply.result.profileID!==(entry??previous)!.profileID){
   if(entry)retire(reply.id,entry,'native_claude_profile_unreviewed');
   throw failure('native_claude_profile_unreviewed');
  }
  // Timeout settles the caller, not the physical host operation. Keep its
  // correlation slot until one strictly matching reply, then discard tokens.
  if(previous){retired.delete(reply.id);return;}
  if(!entry)throw failure('native_provider_response_uncorrelated');
  pending.delete(reply.id);clearTimeout(entry.timer);
  if(!reply.ok)entry.reject(failure(reply.error.code));else entry.resolve(reply.result);
 },close(){closed=true;for(const [id,entry] of pending)retire(id,entry,'native_provider_owner_expired');}};
}
/** A worker bearer is insufficient on its own: every physical request also
 * requires a current constructor-issued attempt for this exact session/root. */
export function createMeridianRequestAuthority(boot:NativeProviderBoot){
 const attempts=new Map<string,{sessionID:string;directory:string}>();let closed=false;
 const authorize=(request:Request)=>{
  if(closed||request.headers.get('authorization')!=='Bearer '+boot.requestAuthorization)return false;
  const url=new URL(request.url);if(request.method==='GET'&&url.pathname==='/health')return true;
  if(request.method!=='POST'||url.pathname!=='/v1/messages')return false;
  const attempt=attempts.get(request.headers.get('x-devryan-provider-attempt')??'');if(!attempt)return false;
  try{return request.headers.get('x-opencode-session')===attempt.sessionID&&decodeURIComponent(request.headers.get('x-devryan-directory')??'')===attempt.directory&&decodeURIComponent(request.headers.get('x-opencode-directory')??'')===attempt.directory;}catch{return false;}
 };
 return {authorize,binding(request:Request){if(!authorize(request)||request.method!=='POST')throw failure('native_provider_attempt_invalid');const attemptID=request.headers.get('x-devryan-provider-attempt')!;return {attemptID,...attempts.get(attemptID)!};},add(input:{attemptID:string;sessionID:string;directory:string}){
  if(closed||attempts.size>=128||attempts.has(input.attemptID)||!boot.transport.directories.includes(input.directory))throw failure('native_provider_attempt_invalid');attempts.set(input.attemptID,{sessionID:input.sessionID,directory:input.directory});
 },remove(input:{attemptID:string;sessionID:string;directory:string}){
  const current=attempts.get(input.attemptID);if(closed||!current||current.sessionID!==input.sessionID||current.directory!==input.directory)throw failure('native_provider_attempt_invalid');attempts.delete(input.attemptID);
 },close(){closed=true;attempts.clear();}};
}
/** The compiled entry provides the hash-reviewed original startup module, never a runtime import path. */
export async function startNativeMeridianWorker(input:unknown,options:{buildId:string;startup:ReviewedClaudeStartup|(()=>Promise<ReviewedClaudeStartup>);resolveCredential?:(input:Omit<NativeProviderCredentialRequest,'protocol'|'type'|'id'>)=>Promise<NativeProviderCredentialResult>}){
  const boot=parseProviderBoot(input);
  if(boot.buildId!==options.buildId)throw failure('native_provider_build_mismatch');
  const environments={HOME:boot.globals.home,XDG_CONFIG_HOME:boot.globals.config,XDG_DATA_HOME:boot.globals.data,XDG_STATE_HOME:boot.globals.state,XDG_CACHE_HOME:boot.globals.cache,TMPDIR:boot.globals.tmp};
  for(const [name,directory] of Object.entries(environments)){
    if(!process.env[name]||process.env[name]!==directory||await fs.realpath(directory)!==directory||!(await fs.stat(directory)).isDirectory())throw failure('native_provider_environment_mismatch');
  }
  for(const directory of Object.values(boot.globals))if(await fs.realpath(directory)!==directory||!(await fs.stat(directory)).isDirectory())throw failure('native_provider_roots_invalid');
  for(const profile of boot.profiles)if(profile.claudeConfigDir){
    const directory=profile.claudeConfigDir;
    if(![boot.globals.home,boot.globals.config,boot.globals.data].some(root=>directory===root||directory.startsWith(root+path.sep))||await fs.realpath(directory)!==directory||!(await fs.stat(directory)).isDirectory())throw failure('native_provider_profile_escape');
  }
  for(const name of ['claude','libsql'] as const){
    const asset=boot.assets[name],expected=REVIEWED_CLAUDE_ASSETS[name];
    if(path.basename(asset.path)!==expected.path||asset.sha256!==expected.sha256||await fs.realpath(asset.path)!==asset.path||!(await fs.stat(asset.path)).isFile())throw failure('native_provider_asset_unverified');
    const hash=createHash('sha256');for await(const bytes of createReadStream(asset.path))hash.update(bytes);if(hash.digest('hex')!==asset.sha256)throw failure('native_provider_asset_unverified');
  }
  if(await fs.realpath(boot.transport.storage)!==boot.transport.storage||await fs.realpath(boot.transport.launcher)!==boot.transport.launcher)throw failure('native_provider_transport_unverified');
  for(const directory of boot.transport.directories)if(await fs.realpath(directory)!==directory||!(await fs.stat(directory)).isDirectory())throw failure('native_provider_transport_unverified');
  // These exact original helpers otherwise consult ambient listener/profile settings.
  process.env.MERIDIAN_HOST='127.0.0.1';process.env.CLAUDE_PROXY_HOST='127.0.0.1';
  process.env.MERIDIAN_PASSTHROUGH='true';
  process.env.MERIDIAN_CLAUDE_PATH=boot.assets.claude.path;
  process.env.DEVRYAN_PROVIDER_AUTHORIZATION=boot.requestAuthorization;
  process.env.DEVRYAN_EXECUTION_BOUNDARY='1';
  process.env.DEVRYAN_PROVIDER_TRANSPORT=JSON.stringify({protocol:1,instanceID:boot.instanceID,buildId:boot.buildId,asset:boot.assets.claude,profileRoots:[boot.globals.home,boot.globals.config,boot.globals.data],keychainAccounts:boot.profiles.filter(profile=>profile.claudeConfigDir&&profile.keychainService).map(profile=>({directory:profile.claudeConfigDir,keychainService:profile.keychainService})),...boot.transport});
  Object.defineProperty(globalThis,'__DEVRYAN_LIBSQL_ASSET',{value:boot.assets.libsql.path,configurable:true});
  const authority=createMeridianRequestAuthority(boot);
  Object.defineProperty(globalThis,'__DEVRYAN_MERIDIAN_AUTHORIZATION',{value:authority.authorize,configurable:true});
  const credentials=async(request:Request,profileID:string,purpose:'request'|'authentication-retry',failedFingerprint?:string)=>{
    const binding=authority.binding(request);
    const profile=boot.profiles.find(profile=>profile.id===profileID)??(!boot.profiles.length&&profileID==='default'?{id:'default',type:'claude-max' as const}:undefined);
    if(!profile)throw failure('native_claude_profile_unreviewed');
    if(profile.type==='api'||profile.credentialPolicy!=='access-only'&&(profile.type==='oauth-token'||profile.oauthToken))return undefined;
    if(!options.resolveCredential)throw failure('native_claude_credential_owner_required');
    const result=parseProviderCredentialResult(await options.resolveCredential({...binding,profileID,purpose,...failedFingerprint?{failedFingerprint}:{}}));
    authority.binding(request);if(result.profileID!==profileID||result.expiresAt<=Date.now()+60000)throw failure('claude_credentials_expired');return result;
  };
  Object.defineProperty(globalThis,'__DEVRYAN_CLAUDE_CREDENTIAL',{value:credentials,configurable:true});
  const log=()=>{}; // Original messages may include provider content; structured health is retained below.
  let startup:ReviewedClaudeStartup,proxy:Awaited<ReturnType<ReviewedClaudeStartup['startReviewedProxy']>>;
  try{startup=typeof options.startup==='function'?await options.startup():options.startup;
    proxy=await startup.startReviewedProxy({port:0,profiles:boot.profiles,defaultProfile:boot.defaultProfile,log});
  }catch(error){authority.close();if(Reflect.get(globalThis,'__DEVRYAN_CLAUDE_CREDENTIAL')===credentials)Reflect.deleteProperty(globalThis,'__DEVRYAN_CLAUDE_CREDENTIAL');throw error;}
  let closeWork:Promise<void>|undefined;
  const close=()=>closeWork??=(async()=>{authority.close();if(Reflect.get(globalThis,'__DEVRYAN_CLAUDE_CREDENTIAL')===credentials)Reflect.deleteProperty(globalThis,'__DEVRYAN_CLAUDE_CREDENTIAL');await proxy.close();})();
  const health=async()=>{
    const value=await startup.checkReviewedProxy(proxy.port,log);
    if(value.ok!==true||value.version!==REVIEWED_CLAUDE_STARTUP.meridianVersion)throw failure('native_provider_health_failed');
    return value.message===undefined&&value.availability===undefined?'healthy' as const:'degraded' as const;
  };
  try{
    const bound=parseProviderBound({protocol:1,type:'provider-bound',instanceID:boot.instanceID,buildId:boot.buildId,url:`http://127.0.0.1:${proxy.port}`,port:proxy.port,health:await health()});
    return {bound,close,async command(input:unknown){
      const command=parseProviderCommand(input);if(command.action==='close'){await close();return null;}if(closeWork)throw failure('native_provider_closed');
      if(command.action==='credential-reply')throw failure('native_provider_protocol_invalid');
      if(command.action==='authorize-attempt'){
        if(await fs.realpath(command.directory)!==command.directory)throw failure('native_provider_attempt_invalid');
        authority.add(command);return null;
      }
      if(command.action==='release-attempt'){
        authority.remove(command);return null;
      }
      return {health:await health()};
    }};
  }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'native_provider_startup_cleanup_failed');}throw error;}
}
