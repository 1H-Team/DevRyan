import fs from 'node:fs/promises';
import path from 'node:path';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {startReadOnlySessionExecution} from '@openchamber/harness-runtime/lib/session-execution.js';
import {REVIEWED_CLAUDE_ASSETS} from './reviewed-claude-transform.js';
const fail=()=>Object.assign(new Error('native_provider_transport_unverified'),{code:'native_provider_transport_unverified'});
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const absolute=(value:unknown):value is string=>typeof value==='string'&&value.length<=8192&&path.isAbsolute(value)&&Array.from(value).every(character=>character>=' ');
/** Exact original readonly provider algorithm, with the selected immutable executable and no external JS entry. */
export async function runNativeClaudeTransport(options:{instanceID:string;buildId:string}){
  const raw=process.env.DEVRYAN_PROVIDER_COMMAND;delete process.env.DEVRYAN_PROVIDER_COMMAND;
  if(!raw||Buffer.byteLength(raw)>4*1024*1024)throw fail();const input:unknown=JSON.parse(raw);
  if(!record(input)||Object.keys(input).some(key=>!['protocol','instanceID','buildId','asset','launcher','storage','directories','profileRoots','keychainAccounts','args','directory'].includes(key))||input.protocol!==1||input.instanceID!==options.instanceID||input.buildId!==options.buildId||!record(input.asset)||Object.keys(input.asset).some(key=>!['path','sha256'].includes(key))||!absolute(input.asset.path)||input.asset.sha256!==REVIEWED_CLAUDE_ASSETS.claude.sha256||path.basename(input.asset.path)!==REVIEWED_CLAUDE_ASSETS.claude.path||!absolute(input.launcher)||!absolute(input.storage)||!absolute(input.directory)||!Array.isArray(input.directories)||!input.directories.every(absolute)||!input.directories.includes(input.directory)||!Array.isArray(input.profileRoots)||!input.profileRoots.every(absolute)||!Array.isArray(input.args)||input.args.length>4096||!input.args.every((arg):arg is string=>typeof arg==='string'&&!arg.includes('\0')&&arg.length<=1024*1024))throw fail();
  for(const directory of [input.directory,input.storage,...input.profileRoots])if(await fs.realpath(directory)!==directory||!(await fs.stat(directory)).isDirectory())throw fail();
  if(await fs.realpath(input.asset.path)!==input.asset.path||await fs.realpath(input.launcher)!==input.launcher)throw fail();
  const hash=createHash('sha256');for await(const bytes of createReadStream(input.asset.path))hash.update(bytes);if(hash.digest('hex')!==input.asset.sha256)throw fail();
  const account=process.env.CLAUDE_CONFIG_DIR||path.join(process.env.HOME||'','.claude');
  if(!absolute(account)||!input.profileRoots.some(root=>account===root||account.startsWith(root+path.sep)))throw fail();
  const keychainAccounts=input.keychainAccounts;
  if(!Array.isArray(keychainAccounts)||keychainAccounts.length>128||keychainAccounts.some(item=>!record(item)||Object.keys(item).some(key=>!['directory','keychainService'].includes(key))||!absolute(item.directory)||typeof item.keychainService!=='string'||!/^Claude Code-credentials(?:-[a-f0-9]{8})?$/.test(item.keychainService)))throw fail();
  if(new Set(keychainAccounts.map(item=>item.directory)).size!==keychainAccounts.length)throw fail();
  const state=path.join(input.storage,'state',createHash('sha256').update(JSON.stringify([account,input.directory])).digest('hex'));await fs.mkdir(state,{recursive:true,mode:0o700});
  const controller=new AbortController();const abort=()=>controller.abort();for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,abort);
  try{
    // Selected request credentials are already access-only. Never consult the
    // relocated account or Keychain from this confined transport.
    const env={...process.env,CLAUDE_CONFIG_DIR:state,DEVRYAN_EXECUTION_WORKER:'1'};
    const handle=await startReadOnlySessionExecution({launcher:input.launcher,storage:input.storage,auxiliaryDirectory:state,logicalDirectory:input.directory,command:input.asset.path,args:input.args,signal:controller.signal,interactive:true,env,socketDirectory:null,workerBrowsers:false});
    process.stdin.pipe(handle.child.stdin);handle.child.stdout.pipe(process.stdout);handle.child.stderr.pipe(process.stderr);handle.child.stdin.on('error',()=>{});
    const receipt=await handle.result;process.stdin.unpipe();process.stdin.destroy();
    if(receipt.terminated!==true||receipt.confined!==true)throw fail();return receipt;
  }finally{for(const signal of ['SIGTERM','SIGINT'] as const)EventEmitter.prototype.removeListener.call(process,signal,abort);}
}
