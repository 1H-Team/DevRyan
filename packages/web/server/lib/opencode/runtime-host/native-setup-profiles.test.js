import fs from 'node:fs/promises';
import path from 'node:path';
import {afterEach,expect,test,vi} from 'vitest';
import {claudeKeychainService} from '../claude-credential-projection.js';
import {relocateNativeSetupProfiles} from './native-setup-profiles.js';
import {captureBundleCredentialOwners,assertBundleCredentialOwners} from './bundle-credential-owner-guard.js';
const roots=[];afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
async function fixture(){
 const root=await fs.mkdtemp(path.resolve('../../.cache/v2-validation/stable-enrollment-'));roots.push(root);await fs.chmod(root,0o700);
 const controlRoot=path.join(root,'control');await fs.mkdir(controlRoot,{mode:0o700});
 const enrollmentID='00000000-0000-4000-8000-000000000001',directory=path.join(controlRoot,'claude-enrollments',enrollmentID);await fs.mkdir(path.dirname(directory),{mode:0o700});await fs.mkdir(directory,{mode:0o700});
 const home=path.join(controlRoot,'bundles/A/global/home'),targetHome=path.join(controlRoot,'bundles/B/global/home');await fs.mkdir(home,{recursive:true});await fs.mkdir(targetHome,{recursive:true});
 const profile={id:'devryan-'+enrollmentID,type:'claude-max',claudeConfigDir:directory,keychainService:claudeKeychainService(directory,home),credentialPolicy:'access-only'};
 const account={profileID:profile.id,service:profile.keychainService,configDirectory:directory,enrollmentID,generation:'original-generation',grantFingerprint:'a'.repeat(64),recordFingerprint:'b'.repeat(64)};
 const claudeLifecycle={protocol:'devryan.claude-lifecycle/1',revision:1,accounts:[account],unresolved:[]};
 return {root,controlRoot,home,targetHome,profile,claudeLifecycle,directory};
}
test('verified original KV enrollment keeps stable directory/service and copies no external account bytes',async()=>{
 const f=await fixture(),copyAccount=vi.fn();
 // An external account file alias is deliberately unreadable as bundle data.
 await fs.symlink('/never/read/credential-store',path.join(f.directory,'.credentials.json'));
 await expect(relocateNativeSetupProfiles({profiles:[f.profile],sourceHome:f.home,targetHome:f.targetHome,controlRoot:f.controlRoot,claudeLifecycle:f.claudeLifecycle,copyAccount})).resolves.toEqual([f.profile]);expect(copyAccount).not.toHaveBeenCalled();
 const descriptor=(bundleID,home)=>({bundleID,...bundleID==='B'?{sourceBundleID:'A'}:{},launch:{global:{home},webDataDirectory:path.join(f.controlRoot,'bundles',bundleID,'web-data')}});
 const target=descriptor('A',f.home),candidate=descriptor('B',f.targetHome);
 for(const d of [target,candidate]){await fs.mkdir(d.launch.webDataDirectory,{recursive:true});const file=path.join(d.launch.global.home,'.config/meridian/profiles.json');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify([f.profile]));}
 const assertHeld=async()=>{},baseline=await captureBundleCredentialOwners({descriptor:target,controlRoot:f.controlRoot,claudeLifecycle:f.claudeLifecycle,assertHeld});
 await expect(assertBundleCredentialOwners({candidate,target,baseline,controlRoot:f.controlRoot,claudeLifecycle:f.claudeLifecycle,assertHeld})).resolves.toEqual(baseline);
 // Grant lifecycle rotates in native KV, whose /2 snapshot/projection owns it;
 // host configuration fingerprint remains the same exact stable identity.
 const rotated={...f.claudeLifecycle,revision:2,accounts:[{...f.claudeLifecycle.accounts[0],generation:'renewed-generation',grantFingerprint:'c'.repeat(64),recordFingerprint:'d'.repeat(64)}]};
 expect(await captureBundleCredentialOwners({descriptor:target,controlRoot:f.controlRoot,claudeLifecycle:rotated,assertHeld})).toEqual(baseline);
 await expect(captureBundleCredentialOwners({descriptor:target,controlRoot:f.controlRoot,assertHeld})).rejects.toMatchObject({code:'bundle_credential_owner_unsupported'});
});
test('copied flags, absent/foreign native receipt, changed identity/service and nonprivate directory never grant stable relocation',async()=>{
 const f=await fixture();for(const state of [null,{...f.claudeLifecycle,accounts:[]},{...f.claudeLifecycle,accounts:[{...f.claudeLifecycle.accounts[0],profileID:'foreign'}]}]){
  const copyAccount=vi.fn();await expect(relocateNativeSetupProfiles({profiles:[{...f.profile,devryanEnrolled:true}],sourceHome:f.home,targetHome:f.targetHome,controlRoot:f.controlRoot,claudeLifecycle:state,copyAccount})).rejects.toMatchObject({code:'native_setup_profiles_invalid'});expect(copyAccount).not.toHaveBeenCalled();
 }
 await fs.chmod(f.directory,0o755);await expect(relocateNativeSetupProfiles({profiles:[f.profile],sourceHome:f.home,targetHome:f.targetHome,controlRoot:f.controlRoot,claudeLifecycle:f.claudeLifecycle,copyAccount:vi.fn()})).rejects.toMatchObject({code:'native_setup_profiles_invalid'});
});
test('first-seed mode drops invalid account paths, later duplicates and rows past 64; strict mode still fails closed',async()=>{
 const home='/fixture/home',targetHome='/fixture/target',copied=[],skipped=[];
 const profiles=[{id:'num',claudeConfigDir:7},{id:'rel',claudeConfigDir:'.claude'},{id:'tilde',type:'claude-max',claudeConfigDir:'~/.claude'},{id:'a'},{id:'a',type:'second'},
  ...Array.from({length:62},(_,index)=>({id:'p'+index})),{id:'late'}];
 const result=await relocateNativeSetupProfiles({profiles,sourceHome:home,targetHome,copyAccount:async account=>copied.push(account),onSkip:row=>skipped.push(row)});
 expect(result.map(row=>row.id)).toEqual(['a',...Array.from({length:59},(_,index)=>'p'+index)]);expect(result[0]).toEqual({id:'a'});expect(copied).toEqual([]);
 expect(skipped).toEqual([{reason:'profile_account_invalid',profile:'num'},{reason:'profile_account_invalid',profile:'rel'},{reason:'profile_account_invalid',profile:'tilde'},
  {reason:'profile_duplicate',profile:'a'},{reason:'profile_limit',profile:'p59'},{reason:'profile_limit',profile:'p60'},{reason:'profile_limit',profile:'p61'},{reason:'profile_limit',profile:'late'}]);
 for(const input of [[{id:'rel',claudeConfigDir:'~/.claude'}],[{id:'a'},{id:'a'}],Array.from({length:65},(_,index)=>({id:'q'+index}))])
  await expect(relocateNativeSetupProfiles({profiles:input,sourceHome:home,targetHome,copyAccount:async()=>{}})).rejects.toMatchObject({code:'native_setup_profiles_invalid'});
});
