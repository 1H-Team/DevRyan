import {verifyNativeBootMigration} from './native-boot-migration.js';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseNativeAssetRequest,parseNativeBoot,parseNativeCommand,parseNativeMigrationRequest,encodeNativeProcessMessage,NATIVE_PROCESS_LIMITS } from './native-process-protocol.js';
import {parseProviderBoot,parseProviderCommand} from './native-provider-worker-protocol.js';
import { createNativeCommandDispatcher } from './controller-dispatch.js';
import type { RegistrationOrigin } from './registration-origin.js';
import type { NativeBundleCredentialBoot } from './native-bundle-credential-contract.js';

declare const DEVRYAN_NATIVE_BUILD_ID:string;
declare const DEVRYAN_HOST_DIGEST:string;
declare const DEVRYAN_REVIEWED_PLUGIN_ORIGINS:readonly Omit<RegistrationOrigin,'kind'>[];
declare const DEVRYAN_CORE_DIGEST:string;
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const write=(value:unknown)=>process.stdout.write(encodeNativeProcessMessage(value));
async function* inputLines() {
  let pending=Buffer.alloc(0),first=true;
  for await(const chunk of process.stdin) {
    pending=Buffer.concat([pending,Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)]);
    for(;;) {
      const newline=pending.indexOf(10),limit=first?NATIVE_PROCESS_LIMITS.bootBytes:NATIVE_PROCESS_LIMITS.recordBytes;
      if(newline<0) {if(pending.length>limit) throw new Error('native_input_limit');break;}
      if(newline>limit) throw new Error('native_input_limit');
      const line=pending.subarray(0,newline).toString('utf8');pending=pending.subarray(newline+1);first=false;
      if(!line) throw new Error('native_input_invalid');yield JSON.parse(line) as unknown;
    }
  }
  if(pending.length) throw new Error('native_input_truncated');
}
const args=process.argv.slice(2);
const lines=inputLines();
let close:()=>Promise<void>=async()=>{};
let credentialIdentity:Pick<NativeBundleCredentialBoot,'protocol'|'requestID'|'instanceID'|'buildID'>|undefined;
try {
  if(args[0]==='--claude-transport-worker'&&args.length===3&&args[1]==='--native-instance'&&/^[a-f0-9-]{32,64}$/i.test(args[2]??'')){
    const {runNativeClaudeTransport}=await import('./native-claude-transport-worker.js');
    process.exitCode=(await runNativeClaudeTransport({instanceID:args[2]!,buildId:DEVRYAN_NATIVE_BUILD_ID})).exitCode;
  }else{
  const first=await lines.next();if(first.done) throw new Error('native_boot_missing');
  if(args.length===1 && args[0]==='--verify-assets') {
    const request=parseNativeAssetRequest(first.value);
    for(const [name,directory] of Object.entries({HOME:request.globals.home,XDG_CONFIG_HOME:request.globals.config,XDG_DATA_HOME:request.globals.data,XDG_STATE_HOME:request.globals.state,XDG_CACHE_HOME:request.globals.cache,TMPDIR:request.globals.tmp})) if(!process.env[name] || await fs.realpath(process.env[name]!)!==await fs.realpath(directory)) throw new Error('native_global_environment_mismatch');
    const {verifyNativeAssets}=await import('./verify-assets.js');
    write(await verifyNativeAssets(request,DEVRYAN_NATIVE_BUILD_ID));
  } else if(args[0]==='--migrate' && args.length===3 && args[1]==='--native-instance' && /^[a-f0-9-]{32,64}$/i.test(args[2]??'')) {
    const request=parseNativeMigrationRequest(first.value);
    // This branch imports no controller/SDK module before isolated migration.
    const {runMigrationRequest}=await import('./migration-mode.js');
    const receipt=await runMigrationRequest(request),bytes=await fs.readFile(request.receiptPath);
    write({protocol:'devryan-native-migration/1',ok:true,receipt,receiptPath:request.receiptPath,sha256:hash(bytes)});
  } else if(args[0]==='--bundle-credentials'&&args.length===3&&args[1]==='--native-instance'&&/^[a-f0-9-]{32,64}$/i.test(args[2]??'')) {
    const {parseNativeBundleCredentialBoot,NATIVE_BUNDLE_CREDENTIAL_BYTES}=await import('./native-bundle-credential-contract.js');
    const request=parseNativeBundleCredentialBoot(first.value);
    credentialIdentity={protocol:request.protocol,requestID:request.requestID,instanceID:request.instanceID,buildID:request.buildID};
    if(request.instanceID!==args[2]||request.buildID!==DEVRYAN_NATIVE_BUILD_ID)throw new Error('bundle_credential_binding_invalid');
    const {runNativeBundleCredentialMode}=await import('./native-bundle-credential-mode.js');
    const result=await runNativeBundleCredentialMode(request);
    const reply=JSON.stringify({...credentialIdentity,ok:true,result})+'\n';
    if(Buffer.byteLength(reply)>NATIVE_BUNDLE_CREDENTIAL_BYTES)throw new Error('bundle_credential_output_bound');
    process.stdout.write(reply);
  } else if(args[0]==='--provider-worker'&&args.length===3&&args[1]==='--native-instance'&&/^[a-f0-9-]{32,64}$/i.test(args[2]??'')) {
    const request=parseProviderBoot(first.value);
    if(request.instanceID!==args[2]||request.buildId!==DEVRYAN_NATIVE_BUILD_ID)throw new Error('native_provider_identity_mismatch');
    const {startNativeMeridianWorker,createProviderCredentialChannel}=await import('./native-meridian-worker.js');
    const credentials=createProviderCredentialChannel(write);
    close=async()=>{credentials.close();};
    const host=await startNativeMeridianWorker(request,{buildId:DEVRYAN_NATIVE_BUILD_ID,startup:()=>import('devryan:reviewed-claude-startup'),resolveCredential:input=>credentials.request(input)});
    let commands=Promise.resolve(),queued=0;
    close=async()=>{credentials.close();await host.close();await commands;};write(host.bound);
    for await(const value of lines){
      const command=parseProviderCommand(value);
      if(command.action==='credential-reply'){credentials.accept(command);continue;}
      if(command.action==='close')credentials.close();
      if(queued>=NATIVE_PROCESS_LIMITS.inFlight)throw new Error('native_provider_command_limit');
      queued++;
      // Consume credential replies while a lifecycle command is awaiting work.
      commands=commands.then(async()=>{
        try{write({protocol:1,id:command.id,ok:true,result:await host.command(command)});}
        catch(error){const code=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&/^[a-z][a-z0-9_]{0,95}$/.test(error.code)?error.code:'native_provider_command_failed';write({protocol:1,id:command.id,ok:false,error:{code,status:503,message:code}});}
        finally{queued--;}
      });
    }
    await close();
  } else {
    if(args.length!==3 || args[0]!=='serve' || args[1]!=='--native-instance' || !/^[a-f0-9-]{32,64}$/i.test(args[2]??'')) throw new Error('native_args_invalid');
    const boot=parseNativeBoot(first.value);
    if(boot.instanceID!==args[2] || boot.buildId!==DEVRYAN_NATIVE_BUILD_ID) throw new Error('native_build_identity_mismatch');
    const env={HOME:boot.globals.home,XDG_CONFIG_HOME:boot.globals.config,XDG_DATA_HOME:boot.globals.data,XDG_STATE_HOME:boot.globals.state,XDG_CACHE_HOME:boot.globals.cache,TMPDIR:boot.globals.tmp};
    for(const [name,directory] of Object.entries(env)) if(!process.env[name] || await fs.realpath(process.env[name]!)!==await fs.realpath(directory)) throw new Error('native_global_environment_mismatch');
    const migration=await verifyNativeBootMigration(boot);
    const {startNativeController}=await import('./controller-startup.js');
    const host=await startNativeController(boot,{coreDigest:DEVRYAN_CORE_DIGEST,hostDigest:DEVRYAN_HOST_DIGEST,reviewedPlugins:DEVRYAN_REVIEWED_PLUGIN_ORIGINS,migration:migration.marker});
    close=host.close;
    write({protocol:1,type:'bound',bundleID:boot.bundleID,instanceID:boot.instanceID,url:host.url,port:host.port,buildId:boot.buildId,catalog:host.catalog,migration:{v1:migration.marker}});
    const dispatcher=createNativeCommandDispatcher({run:host.command,closeStartup:host.closeStartup,respond:(id,result)=>write({protocol:1,id,...result})});
    for await(const value of lines) dispatcher.dispatch(parseNativeCommand(value));
    host.closeStartup();await close();await dispatcher.drain();
  }
  }
} catch(error) {
  if(args[0]==='--verify-assets') console.error(JSON.stringify({mode:'verify-assets',name:error instanceof Error?error.name:'unknown',message:String(error).slice(0,2048),stack:error instanceof Error?error.stack?.slice(0,4096):undefined}));
  if(args[0]==='--bundle-credentials') {
    const candidate=error&&typeof error==='object'&&'code'in error?error.code:error instanceof Error?error.message:undefined;
    const code=typeof candidate==='string'&&/^bundle_credential_[a-z0-9_]{1,80}$/.test(candidate)?candidate:'bundle_credential_failed';
    process.stdout.write(JSON.stringify({...credentialIdentity,ok:false,error:{code,status:503}})+'\n');
  } else if(args[0]==='--migrate') {
    const value=error && typeof error==='object' ? error : {};
    const code='code' in value && typeof value.code==='string' && /^[a-z][a-z0-9_]{0,95}$/.test(value.code) ? value.code : 'native_migration_failed';
    const status='status' in value && typeof value.status==='number' && Number.isSafeInteger(value.status) && value.status>=400 && value.status<=599 ? value.status : 503;
    write({protocol:'devryan-native-migration/1',ok:false,error:{code,status}});
  } else {
    const value=error&&typeof error==='object'?error:{};
    const candidate='code' in value?value.code:'message' in value?value.message:undefined;
    // Startup replies carry identifiers only; native errors can contain input or credentials.
    const code=typeof candidate==='string'&&/^(?:native|opencode)_[a-z0-9_]{1,80}$/.test(candidate)?candidate:'native_process_failed';
    write({protocol:1,id:'boot',ok:false,error:{code,status:503,message:code}});
  }process.exitCode=1;
} finally {
  try {await close();} catch {process.exitCode=1;}
}
