import path from 'node:path';
import type {ChildProcess,SpawnOptions} from 'node:child_process';
export type NativeBrowserSpawn=(command:string,args:readonly string[],options:SpawnOptions)=>ChildProcess;
export interface NativeBrowserStep {readonly command:string;readonly args?:readonly string[];readonly selector?:string;readonly styles?:readonly string[];readonly attributes?:readonly string[]}
export interface NativeBrowserInput extends NativeBrowserStep {readonly steps?:readonly NativeBrowserStep[];readonly timeout_ms?:number}
export interface NativeBrowserContext {readonly sessionID:string;readonly messageID:string;readonly directory:string;readonly agent?:string;readonly abort:AbortSignal}
export interface NativeBrowserScope {readonly opencodeSessionID:string;readonly messageID:string;readonly directory:string;readonly agent:string|null}
export interface NativeBrowserEnvironment {readonly leasesUrl:string;readonly token:string;readonly binaryPath:string;readonly configPath:string;readonly installRoot:string;readonly screenshotDirectory:string|null;readonly ffmpegDirectory:string|null}
export interface NativeBrowserLaunch {readonly binaryPath:string;readonly args:readonly string[];readonly timeoutMs:number;readonly signal:AbortSignal;readonly sensitiveValues:readonly string[];readonly cwd:string;readonly screenshotDirectory:string|null;readonly errorCode?:string;readonly callerEval?:boolean}
export interface NativeBrowserLeaseRequest {readonly url:string;readonly method:'POST'|'DELETE';readonly body:NativeBrowserScope;readonly signal:AbortSignal;readonly errorCode:string}
export interface NativeBrowserOwners {
 readonly assertCurrent:()=>Promise<void>;
 /** Resolve exact current canonical assistant -> parent user; never transcript metadata supplied by a plugin. */
 readonly resolveTurn:(scope:NativeBrowserScope)=>Promise<string>;
 readonly lease:(operation:'resolve'|'acquire'|'touch'|'release',input:{readonly scope:NativeBrowserScope;readonly leaseID?:string;readonly signal:AbortSignal})=>Promise<unknown>;
 /** Must run original runReviewedBrowserBinary in the existing confined supervisor and settle before resolving. */
 readonly runBinary:(request:NativeBrowserLaunch)=>Promise<string>;
}
export interface NativeBrowserDefinition {readonly description:string;readonly args:Readonly<Record<string,{readonly parse:(input:unknown)=>unknown}>>;readonly execute:(input:NativeBrowserInput,context:NativeBrowserContext)=>Promise<string>}
export interface NativeBrowserOriginals {
 readonly DevRyanBrowserPlugin:(input:Readonly<Record<string,unknown>>)=>Promise<{readonly tool:{readonly devryan_browser:NativeBrowserDefinition}}>;
 readonly withReviewedBrowserOwner:<T>(owner:{readonly environment:NativeBrowserEnvironment;readonly resolveTurn:NativeBrowserOwners['resolveTurn'];readonly requestLease:(request:NativeBrowserLeaseRequest)=>Promise<unknown>;readonly runBinary:NativeBrowserOwners['runBinary']},action:()=>Promise<T>)=>Promise<T>;
}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
/** The exact production tool state machine, using the existing private lease and supervised launcher owners. */
export async function createOwnedNativeBrowser(options:{readonly originals:NativeBrowserOriginals;readonly environment:NativeBrowserEnvironment;readonly ownersFor:(context:NativeBrowserContext)=>Promise<NativeBrowserOwners>}):Promise<NativeBrowserDefinition>{
 const environment=structuredClone(options.environment);
 if(environment.leasesUrl!=='devryan://private-browser/leases'||environment.token!==''
  ||[environment.binaryPath,environment.configPath,environment.installRoot].some(value=>!path.isAbsolute(value)||value.includes('\0'))
  ||[environment.screenshotDirectory,environment.ffmpegDirectory].some(value=>value!==null&&(!path.isAbsolute(value)||value.includes('\0'))))throw new Error('native_browser_environment_invalid');
 const unavailable=async():Promise<never>=>{throw new Error('native_browser_invocation_required');};
 const plugin=await options.originals.withReviewedBrowserOwner({environment,resolveTurn:unavailable,requestLease:unavailable,runBinary:unavailable},()=>options.originals.DevRyanBrowserPlugin({client:null}));
 const original=plugin.tool.devryan_browser;
 return {...original,execute:async(input,context)=>{
  if(!record(input)||Object.keys(input).some(key=>!Object.hasOwn(original.args,key)))throw new Error('native_browser_input_invalid');
  for(const [key,schema]of Object.entries(original.args))schema.parse(input[key]);
  if(!context.sessionID||!context.messageID||!path.isAbsolute(context.directory)||!(context.abort instanceof AbortSignal))throw new Error('native_browser_context_invalid');
  context.abort.throwIfAborted();const owner=await options.ownersFor(context);let turn:string|undefined;
  const check=async(signal?:AbortSignal)=>{signal?.throwIfAborted();await owner.assertCurrent();signal?.throwIfAborted();};
  const scope=(request:NativeBrowserScope,canonical:boolean)=>{
   if(request.opencodeSessionID!==context.sessionID||request.directory!==context.directory||request.agent!==(context.agent?.trim()||null)
    ||request.messageID!==(canonical?turn:context.messageID))throw new Error('native_browser_scope_mismatch');
  };
  const pending=new Set<Promise<unknown>>();
  const track=<T>(action:()=>Promise<T>):Promise<T>=>{
   const promise=action();pending.add(promise);void promise.then(()=>pending.delete(promise),()=>pending.delete(promise));return promise;
  };
  await check(context.abort);
  try{
   const content=await options.originals.withReviewedBrowserOwner({environment,
    resolveTurn:request=>track(async()=>{scope(request,false);await check(context.abort);const resolved=await owner.resolveTurn(request);if(!resolved||resolved.includes('\0'))throw new Error('native_browser_turn_invalid');await check(context.abort);turn=resolved;return resolved;}),
    requestLease:request=>track(async()=>{
     scope(request.body,true);await check(request.signal);
     const suffix=request.url.slice(environment.leasesUrl.length);
     if(!request.url.startsWith(environment.leasesUrl))throw new Error('native_browser_lease_invalid');
     let operation:'resolve'|'acquire'|'touch'|'release';let leaseID:string|undefined;
     if(request.method==='POST'&&suffix==='')operation='acquire';
     else if(request.method==='POST'&&suffix==='/resolve')operation='resolve';
     else{
      const match=/^\/([^/]+)(\/touch)?$/.exec(suffix);
      if(!match||request.method==='POST'&&match[2]!=='/touch'||request.method==='DELETE'&&match[2])throw new Error('native_browser_lease_invalid');
      leaseID=decodeURIComponent(match[1]);if(!leaseID||leaseID.includes('/')||leaseID.includes('\0'))throw new Error('native_browser_lease_invalid');operation=request.method==='DELETE'?'release':'touch';
     }
     const result=await owner.lease(operation,{scope:request.body,leaseID,signal:request.signal});await check(request.signal);return result;
    }),
    runBinary:request=>track(async()=>{
     await check(request.signal);
     if(request.binaryPath!==environment.binaryPath||request.cwd!==environment.installRoot||request.screenshotDirectory!==environment.screenshotDirectory
      ||!Number.isFinite(request.timeoutMs)||request.timeoutMs<1||request.timeoutMs>120000)throw new Error('native_browser_launcher_invalid');
     const result=await owner.runBinary(request);await check(request.signal);return result;
    })
   },()=>original.execute(input,context));
   await check(context.abort);return content;
  }finally{
   // The original sequence races abort against a step. Keep authority alive until every actual callback settles.
   while(pending.size)await Promise.allSettled([...pending]);
  }
 }};
}
