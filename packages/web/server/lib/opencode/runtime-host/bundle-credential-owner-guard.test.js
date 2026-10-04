import fs from 'node:fs/promises';
import path from 'node:path';
import {afterEach,expect,test} from 'vitest';
import {captureBundleCredentialOwners,assertBundleCredentialOwners} from './bundle-credential-owner-guard.js';
import {createSessionVault} from '../../multi-user/vault.js';
import {createMultiUserRuntime} from '../../multi-user/runtime.js';
import {relocateNativeSetupProfiles} from './native-setup-profiles.js';

const roots=[];
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
const put=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,typeof value==='string'?value:JSON.stringify(value));};
async function fixture(){
 const root=await fs.mkdtemp(path.resolve(import.meta.dirname,'../../../../../../.cache/v2-validation/credential-owner-'));roots.push(root);
 const descriptor=name=>({bundleID:name,...name==='B'?{sourceBundleID:'A'}:{},launch:{global:{home:path.join(root,name,'home')},webDataDirectory:path.join(root,name,'web')}});
 const target=descriptor('A'),candidate=descriptor('B');
 for(const d of [target,candidate])for(const p of [d.launch.global.home,d.launch.webDataDirectory])await fs.mkdir(p,{recursive:true});
 const sourceHome=target.launch.global.home,targetHome=candidate.launch.global.home;
 const profiles=[{id:'one',type:'claude-max',priority:2},{id:'two',type:'oauth-token',credentialPolicy:'access-only',oauthToken:'synthetic-only',oauthTokenExpiresAt:9999999999999}];
 await put(path.join(sourceHome,'.config/meridian/profiles.json'),profiles);
 await put(path.join(sourceHome,'.config/meridian/settings.json'),{activeProfile:'one'});
 await put(path.join(sourceHome,'.claude/.credentials.json'),{claudeAiOauth:{accessToken:'synthetic-A',refreshToken:'synthetic-refresh'}});
 const relocated=await relocateNativeSetupProfiles({profiles,sourceHome,targetHome,copyAccount:async(from,to)=>{
  await fs.mkdir(to,{recursive:true});await fs.copyFile(path.join(from,'.credentials.json'),path.join(to,'.credentials.json'));
 }});
 await put(path.join(targetHome,'.config/meridian/profiles.json'),relocated);
 await put(path.join(targetHome,'.config/meridian/settings.json'),{activeProfile:'one'});
 await fs.mkdir(path.join(targetHome,'.claude'),{recursive:true});await fs.copyFile(path.join(sourceHome,'.claude/.credentials.json'),path.join(targetHome,'.claude/.credentials.json'));
 for(const d of [target,candidate]){
  await put(path.join(d.launch.webDataDirectory,'quota/cursor-acp.json'),{accessToken:'synthetic-quota'});
  await put(path.join(d.launch.webDataDirectory,'branch-preview-vault.key'),'synthetic-key');
  await put(path.join(d.launch.webDataDirectory,'branch-preview-vault.json'),'synthetic-encrypted-vault');
 }
 const vault=await createSessionVault({dataDirectory:target.launch.webDataDirectory});
 await vault.set('unknown-synthetic-credential',{accessToken:'synthetic-only',expiresAt:123});
 for(const name of ['multi-user-vault.key','multi-user-vault.json'])await fs.copyFile(path.join(target.launch.webDataDirectory,name),path.join(candidate.launch.webDataDirectory,name));
 let held=true;const assertHeld=async()=>{if(!held)throw Error('checkpoint_expired');};
 const baseline=await captureBundleCredentialOwners({descriptor:target,assertHeld});
 return {target,candidate,baseline,assertHeld,revoke:()=>{held=false;},check:()=>assertBundleCredentialOwners({target,candidate,baseline,assertHeld})};
}
test('unchanged original relocation retains logical profile order, Keychain identity and exact credential owners',async()=>{
 const f=await fixture();expect(await f.check()).toEqual(f.baseline);
 expect(Object.keys(f.baseline).sort()).toEqual(['accountDirectories','protocol','sha256']);
 expect(JSON.stringify(f.baseline)).not.toMatch(/synthetic|one|\.credentials/);
});
test.each(['disconnect','active','policy','expiry','refresh','quota-delete','quota-change','vault','key','branch-vault','branch-key','absent-present','service','priority','target-change','account-directory','settings-null'])('changed %s refuses rather than publishing stale A',async kind=>{
 const f=await fixture(),d=kind==='target-change'?f.target:f.candidate,home=d.launch.global.home,web=d.launch.webDataDirectory;
 const file=path.join(home,'.config/meridian/profiles.json'),profiles=JSON.parse(await fs.readFile(file,'utf8'));
 if(kind==='disconnect')await put(file,profiles.slice(1));
 else if(kind==='active')await put(path.join(home,'.config/meridian/settings.json'),{activeProfile:'two'});
 else if(kind==='policy'){delete profiles[1].credentialPolicy;await put(file,profiles);}
 else if(kind==='expiry'){profiles[1].oauthTokenExpiresAt--;await put(file,profiles);}
 else if(kind==='service'){profiles[0].keychainService='Claude Code-credentials-12345678';await put(file,profiles);}
 else if(kind==='priority'){profiles[0].priority++;await put(file,profiles);}
 else if(kind==='account-directory'){const moved=path.join(home,'another-account');await fs.mkdir(moved);await fs.copyFile(path.join(profiles[0].claudeConfigDir,'.credentials.json'),path.join(moved,'.credentials.json'));profiles[0].claudeConfigDir=moved;await put(file,profiles);}
 else if(kind==='settings-null')await put(path.join(home,'.config/meridian/settings.json'),'null');
 else if(kind==='refresh')await put(path.join(profiles[0].claudeConfigDir,'.credentials.json'),{refreshToken:'synthetic-next'});
 else if(kind==='quota-delete')await fs.rm(path.join(web,'quota/cursor-acp.json'));
 else if(kind==='quota-change'||kind==='target-change')await put(path.join(web,'quota/cursor-acp.json'),'synthetic-changed');
 else if(kind==='absent-present')await put(path.join(web,'quota/opencode-go.json'),'synthetic-new');
 else await put(path.join(web,(kind.startsWith('branch')?'branch-preview-vault':'multi-user-vault')+(kind.endsWith('key')?'.key':'.json')),'synthetic-changed');
 await expect(f.check()).rejects.toMatchObject({code:'bundle_credential_owner_unsupported'});
});
test('the original branch-preview key-only empty owner is compatible, later credential publication refuses',async()=>{
 const f=await fixture();for(const d of [f.target,f.candidate])await fs.rm(path.join(d.launch.webDataDirectory,'branch-preview-vault.json'));
 const baseline=await captureBundleCredentialOwners({descriptor:f.target,assertHeld:f.assertHeld});
 await expect(assertBundleCredentialOwners({...f,baseline})).resolves.toEqual(baseline);
 await put(path.join(f.candidate.launch.webDataDirectory,'branch-preview-vault.json'),'synthetic-new-connection');
 await expect(assertBundleCredentialOwners({...f,baseline})).rejects.toMatchObject({code:'bundle_credential_owner_unsupported'});
});
test('missing baseline, incomplete pairs, symlink aliases and expired checkpoint never qualify',async()=>{
 const f=await fixture();await expect(assertBundleCredentialOwners({...f,baseline:null})).rejects.toMatchObject({code:'bundle_credential_owner_unsupported'});
 const key=path.join(f.candidate.launch.webDataDirectory,'multi-user-vault.key');await fs.rm(key);
 await expect(f.check()).rejects.toMatchObject({code:'bundle_credential_owner_unsupported'});
 await fs.symlink(path.join(f.target.launch.webDataDirectory,'multi-user-vault.key'),key);
 await expect(f.check()).rejects.toMatchObject({code:'bundle_credential_owner_unsupported'});
 f.revoke();await expect(f.check()).rejects.toThrow('checkpoint_expired');
});

test('revocation after awaited owner capture prevents a fingerprint from qualifying',async()=>{
 const f=await fixture();let checks=0;
 const assertHeld=async()=>{if(++checks>1)throw Error('checkpoint_expired_after_capture');};
 await expect(captureBundleCredentialOwners({descriptor:f.target,assertHeld})).rejects.toThrow('checkpoint_expired_after_capture');
 expect(checks).toBe(2);
});

test('original runtime session.created persists candidate ownership without changing rollback credentials',async()=>{
 const root=await fs.mkdtemp(path.resolve(import.meta.dirname,'../../../../../../.cache/v2-validation/owner-event-'));roots.push(root);const active=[];
 const descriptor=id=>({bundleID:id,...id==='B'?{sourceBundleID:'A'}:{},launch:{global:{home:path.join(root,id,'home')},webDataDirectory:path.join(root,id,'web')}});
 const A=descriptor('A'),B=descriptor('B');let requests=0;
 const make=async d=>{const runtime=await createMultiUserRuntime({dataDirectory:d.launch.webDataDirectory,botsExecutionEnabled:false,fetchImpl:async()=>{requests++;throw Error('unexpected_external_request');},logger:{warn(){}}});active.push(runtime);await runtime.botsRuntime.start();return runtime;};
 try{
  for(const d of [A,B])for(const directory of [d.launch.global.home,d.launch.webDataDirectory])await fs.mkdir(directory,{recursive:true});
  const a=await make(A);await a.connection.bootstrapLocalOwner();
  expect(await a.recordOpenCodeActivity({type:'session.created',properties:{info:{id:'ses_owned_A',directory:root}}})).toBe(true);await a.connection.vault.drain();
  const baseline=await captureBundleCredentialOwners({descriptor:A,assertHeld:async()=>{}});
  await a.botsRuntime.shutdown();await a.connection.dispose();active.splice(active.indexOf(a),1);await fs.cp(A.launch.webDataDirectory,B.launch.webDataDirectory,{recursive:true});
  const b=await make(B);
  expect(await b.recordOpenCodeActivity({type:'session.created',properties:{info:{id:'ses_owned_B',directory:root}}})).toBe(true);await b.connection.vault.drain();
  await expect(assertBundleCredentialOwners({candidate:B,target:A,baseline,assertHeld:async()=>{}})).resolves.toEqual(baseline);
  expect(Object.keys(b.connection.vault.get('supabase-local-sessions'))).toHaveLength(2);expect(requests).toBe(0);
  const reloaded=await createSessionVault({dataDirectory:A.launch.webDataDirectory});expect(Object.keys(reloaded.get('supabase-local-sessions'))).toHaveLength(1);
 }finally{for(const runtime of active){await runtime.botsRuntime.shutdown();await runtime.connection.dispose();}}
});
test('historical ciphertext-only fingerprints never become logical /2 rollback baselines',async()=>{
 const f=await fixture();await expect(assertBundleCredentialOwners({...f,baseline:{...f.baseline,protocol:'devryan.bundle.credential-owners/1'}})).rejects.toMatchObject({code:'bundle_credential_owner_unsupported'});
});

test('valid encrypted unknown-credential changes and replacement keypairs refuse rollback',async()=>{
 const f=await fixture(),web=f.candidate.launch.webDataDirectory;
 const vault=await createSessionVault({dataDirectory:web});await vault.set('unknown-synthetic-credential',{accessToken:'synthetic-rotated',expiresAt:123});
 await expect(f.check()).rejects.toMatchObject({code:'bundle_credential_owner_unsupported'});
 const replacement=path.join(path.dirname(web),'replacement');await fs.mkdir(replacement);
 const next=await createSessionVault({dataDirectory:replacement});await next.set('unknown-synthetic-credential',{accessToken:'synthetic-only',expiresAt:123});
 for(const name of ['multi-user-vault.key','multi-user-vault.json'])await fs.copyFile(path.join(replacement,name),path.join(web,name));
 await expect(f.check()).rejects.toMatchObject({code:'bundle_credential_owner_unsupported'});
});
test('credential mutation during the final awaited hold assertion cannot publish an old fingerprint',async()=>{
 const f=await fixture();const vault=await createSessionVault({dataDirectory:f.target.launch.webDataDirectory});let checks=0;
 const assertHeld=async()=>{if(++checks===2)await vault.set('unknown-synthetic-credential',{accessToken:'synthetic-during-hold'});};
 await expect(captureBundleCredentialOwners({descriptor:f.target,assertHeld})).rejects.toMatchObject({code:'bundle_credential_owner_unsupported'});
 expect(checks).toBe(2);
});
test.each(['absent-publication','branch-key','branch-vault'])('late %s paired-owner changes cannot escape final checkpoint recheck',async kind=>{
 const f=await fixture(),web=f.target.launch.webDataDirectory;
 if(kind==='absent-publication')for(const name of ['multi-user-vault.key','multi-user-vault.json'])await fs.rm(path.join(web,name));
 let checks=0;const assertHeld=async()=>{if(++checks!==2)return;
  if(kind==='absent-publication'){const vault=await createSessionVault({dataDirectory:web});await vault.set('new-credential',{token:'synthetic'});}
  else await put(path.join(web,kind==='branch-key'?'branch-preview-vault.key':'branch-preview-vault.json'),'synthetic-late-change');
 };
 await expect(captureBundleCredentialOwners({descriptor:f.target,assertHeld})).rejects.toMatchObject({code:'bundle_credential_owner_unsupported'});
});
