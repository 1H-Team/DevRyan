import {afterEach,expect,test} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os,{userInfo} from 'node:os';
import {createNativeClaudeEnrollmentOwner} from './native-claude-enrollment.js';
import {emptyClaudeLifecycle,transitionClaudeLifecycle} from './native-claude-lifecycle.js';
import {rewriteReviewedClaudeCredentials} from './reviewed-claude-transform.js';

const roots=[];
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
async function fixture(){
 const base=await fs.realpath(os.tmpdir());const root=await fs.mkdtemp(path.join(base,'devryan-claude-enrollment-'));roots.push(root);
 const source=await fs.readFile(new URL('../../../../runtime/reviewed-inputs/claude-1.11.2/node_modules/@rynfar/meridian/dist/cli-chsp880k.js',import.meta.url));
 const module=await import('data:text/javascript;base64,'+Buffer.from(rewriteReviewedClaudeCredentials(source)).toString('base64'));
 const records=new Map(),calls=[],published=[];let state=emptyClaudeLifecycle(),valid=true,exchanges=0,beforeExchange=async()=>{},beforeWrite=async()=>{},afterWrite=async()=>{},afterTransition=async()=>{},transitionFault;
 let token={access_token:'fresh-access',refresh_token:'fresh-grant',expires_in:3600,scope:'user:profile user:inference'},beforeDelete=async()=>{},removalFault;
 let queue=Promise.resolve();const mutation=action=>{const work=queue.then(action);queue=work.catch(()=>{});return work;};
 const execute=async(file,args)=>{
  expect(file).toBe('/usr/bin/security');const service=args[args.indexOf('-s')+1];calls.push(args[0]);
  if(args[0]==='find-generic-password'){if(!records.has(service))throw Object.assign(new Error('missing'),{code:44});return{stdout:args.includes('-w')?JSON.stringify(records.get(service)):''};}
  if(args[0]==='delete-generic-password'){expect(args).toEqual(['delete-generic-password','-s',service,'-a',fAccount]);await beforeDelete();if(!records.delete(service))throw Object.assign(Error('missing'),{code:44});return{stdout:''};}
  expect(args[0]).toBe('add-generic-password');expect(args).not.toContain('-U');await beforeWrite(service);
  if(records.has(service))throw Object.assign(new Error('collision'),{code:45});records.set(service,JSON.parse(args[args.indexOf('-w')+1]));await afterWrite();return{stdout:''};
 };
 const fAccount=userInfo().username;
 const options={controlRoot:root,home:root,account:fAccount,asset:{},lifecycle:{read:async()=>structuredClone(state),transition:async(revision,action)=>{if(transitionFault)await transitionFault(action);state=transitionClaudeLifecycle(state,revision,action);await afterTransition(action);return state;}},withMutationQueue:mutation,
  captureBinding:async()=>({principal:'admin',revision:1}),recheckBinding:async()=>{if(!valid)throw Object.assign(new Error('revoked'),{code:'web_authorization_revoked',status:403});},
  publishProfile:async profile=>published.push(profile),loadModule:async()=>module,execute,
  withProfileRemoval:action=>action(),assertProfileRemoval:async profile=>{if(published.at(-1)?.id===profile.id)throw Object.assign(Error('selected'),{code:'native_claude_enrollment_selected'});},
  removeProfile:async profile=>{if(removalFault)await removalFault();for(let i=published.length-1;i>=0;i--)if(published[i].id===profile.id)published.splice(i,1);},
  recheckAfterRemoval:async()=>{if(!valid)throw Object.assign(Error('revoked'),{status:403});},
  fetchImpl:async(url,request)=>{expect(url).toBe('https://platform.claude.com/v1/oauth/token');exchanges++;await beforeExchange();const body=JSON.parse(request.body);expect(body.grant_type).toBe('authorization_code');expect(body.code_verifier).toHaveLength(43);return new Response(JSON.stringify(token));},
 };
 const owner=createNativeClaudeEnrollmentOwner(options);
 const start=async()=>{const pending=await owner.begin({});return{...pending,code:'original-user-code',state:new URL(pending.url).searchParams.get('state')};};
 return{owner,options,start,records,calls,published,get state(){return state;},replaceState:value=>{state=structuredClone(value);},get exchanges(){return exchanges;},revoke:()=>{valid=false;},restore:()=>{valid=true;},token:value=>{token=value;},afterTransition:fn=>{afterTransition=fn;},beforeExchange:fn=>{beforeExchange=fn;},beforeWrite:fn=>{beforeWrite=fn;},afterWrite:fn=>{afterWrite=fn;},transitionFault:fn=>{transitionFault=fn;},beforeDelete:fn=>{beforeDelete=fn;},removalFault:fn=>{removalFault=fn;}};
}

const fullLifecycle=()=>({protocol:'devryan.claude-lifecycle/1',revision:1,unresolved:[],accounts:Array.from({length:64},(_,index)=>({
 profileID:'existing-'+index,service:'Claude Code-credentials-'+index.toString(16).padStart(8,'0'),configDirectory:'/owned/existing/'+index,
 enrollmentID:'existing-'+index,generation:'generation-'+index,grantFingerprint:index.toString(16).padStart(64,'0'),recordFingerprint:(index+64).toString(16).padStart(64,'0'),
}))});

test('deletes one exact unselected enrollment while retaining the working account and selection',async()=>{
 const f=await fixture(),first=await f.start();await f.owner.complete(first.enrollmentID,{code:first.code,state:first.state},{});
 f.token({access_token:'working-access',refresh_token:'working-grant',expires_in:3600});
 const working=await f.start();await f.owner.complete(working.enrollmentID,{code:working.code,state:working.state},{});await f.owner.select(working.enrollmentID,{});
 const preserved=structuredClone(f.state.accounts[1]),record=structuredClone(f.records.get(preserved.service));
 expect(await f.owner.remove(first.enrollmentID,{})).toEqual({enrollmentID:first.enrollmentID,profileID:`devryan-${first.enrollmentID}`,status:'deleted'});
 expect(f.state.accounts).toEqual([preserved]);expect(f.state.unresolved).toEqual([]);expect(f.records.get(preserved.service)).toEqual(record);
 expect(f.published.at(-1).id).toBe(preserved.profileID);expect(f.exchanges).toBe(2);
 await expect(f.owner.remove(working.enrollmentID,{})).rejects.toMatchObject({code:'native_claude_enrollment_selected'});
 expect(f.records.get(preserved.service)).toEqual(record);await f.owner.close();
});

test.each([false,true])('deletes incomplete enrollment with missing credential=%s without exchanging or renewing',async missing=>{
 const f=await fixture(),p=await f.start();f.transitionFault(action=>{if(action.kind==='settle-enrollment')throw Error('fixture interrupted enrollment');});
 await expect(f.owner.complete(p.enrollmentID,{code:p.code,state:p.state},{})).rejects.toMatchObject({code:'native_claude_enrollment_failed'});
 if(missing)f.records.clear();f.transitionFault(undefined);
 expect((await f.owner.list({}))[0].status).toBe('incomplete');
 expect((await f.owner.remove(p.enrollmentID,{})).status).toBe('deleted');expect(f.state.unresolved).toEqual([]);expect(f.records.size).toBe(0);expect(f.exchanges).toBe(1);await f.owner.close();
});

test('partial deletion remains listed and retryable after restart, without deleting a changed credential',async()=>{
 const f=await fixture(),p=await f.start();await f.owner.complete(p.enrollmentID,{code:p.code,state:p.state},{});
 const original=structuredClone(f.state.accounts[0]);f.removalFault(()=>{throw Error('profile write failed');});
 await expect(f.owner.remove(p.enrollmentID,{})).rejects.toMatchObject({code:'native_claude_enrollment_failed'});
 expect(f.state.unresolved[0].phase).toBe('deletion-prepared');expect(f.records.size).toBe(0);await f.owner.close();
 const restarted=createNativeClaudeEnrollmentOwner(f.options);expect((await restarted.list({}))[0].status).toBe('deleting');
 f.records.set(original.service,{claudeAiOauth:{accessToken:'foreign',refreshToken:'foreign-grant'}});
 await expect(restarted.remove(p.enrollmentID,{})).rejects.toMatchObject({code:'native_claude_enrollment_account_changed'});
 expect(f.records.get(original.service).claudeAiOauth.accessToken).toBe('foreign');
 f.records.clear();f.removalFault(undefined);expect((await restarted.remove(p.enrollmentID,{})).status).toBe('deleted');
 expect(f.state.accounts).toEqual([]);expect(f.state.unresolved).toEqual([]);await restarted.close();
});

test('unavailable missing directory retains exact credential deletion authority, while dangling links refuse',async()=>{
 for(const linked of [false,true]){
  const f=await fixture(),p=await f.start();await f.owner.complete(p.enrollmentID,{code:p.code,state:p.state},{});
  const row=f.state.accounts[0];await fs.rmdir(row.configDirectory);
  if(linked)await fs.symlink(path.join(f.options.controlRoot,'absent-foreign'),row.configDirectory);
  expect((await f.owner.list({}))[0].status).toBe('unavailable');
  if(linked){await expect(f.owner.remove(p.enrollmentID,{})).rejects.toMatchObject({code:'native_claude_enrollment_receipt_invalid'});expect(f.records.size).toBe(1);}
  else{expect((await f.owner.remove(p.enrollmentID,{})).status).toBe('deleted');expect(f.records.size).toBe(0);}
  await f.owner.close();
 }
});

test('refuses refresh intents, foreign service and record edits before credential deletion',async()=>{
 for(const fault of ['refresh','service','record']){
  const f=await fixture(),p=await f.start();await f.owner.complete(p.enrollmentID,{code:p.code,state:p.state},{});const row=f.state.accounts[0];
  if(fault==='refresh')f.replaceState(transitionClaudeLifecycle(f.state,f.state.revision,{kind:'begin',account:row,attemptID:'active-refresh'}));
  if(fault==='service')f.replaceState({...f.state,accounts:[{...row,service:'Claude Code-credentials'}]});
  if(fault==='record')f.records.set(row.service,{claudeAiOauth:{accessToken:'changed',refreshToken:'changed'}});
  await expect(f.owner.remove(p.enrollmentID,{})).rejects.toMatchObject({code:fault==='refresh'?'native_claude_enrollment_busy':fault==='service'?'native_claude_enrollment_receipt_invalid':'native_claude_enrollment_account_changed'});
  expect(f.calls).not.toContain('delete-generic-password');expect(f.records.size).toBe(1);await f.owner.close();
 }
});

test('nonempty directories and replaced deletion directories remain fenced for explicit recovery',async()=>{
 const f=await fixture(),p=await f.start();await f.owner.complete(p.enrollmentID,{code:p.code,state:p.state},{});const row=f.state.accounts[0];
 await fs.writeFile(path.join(row.configDirectory,'unexpected'),'preserve');
 await expect(f.owner.remove(p.enrollmentID,{})).rejects.toMatchObject({code:'native_claude_enrollment_failed'});
 expect(await fs.readFile(path.join(row.configDirectory,'unexpected'),'utf8')).toBe('preserve');
 await fs.rename(row.configDirectory,row.configDirectory+'-original');await fs.mkdir(row.configDirectory,{mode:0o700});
 await expect(f.owner.remove(p.enrollmentID,{})).rejects.toMatchObject({code:'native_claude_enrollment_receipt_invalid'});
 expect(f.state.unresolved[0].phase).toBe('deletion-prepared');await f.owner.close();
});
test('incomplete deletion distinguishes proved missing credentials from unreadable records',async()=>{
 const f=await fixture(),p=await f.start();f.transitionFault(action=>{if(action.kind==='settle-enrollment')throw Error('incomplete');});
 await f.owner.complete(p.enrollmentID,{code:p.code,state:p.state},{}).catch(()=>{});f.transitionFault(undefined);
 const row=f.state.unresolved[0];f.records.set(row.service,null);
 await expect(f.owner.remove(p.enrollmentID,{})).rejects.toMatchObject({code:'native_claude_enrollment_persistence_failed'});
 expect(f.calls).not.toContain('delete-generic-password');expect(f.state.unresolved[0].phase).toBe('enrollment-prepared');await f.owner.close();
});

test('capacity refusal precedes a URL or issuer exchange and retains every existing account',async()=>{
 const f=await fixture(),full=fullLifecycle();f.replaceState(full);
 await expect(f.start()).rejects.toMatchObject({code:'native_claude_enrollment_capacity'});
 expect(f.exchanges).toBe(0);expect(f.records.size).toBe(0);expect(f.state).toEqual(full);
 expect(await fs.readdir(path.join(f.options.controlRoot,'claude-enrollments'))).toEqual([]);await f.owner.close();
 const g=await fixture(),p=await g.start();g.replaceState(full);
 await expect(g.owner.complete(p.enrollmentID,{code:p.code,state:p.state},{})).rejects.toMatchObject({code:'native_claude_enrollment_capacity'});
 expect(g.exchanges).toBe(0);expect(g.records.size).toBe(0);expect(g.state).toEqual(full);
 expect(await fs.readdir(path.join(g.options.controlRoot,'claude-enrollments'))).toEqual([]);await g.owner.close();
});

test('fresh original factory enrollment publishes KV authority only after readback and selects only explicitly',async()=>{
 const f=await fixture(),pending=await f.start();const url=new URL(pending.url);expect(url.origin).toBe('https://claude.com');expect(url.searchParams.get('code_challenge_method')).toBe('S256');
 const result=await f.owner.complete(pending.enrollmentID,{code:pending.code,state:pending.state},{});
 expect(result.status).toBe('enrolled');expect(f.exchanges).toBe(1);expect(f.state.accounts).toHaveLength(1);expect(f.published).toHaveLength(0);
 expect(JSON.stringify(result)).not.toContain('fresh-');await f.owner.select(pending.enrollmentID,{});expect(f.published).toHaveLength(1);expect(f.published[0].claudeConfigDir).toBe(f.state.accounts[0].configDirectory);await f.owner.close();
});
test('rejects foreign state and extra callback authority without issuer work',async()=>{
 const f=await fixture(),p=await f.start();await expect(f.owner.complete(p.enrollmentID,{code:p.code,state:'foreign'},{})).rejects.toMatchObject({code:'native_claude_enrollment_callback_invalid'});
 await expect(f.owner.complete(p.enrollmentID,{code:p.code,state:p.state,service:'foreign'},{})).rejects.toMatchObject({code:'native_claude_enrollment_callback_invalid'});expect(f.exchanges).toBe(0);await f.owner.close();
});
test('never retries an exchanged callback and never claims imported service authority',async()=>{
 const f=await fixture(),p=await f.start();await f.owner.complete(p.enrollmentID,{code:p.code,state:p.state},{});await expect(f.owner.complete(p.enrollmentID,{code:p.code,state:p.state},{})).rejects.toMatchObject({code:'native_claude_enrollment_callback_invalid'});expect(f.exchanges).toBe(1);await f.owner.close();
});
test('a fresh callback cannot alias an already enrolled grant into another service',async()=>{
 const f=await fixture(),first=await f.start();await f.owner.complete(first.enrollmentID,{code:first.code,state:first.state},{});
 const second=await f.start();await expect(f.owner.complete(second.enrollmentID,{code:second.code,state:second.state},{})).rejects.toMatchObject({code:'native_claude_enrollment_collision'});
 expect(f.exchanges).toBe(2);expect(f.records.size).toBe(1);expect(f.state.accounts).toHaveLength(1);await f.owner.close();
});
test('revocation during fresh exchange prevents credential publication and KV enrollment',async()=>{
 const f=await fixture(),p=await f.start();f.beforeExchange(async()=>f.revoke());await expect(f.owner.complete(p.enrollmentID,{code:p.code,state:p.state},{})).rejects.toMatchObject({code:'native_claude_enrollment_refused',status:403});expect(f.records.size).toBe(0);expect(f.state.accounts).toHaveLength(0);await f.owner.close();
});
test.each([null,[],{expires_in:'3600'},{expires_in:[]},{expires_at:'9999999999999'},{scope:''},{scope:[]}])('rejects malformed issuer expiry/body/scopes before original-store publication: %j',async malformed=>{
 const f=await fixture(),p=await f.start();f.token(malformed===null||Array.isArray(malformed)?malformed:{access_token:'fresh-access',refresh_token:'fresh-grant',...malformed});
 await expect(f.owner.complete(p.enrollmentID,{code:p.code,state:p.state},{})).rejects.toMatchObject({code:'native_claude_enrollment_response_invalid'});expect(f.records.size).toBe(0);expect(f.state.accounts).toHaveLength(0);await f.owner.close();
});
test('committed enrollment survives post-KV revocation and selects with fresh authorization without issuer retry',async()=>{
 const f=await fixture(),p=await f.start();f.afterTransition(async action=>{if(action.kind==='settle-enrollment')f.revoke();});await expect(f.owner.complete(p.enrollmentID,{code:p.code,state:p.state},{})).rejects.toMatchObject({status:403});
 expect(f.state.accounts).toHaveLength(1);f.restore();await f.owner.select(p.enrollmentID,{});expect(f.published).toHaveLength(1);expect(f.exchanges).toBe(1);await f.owner.close();
});
test('refuses a directory replaced during issuer work before KV or credential publication',async()=>{
 const f=await fixture(),p=await f.start(),directory=path.join(f.options.controlRoot,'claude-enrollments',p.enrollmentID);
 f.beforeExchange(async()=>{await fs.rename(directory,directory+'-saved');await fs.symlink(directory+'-saved',directory);});
 await expect(f.owner.complete(p.enrollmentID,{code:p.code,state:p.state},{})).rejects.toMatchObject({code:'native_claude_enrollment_receipt_invalid'});
 expect(f.records.size).toBe(0);expect(f.state.accounts).toHaveLength(0);await f.owner.close();
});
test('adopts configured legacy ambiguity before URL and again before fresh grant publication',async()=>{
 const f=await fixture();await f.owner.close();let migrated=0;
 const owner=createNativeClaudeEnrollmentOwner({...f.options,beforeEnrollment:async({recheck})=>{migrated++;await recheck();}});
 const p=await owner.begin({});expect(migrated).toBe(1);
 await owner.complete(p.enrollmentID,{code:'new-code',state:new URL(p.url).searchParams.get('state')},{});expect(migrated).toBe(2);await owner.close();
});
test('owner close drains actual exchange and never publishes a late reply',async()=>{
 const f=await fixture(),p=await f.start();let release;const wait=new Promise(resolve=>{release=resolve;});let entered;
 const started=new Promise(resolve=>{entered=resolve;});f.beforeExchange(async()=>{entered();await wait;});
 const work=f.owner.complete(p.enrollmentID,{code:p.code,state:p.state},{});const outcome=work.catch(error=>error);await started;
 let closed=false;const closing=f.owner.close().then(()=>{closed=true;});await Promise.resolve();expect(closed).toBe(false);release();await closing;
 expect((await outcome).code).toBe('native_claude_enrollment_closed');expect(f.records.size).toBe(0);expect(f.state.accounts).toHaveLength(0);
});
test('exclusive original-store add refuses a service appearing after the absence probe',async()=>{
 const f=await fixture(),p=await f.start();const foreign={claudeAiOauth:{accessToken:'replacement'}};f.beforeWrite(async service=>{f.records.set(service,foreign);});
 await expect(f.owner.complete(p.enrollmentID,{code:p.code,state:p.state},{})).rejects.toMatchObject({code:'native_claude_enrollment_persistence_failed'});expect([...f.records.values()]).toEqual([foreign]);expect(f.state.accounts).toHaveLength(0);await f.owner.close();
});
test('completed enrollment can be selected after host recreation using KV authority and original store proof',async()=>{
 const f=await fixture(),p=await f.start();await f.owner.complete(p.enrollmentID,{code:p.code,state:p.state},{});await f.owner.close();const replacement=createNativeClaudeEnrollmentOwner(f.options);
 expect(await replacement.list({})).toEqual([{enrollmentID:p.enrollmentID,profileID:f.state.accounts[0].profileID,status:'enrolled'}]);await replacement.select(p.enrollmentID,{});expect(f.published).toHaveLength(1);expect(f.exchanges).toBe(1);await replacement.close();
});
test('recreated owner refuses externally replaced enrolled credential',async()=>{
 const f=await fixture(),p=await f.start();await f.owner.complete(p.enrollmentID,{code:p.code,state:p.state},{});await f.owner.close();f.records.set(f.state.accounts[0].service,{claudeAiOauth:{accessToken:'foreign'}});const replacement=createNativeClaudeEnrollmentOwner(f.options);
 await expect(replacement.select(p.enrollmentID,{})).rejects.toMatchObject({code:'native_claude_enrollment_account_changed'});expect(f.published).toHaveLength(0);await replacement.close();
});
test.each(['revoked','settlement-conflict'])('a vendor write retains a recoverable intent after %s, without repeating the issuer',async fault=>{
 const f=await fixture(),p=await f.start();
 if(fault==='revoked')f.afterWrite(async()=>f.revoke());
 else f.transitionFault(async action=>{if(action.kind==='settle-enrollment')throw Object.assign(new Error('conflict'),{code:'native_claude_lifecycle_conflict'});});
 await expect(f.owner.complete(p.enrollmentID,{code:p.code,state:p.state},{})).rejects.toMatchObject({code:fault==='revoked'?'native_claude_enrollment_refused':'native_claude_enrollment_failed'});
 expect(f.records.size).toBe(1);expect(f.state.accounts).toHaveLength(0);expect(f.state.unresolved[0].phase).toBe('enrollment-prepared');
 await f.owner.close();f.restore();f.transitionFault(undefined);f.afterWrite(async()=>{});
 const replacement=createNativeClaudeEnrollmentOwner(f.options);
 expect(await replacement.list({})).toEqual([{enrollmentID:p.enrollmentID,profileID:f.state.unresolved[0].profileID,status:'incomplete'}]);
 expect((await replacement.select(p.enrollmentID,{})).status).toBe('selected');expect(f.state.accounts).toHaveLength(1);expect(f.state.unresolved).toEqual([]);expect(f.exchanges).toBe(1);await replacement.close();
});
test('a failed intent commit never writes a vendor credential, and a foreign record cannot settle an intent',async()=>{
 const f=await fixture(),p=await f.start();f.transitionFault(async()=>{throw new Error('commit failed');});
 await expect(f.owner.complete(p.enrollmentID,{code:p.code,state:p.state},{})).rejects.toMatchObject({code:'native_claude_enrollment_failed'});
 expect(f.records.size).toBe(0);expect(f.state.unresolved).toEqual([]);await f.owner.close();
 const g=await fixture(),q=await g.start();g.beforeWrite(async service=>g.records.set(service,{claudeAiOauth:{accessToken:'foreign'}}));
 await expect(g.owner.complete(q.enrollmentID,{code:q.code,state:q.state},{})).rejects.toMatchObject({code:'native_claude_enrollment_persistence_failed'});
 expect(g.state.accounts).toHaveLength(0);expect(g.state.unresolved[0].phase).toBe('enrollment-prepared');
 await expect(g.owner.select(q.enrollmentID,{})).rejects.toMatchObject({code:'native_claude_enrollment_account_changed'});expect(g.published).toEqual([]);await g.owner.close();
});
test('abandoned starts remove only their own empty directories; one damaged enrollment does not hide healthy rows',async()=>{
 const f=await fixture();await f.start();await f.start();await f.owner.close();
 expect(await fs.readdir(path.join(f.options.controlRoot,'claude-enrollments'))).toEqual([]);
 const g=await fixture(),a=await g.start();await g.owner.complete(a.enrollmentID,{code:a.code,state:a.state},{});
 g.token({access_token:'second-access',refresh_token:'second-grant',expires_in:3600});const b=await g.start();await g.owner.complete(b.enrollmentID,{code:b.code,state:b.state},{});
 await fs.chmod(path.join(g.options.controlRoot,'claude-enrollments',a.enrollmentID),0o750);
 expect((await g.owner.list({})).map(row=>row.status)).toEqual(['unavailable','enrolled']);expect((await g.owner.select(b.enrollmentID,{})).status).toBe('selected');await g.owner.close();
});
test('a non-private control root is refused before issuer, credential or lifecycle work',async()=>{
 const f=await fixture();await fs.chmod(f.options.controlRoot,0o755);
 await expect(f.owner.begin({})).rejects.toMatchObject({code:'native_claude_enrollment_root_invalid'});expect(f.exchanges).toBe(0);expect(f.records.size).toBe(0);expect(f.state.accounts).toEqual([]);await f.owner.close();
});
