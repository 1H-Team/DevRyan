import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createNativeClaudeCredentialOwner,migrateNativeClaudeLegacyFences} from '../../packages/web/server/lib/opencode/runtime-host/native-provider-runtime-owner.js';
import {rewriteReviewedClaudeCredentials,REVIEWED_CLAUDE_CREDENTIALS} from '../../packages/web/server/lib/opencode/runtime-host/reviewed-claude-transform.js';
import {loadReviewedClaudeCredentials} from '../../packages/web/server/lib/opencode/runtime-host/reviewed-claude-host-credentials.js';
import {emptyClaudeLifecycle,transitionClaudeLifecycle,claudeRecordFingerprint,claudeGrantFingerprint} from '../../packages/web/server/lib/opencode/runtime-host/native-claude-lifecycle.js';
import {credentialMutationFingerprint as fingerprint} from '../../packages/web/server/lib/opencode/runtime-host/native-credential-mutation-owner.js';
const repository=path.resolve(import.meta.dirname,'../..');
const original=await fs.readFile(path.join(repository,'packages/web/runtime/reviewed-inputs/claude-1.8.0/node_modules/@rynfar/meridian/dist/cli-khhjyk04.js'));
const transformed=rewriteReviewedClaudeCredentials(original),module=await import('data:text/javascript;base64,'+Buffer.from(transformed).toString('base64'));
const serviceA='Claude Code-credentials-01234567',serviceB='Claude Code-credentials-89abcdef';
const credential=(token,expiresAt=Date.now()+3600000)=>({account:'synthetic',claudeAiOauth:{accessToken:token,refreshToken:'synthetic-refresh-'+token,expiresAt}});
function fixture({policy='renew',expiresAt=Date.now()+3600000,dedicated=policy==='renew'}={}){
 const stored=new Map([[serviceA,credential('token-A',expiresAt)],[serviceB,credential('other-A',expiresAt)]]),operations=[];let chain=Promise.resolve(),exchanges=0,writeOK=true,readHook,writeHook,fetchHook,responseBody={access_token:'token-B',refresh_token:'synthetic-next-refresh',expires_in:3600};
 let state=emptyClaudeLifecycle(),transitionHook;
 const enroll=(id,service,configDirectory)=>{const value=stored.get(service);state=transitionClaudeLifecycle(state,state.revision,{kind:'enroll',account:{profileID:id,service,configDirectory,enrollmentID:'enrolled-'+id,generation:'generation-'+id,grantFingerprint:claudeGrantFingerprint(value.claudeAiOauth.refreshToken),recordFingerprint:claudeRecordFingerprint(value)}});};
 if(dedicated){enroll('one',serviceA,'/owned/relocated/one');enroll('two',serviceB,'/owned/relocated/two');}
 const lifecycle={read:async()=>structuredClone(state),transition:async(revision,operation)=>{await transitionHook?.(operation);state=transitionClaudeLifecycle(state,revision,operation);return structuredClone(state);}};
 const queue=action=>{const work=chain.then(action);chain=work.catch(()=>{});return work;};
 const backend={async execFile(file,args){
  assert.equal(file,'/usr/bin/security');const service=args[args.indexOf('-s')+1];assert.ok(stored.has(service));operations.push([args[0],service]);
  if(args[0]==='find-generic-password'){await readHook?.();return {stdout:JSON.stringify(stored.get(service))};}
  assert.equal(args[0],'add-generic-password');assert.equal(args[1],'-U');if(!writeOK)throw new Error('synthetic persist refusal');stored.set(service,JSON.parse(args[args.indexOf('-w')+1]));await writeHook?.();return {stdout:''};
 },async fetch(url,options){
  assert.equal(url,'https://platform.claude.com/v1/oauth/token');assert.equal(options.method,'POST');assert.equal(JSON.parse(options.body).grant_type,'refresh_token');exchanges++;await fetchHook?.();return Response.json(responseBody);
 }};
 const owner=createNativeClaudeCredentialOwner({profiles:[{id:'one',type:'claude-max',claudeConfigDir:'/owned/relocated/one',keychainService:serviceA},{id:'two',type:'claude-max',claudeConfigDir:'/owned/relocated/two',keychainService:serviceB}],home:'/owned/home',withMutationQueue:queue,loadModule:async()=>module,backend,policy,lifecycle});
 const context=()=>({recheck:async()=>{},retried:new Set()});
 return {owner,recreate:()=>createNativeClaudeCredentialOwner({profiles:[{id:'one',type:'claude-max',claudeConfigDir:'/owned/relocated/one',keychainService:serviceA}],home:'/owned',withMutationQueue:queue,loadModule:async()=>module,backend,policy,lifecycle}),context,stored,operations,exchanges:()=>exchanges,writeRefuse:()=>{writeOK=false;},onRead:fn=>{readHook=fn;},onWrite:fn=>{writeHook=fn;},onFetch:fn=>{fetchHook=fn;},response:value=>{responseBody=value;},lifecycle,state:()=>structuredClone(state),onTransition:fn=>{transitionHook=fn;}};
}
test('fresh enrollment adopts legacy fences only from configured services and blocks grant aliases',async()=>{
 let state=emptyClaudeLifecycle();const current=credential('legacy-access');current.devryanRefreshBlock={protocol:'devryan.claude-refresh-block/1',generation:claudeRecordFingerprint(current)};
 const bytes=JSON.stringify(current),reads=[];
 const lifecycle={read:async()=>structuredClone(state),transition:async(revision,operation)=>{state=transitionClaudeLifecycle(state,revision,operation);return structuredClone(state);}};
 const options={profiles:[{id:'one',type:'claude-max',claudeConfigDir:'/owned/one',keychainService:serviceA},{id:'alias',type:'claude-max',claudeConfigDir:'/owned/alias',keychainService:serviceB},{id:'inline',type:'oauth-token',oauthToken:'synthetic'}],home:'/owned',lifecycle,loadModule:async()=>module,backend:{execFile:async(file,args)=>{assert.equal(file,'/usr/bin/security');assert.equal(args[0],'find-generic-password');reads.push(args[args.indexOf('-s')+1]);return {stdout:bytes};},fetch:async()=>{throw new Error('must not exchange');}}};
 assert.deepEqual(await migrateNativeClaudeLegacyFences(options,{recheck:async()=>{}}),{observed:2,adopted:1});
 assert.deepEqual(reads,[serviceA,serviceB]);assert.equal(state.accounts.length,0);assert.equal(state.unresolved.length,1);assert.equal(state.unresolved[0].phase,'blocked');
 assert.deepEqual(await migrateNativeClaudeLegacyFences(options,{recheck:async()=>{}}),{observed:2,adopted:0});assert.equal(state.revision,1);
 assert.throws(()=>transitionClaudeLifecycle(state,state.revision,{kind:'enroll',account:{profileID:'fresh',service:'Claude Code-credentials-aabbccdd',configDirectory:'/owned/fresh',enrollmentID:'fresh',generation:'fresh',recordFingerprint:claudeRecordFingerprint(credential('fresh')),grantFingerprint:claudeGrantFingerprint(current.claudeAiOauth.refreshToken)}}),/native_claude_enrollment_conflict/);
 assert.equal(JSON.stringify(current),bytes);
});
test('legacy adoption skips only verified missing services and refuses unreadable or malformed records',async()=>{
 const lifecycle={read:async()=>emptyClaudeLifecycle(),transition:async()=>{throw new Error('must not persist');}};
 const options={profiles:[],home:'/owned/home',lifecycle,loadModule:async()=>module};let expected='Claude Code-credentials';
 const run=backend=>migrateNativeClaudeLegacyFences({...options,backend},{recheck:async()=>{}});
 const missing=async(file,args)=>{assert.equal(file,'/usr/bin/security');assert.equal(args[args.indexOf('-s')+1],expected);throw Object.assign(new Error('missing'),{code:44});};
 assert.deepEqual(await run({execFile:missing}),{observed:0,adopted:0});
 for(const code of ['44',1])await assert.rejects(run({execFile:async()=>{throw Object.assign(new Error('unreadable'),{code});}}),/claude_credentials_unreadable/);
 for(const stdout of ['', 'null','{'])await assert.rejects(run({execFile:async()=>({stdout})}),/claude_credentials_unreadable/);
 const current=credential('marked');current.devryanRefreshBlock={protocol:'devryan.claude-refresh-block/1',generation:'a'.repeat(64)};
 await assert.rejects(run({execFile:async()=>({stdout:JSON.stringify(current)})}),/native_claude_legacy_fence_invalid/);
 expected='unused';assert.deepEqual(await migrateNativeClaudeLegacyFences({...options,profiles:[{id:'api',type:'api',apiKey:'synthetic'}],backend:{execFile:missing}},{recheck:async()=>{}}),{observed:0,adopted:0});
});
test('legacy adoption preserves a committed fence when caller authority is revoked during persistence',async()=>{
 const current=credential('marked');current.devryanRefreshBlock={protocol:'devryan.claude-refresh-block/1',generation:claudeRecordFingerprint(current)};let state=emptyClaudeLifecycle(),active=true;
 const lifecycle={read:async()=>state,transition:async(revision,operation)=>{state=transitionClaudeLifecycle(state,revision,operation);active=false;return structuredClone(state);}};
 await assert.rejects(migrateNativeClaudeLegacyFences({profiles:[],home:'/owned',lifecycle,loadModule:async()=>module,backend:{execFile:async()=>({stdout:JSON.stringify(current)})}},{recheck:async()=>{if(!active)throw new Error('revoked');}}),/revoked/);
 assert.equal(state.unresolved.length,1);assert.equal(state.unresolved[0].phase,'blocked');assert.equal(state.accounts.length,0);
});
test('sealed host module uses exact reviewed bytes, restricted exports and explicit service for read and write',async()=>{
 assert.equal(createHash('sha256').update(transformed).digest('hex'),REVIEWED_CLAUDE_CREDENTIALS.sha256);
 assert.deepEqual(Object.keys(module).sort(),['createPlatformCredentialStore','ensureFreshToken','refreshOAuthToken']);
 assert.throws(()=>module.createPlatformCredentialStore({serviceName:'unreviewed-service'}),/native_claude_service_invalid/);
 const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/claude-host-renewal/asset-'));
 const file=path.join(root,REVIEWED_CLAUDE_CREDENTIALS.path);try{
  await fs.writeFile(file,transformed,{mode:0o644});assert.equal(typeof(await loadReviewedClaudeCredentials({path:file,sha256:REVIEWED_CLAUDE_CREDENTIALS.sha256})).refreshOAuthToken,'function');
  await fs.appendFile(file,'\n');await assert.rejects(loadReviewedClaudeCredentials({path:file,sha256:REVIEWED_CLAUDE_CREDENTIALS.sha256}),/native_claude_credentials_unverified/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
 const owned=fixture({expiresAt:Date.now()+1000});const result=await owned.owner({profileID:'one',purpose:'request'},owned.context());
 assert.equal(result.accessToken,'token-B');assert.equal(result.profileID,'one');assert.equal(result.refreshToken,undefined);assert.equal(owned.exchanges(),1);assert.ok(owned.operations.every(([,service])=>service===serviceA));
});
test('queue prevents duplicate renewal; selected profiles retain separate access-only results',async()=>{
 const owned=fixture({expiresAt:Date.now()+1000});
 const results=await Promise.all([owned.owner({profileID:'one',purpose:'request'},owned.context()),owned.owner({profileID:'one',purpose:'request'},owned.context())]);
 assert.equal(owned.exchanges(),1);assert.equal(results[0].accessToken,'token-B');assert.deepEqual(results[0],results[1]);
 const other=fixture();const [one,two]=await Promise.all([other.owner({profileID:'one',purpose:'request'},other.context()),other.owner({profileID:'two',purpose:'request'},other.context())]);
 assert.equal(one.accessToken,'token-A');assert.equal(two.accessToken,'other-A');assert.equal(other.exchanges(),0);
 await assert.rejects(other.owner({profileID:'foreign',purpose:'request'},other.context()),/native_claude_profile_unreviewed/);
});
test('401 renews once for exact failed token; an already-newer token is reused without exchanging',async()=>{
 const owned=fixture(),context=owned.context(),input={profileID:'one',purpose:'authentication-retry',failedFingerprint:fingerprint('token-A')};
 assert.equal((await owned.owner(input,context)).accessToken,'token-B');assert.equal(owned.exchanges(),1);
 assert.equal((await owned.owner(input,owned.context())).accessToken,'token-B');assert.equal(owned.exchanges(),1);
 await assert.rejects(owned.owner(input,context),/native_claude_retry_exhausted/);
});
test('access-only QA cannot renew or persist, including authentication failure and expiry',async()=>{
 const owned=fixture({policy:'access-only',expiresAt:Date.now()+120000});
 assert.equal((await owned.owner({profileID:'one',purpose:'request'},owned.context())).accessToken,'token-A');
 await assert.rejects(owned.owner({profileID:'one',purpose:'authentication-retry',failedFingerprint:fingerprint('token-A')},owned.context()),/claude_credentials_expired/);
 owned.stored.set(serviceA,credential('token-A',Date.now()-1));await assert.rejects(owned.owner({profileID:'one',purpose:'request'},owned.context()),/claude_credentials_expired/);
 assert.equal(owned.exchanges(),0);assert.ok(owned.operations.every(([operation])=>operation==='find-generic-password'));
});
test('revocation/cancellation after exchange prevents persistence and fences ambiguous generation',async()=>{
 const owned=fixture({expiresAt:Date.now()+1000}),context=owned.context();let active=true;
 context.recheck=async()=>{if(!active)throw Object.assign(new Error('revoked'),{code:'native_provider_attempt_expired'});};owned.onFetch(()=>{active=false;});
 await assert.rejects(owned.owner({profileID:'one',purpose:'request'},context),/revoked/);assert.equal(owned.stored.get(serviceA).claudeAiOauth.accessToken,'token-A');
 await assert.rejects(owned.owner({profileID:'one',purpose:'request'},owned.context()),/native_claude_refresh_unsettled/);assert.equal(owned.exchanges(),1);
 const canceled=fixture({expiresAt:Date.now()+1000}),abort=new AbortController(),ctx=canceled.context();ctx.signal=abort.signal;canceled.onFetch(()=>abort.abort());
 await assert.rejects(canceled.owner({profileID:'one',purpose:'request'},ctx));assert.equal(canceled.state().unresolved[0].phase,'in-flight');assert.equal(canceled.stored.get(serviceA).devryanRefreshBlock,undefined);assert.equal(canceled.stored.get(serviceA).claudeAiOauth.accessToken,'token-A');
});
test('account change and persistence failure refuse without returning exchanged credentials',async()=>{
 const changed=fixture({expiresAt:Date.now()+1000});changed.onFetch(()=>changed.stored.set(serviceA,{...credential('new-account-token'),account:'another'}));
 await assert.rejects(changed.owner({profileID:'one',purpose:'request'},changed.context()),/native_claude_account_changed/);assert.equal(changed.stored.get(serviceA).account,'another');assert.equal(changed.stored.get(serviceA).claudeAiOauth.accessToken,'new-account-token');
 const failed=fixture({expiresAt:Date.now()+1000});failed.writeRefuse();await assert.rejects(failed.owner({profileID:'one',purpose:'request'},failed.context()),/native_claude_refresh_failed/);
 await assert.rejects(failed.owner({profileID:'one',purpose:'request'},failed.context()),/native_claude_refresh_unsettled/);assert.equal(failed.exchanges(),1);
});

test('actual transformed selection preserves active/priority/sticky and request-local A survives later B',async()=>{
 const {rewriteReviewedMeridianLibsql}=await import('../../packages/web/server/lib/opencode/runtime-host/reviewed-claude-transform.js');
 const directory=path.join(repository,'packages/web/runtime/reviewed-inputs/claude-1.8.0/node_modules/@rynfar/meridian/dist');
 const source=rewriteReviewedMeridianLibsql(await fs.readFile(path.join(directory,'cli-wxk8xvd3.js')));
 const profilesSource=await fs.readFile(path.join(directory,'cli-m0p2bc8v.js'),'utf8');
 const resolver=profilesSource.slice(profilesSource.indexOf('function resolveProfile('),profilesSource.indexOf('function listProfiles('));
 const routing=profilesSource.slice(profilesSource.indexOf('function rendezvousScore('),profilesSource.indexOf('class ProfileExhaustion'));
 const resolve=new Function('getEffectiveProfiles','activeProfileId','DEFAULT_PROFILE_ID','join','homedir','createHash',routing+resolver+';return {resolveProfile,choosePriorityProfile,pickStickyProfile};')(value=>value,'two','default',path.join,()=>'/owned/home',createHash);
 const selection=source.slice(source.indexOf('        let profile = resolveProfile('),source.indexOf('        const requestSource ='));
 const envStart=source.indexOf('        const sdkModelDefaults =',source.indexOf('        let profile = resolveProfile('));
 const env=source.slice(envStart,source.indexOf('        let systemContext =',envStart));
 const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
 const dispatch=new AsyncFunction('resolveProfile','finalConfig','options','c','routingMode','adapter','body','globalThis','getClaudeAuthStatusAsync','resolveSdkModelDefaults','cleanEnv',selection+env+';return {profile,profileEnv,renewNativeCredential};');
 const owned=fixture({dedicated:false});const profiles=[{id:'one',claudeConfigDir:'/owned/one'},{id:'two',claudeConfigDir:'/owned/two'}];
 const seen=[],scope={__DEVRYAN_CLAUDE_CREDENTIAL:async(_request,profileID,purpose,failedFingerprint)=>{seen.push(profileID);return owned.owner({profileID,purpose,...failedFingerprint?{failedFingerprint}:{}},owned.context());}};
 const call=async(mode,forced)=>dispatch(resolve.resolveProfile,{profiles,defaultProfile:'one'},{forcedProfileId:forced},{req:{raw:{},header:()=>undefined}},mode,{getSessionId:()=> 'synthetic-session'},{},scope,async(id,env)=>{assert.equal(seen.at(-1),id);assert.ok(env.CLAUDE_CODE_OAUTH_TOKEN);return {};},()=>({}),{});
 assert.equal((await call('active')).profile.id,'two');
 const priority=resolve.choosePriorityProfile(['one','two'],id=>id==='one').id;assert.equal((await call('priority',priority)).profile.id,'two');
 const sticky=resolve.pickStickyProfile('synthetic-session',['one','two']);assert.equal((await call('sticky')).profile.id,sticky);
 const held=await call('active','one');assert.equal(held.profileEnv.CLAUDE_CODE_OAUTH_TOKEN,'token-A');
 owned.stored.set(serviceA,credential('token-B'));
 const next=await call('active','one');assert.equal(next.profileEnv.CLAUDE_CODE_OAUTH_TOKEN,'token-B');assert.equal(held.profileEnv.CLAUDE_CODE_OAUTH_TOKEN,'token-A');
 assert.equal(profiles[0].env,undefined);assert.equal(owned.exchanges(),0);
 // All native ambient/manual refresh owners are disabled, not merely the timer.
 assert.match(source,/function credentialStoreForProfile\(profile\) \{\n  if \(process.env.DEVRYAN_EXECUTION_BOUNDARY === "1"\) return;/);
 assert.match(source,/async function ensureFreshTokenForProfiles\(config\) \{\n  if \(process.env.DEVRYAN_EXECUTION_BOUNDARY === "1"\) return;/);
 assert.match(source,/async function fetchOAuthUsageImpl\(opts\) \{\n  if \(process.env.DEVRYAN_EXECUTION_BOUNDARY === "1"\) return/);
 assert.equal((source.match(/nativeCredential \? await renewNativeCredential\(\) : false/g)??[]).length,2);
 assert.match(source,/profileTokenRefreshInterval = process.env.DEVRYAN_EXECUTION_BOUNDARY === "1" \? undefined/);
 assert.match(source,/effectiveProfiles.length > 0 && process.env.DEVRYAN_EXECUTION_BOUNDARY !== "1"/);
});

test('finite selected-profile wire strips refresh and refuses malformed, mixed, or private replies',async()=>{
 const {parseProviderCredentialRequest,parseProviderCredentialReply,parseProviderCredentialResult}=await import('../../packages/web/server/lib/opencode/runtime-host/native-provider-worker-protocol.js');
 const request=parseProviderCredentialRequest({protocol:1,type:'credential-request',id:'request',attemptID:'a'.repeat(64),sessionID:'ses_owned',directory:'/owned',profileID:'one',purpose:'request'});
 const owned=fixture();const result=parseProviderCredentialResult(await owned.owner(request,owned.context()));
 assert.deepEqual(Object.keys(result).sort(),['accessToken','expiresAt','fingerprint','profileID']);
 assert.equal(parseProviderCredentialReply({protocol:1,id:request.id,action:'credential-reply',ok:true,result}).result.accessToken,'token-A');
 for(const value of [{...result,refreshToken:'synthetic-refresh'},{...result,accessToken:'x'.repeat(60001)},{...result,fingerprint:'wrong'},{...result,expiresAt:NaN}])assert.throws(()=>parseProviderCredentialResult(value),/native_provider_protocol_invalid/);
 assert.throws(()=>parseProviderCredentialRequest({...request,purpose:'authentication-retry'}),/native_provider_protocol_invalid/);
 assert.throws(()=>parseProviderCredentialRequest({...request,keychainService:serviceA}),/native_provider_protocol_invalid/);
 for(const reply of [{protocol:1,id:'request',action:'credential-reply',ok:false,error:{code:'private_error_message'}},{protocol:1,id:'request',action:'credential-reply',ok:false,error:{code:'claude_credentials_expired',message:'private'}},{protocol:1,id:'request',action:'credential-reply',ok:true,result,error:{code:'claude_credentials_expired'}}])assert.throws(()=>parseProviderCredentialReply(reply),/native_provider_protocol_invalid/);
});

test('a canceled attempt cannot read/renew and queued revoked work never exchanges',async()=>{
 const owned=fixture({expiresAt:Date.now()+1000}),abort=new AbortController();abort.abort();
 await assert.rejects(owned.owner({profileID:'one',purpose:'request'},{...owned.context(),signal:abort.signal}));assert.equal(owned.operations.length,0);assert.equal(owned.exchanges(),0);
 let release;const gate=new Promise(resolve=>{release=resolve;});let entered;const started=new Promise(resolve=>{entered=resolve;});
 owned.onFetch(async()=>{entered();await gate;});
 const first=owned.owner({profileID:'one',purpose:'request'},owned.context());await started;
 const second=owned.owner({profileID:'two',purpose:'request'},{...owned.context(),recheck:async()=>{throw Object.assign(new Error('native_provider_attempt_expired'),{code:'native_provider_attempt_expired'});}});
 const rejected=assert.rejects(second,/native_provider_attempt_expired/);release();await first;await rejected;assert.equal(owned.exchanges(),1);assert.ok(owned.operations.every(([,service])=>service===serviceA));
});

test('native transport accepts only issued access environment and never reads saved credential sources',async()=>{
 const source=await fs.readFile(path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-claude-transport-worker.ts'),'utf8');
 assert.doesNotMatch(source,/prepareClaudeTransportEnvironment|readClaudeAccessToken|\.credentials\.json/);
 assert.match(source,/const env=\{\.\.\.process.env,CLAUDE_CONFIG_DIR:state,DEVRYAN_EXECUTION_WORKER:'1'\}/);
});


test('malformed issuer success does not replace saved credentials',async()=>{
 const owned=fixture({expiresAt:Date.now()+1000});owned.response({refresh_token:'synthetic-next-refresh',expires_in:3600});
 await assert.rejects(owned.owner({profileID:'one',purpose:'request'},owned.context()),/claude_credentials_unreadable/);
 assert.equal(owned.stored.get(serviceA).claudeAiOauth.accessToken,'token-A');assert.equal(owned.state().unresolved[0].phase,'in-flight');assert.equal(owned.stored.get(serviceA).devryanRefreshBlock,undefined);
 await assert.rejects(owned.owner({profileID:'one',purpose:'request'},owned.context()),/native_claude_refresh_unsettled/);assert.equal(owned.exchanges(),1);
});
test('marked access-only token uses only configured expiry and refuses retry without module, Keychain or refresh',async()=>{
 let now=1000000,loaded=0,io=0;const create=(token='synthetic-access',expiry=now+3600000)=>createNativeClaudeCredentialOwner({profiles:[{id:'qa',type:'oauth-token',credentialPolicy:'access-only',oauthToken:token}],oauthTokenExpiries:{qa:expiry},home:'/owned',now:()=>now,withMutationQueue:action=>action(),loadModule:async()=>{loaded++;throw new Error('must not load');},backend:{execFile:async()=>{io++;throw new Error('must not read');},fetch:async()=>{io++;throw new Error('must not renew');}}});
 const context={recheck:async()=>{},retried:new Set()};const owner=create();
 assert.equal((await owner({profileID:'qa',purpose:'request'},context)).accessToken,'synthetic-access');
 await assert.rejects(owner({profileID:'qa',purpose:'authentication-retry'},context),/claude_credentials_expired/);
 now+=3600000;await assert.rejects(owner({profileID:'qa',purpose:'request'},context),/claude_credentials_expired/);
 await assert.rejects(create('',now+3600000)({profileID:'qa',purpose:'request'},context),/claude_credentials_missing/);
 await assert.rejects(create('synthetic',null)({profileID:'qa',purpose:'request'},context),/claude_credentials_expired/).catch(error=>{throw error;});
 assert.equal(loaded,0);assert.equal(io,0);
});
test('original credential command waits exact subprocess close on request cancellation',async()=>{
 const {runNativeClaudeCredentialCommand}=await import('../../packages/web/server/lib/opencode/runtime-host/native-provider-runtime-owner.js');
 const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/claude-command-'));const file=path.join(root,'pid.json');
 const abort=new AbortController();let work;
 try{
  work=runNativeClaudeCredentialCommand(process.execPath,['-e',"require('fs').writeFileSync(process.argv[1],JSON.stringify(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",file],{signal:abort.signal});
  const rejected=assert.rejects(work);
  let pid;for(let n=0;n<100&&!pid;n++){try{pid=JSON.parse(await fs.readFile(file,'utf8'));}catch{}if(!pid)await new Promise(resolve=>setTimeout(resolve,10));}
  assert.ok(Number.isInteger(pid));abort.abort();await rejected;
  assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
 }finally{abort.abort();await work?.catch(()=>{});await fs.rm(root,{recursive:true,force:true});}
});

test('failed exchange persistence retains the KV prepared replacement across owner recreation',async()=>{
 const owned=fixture({expiresAt:Date.now()+1000});owned.writeRefuse();
 await assert.rejects(owned.owner({profileID:'one',purpose:'request'},owned.context()),/native_claude_refresh_failed/);
 const saved=owned.stored.get(serviceA);assert.equal(saved.claudeAiOauth.accessToken,'token-A');assert.equal(saved.devryanRefreshBlock,undefined);assert.equal(owned.state().unresolved[0].phase,'replacement-prepared');
 await assert.rejects(owned.recreate()({profileID:'one',purpose:'request'},owned.context()),/native_claude_refresh_unsettled/);assert.equal(owned.exchanges(),1);
 const good=fixture({expiresAt:Date.now()+1000});await good.owner({profileID:'one',purpose:'request'},good.context());assert.equal(good.stored.get(serviceA).devryanRefreshBlock,undefined);assert.equal(good.stored.get(serviceA).claudeAiOauth.accessToken,'token-B');
});

test('a changed credential refuses before dispatch and cancels only its undispatched KV intent',async()=>{
 const owned=fixture({expiresAt:Date.now()+1000});let reads=0;
 owned.onRead(()=>{if(++reads===2)owned.stored.set(serviceA,{...credential('new-current-account'),account:'new-owner'});});
 await assert.rejects(owned.owner({profileID:'one',purpose:'request'},owned.context()),/native_claude_account_changed/);
 assert.equal(owned.exchanges(),0);assert.ok(owned.operations.every(([operation])=>operation==='find-generic-password'));assert.equal(owned.stored.get(serviceA).account,'new-owner');
});
test('unconfirmed durable KV intent refuses before issuer dispatch without writing the credential',async()=>{
 const owned=fixture({expiresAt:Date.now()+1000});owned.onTransition(operation=>{if(operation.kind==='begin')throw new Error('native_claude_lifecycle_unverified');});
 await assert.rejects(owned.owner({profileID:'one',purpose:'request'},owned.context()),/native_claude_lifecycle_unverified/);
 assert.equal(owned.exchanges(),0);assert.equal(owned.stored.get(serviceA).claudeAiOauth.accessToken,'token-A');assert.equal(owned.state().unresolved.length,0);
 assert.ok(owned.operations.every(([operation])=>operation==='find-generic-password'));
});

test('shared and implicit authority remain access-only even when renewal policy is requested',async()=>{
 const owned=fixture({dedicated:false,expiresAt:Date.now()+120000});
 assert.equal((await owned.owner({profileID:'one',purpose:'request'},owned.context())).accessToken,'token-A');
 await assert.rejects(owned.owner({profileID:'one',purpose:'authentication-retry',failedFingerprint:fingerprint('token-A')},owned.context()),/claude_credentials_expired/);
 owned.stored.set(serviceA,credential('token-A',Date.now()-1));
 await assert.rejects(owned.recreate()({profileID:'one',purpose:'request'},owned.context()),/claude_credentials_expired/);
 assert.equal(owned.exchanges(),0);assert.equal(owned.state().revision,0);assert.ok(owned.operations.every(([operation])=>operation==='find-generic-password'));
});
test('recognized legacy fence allows current shared access but never renewal; malformed fences refuse',async()=>{
 const owned=fixture({dedicated:false,expiresAt:Date.now()+120000});const original=owned.stored.get(serviceA);
 owned.stored.set(serviceA,{...original,devryanRefreshBlock:{protocol:'devryan.claude-refresh-block/1',generation:claudeRecordFingerprint(original)}});
 assert.equal((await owned.owner({profileID:'one',purpose:'request'},owned.context())).accessToken,'token-A');
 await assert.rejects(owned.owner({profileID:'one',purpose:'authentication-retry',failedFingerprint:fingerprint('token-A')},owned.context()),/claude_credentials_expired/);
 const marked=owned.stored.get(serviceA);marked.devryanRefreshBlock.generation='a'.repeat(64);
 await assert.rejects(owned.owner({profileID:'one',purpose:'request'},owned.context()),/native_claude_legacy_fence_invalid/);
 assert.equal(owned.exchanges(),0);assert.equal(owned.state().revision,0);assert.ok(owned.operations.every(([operation])=>operation==='find-generic-password'));
});
test('status/quota resolution does not renew, write credentials, migrate fences or settle lifecycle',async()=>{
 const owned=fixture({expiresAt:Date.now()+120000}),before=owned.state();
 assert.equal((await owned.owner({profileID:'one',purpose:'request'},{...owned.context(),readOnly:true})).accessToken,'token-A');
 assert.deepEqual(owned.state(),before);assert.equal(owned.exchanges(),0);assert.ok(owned.operations.every(([operation])=>operation==='find-generic-password'));
 const expired=fixture({expiresAt:Date.now()-1});await assert.rejects(expired.owner({profileID:'one',purpose:'request'},{...expired.context(),readOnly:true}),/claude_credentials_expired/);assert.equal(expired.exchanges(),0);
});
test('prepared publication failure never writes a vendor credential or repeats issuer exchange',async()=>{
 const owned=fixture({expiresAt:Date.now()+1000});owned.onTransition(operation=>{if(operation.kind==='prepare')throw new Error('synthetic_kv_prepare_failure');});
 await assert.rejects(owned.owner({profileID:'one',purpose:'request'},owned.context()),/synthetic_kv_prepare_failure/);
 assert.equal(owned.state().unresolved[0].phase,'in-flight');assert.ok(owned.operations.every(([operation])=>operation==='find-generic-password'));
 owned.onTransition(undefined);await assert.rejects(owned.recreate()({profileID:'one',purpose:'request'},owned.context()),/native_claude_refresh_unsettled/);assert.equal(owned.exchanges(),1);
});
test('restart reconciles only the canonical prepared replacement and never repeats the issuer exchange',async()=>{
 const owned=fixture({expiresAt:Date.now()+1000});owned.onTransition(operation=>{if(operation.kind==='settle')throw new Error('synthetic_kv_settle_failure');});
 await assert.rejects(owned.owner({profileID:'one',purpose:'request'},owned.context()),/synthetic_kv_settle_failure/);
 const pending=owned.state().unresolved[0];assert.equal(pending.phase,'replacement-prepared');assert.equal(owned.stored.get(serviceA).claudeAiOauth.accessToken,'token-B');
 // Property order and serialization whitespace do not manufacture another record.
 const written=owned.stored.get(serviceA);owned.stored.set(serviceA,JSON.parse(JSON.stringify({claudeAiOauth:written.claudeAiOauth,account:written.account},null,2)));
 owned.onTransition(undefined);const result=await owned.recreate()({profileID:'one',purpose:'request'},owned.context());
 assert.equal(result.accessToken,'token-B');assert.equal(owned.exchanges(),1);assert.equal(owned.state().unresolved.length,0);
 assert.equal(owned.state().accounts[0].recordFingerprint,pending.replacementRecordFingerprint);
});
test('cancellation after a physical credential write settles the exact replacement before queue release',async()=>{
 const owned=fixture({expiresAt:Date.now()+1000}),abort=new AbortController();owned.onWrite(()=>abort.abort());
 await assert.rejects(owned.owner({profileID:'one',purpose:'request'},{...owned.context(),signal:abort.signal}));
 assert.equal(owned.stored.get(serviceA).claudeAiOauth.accessToken,'token-B');assert.equal(owned.state().unresolved.length,0);
 assert.equal((await owned.recreate()({profileID:'one',purpose:'request'},owned.context())).accessToken,'token-B');assert.equal(owned.exchanges(),1);
});
test('changed prepared record fails closed even if its access token and refresh token still match',async()=>{
 const owned=fixture({expiresAt:Date.now()+1000});owned.onTransition(operation=>{if(operation.kind==='settle')throw new Error('synthetic_kv_settle_failure');});
 await assert.rejects(owned.owner({profileID:'one',purpose:'request'},owned.context()));owned.onTransition(undefined);
 owned.stored.get(serviceA).account='unverified-external-owner';
 await assert.rejects(owned.recreate()({profileID:'one',purpose:'request'},owned.context()),/native_claude_refresh_unsettled/);assert.equal(owned.exchanges(),1);assert.equal(owned.state().unresolved.length,1);
});
test('a lost committed begin acknowledgement cancels its proved undispatched attempt before releasing ownership',async()=>{
 const owned=fixture({expiresAt:Date.now()+1000}),original=owned.lifecycle.transition;let lose=true;
 owned.lifecycle.transition=async(revision,operation)=>{
  const result=await original(revision,operation);
  if(operation.kind==='begin'&&lose){lose=false;throw Object.assign(new Error('native_claude_lifecycle_owner_expired'),{code:'native_claude_lifecycle_owner_expired'});}return result;
 };
 await assert.rejects(owned.owner({profileID:'one',purpose:'request'},owned.context()),/native_claude_lifecycle_owner_expired/);
 assert.equal(owned.exchanges(),0);assert.equal(owned.state().unresolved.length,0);
 assert.equal((await owned.recreate()({profileID:'one',purpose:'request'},owned.context())).accessToken,'token-B');assert.equal(owned.exchanges(),1);
});
test('an unverified begin receipt is never cancelled after a lost acknowledgement',async()=>{
 const owned=fixture({expiresAt:Date.now()+1000}),original=owned.lifecycle.transition,read=owned.lifecycle.read;let lose=true;
 owned.lifecycle.transition=async(revision,operation)=>{const result=await original(revision,operation);if(operation.kind==='begin'&&lose){lose=false;throw new Error('lost begin');}return result;};
 owned.lifecycle.read=async()=>{const result=await read();if(result.unresolved.length)result.unresolved[0].recordFingerprint='f'.repeat(64);return result;};
 await assert.rejects(owned.owner({profileID:'one',purpose:'request'},owned.context()),/lost begin/);assert.equal(owned.exchanges(),0);assert.equal(owned.state().unresolved.length,1);
});
