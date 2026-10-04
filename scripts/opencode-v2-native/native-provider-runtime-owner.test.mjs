import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createNativeProviderRuntimeOwner} from '../../packages/web/server/lib/opencode/runtime-host/native-provider-runtime-owner.js';
import {credentialMutationFingerprint as fingerprint} from '../../packages/web/server/lib/opencode/runtime-host/native-credential-mutation-owner.js';
import {emptyClaudeLifecycle,transitionClaudeLifecycle,claudeRecordFingerprint,claudeGrantFingerprint} from '../../packages/web/server/lib/opencode/runtime-host/native-claude-lifecycle.js';
const directory='/owned/project',instanceID='a'.repeat(32),origin={kind:'plugin',id:'devryan.provider-compat',manifestDigest:'b'.repeat(64),capabilities:['provider']};
const configuration={providers:{'github-copilot':{models:{}}}};
const binding={directory,controllerInstanceID:instanceID,integrationID:'github-copilot',acquisitionID:'actual-acquisition',configurationDigest:fingerprint(configuration.providers['github-copilot']),origin:{id:origin.id,manifestDigest:origin.manifestDigest}};
const fixture=(fetchImpl)=>{
  let selected={...binding,credential:{id:'cred_owned',integrationID:'github-copilot',value:{type:'oauth',methodID:'device',refresh:'synthetic-owned-github-token',access:'',expires:0}}};let chain=Promise.resolve(),reads=0;
  const owner=createNativeProviderRuntimeOwner({claudeSupported:true,instanceID,snapshot:{locations:[{directory,configuration}]},registrationOrigin:origin,isReady:()=>true,controller:()=>({instanceID,async call(input){assert.equal(input.action,'provider-catalog-selection-owned');reads++;return structuredClone(selected);}}),withMutationQueue:action=>{const work=chain.then(action);chain=work.catch(()=>{});return work;},admissionOwner:{withProviderAttempt:async()=>{throw new Error('not used by catalog');}},fetchImpl});
  return {owner,select:value=>{selected=value;},selected:()=>structuredClone(selected),reads:()=>reads};
};
test('constructor-owned catalog fetch preserves original official URL/headers and same selected credential',async()=>{
  const received=[];const server=http.createServer((request,response)=>{received.push({url:request.url,authorization:request.headers.authorization,version:request.headers['x-github-api-version']});response.setHeader('content-type','application/json');response.end(JSON.stringify({data:[{id:'gpt-4o-mini',model_picker_enabled:false}]}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.notEqual(typeof address,'string');
  const owned=fixture((url,options)=>{assert.equal(url,'https://api.githubcopilot.com/models');assert.equal(options.redirect,'error');return fetch(`http://127.0.0.1:${address.port}/models`,options);});
  try{assert.deepEqual(await owned.owner.catalog(binding),[{id:'gpt-4o-mini',model_picker_enabled:false}]);assert.equal(owned.reads(),2);assert.deepEqual(received,[{url:'/models',authorization:'Bearer synthetic-owned-github-token',version:'2026-06-01'}]);
    await assert.rejects(owned.owner.catalog({...binding,origin:{...binding.origin,manifestDigest:'c'.repeat(64)}}),/native_provider_catalog_binding_invalid/);assert.equal(received.length,1);
  }finally{await owned.owner.close();await new Promise(resolve=>server.close(resolve));}
});
test('catalog refuses account changes, original acquisition changes, expired access-only and owner invalidation',async()=>{
  const owned=fixture(async()=>{const next=owned.selected();next.credential.id='cred_other';owned.select(next);return Response.json({data:[]});});
  await assert.rejects(owned.owner.catalog(binding),/native_provider_catalog_selection_changed/);await owned.owner.close();
  await assert.rejects(owned.owner.catalog(binding),/native_provider_owner_expired/);
  const stale=fixture(async()=>{throw new Error('must not fetch');});const selected=stale.selected();selected.acquisitionID='old-acquisition';stale.select(selected);
  await assert.rejects(stale.owner.catalog(binding),/native_provider_catalog_selection_invalid/);await stale.owner.close();
  const expired=fixture(async()=>{throw new Error('must not fetch');});const value=expired.selected();value.credential.value.refresh='';value.credential.value.access='synthetic-expired';value.credential.value.expires=1;expired.select(value);
  await assert.rejects(expired.owner.catalog(binding),/native_copilot_refresh_required/);await expired.owner.close();
});
test('catalog stays in the shared queue through actual fetch settlement and queued work cannot run after close',async()=>{
  let release;const blocked=new Promise(resolve=>{release=resolve;});let fetched=0;
  const owned=fixture(async()=>{fetched++;await blocked;return Response.json({data:[]});});
  const first=owned.owner.catalog(binding);const firstRejected=assert.rejects(first,/native_provider_owner_expired/);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(fetched,1);
  const second=owned.owner.catalog(binding);const secondRejected=assert.rejects(second,/native_provider_owner_expired/);
  const closed=owned.owner.close();release();await closed;await Promise.all([firstRejected,secondRejected]);assert.equal(fetched,1);
});
const claudeFixture=(profiles,fetchImpl=async()=>Response.json({five_hour:{utilization:12,resets_at:new Date(Date.now()+10000).toISOString()}}))=>{
 let ready=true,instance=instanceID,grant=true,chain=Promise.resolve();const expiries=Object.fromEntries(profiles.map(row=>[row.id,Date.now()+3600000]));
 const owner=createNativeProviderRuntimeOwner({claudeSupported:true,instanceID,snapshot:{locations:[{directory,configuration}]},registrationOrigin:origin,isReady:()=>ready,controller:()=>({instanceID:instance}),withMutationQueue:action=>{const work=chain.then(action);chain=work.catch(()=>{});return work;},admissionOwner:{withProviderAttempt:async()=>{throw new Error('inspection is not inference');}},meridian:{boot:{profiles,globals:{home:'/owned'}}},claudeCredentials:{oauthTokenExpiries:expiries,loadModule:async()=>{throw new Error('no Keychain/module for access-only');}},fetchImpl});
 return {owner,expiries,recheck:async()=>{if(!grant)throw Object.assign(new Error('revoked'),{code:'permission_denied',status:403});},revoke:()=>{grant=false;},stop:()=>{ready=false;},replace:()=>{instance='b'.repeat(32);}};
};
test('inspection reads only one explicit selected access-only account; missing/expired/ambiguous never fetch',async()=>{
 let calls=0;const profiles=[{id:'qa',type:'oauth-token',credentialPolicy:'access-only',oauthToken:'synthetic-token'}];const owned=claudeFixture(profiles,async(url,options)=>{calls++;assert.equal(url,'https://api.anthropic.com/api/oauth/usage');assert.equal(options.headers.Authorization,'Bearer synthetic-token');return Response.json({five_hour:{utilization:12}});});
 try{assert.equal((await owned.owner.inspectClaude({directory,kind:'status'},{recheck:owned.recheck})).loggedIn,true);assert.equal(calls,0);
  const quota=await owned.owner.inspectClaude({directory,kind:'quota'},{recheck:owned.recheck});assert.equal(quota.ok,true);assert.equal(calls,1);assert.ok(!JSON.stringify(quota).includes('synthetic-token'));
  owned.expiries.qa=1;await assert.rejects(owned.owner.inspectClaude({directory,kind:'quota'},{recheck:owned.recheck}),/claude_credentials_expired/);assert.equal(calls,1);
 }finally{await owned.owner.close();}
 for(const rows of [[],[...profiles,{id:'other',type:'claude-max'}],[{id:'legacy',type:'oauth-token',oauthToken:'synthetic'}]]){
  const owned=claudeFixture(rows,async()=>{throw new Error('must not fetch');});try{await assert.rejects(owned.owner.inspectClaude({directory,kind:'quota'},{recheck:owned.recheck}),/claude_credentials_missing|native_claude_account_ambiguous|native_claude_profile_unreviewed/);}finally{await owned.owner.close();}
 }
});
test('inspection rechecks authorization/controller after async HTTP and drains cancellation without CLI fallback',async()=>{
 const profile=[{id:'qa',type:'oauth-token',credentialPolicy:'access-only',oauthToken:'synthetic'}];
 for(const change of ['revoke','replace']){
  let owned;owned=claudeFixture(profile,async()=>{owned[change]();return Response.json({five_hour:{utilization:12}});});
  try{await assert.rejects(owned.owner.inspectClaude({directory,kind:'quota'},{recheck:owned.recheck}),/revoked|native_provider_owner_expired/);}finally{await owned.owner.close();}
 }
 let fetched;const started=new Promise(resolve=>{fetched=resolve;});const server=http.createServer(()=>{fetched();});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();const owned=claudeFixture(profile,(_url,options)=>fetch(`http://127.0.0.1:${address.port}/usage`,options));
 try{const work=owned.owner.inspectClaude({directory,kind:'quota'},{recheck:owned.recheck});const rejected=assert.rejects(work);await started;await owned.owner.close();await rejected;}
 finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('non-OK usage responses are cancelled before queue release and held body requests drain on abort',async()=>{
 const {fetchSelectedClaudeQuota}=await import('../../packages/web/server/lib/opencode/runtime-host/native-claude-inspection.js');
 let cancelled=false;const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('private failure body'));},cancel(){cancelled=true;}});
 await assert.rejects(fetchSelectedClaudeQuota({accessToken:'synthetic',fetchImpl:async()=>new Response(stream,{status:401})}),/native_claude_quota_unavailable/);assert.equal(cancelled,true);
 let arrived,closed;const began=new Promise(resolve=>{arrived=resolve;}),ended=new Promise(resolve=>{closed=resolve;});
 const server=http.createServer((_request,response)=>{response.writeHead(200,{'content-type':'application/json'});response.write('{');arrived();response.once('close',closed);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address(),abort=new AbortController();
 try{
  const work=fetchSelectedClaudeQuota({accessToken:'synthetic',signal:abort.signal,fetchImpl:(_url,options)=>fetch(`http://127.0.0.1:${address.port}/usage`,options)});const rejected=assert.rejects(work);await began;abort.abort();await rejected;await ended;
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('unsupported Claude capability refuses before inspection or worker activity without breaking other catalogs',async()=>{
 let touched=0;const owner=createNativeProviderRuntimeOwner({claudeSupported:false,instanceID,snapshot:{locations:[{directory,configuration}]},registrationOrigin:origin,isReady:()=>true,
  controller:()=>({instanceID,call:async()=>{touched++;throw new Error('must not call');}}),withMutationQueue:action=>action(),admissionOwner:{withProviderAttempt:async(_input,action)=>action(async()=>{})},
  meridian:{boot:{profiles:[{id:'one',type:'claude-max'}],globals:{home:'/owned'}}},prepareMeridianProfiles:async()=>{touched++;throw new Error('must not project');},claudeCredentials:{loadModule:async()=>{touched++;throw new Error('must not load');}}});
 try{await assert.rejects(owner.inspectClaude({directory,kind:'status'},{recheck:async()=>{touched++;}}),/native_claude_update_required/);await assert.rejects(owner.withMeridian({directory,sessionID:'ses_owned'},async()=>{touched++;}),/native_claude_update_required/);assert.equal(touched,0);}
 finally{await owner.close();}
});

test('credential resolution retains original enrollment profiles when worker configuration paths are projected',async()=>{
 const profile={id:'dedicated',type:'claude-max',claudeConfigDir:'/owned/stable/enrollment',keychainService:'Claude Code-credentials-01234567'};
 const value={claudeAiOauth:{accessToken:'synthetic-access',refreshToken:'synthetic-refresh',expiresAt:Date.now()+3600000}};
 const state=transitionClaudeLifecycle(emptyClaudeLifecycle(),0,{kind:'enroll',account:{profileID:profile.id,service:profile.keychainService,configDirectory:profile.claudeConfigDir,enrollmentID:'enrolled',generation:'generation',recordFingerprint:claudeRecordFingerprint(value),grantFingerprint:claudeGrantFingerprint(value.claudeAiOauth.refreshToken)}});
 let reads=0,projected=0;
 const owner=createNativeProviderRuntimeOwner({claudeSupported:true,instanceID,snapshot:{locations:[{directory,configuration}]},registrationOrigin:origin,isReady:()=>true,controller:()=>({instanceID}),withMutationQueue:action=>action(),admissionOwner:{withProviderAttempt:async()=>{throw new Error('inspection is not inference');}},
  meridian:{boot:{profiles:[{...profile,claudeConfigDir:'/owned/home/empty-worker'}],globals:{home:'/owned/home'}}},prepareMeridianProfiles:async()=>{projected++;throw new Error('inspection must not project');},
  claudeCredentials:{profiles:[profile],lifecycle:{read:async()=>state,transition:async()=>{throw new Error('inspection must not change lifecycle');}},loadModule:async()=>({createPlatformCredentialStore:options=>{assert.equal(options.serviceName,profile.keychainService);return {read:async()=>{reads++;return value;}};}})}});
 try{assert.equal((await owner.inspectClaude({directory,kind:'status'},{recheck:async()=>{}})).loggedIn,true);assert.equal(projected,0);assert.equal(reads,3);}
 finally{await owner.close();}
});
test('owner close cancels and drains pending profile projection before any provider worker can launch',async()=>{
 let entered,release,signal;const begun=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const owner=createNativeProviderRuntimeOwner({claudeSupported:true,instanceID,snapshot:{locations:[{directory,configuration}]},registrationOrigin:origin,isReady:()=>true,controller:()=>({instanceID}),withMutationQueue:action=>action(),admissionOwner:{withProviderAttempt:async(_input,action)=>action(async()=>{})},
  meridian:{binary:'/must-not-launch',boot:{profiles:[],globals:{home:'/owned'}}},prepareMeridianProfiles:async context=>{signal=context.signal;entered();await gate;return [];}});
 const work=owner.withMeridian({directory,sessionID:'ses_owned'},async()=>{throw new Error('must not bind');});const rejected=assert.rejects(work,/native_provider_owner_expired/);
 await begun;const closing=owner.close();assert.equal(signal.aborted,true);release();await closing;await rejected;
});
