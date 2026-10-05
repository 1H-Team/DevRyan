import {afterEach,expect,test} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createNativeClaudeEnrollmentOwner} from './native-claude-enrollment.js';
import {emptyClaudeLifecycle,transitionClaudeLifecycle} from './native-claude-lifecycle.js';
import {rewriteReviewedClaudeCredentials} from './reviewed-claude-transform.js';

const roots=[];
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
async function fixture(){
 const base=await fs.realpath(path.resolve('../../.cache/v2-validation'));const root=await fs.mkdtemp(path.join(base,'claude-enrollment-'));roots.push(root);
 const source=await fs.readFile(new URL('../../../../runtime/reviewed-inputs/claude-1.8.0/node_modules/@rynfar/meridian/dist/cli-khhjyk04.js',import.meta.url));
 const module=await import('data:text/javascript;base64,'+Buffer.from(rewriteReviewedClaudeCredentials(source)).toString('base64'));
 const records=new Map(),calls=[],published=[];let state=emptyClaudeLifecycle(),valid=true,exchanges=0,beforeExchange=async()=>{},beforeWrite=async()=>{},afterWrite=async()=>{},afterTransition=async()=>{},transitionFault;
 let token={access_token:'fresh-access',refresh_token:'fresh-grant',expires_in:3600,scope:'user:profile user:inference'};
 let queue=Promise.resolve();const mutation=action=>{const work=queue.then(action);queue=work.catch(()=>{});return work;};
 const execute=async(file,args)=>{
  expect(file).toBe('/usr/bin/security');const service=args[args.indexOf('-s')+1];calls.push(args[0]);
  if(args[0]==='find-generic-password'){if(!records.has(service))throw Object.assign(new Error('missing'),{code:44});return{stdout:args.includes('-w')?JSON.stringify(records.get(service)):''};}
  expect(args[0]).toBe('add-generic-password');expect(args).not.toContain('-U');await beforeWrite(service);
  if(records.has(service))throw Object.assign(new Error('collision'),{code:45});records.set(service,JSON.parse(args[args.indexOf('-w')+1]));await afterWrite();return{stdout:''};
 };
 const options={controlRoot:root,home:root,asset:{},lifecycle:{read:async()=>structuredClone(state),transition:async(revision,action)=>{if(transitionFault)await transitionFault(action);state=transitionClaudeLifecycle(state,revision,action);await afterTransition(action);return state;}},withMutationQueue:mutation,
  captureBinding:async()=>({principal:'admin',revision:1}),recheckBinding:async()=>{if(!valid)throw Object.assign(new Error('revoked'),{code:'web_authorization_revoked',status:403});},
  publishProfile:async profile=>published.push(profile),loadModule:async()=>module,execute,
  fetchImpl:async(url,request)=>{expect(url).toBe('https://platform.claude.com/v1/oauth/token');exchanges++;await beforeExchange();const body=JSON.parse(request.body);expect(body.grant_type).toBe('authorization_code');expect(body.code_verifier).toHaveLength(43);return new Response(JSON.stringify(token));},
 };
 const owner=createNativeClaudeEnrollmentOwner(options);
 const start=async()=>{const pending=await owner.begin({});return{...pending,code:'original-user-code',state:new URL(pending.url).searchParams.get('state')};};
 return{owner,options,start,records,calls,published,get state(){return state;},replaceState:value=>{state=structuredClone(value);},get exchanges(){return exchanges;},revoke:()=>{valid=false;},restore:()=>{valid=true;},token:value=>{token=value;},afterTransition:fn=>{afterTransition=fn;},beforeExchange:fn=>{beforeExchange=fn;},beforeWrite:fn=>{beforeWrite=fn;},afterWrite:fn=>{afterWrite=fn;},transitionFault:fn=>{transitionFault=fn;}};
}

const fullLifecycle=()=>({protocol:'devryan.claude-lifecycle/1',revision:1,unresolved:[],accounts:Array.from({length:64},(_,index)=>({
 profileID:'existing-'+index,service:'Claude Code-credentials-'+index.toString(16).padStart(8,'0'),configDirectory:'/owned/existing/'+index,
 enrollmentID:'existing-'+index,generation:'generation-'+index,grantFingerprint:index.toString(16).padStart(64,'0'),recordFingerprint:(index+64).toString(16).padStart(64,'0'),
}))});

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
