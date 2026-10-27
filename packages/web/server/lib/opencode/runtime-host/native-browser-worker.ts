import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createOwnedNativeBrowser} from './native-browser.js';
import type {NativeBrowserOriginals,NativeBrowserLaunch,NativeBrowserInput,NativeBrowserSpawn} from './native-browser.js';
import type {WorkerInput,BrowserOperation,NativeResult} from './worker-protocol.js';
import type {Permission} from '@opencode/core/permission';

type BrowserRequest=Extract<WorkerInput,{tool:'devryan_browser'}>;
export interface BrowserWorkerOriginals extends NativeBrowserOriginals {
 readonly runReviewedBrowserBinary:(input:NativeBrowserLaunch&{readonly spawnImpl:NativeBrowserSpawn})=>Promise<string>;
}
export interface BrowserWorkerCallbacks {
 readonly operation:(input:Omit<BrowserOperation,'type'|'id'>)=>Promise<unknown>;
 readonly assertPermission:(input:Permission.AssertInput)=>Promise<void>;
 readonly signal:AbortSignal;
}
const inside=(root:string,value:string)=>value===root||value.startsWith(root+path.sep);
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const asset=async(file:string,digest:string,executable:boolean)=>{
 if(!path.isAbsolute(file)||file.includes('\0')||!/^[a-f0-9]{64}$/.test(digest)||await fs.realpath(file)!==file)throw Error('native_browser_asset_invalid');
 const stat=await fs.lstat(file);
 if(!stat.isFile()||stat.size>256*1024*1024||(executable&&!(stat.mode&0o111)))throw Error('native_browser_asset_invalid');
 if(createHash('sha256').update(await fs.readFile(file)).digest('hex')!==digest)throw Error('native_browser_asset_invalid');
};
const input=(value:unknown):NativeBrowserInput=>{
 if(!record(value)||Object.keys(value).some(key=>!['command','args','selector','styles','attributes','steps','timeout_ms'].includes(key))||typeof value.command!=='string')throw Error('native_browser_input_invalid');
 const strings=(raw:unknown)=>{if(raw===undefined)return;if(!Array.isArray(raw)||raw.some(value=>typeof value!=='string'))throw Error('native_browser_input_invalid');return raw.filter((value):value is string=>typeof value==='string');};
 const step=(raw:unknown,top=false)=>{
  const keys=top?['command','args','selector','styles','attributes','steps','timeout_ms']:['command','args','selector','styles','attributes'];
  if(!record(raw)||Object.keys(raw).some(key=>!keys.includes(key))||typeof raw.command!=='string'||raw.selector!==undefined&&typeof raw.selector!=='string')throw Error('native_browser_input_invalid');
  return {command:raw.command,...(raw.args===undefined?{}:{args:strings(raw.args)}),
   ...(typeof raw.selector==='string'?{selector:raw.selector}:{}),
   ...(raw.styles===undefined?{}:{styles:strings(raw.styles)}),...(raw.attributes===undefined?{}:{attributes:strings(raw.attributes)})};
 };
 if(value.timeout_ms!==undefined&&typeof value.timeout_ms!=='number')throw Error('native_browser_input_invalid');
 if(value.steps!==undefined&&!Array.isArray(value.steps))throw Error('native_browser_input_invalid');
 return {...step(value,true),...(Array.isArray(value.steps)?{steps:value.steps.map(raw=>step(raw))}:{}),
  ...(typeof value.timeout_ms==='number'?{timeout_ms:value.timeout_ms}:{})};
};
/** Runs the original complete tool inside one already-supervised lease view. */
export async function runNativeBrowserWorker(request:BrowserRequest,callbacks:BrowserWorkerCallbacks,originals?:BrowserWorkerOriginals):Promise<typeof NativeResult.Type>{
 if(await fs.realpath(request.directory)!==request.directory||process.cwd()!==request.directory
  ||!inside(request.projectDirectory,request.directory)||process.env.HOME!==request.scratchDirectory)throw Error('native_browser_worker_boundary_invalid');
 const reviewed=request.reviewedBrowser;
 const socket=request.browserSocketDirectory,relativeSocket=path.relative(request.directory,socket);
 if(socket!==path.join(request.scratchDirectory,'s')||await fs.realpath(socket)!==socket||!relativeSocket
  ||Buffer.byteLength(relativeSocket)>26)throw Error('native_browser_socket_invalid');
 await asset(reviewed.binaryPath,reviewed.sha256,true);await asset(reviewed.configPath,reviewed.configSha256,false);
 if(reviewed.ffmpeg){if(!['ffmpeg','ffmpeg.exe'].includes(path.basename(reviewed.ffmpeg.path)))throw Error('native_browser_asset_invalid');await asset(reviewed.ffmpeg.path,reviewed.ffmpeg.sha256,true);}
 // Build applies the exact source-hash transformation; source tests inject that
 // same transformed module. No runtime eval or caller-supplied module path.
 const nativeOriginals=originals??await import('../../../default-config/plugins/devryan-browser.mjs');
 if(typeof nativeOriginals.withReviewedBrowserOwner!=='function'||typeof nativeOriginals.runReviewedBrowserBinary!=='function')throw Error('native_browser_originals_unavailable');
 const screenshotDirectory=path.join(request.projectDirectory,'.devryan-browser');await fs.mkdir(screenshotDirectory,{recursive:true,mode:0o700});
 const scope={opencodeSessionID:request.context.sessionID,messageID:request.context.userMessageID,
  directory:request.logicalDirectory,agent:request.context.agent};
 const operation=(name:BrowserOperation['operation'],leaseID?:string)=>callbacks.operation({operation:name,scope,...(leaseID===undefined?{}:{leaseID})});
 await callbacks.assertPermission({sessionID:request.context.sessionID,agent:request.context.agent,action:'devryan_browser',resources:['*'],
  source:{type:'tool',messageID:request.context.messageID,id:request.context.id}});
 const tool=await createOwnedNativeBrowser({originals:nativeOriginals,environment:{leasesUrl:'devryan://private-browser/leases',token:'',
  binaryPath:reviewed.binaryPath,configPath:reviewed.configPath,installRoot:request.directory,screenshotDirectory,
  ffmpegDirectory:reviewed.ffmpeg?path.dirname(reviewed.ffmpeg.path):null},ownersFor:async()=>({
   assertCurrent:async()=>{callbacks.signal.throwIfAborted();await operation('assert-current');callbacks.signal.throwIfAborted();},
   resolveTurn:async()=>request.context.userMessageID,
   lease:(name,request)=>{request.signal.throwIfAborted();return operation(name,request.leaseID);},
   runBinary:async launch=>{
    // Permission/lease round trips can outlive a managed asset update.
    await asset(reviewed.binaryPath,reviewed.sha256,true);await asset(reviewed.configPath,reviewed.configSha256,false);
    if(reviewed.ffmpeg)await asset(reviewed.ffmpeg.path,reviewed.ffmpeg.sha256,true);
    return nativeOriginals.runReviewedBrowserBinary({...launch,spawnImpl:(file,args,options)=>{
    if(file!==reviewed.binaryPath||options?.cwd!==request.directory)throw Error('native_browser_launcher_invalid');
    // Rust 0.38.1 honors this relative spelling, keeping Darwin's 103-byte
    // socket limit while Seatbelt grants only the canonical private directory.
    return spawn(file,args,{...options,env:{...options.env,AGENT_BROWSER_SOCKET_DIR:relativeSocket}});
   }});},
  })});
 const content=await tool.execute(input(request.input),{sessionID:request.context.sessionID,messageID:request.context.messageID,
  directory:request.logicalDirectory,agent:request.context.agent,abort:callbacks.signal});
 return {content};
}
