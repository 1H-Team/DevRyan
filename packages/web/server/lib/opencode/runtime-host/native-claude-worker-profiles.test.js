import {afterEach,expect,test} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {projectNativeClaudeWorkerProfiles} from './native-claude-worker-profiles.js';
import {emptyClaudeLifecycle,transitionClaudeLifecycle} from './native-claude-lifecycle.js';
import {claudeKeychainService} from '../claude-credential-projection.js';

const roots=[];
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
async function fixture(){
 const base=await fs.realpath(path.resolve('../../.cache/v2-validation'));
 const root=await fs.mkdtemp(path.join(base,'claude-worker-profiles-'));roots.push(root);
 const globals=Object.fromEntries(['home','config','data'].map(key=>[key,path.join(root,key)]));
 for(const directory of Object.values(globals))await fs.mkdir(directory,{mode:0o700});
 const controlRoot=path.join(root,'control');await fs.mkdir(controlRoot,{mode:0o700});
 const enrollmentID=randomUUID(),directory=path.join(controlRoot,'claude-enrollments',enrollmentID);await fs.mkdir(directory,{recursive:true,mode:0o700});
 const profile={id:'devryan-'+enrollmentID,type:'claude-max',claudeConfigDir:directory,keychainService:claudeKeychainService(directory,globals.home)};
 const account={profileID:profile.id,service:profile.keychainService,configDirectory:directory,enrollmentID,generation:randomUUID(),recordFingerprint:'a'.repeat(64),grantFingerprint:'b'.repeat(64)};
 const state=transitionClaudeLifecycle(emptyClaudeLifecycle(),0,{kind:'enroll',account});let reads=0;
 const options={profiles:[profile],globals,controlRoot,workerInstanceID:randomUUID(),lifecycle:{read:async()=>{reads++;return state;}}};
 return {root,options,profile,state,reads:()=>reads,context:{recheck:async()=>{}}};
}
test('projects only exact enrolled external profiles into fresh empty private worker directories',async()=>{
 const f=await fixture(),sentinel='synthetic external credential must stay external';
 await fs.writeFile(path.join(f.profile.claudeConfigDir,'.credentials.json'),sentinel);
 const shared={id:'shared',type:'claude-max',claudeConfigDir:f.options.globals.home};
 const inline={id:'inline',type:'oauth-token',credentialPolicy:'access-only',oauthToken:'synthetic'};
 f.options.profiles.push(shared,inline);const original=structuredClone(f.options.profiles);
 const result=await projectNativeClaudeWorkerProfiles(f.options,f.context);
 expect(result).not.toBe(f.options.profiles);expect(f.options.profiles).toEqual(original);expect(result[1]).toBe(shared);expect(result[2]).toBe(inline);
 expect(result[0]).toEqual({...f.profile,claudeConfigDir:expect.stringMatching(new RegExp('^'+f.options.globals.home+'/.devryan-claude-workers/'))});
 const stat=await fs.lstat(result[0].claudeConfigDir);expect(stat.mode&0o777).toBe(0o700);expect(stat.uid).toBe(process.getuid());
 expect(await fs.realpath(result[0].claudeConfigDir)).toBe(result[0].claudeConfigDir);expect(await fs.readdir(result[0].claudeConfigDir)).toEqual([]);
 expect(await fs.readFile(path.join(f.profile.claudeConfigDir,'.credentials.json'),'utf8')).toBe(sentinel);expect(f.reads()).toBe(2);
});
test('shared and implicit profiles preserve references and need no enrollment state or worker directories',async()=>{
 const f=await fixture();for(const profiles of [[],[{id:'shared',type:'claude-max'}],[{id:'shared',type:'claude-max',claudeConfigDir:f.options.globals.home}]]){
  expect(await projectNativeClaudeWorkerProfiles({...f.options,profiles},f.context)).toBe(profiles);
 }
 expect(f.reads()).toBe(0);await expect(fs.stat(path.join(f.options.globals.home,'.devryan-claude-workers'))).rejects.toMatchObject({code:'ENOENT'});
});
test('foreign service, missing authority and changed enrollment generation refuse without exposing a source directory',async()=>{
 const f=await fixture();
 await expect(projectNativeClaudeWorkerProfiles({...f.options,profiles:[{...f.profile,keychainService:'Claude Code-credentials-01234567'}]},f.context)).rejects.toMatchObject({code:'native_claude_enrollment_required'});
 await expect(projectNativeClaudeWorkerProfiles({...f.options,lifecycle:{read:async()=>emptyClaudeLifecycle()}},f.context)).rejects.toMatchObject({code:'native_claude_enrollment_required'});
 let reads=0;const changed=structuredClone(f.state);changed.accounts[0].generation=randomUUID();
 await expect(projectNativeClaudeWorkerProfiles({...f.options,lifecycle:{read:async()=>++reads===1?f.state:changed}},f.context)).rejects.toMatchObject({code:'native_claude_enrollment_required'});
 await expect(fs.stat(path.join(f.options.globals.home,'.devryan-claude-workers',f.options.workerInstanceID))).rejects.toMatchObject({code:'ENOENT'});
});
test('symlink parents, nonempty reused worker roots, and canceled projection are refused',async()=>{
 const f=await fixture(),parent=path.join(f.options.globals.home,'.devryan-claude-workers');
 await fs.symlink(f.options.controlRoot,parent);
 await expect(projectNativeClaudeWorkerProfiles(f.options,f.context)).rejects.toMatchObject({code:'native_claude_worker_profile_invalid'});
 await fs.unlink(parent);await fs.mkdir(parent,{mode:0o700});const worker=path.join(parent,f.options.workerInstanceID);await fs.mkdir(worker,{mode:0o700});await fs.writeFile(path.join(worker,'keep'),'synthetic');
 await expect(projectNativeClaudeWorkerProfiles(f.options,f.context)).rejects.toMatchObject({code:'native_claude_worker_profile_invalid'});expect(await fs.readFile(path.join(worker,'keep'),'utf8')).toBe('synthetic');
 const abort=new AbortController();
 await expect(projectNativeClaudeWorkerProfiles({...f.options,workerInstanceID:randomUUID(),lifecycle:{read:async()=>{abort.abort(new Error('closed'));return f.state;}}},{...f.context,signal:abort.signal})).rejects.toThrow('closed');
 expect(await fs.readdir(parent)).toEqual([f.options.workerInstanceID]);
});
