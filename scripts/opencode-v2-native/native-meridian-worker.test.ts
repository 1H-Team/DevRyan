import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createClaudeTransportChannel} from '../../packages/web/server/lib/opencode/runtime-host/native-claude-transport-channel.js';
import type {ClaudeTransportRequest} from '../../packages/web/server/lib/opencode/runtime-host/native-claude-transport-protocol.js';
import {expect,test} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {REVIEWED_CLAUDE_ASSETS,REVIEWED_CLAUDE_STARTUP} from '../../packages/web/server/lib/opencode/runtime-host/reviewed-claude-transform.js';
import {startNativeMeridianWorker,createMeridianRequestAuthority,createProviderCredentialChannel} from '../../packages/web/server/lib/opencode/runtime-host/native-meridian-worker.js';
import {parseProviderBoot,parseProviderBound,parseProviderCommand} from '../../packages/web/server/lib/opencode/runtime-host/native-provider-worker-protocol.js';
const fixture=async()=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'devryan-meridian-protocol-')));
  const globals=Object.fromEntries(['home','config','data','state','cache','bin','log','repos','tmp'].map(name=>[name,path.join(root,name)])) as Record<'home'|'config'|'data'|'state'|'cache'|'bin'|'log'|'repos'|'tmp',string>;
  await Promise.all(Object.values(globals).map(directory=>fs.mkdir(directory)));
  const environment={HOME:globals.home,XDG_CONFIG_HOME:globals.config,XDG_DATA_HOME:globals.data,XDG_STATE_HOME:globals.state,XDG_CACHE_HOME:globals.cache,TMPDIR:globals.tmp};
  const saved=Object.fromEntries([...Object.keys(environment),'MERIDIAN_HOST','CLAUDE_PROXY_HOST','MERIDIAN_PASSTHROUGH','UPSTREAM_IDLE_MS','MERIDIAN_CLAUDE_PATH','DEVRYAN_EXECUTION_BOUNDARY','DEVRYAN_PROVIDER_TRANSPORT','DEVRYAN_PROVIDER_AUTHORIZATION'].map(name=>[name,process.env[name]]));Object.assign(process.env,environment);
  return {boot:{protocol:1 as const,type:'provider-boot' as const,provider:'anthropic' as const,requestAuthorization:'1'.repeat(64),instanceID:randomUUID(),buildId:'a'.repeat(64),globals,profiles:[],assets:{claude:{path:path.resolve(import.meta.dirname,'../../packages/web/runtime/reviewed-inputs/claude-1.11.2/assets',REVIEWED_CLAUDE_ASSETS.claude.path),sha256:REVIEWED_CLAUDE_ASSETS.claude.sha256},libsql:{path:path.resolve(import.meta.dirname,'../../packages/web/runtime/reviewed-inputs/claude-1.11.2/assets',REVIEWED_CLAUDE_ASSETS.libsql.path),sha256:REVIEWED_CLAUDE_ASSETS.libsql.sha256}},transport:{launcher:path.resolve(import.meta.dirname,'../../packages/web/runtime/darwin-arm64/DevRyan-execution-darwin-arm64'),storage:globals.state,directories:[globals.repos]}},async cleanup(){for(const [name,value] of Object.entries(saved)){if(value===undefined)delete process.env[name];else process.env[name]=value;}await fs.rm(root,{recursive:true,force:true});}};
};
test('the reviewed spawn hook brokers only live exact scope and finite SDK semantics without forwarding environment',async()=>{
 const owned=await fixture(),frames:ClaudeTransportRequest[]=[],transport=createClaudeTransportChannel(frame=>frames.push(frame));
 try{
  const worker=await startNativeMeridianWorker(owned.boot,{buildId:owned.boot.buildId,transport,startup:{async startReviewedProxy(){return {port:3456,async close(){}};},async checkReviewedProxy(){return {ok:true,version:REVIEWED_CLAUDE_STARTUP.meridianVersion};}}});
  expect(process.env.UPSTREAM_IDLE_MS).toBe('90000');
  const binding={attemptID:'a'.repeat(64),sessionID:'ses_fixture',directory:owned.boot.globals.repos};
  await worker.command({protocol:1,id:'admit',action:'authorize-attempt',...binding});
  const spawn=Reflect.get(globalThis,'__DEVRYAN_CLAUDE_TRANSPORT_SPAWN');
  const abort=new AbortController(),input={command:owned.boot.assets.claude.path,cwd:binding.directory,args:['--model','opus','--effort','medium'],signal:abort.signal,env:{ANTHROPIC_DEFAULT_OPUS_MODEL:'claude-opus-5-5',ENABLE_TOOL_SEARCH:'true',CLAUDE_CODE_OAUTH_TOKEN:'synthetic-private',HOME:'/foreign'}};
  const raw=JSON.stringify({...binding,profileID:'default'}),child=spawn(input,raw);child.on('error',()=>{});
  expect(Reflect.get(globalThis,'__DEVRYAN_CLAUDE_CHECKPOINT_DIRECTORY')(raw,binding.directory)).toStartWith(path.join(owned.boot.transport.storage,'state')+path.sep);
  expect(frames[0]).toMatchObject({action:'start',...binding,profileID:'default',modelPins:{opus:'claude-opus-5-5'},toolSearch:true,args:input.args});
  expect(JSON.stringify(frames)).not.toContain('synthetic-private');expect(JSON.stringify(frames)).not.toContain('/foreign');
  for(const changed of [{command:'/bin/sh'},{cwd:owned.boot.globals.home}])expect(()=>spawn({...input,...changed},raw)).toThrow('transport_invalid');
  expect(()=>spawn(input,JSON.stringify({...binding,profileID:'unowned'}))).toThrow('transport_invalid');
  const id=frames[0]!.id;transport.accept({protocol:1,type:'claude-transport-reply',id,attemptID:binding.attemptID,action:'started',pid:123,incarnation:{version:1,pid:123,hostId:'a'.repeat(64),bootId:'12345678-1234-1234-1234-123456789abc',startId:'12345',startIdKind:'linux-proc-start-ticks'}});
  let released=false;const releasing=worker.command({protocol:1,id:'release',action:'release-attempt',...binding}).then(()=>released=true);
  await Promise.resolve();expect(released).toBe(false);expect(frames.at(-1)!.action).toBe('cancel');expect(()=>spawn(input,raw)).toThrow('attempt_invalid');
  transport.accept({protocol:1,type:'claude-transport-reply',id,attemptID:binding.attemptID,action:'settled',receipt:{terminated:true,confined:true,cancelled:true,exitCode:137}});await releasing;expect(released).toBe(true);
  const frameCount=frames.length;abort.abort();expect(frames.length).toBe(frameCount);
  await worker.close();expect(Reflect.get(globalThis,'__DEVRYAN_CLAUDE_TRANSPORT_SPAWN')).toBeUndefined();await transport.close();
 }finally{await owned.cleanup();}
});
test('provider worker protocol rejects foreign bind, unknown controls, and duplicate profiles',async()=>{
  const owned=await fixture();try{
    expect(parseProviderBoot(owned.boot).globals).toEqual(owned.boot.globals);
    expect(parseProviderBoot({...owned.boot,defaultProfile:'default'}).defaultProfile).toBe('default');
    expect(()=>parseProviderBoot({...owned.boot,profiles:[{id:'other'}],defaultProfile:'default'})).toThrow('native_provider_protocol_invalid');
    expect(()=>parseProviderBoot({...owned.boot,profiles:[{id:'same'},{id:'same'}]})).toThrow('native_provider_protocol_invalid');
    expect(()=>parseProviderCommand({protocol:1,id:'request',action:'execute'})).toThrow('native_provider_protocol_invalid');
    expect(()=>parseProviderBound({protocol:1,type:'provider-bound',instanceID:owned.boot.instanceID,buildId:owned.boot.buildId,url:'http://0.0.0.0:3456',port:3456,health:'healthy'})).toThrow('native_provider_protocol_invalid');
  }finally{await owned.cleanup();}
});
test('worker waits for original health result, retains degraded compatibility, and closes exactly once',async()=>{
  const owned=await fixture();let starts=0,closes=0,checks=0;
  try{
    const worker=await startNativeMeridianWorker(owned.boot,{buildId:owned.boot.buildId,startup:{async startReviewedProxy(input){starts++;expect(input.port).toBe(0);expect(process.env.MERIDIAN_HOST).toBe('127.0.0.1');return {port:3456,async close(){closes++;}};},async checkReviewedProxy(){checks++;return {ok:true,version:REVIEWED_CLAUDE_STARTUP.meridianVersion,message:'degraded fixture'};}}});
    expect(worker.bound.health).toBe('degraded');expect(checks).toBe(1);
    expect(await worker.command({protocol:1,id:'health',action:'health'})).toEqual({health:'degraded'});
    await worker.close();await worker.close();expect(closes).toBe(1);expect(starts).toBe(1);
    await expect(worker.command({protocol:1,id:'health-after-close',action:'health'})).rejects.toThrow('native_provider_closed');
  }finally{await owned.cleanup();}
});
test('negative health observation closes acquired worker and invalid environment refuses before acquisition',async()=>{
  const owned=await fixture();let starts=0,closes=0;
  const startup={async startReviewedProxy(){starts++;return {port:3456,async close(){closes++;}};},async checkReviewedProxy(){return {ok:false};}};
  try{
    await expect(startNativeMeridianWorker(owned.boot,{buildId:owned.boot.buildId,startup})).rejects.toThrow('native_provider_health_failed');expect(closes).toBe(1);
    process.env.HOME=owned.boot.globals.data;
    await expect(startNativeMeridianWorker(owned.boot,{buildId:owned.boot.buildId,startup})).rejects.toThrow('native_provider_environment_mismatch');expect(starts).toBe(1);
  }finally{await owned.cleanup();}
});

test('worker request authority refuses bearer-only, copied sessions/roots, released handles and closed scope',async()=>{
 const owned=await fixture();try{
  const authority=createMeridianRequestAuthority(owned.boot),attempt={attemptID:'a'.repeat(64),sessionID:'ses_owned',directory:owned.boot.globals.repos};authority.add(attempt);
  const headers={authorization:'Bearer '+owned.boot.requestAuthorization,'x-devryan-provider-attempt':attempt.attemptID,'x-devryan-session':attempt.sessionID,'x-opencode-session':attempt.sessionID,'x-devryan-directory':encodeURIComponent(attempt.directory),'x-opencode-directory':encodeURIComponent(attempt.directory)};
  const request=(changes:Record<string,string>={})=>new Request('http://127.0.0.1:3456/v1/messages',{method:'POST',headers:{...headers,...changes},body:JSON.stringify({messages:[{role:'user',content:'cwd="'+owned.boot.globals.home+'"'}]})});
  expect(authority.authorize(request())).toBe(true);expect(authority.authorize(request({authorization:'Bearer wrong'}))).toBe(false);expect(authority.authorize(request({'x-devryan-provider-attempt':'b'.repeat(64)}))).toBe(false);
  expect(authority.authorize(new Request('http://127.0.0.1:3456/v1/messages/count_tokens',{method:'POST',headers}))).toBe(false);
  expect(authority.authorize(request({'x-opencode-session':'ses_foreign'}))).toBe(false);expect(authority.authorize(request({'x-opencode-directory':encodeURIComponent(owned.boot.globals.home)}))).toBe(false);
  expect(authority.authorize(request({'x-devryan-session':'ses_foreign'}))).toBe(false);
  for(const key of ['x-session-affinity','x-session-id','x-parent-session-id'])expect(authority.authorize(request({[key]:'ses_foreign'}))).toBe(false);
  const detached=request();detached.headers.delete('x-opencode-session');detached.headers.set('x-meridian-source','subagent-title');
  expect(authority.authorize(detached)).toBe(true);expect(authority.binding(detached)).toEqual(attempt);
  detached.headers.delete('x-devryan-session');expect(authority.authorize(detached)).toBe(false);
  authority.remove(attempt);expect(authority.authorize(request())).toBe(false);authority.add(attempt);authority.close();expect(authority.authorize(request())).toBe(false);expect(()=>authority.add(attempt)).toThrow('native_provider_attempt_invalid');
 }finally{await owned.cleanup();}
});

const credentialInput={attemptID:'a'.repeat(64),sessionID:'ses_owned',directory:'/owned',profileID:'selected',purpose:'request' as const};
const credentialReply=(id:string,profileID='selected',accessToken='synthetic-access')=>({protocol:1,id,action:'credential-reply',ok:true,result:{profileID,accessToken,expiresAt:Date.now()+3600000,fingerprint:'b'.repeat(64)}});
test('timed-out credential request accepts and discards exactly one late valid reply',async()=>{
 const requests:{id:string}[]=[];const channel=createProviderCredentialChannel(value=>{requests.push(value);},1);
 try{
  await expect(channel.request(credentialInput)).rejects.toThrow('native_claude_credential_failed');
  expect(()=>channel.accept(credentialReply(requests[0].id))).not.toThrow();
  expect(()=>channel.accept(credentialReply(requests[0].id))).toThrow('native_provider_response_uncorrelated');
 }finally{channel.close();}
});
test('timed-out finite error is consumed without rejecting an unrelated active request',async()=>{
 const requests:{id:string}[]=[];const channel=createProviderCredentialChannel(value=>{requests.push(value);},1);
 try{
  await expect(channel.request(credentialInput)).rejects.toThrow('native_claude_credential_failed');
  const current=channel.request({...credentialInput,profileID:'current'});
  expect(()=>channel.accept({protocol:1,id:requests[0].id,action:'credential-reply',ok:false,error:{code:'claude_credentials_missing'}})).not.toThrow();
  channel.accept(credentialReply(requests[1].id,'current','current-access'));
  expect((await current).accessToken).toBe('current-access');
 }finally{channel.close();}
});
test('late replies retain exact profile validation; malformed and unknown replies remain fatal',async()=>{
 const requests:{id:string}[]=[];const channel=createProviderCredentialChannel(value=>{requests.push(value);},1);
 try{
  await expect(channel.request(credentialInput)).rejects.toThrow('native_claude_credential_failed');
  expect(()=>channel.accept(credentialReply(requests[0].id,'foreign'))).toThrow('native_claude_profile_unreviewed');
  expect(()=>channel.accept({...credentialReply(requests[0].id),extra:'foreign'})).toThrow('native_provider_protocol_invalid');
  expect(()=>channel.accept(credentialReply('unknown'))).toThrow('native_provider_response_uncorrelated');
 }finally{channel.close();}
});
test('active plus retired correlation records stay bounded until physical replies or channel close',async()=>{
 const requests:{id:string}[]=[];const channel=createProviderCredentialChannel(value=>{requests.push(value);},1);
 try{
  const expired=Array.from({length:64},()=>channel.request(credentialInput).catch(error=>error));
  expect((await Promise.all(expired)).every(error=>error.message==='native_claude_credential_failed')).toBe(true);
  await expect(channel.request(credentialInput)).rejects.toThrow('native_claude_credential_failed');expect(requests).toHaveLength(64);
  channel.accept(credentialReply(requests[0].id));
  const current=channel.request(credentialInput);expect(requests).toHaveLength(65);channel.accept(credentialReply(requests[64].id));await current;
  channel.close();channel.close();await expect(channel.request(credentialInput)).rejects.toThrow('native_claude_credential_failed');
  expect(()=>channel.accept(credentialReply(requests[1].id))).not.toThrow();
  expect(()=>channel.accept(credentialReply(requests[1].id))).toThrow('native_provider_response_uncorrelated');
 }finally{channel.close();}
});
test('close rejects active caller but keeps exactly one physical reply correlated through shutdown',async()=>{
 const requests:{id:string}[]=[];const channel=createProviderCredentialChannel(value=>{requests.push(value);});
 const work=channel.request(credentialInput);const rejected=work.catch(error=>error);channel.close();channel.close();
 expect((await rejected).message).toBe('native_provider_owner_expired');
 expect(()=>channel.accept(credentialReply(requests[0].id))).not.toThrow();
 expect(()=>channel.accept(credentialReply(requests[0].id))).toThrow('native_provider_response_uncorrelated');
 await expect(channel.request(credentialInput)).rejects.toThrow('native_claude_credential_failed');expect(requests).toHaveLength(1);
});
test('ambiguous synchronous dispatch failure retains its ID until one physical reply',async()=>{
 let id='';const channel=createProviderCredentialChannel(request=>{id=request.id;throw new Error('synthetic dispatch failure');});
 try{await expect(channel.request(credentialInput)).rejects.toThrow('native_claude_credential_failed');expect(()=>channel.accept(credentialReply(id))).not.toThrow();expect(()=>channel.accept(credentialReply(id))).toThrow('native_provider_response_uncorrelated');}
 finally{channel.close();}
});

test('credential channel correlates finite replies, refuses foreign profile, and drains on close',async()=>{
 const requests:unknown[]=[];const channel=createProviderCredentialChannel(value=>{requests.push(value);});
 const input={attemptID:'a'.repeat(64),sessionID:'ses_owned',directory:'/owned',profileID:'selected',purpose:'request' as const};
 const work=channel.request(input);const request=requests[0] as {id:string};
 channel.accept({protocol:1,id:request.id,action:'credential-reply',ok:true,result:{profileID:'selected',accessToken:'synthetic-access',expiresAt:Date.now()+3600000,fingerprint:'b'.repeat(64)}});
 expect((await work).profileID).toBe('selected');
 const wrong=channel.request(input);const wrongRejected=wrong.catch(error=>error);
 expect(()=>channel.accept({protocol:1,id:(requests[1] as {id:string}).id,action:'credential-reply',ok:true,result:{profileID:'foreign',accessToken:'synthetic-access',expiresAt:Date.now()+3600000,fingerprint:'b'.repeat(64)}})).toThrow('native_claude_profile_unreviewed');expect((await wrongRejected).message).toBe('native_claude_profile_unreviewed');
 const pending=channel.request(input);const rejected=pending.catch(error=>error);channel.close();expect((await rejected).message).toBe('native_provider_owner_expired');
 await expect(channel.request(input)).rejects.toThrow('native_claude_credential_failed');
 expect(()=>channel.accept({protocol:1,id:'foreign',action:'credential-reply',ok:false,error:{code:'private secret'}})).toThrow('native_provider_protocol_invalid');
});

test('signed-out classified health binds degraded; version and real unhealthy failures remain fatal',async()=>{
 const owned=await fixture();let closed=0;
 const startReviewedProxy=async()=>({port:3456,close:async()=>{closed++;}});
 try{
  const worker=await startNativeMeridianWorker(owned.boot,{buildId:owned.boot.buildId,startup:{startReviewedProxy,checkReviewedProxy:async()=>({ok:true,version:REVIEWED_CLAUDE_STARTUP.meridianVersion,availability:'credential-unavailable'})}});
  expect(worker.bound.health).toBe('degraded');await worker.close();
  await expect(startNativeMeridianWorker(owned.boot,{buildId:owned.boot.buildId,startup:{startReviewedProxy,checkReviewedProxy:async()=>({ok:true,version:'wrong',availability:'credential-unavailable'})}})).rejects.toThrow('native_provider_health_failed');
  await expect(startNativeMeridianWorker(owned.boot,{buildId:owned.boot.buildId,startup:{startReviewedProxy,checkReviewedProxy:async()=>({ok:false,version:REVIEWED_CLAUDE_STARTUP.meridianVersion})}})).rejects.toThrow('native_provider_health_failed');
  expect(closed).toBe(3);
 }finally{await owned.cleanup();}
});

test('worker projects selected account per live request, bypasses explicit QA token, and rejects release during read',async()=>{
 const owned=await fixture();const boot={...owned.boot,profiles:[{id:'selected',type:'claude-max' as const},{id:'qa',type:'oauth-token' as const,oauthToken:'synthetic-qa'}]};
 let reads=0,release:()=>void=()=>{};
 const gate=new Promise<void>(resolve=>{release=resolve;});
 try{
  const worker=await startNativeMeridianWorker(boot,{buildId:boot.buildId,startup:{startReviewedProxy:async()=>({port:3456,close:async()=>{}}),checkReviewedProxy:async()=>({ok:true,version:REVIEWED_CLAUDE_STARTUP.meridianVersion})},resolveCredential:async input=>{reads++;await gate;return {profileID:input.profileID,accessToken:'synthetic-current',expiresAt:Date.now()+3600000,fingerprint:'c'.repeat(64)};}});
  const attempt={attemptID:'a'.repeat(64),sessionID:'ses_owned',directory:boot.globals.repos};await worker.command({protocol:1,id:'authorize',action:'authorize-attempt',...attempt});
  const request=new Request('http://127.0.0.1:3456/v1/messages',{method:'POST',headers:{authorization:'Bearer '+boot.requestAuthorization,'x-devryan-provider-attempt':attempt.attemptID,'x-devryan-session':attempt.sessionID,'x-opencode-session':attempt.sessionID,'x-devryan-directory':encodeURIComponent(attempt.directory),'x-opencode-directory':encodeURIComponent(attempt.directory)},body:'{}'});
  const resolve=Reflect.get(globalThis,'__DEVRYAN_CLAUDE_CREDENTIAL') as (request:Request,profile:string,purpose:string)=>Promise<unknown>;
  expect(await resolve(request,'qa','request')).toBeUndefined();expect(reads).toBe(0);
  const pending=resolve(request,'selected','request');const rejected=pending.catch(error=>error);
  await worker.command({protocol:1,id:'release',action:'release-attempt',...attempt});release();const error=await rejected;expect(error instanceof Error&&error.message).toBe('native_provider_attempt_invalid');expect(reads).toBe(1);
  await worker.close();expect(Reflect.get(globalThis,'__DEVRYAN_CLAUDE_CREDENTIAL')).toBeUndefined();
 }finally{release();await owned.cleanup();}
});

test('failed startup import/acquisition removes request credential owner and channel timeout closes pending work',async()=>{
 const owned=await fixture();try{
  await expect(startNativeMeridianWorker(owned.boot,{buildId:owned.boot.buildId,startup:async()=>{throw new Error('synthetic import failure');}})).rejects.toThrow('synthetic import failure');
  expect(Reflect.get(globalThis,'__DEVRYAN_CLAUDE_CREDENTIAL')).toBeUndefined();
  await expect(startNativeMeridianWorker(owned.boot,{buildId:owned.boot.buildId,startup:{startReviewedProxy:async()=>{throw new Error('synthetic acquisition failure');},checkReviewedProxy:async()=>({ok:true,version:REVIEWED_CLAUDE_STARTUP.meridianVersion})}})).rejects.toThrow('synthetic acquisition failure');
  expect(Reflect.get(globalThis,'__DEVRYAN_CLAUDE_CREDENTIAL')).toBeUndefined();
  const channel=createProviderCredentialChannel(()=>{},1);
  await expect(channel.request({attemptID:'a'.repeat(64),sessionID:'ses_owned',directory:'/owned',profileID:'one',purpose:'request'})).rejects.toThrow('native_claude_credential_failed');channel.close();
  expect(()=>createProviderCredentialChannel(()=>{},0)).toThrow('native_provider_protocol_invalid');
 }finally{await owned.cleanup();}
});

test('marked access-only profiles use original selected-account IPC while legacy token bypass stays unchanged',async()=>{
 const owned=await fixture();let reads=0;
 const boot={...owned.boot,profiles:[{id:'marked',type:'oauth-token' as const,credentialPolicy:'access-only' as const,oauthToken:'synthetic'},{id:'legacy',type:'oauth-token' as const,oauthToken:'synthetic'}]};
 try{
  expect(parseProviderBoot(boot).profiles[0].credentialPolicy).toBe('access-only');
  for(const profile of [{id:'bad',type:'claude-max',credentialPolicy:'access-only'},{id:'bad',type:'oauth-token',credentialPolicy:'renew'}])expect(()=>parseProviderBoot({...boot,profiles:[profile]})).toThrow('native_provider_protocol_invalid');
  const worker=await startNativeMeridianWorker(boot,{buildId:boot.buildId,startup:{startReviewedProxy:async()=>({port:3456,close:async()=>{}}),checkReviewedProxy:async()=>({ok:true,version:REVIEWED_CLAUDE_STARTUP.meridianVersion})},resolveCredential:async input=>{reads++;expect(input.profileID).toBe('marked');throw Object.assign(new Error('claude_credentials_expired'),{code:'claude_credentials_expired'});}});
  try{
   const attempt={attemptID:'a'.repeat(64),sessionID:'ses_owned',directory:boot.globals.repos};await worker.command({protocol:1,id:'authorize',action:'authorize-attempt',...attempt});
   const request=new Request('http://127.0.0.1:3456/v1/messages',{method:'POST',headers:{authorization:'Bearer '+boot.requestAuthorization,'x-devryan-provider-attempt':attempt.attemptID,'x-devryan-session':attempt.sessionID,'x-opencode-session':attempt.sessionID,'x-devryan-directory':encodeURIComponent(attempt.directory),'x-opencode-directory':encodeURIComponent(attempt.directory)},body:'{}'});
   const resolve=Reflect.get(globalThis,'__DEVRYAN_CLAUDE_CREDENTIAL') as (request:Request,profile:string,purpose:string)=>Promise<unknown>;
   expect(await resolve(request,'legacy','request')).toBeUndefined();expect(reads).toBe(0);
   await expect(resolve(request,'marked','request')).rejects.toThrow('claude_credentials_expired');expect(reads).toBe(1);
  }finally{await worker.close();}
 }finally{await owned.cleanup();}
});

test('compiled provider observation hooks bind finite child receipts to the exact admitted request and retire on close',async()=>{
 const owned=await fixture(),receipts:unknown[]=[];
 try{
  const worker=await startNativeMeridianWorker(owned.boot,{buildId:owned.boot.buildId,onDiagnostic:value=>receipts.push(value),startup:{
   async startReviewedProxy(){return {port:3456,async close(){}};},async checkReviewedProxy(){return {ok:true,version:REVIEWED_CLAUDE_STARTUP.meridianVersion};}}});
  const attempt={attemptID:'a'.repeat(64),sessionID:'ses_diagnostic',directory:owned.boot.globals.repos};
  await worker.command({protocol:1,id:'authorize-diagnostic',action:'authorize-attempt',...attempt});
  const request=new Request('http://127.0.0.1:3456/v1/messages',{method:'POST',headers:{authorization:'Bearer '+owned.boot.requestAuthorization,
   'x-devryan-provider-attempt':attempt.attemptID,'x-devryan-session':attempt.sessionID,'x-opencode-session':attempt.sessionID,'x-devryan-directory':encodeURIComponent(attempt.directory),'x-opencode-directory':encodeURIComponent(attempt.directory)}});
  const binding:unknown=Reflect.get(globalThis,'__DEVRYAN_CLAUDE_DIAGNOSTIC_BINDING')(request);expect(binding).toEqual(attempt);
  const child=Object.assign(new EventEmitter(),{stderr:new PassThrough()});
  Reflect.get(globalThis,'__DEVRYAN_CLAUDE_DIAGNOSTIC_SPAWN')(child,JSON.stringify(binding));
  child.stderr.write('Unknown option --private-secret');child.emit('close',1,null);
  expect(receipts).toEqual([{protocol:1,type:'claude-process-diagnostic',instanceID:owned.boot.instanceID,...attempt,
   receipt:{code:1,signalPresent:false,stderrBytes:31,scannedBytes:31,truncated:false,clues:['unsupported_option']}}]);
  expect(JSON.stringify(receipts)).not.toContain('private-secret');
  const raw=JSON.stringify({...attempt,profileID:'default'});
  const checkpointDirectory=Reflect.get(globalThis,'__DEVRYAN_CLAUDE_CHECKPOINT_DIRECTORY');
  expect(()=>checkpointDirectory(raw,attempt.directory)).toThrow('native_claude_transport_invalid');
  expect(()=>checkpointDirectory(raw,owned.boot.globals.home)).toThrow('native_claude_transport_invalid');
  const checkpointDiagnostic=Reflect.get(globalThis,'__DEVRYAN_CLAUDE_CHECKPOINT_DIAGNOSTIC');
  checkpointDiagnostic(raw,'passthrough.checkpoint_rejected',{reason:'persisted_boundary_unverified',toolCount:2});
  expect(receipts[1]).toEqual({protocol:1,type:'claude-checkpoint-diagnostic',instanceID:owned.boot.instanceID,...attempt,
    checkpoint:{event:'passthrough.checkpoint_rejected',reason:'persisted_boundary_unverified',toolCount:2}});
  checkpointDiagnostic(raw,'passthrough.checkpoint_rejected',{reason:'persisted_boundary_unverified',toolCount:2,body:'private'});
  expect(receipts).toHaveLength(2);
  await worker.command({protocol:1,id:'retire-checkpoint',action:'release-attempt',...attempt});
  expect(()=>checkpointDirectory(raw,attempt.directory)).toThrow('native_provider_attempt_invalid');
  checkpointDiagnostic(raw,'passthrough.checkpoint_settled',{reason:'sdk_terminal',toolCount:2});expect(receipts).toHaveLength(2);
  await worker.close();expect(Reflect.get(globalThis,'__DEVRYAN_CLAUDE_DIAGNOSTIC_SPAWN')).toBeUndefined();expect(Reflect.get(globalThis,'__DEVRYAN_CLAUDE_DIAGNOSTIC_BINDING')).toBeUndefined();
  expect(Reflect.get(globalThis,'__DEVRYAN_CLAUDE_CHECKPOINT_DIRECTORY')).toBeUndefined();expect(Reflect.get(globalThis,'__DEVRYAN_CLAUDE_CHECKPOINT_DIAGNOSTIC')).toBeUndefined();
 }finally{await owned.cleanup();}
});

test('host owner incarnation is validated, scoped to this worker and retired on close',async()=>{
 const owned=await fixture();
 const ownerIncarnation={version:1 as const,pid:process.pid,hostId:'a'.repeat(64),bootId:'00000000-0000-4000-8000-000000000001',startId:'123',startIdKind:'linux-proc-start-ticks' as const};
 try{
  expect(()=>parseProviderBoot({...owned.boot,ownerIncarnation:{...ownerIncarnation,hostId:'unverified'}})).toThrow('native_provider_protocol_invalid');
  const startup={async startReviewedProxy(){expect(Reflect.get(globalThis,'__DEVRYAN_CLAUDE_OWNER_INCARNATION')).toEqual(ownerIncarnation);return {port:3456,async close(){}};},async checkReviewedProxy(){return {ok:true,version:REVIEWED_CLAUDE_STARTUP.meridianVersion};}};
  await expect(startNativeMeridianWorker({...owned.boot,ownerIncarnation:{...ownerIncarnation,pid:process.pid+1}},{buildId:owned.boot.buildId,startup})).rejects.toThrow('native_provider_identity_mismatch');
  const worker=await startNativeMeridianWorker({...owned.boot,ownerIncarnation},{buildId:owned.boot.buildId,startup});
  expect(Object.isFrozen(Reflect.get(globalThis,'__DEVRYAN_CLAUDE_OWNER_INCARNATION'))).toBe(true);
  await worker.close();expect(Reflect.has(globalThis,'__DEVRYAN_CLAUDE_OWNER_INCARNATION')).toBe(false);
 }finally{await owned.cleanup();}
});

test('worker writer gate attaches host executor before SDK input and transcript roots require the issued request',async()=>{
 const owned=await fixture(),frames:ClaudeTransportRequest[]=[],transport=createClaudeTransportChannel(frame=>frames.push(frame));
 let worker:Awaited<ReturnType<typeof startNativeMeridianWorker>>|undefined;
 try{
  worker=await startNativeMeridianWorker(owned.boot,{buildId:owned.boot.buildId,transport,startup:{async startReviewedProxy(){return {port:3456,async close(){}};},async checkReviewedProxy(){return {ok:true,version:REVIEWED_CLAUDE_STARTUP.meridianVersion};}}});
  const binding={attemptID:'a'.repeat(64),sessionID:'ses_fixture',directory:owned.boot.globals.repos};
  await worker.command({protocol:1,id:'admit',action:'authorize-attempt',...binding});
  const request=new Request('http://127.0.0.1:3456/v1/messages',{method:'POST',headers:{authorization:'Bearer '+owned.boot.requestAuthorization,'x-devryan-provider-attempt':binding.attemptID,'x-devryan-session':binding.sessionID,'x-opencode-session':binding.sessionID,'x-devryan-directory':encodeURIComponent(binding.directory),'x-opencode-directory':encodeURIComponent(binding.directory)}});
  const directory=Reflect.get(globalThis,'__DEVRYAN_CLAUDE_TRANSCRIPT_DIRECTORY');
  expect(directory(request,'default')).toStartWith(path.join(owned.boot.transport.storage,'state')+path.sep);
  expect(()=>directory(request,'foreign')).toThrow('transport_invalid');
  const foreign=new Request(request);foreign.headers.delete('x-devryan-session');expect(()=>directory(foreign,'default')).toThrow('attempt_invalid');
  const factory=Reflect.get(globalThis,'__DEVRYAN_CLAUDE_PROCESS_GATE');
  expect(()=>factory({},async()=>{})).toThrow('transport_invalid');
  const attached:unknown[]=[],gate=factory({env:{DEVRYAN_CLAUDE_DIAGNOSTIC_SCOPE:JSON.stringify({...binding,profileID:'default'})}},async(identity:unknown,recoverable:boolean)=>{attached.push({identity,recoverable});});
  const child=gate.spawnClaudeCodeProcess({command:owned.boot.assets.claude.path,cwd:binding.directory,args:['--print']});child.on('error',()=>{});child.stdin.write('fixture');
  expect(frames.map(frame=>frame.action)).toEqual(['start']);
  const id=frames[0]!.id,incarnation={version:1,pid:123,hostId:'a'.repeat(64),bootId:'12345678-1234-1234-1234-123456789abc',startId:'12345',startIdKind:'linux-proc-start-ticks'};
  transport.accept({protocol:1,type:'claude-transport-reply',id,attemptID:binding.attemptID,action:'started',pid:123,incarnation});
  await new Promise(resolve=>setTimeout(resolve,0));expect(attached).toEqual([{identity:incarnation,recoverable:false}]);expect(frames.at(-1)!.action).toBe('stdin');
  expect(await gate.closeAndJoin(1)).toBe(false);
  transport.accept({protocol:1,type:'claude-transport-reply',id,attemptID:binding.attemptID,action:'settled',receipt:{terminated:true,confined:true,cancelled:true,exitCode:137}});
  expect(await gate.closeAndJoin(1)).toBe(true);await worker.close();
  expect(Reflect.get(globalThis,'__DEVRYAN_CLAUDE_PROCESS_GATE')).toBeUndefined();expect(Reflect.get(globalThis,'__DEVRYAN_CLAUDE_TRANSCRIPT_DIRECTORY')).toBeUndefined();
 }finally{
  for(const frame of frames.filter(frame=>frame.action==='start'))if(transport.activeRuns)try{transport.accept({protocol:1,type:'claude-transport-reply',id:frame.id,attemptID:frame.attemptID,action:'settled',error:'native_claude_transport_failed',receipt:{terminated:true,confined:true,cancelled:true,exitCode:137}});}catch{ /* The run may already have settled. */ }
  await worker?.close();await transport.close();await owned.cleanup();
 }
});
