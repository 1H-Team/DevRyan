import {test,expect} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {writeFileAtomic} from '../../../../../harness-runtime/lib/atomic-file.js';
import {claudeKeychainService} from '../claude-credential-projection.js';
import {createNativeClaudeProfilePublication} from './native-claude-profile-publication.js';

async function fixture(action,writeAtomic){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'devryan-claude-publication-')));
 try{
  const home=path.join(root,'home'),controlRoot=path.join(root,'control'),directory=path.join(home,'.config','meridian');
  await fs.mkdir(directory,{recursive:true,mode:0o700});await fs.mkdir(controlRoot,{mode:0o700});
  const id=randomUUID(),claudeConfigDir=path.join(controlRoot,'claude-enrollments',id);
  await fs.mkdir(claudeConfigDir,{recursive:true,mode:0o700});
  const profile={id:`devryan-${id}`,type:'claude-max',claudeConfigDir,keychainService:claudeKeychainService(claudeConfigDir,home)};
  const profiles=path.join(directory,'profiles.json'),settings=path.join(directory,'settings.json');
  const originalProfiles=Buffer.from('[ { "id":"shared", "type":"claude-max", "priority":17 } ]\n');
  const originalSettings=Buffer.from('{"activeProfile":"shared","theme":"dark","unknown":{"retain":true}}\n');
  await fs.writeFile(profiles,originalProfiles);await fs.writeFile(settings,originalSettings);
  const owner=createNativeClaudeProfilePublication({home,controlRoot,...writeAtomic?{writeAtomic}:{} });
  await action({owner,profile,profiles,settings,root,originalProfiles,originalSettings});
 }finally{await fs.rm(root,{recursive:true,force:true});}
}
test('explicit publication preserves existing profiles and unrelated settings',()=>fixture(async({owner,profile,profiles,settings})=>{
 const baseline=await owner.snapshot();expect(baseline.selectedProfileID).toBe('shared');
 expect(JSON.stringify(baseline)).not.toContain('priority');
 await owner.publish(profile,baseline,{recheck:async()=>{}});
 expect(JSON.parse(await fs.readFile(profiles,'utf8'))).toEqual([{id:'shared',type:'claude-max',priority:17},profile]);
 expect(JSON.parse(await fs.readFile(settings,'utf8'))).toEqual({activeProfile:profile.id,theme:'dark',unknown:{retain:true}});
}));
test('deletion preserves other profile fields and settings and refuses explicit or implicit selection',()=>fixture(async({owner,profile,profiles,settings,originalSettings})=>{
 await fs.writeFile(profiles,JSON.stringify([{id:'shared',type:'claude-max',priority:17},profile]));
 const baseline=await owner.snapshot();await owner.assertRemoval(profile,baseline,{recheck:async()=>{}});
 await owner.remove(profile,baseline,{recheck:async()=>{}});
 expect(JSON.parse(await fs.readFile(profiles,'utf8'))).toEqual([{id:'shared',type:'claude-max',priority:17}]);
 expect(await fs.readFile(settings)).toEqual(originalSettings);
 for(const explicit of [false,true]){
  await fs.writeFile(profiles,JSON.stringify([profile,{id:'shared',type:'claude-max'}]));await fs.writeFile(settings,JSON.stringify(explicit?{activeProfile:profile.id}:{theme:'dark'}));
  const beforeProfiles=await fs.readFile(profiles),beforeSettings=await fs.readFile(settings);
  await expect(owner.remove(profile,await owner.snapshot(),{recheck:async()=>{}})).rejects.toMatchObject({code:'native_claude_enrollment_selected'});
  expect(await fs.readFile(profiles)).toEqual(beforeProfiles);expect(await fs.readFile(settings)).toEqual(beforeSettings);
 }
}));
test('deletion refuses changed profile identity and stale settings before writing',()=>fixture(async({owner,profile,profiles,settings})=>{
 await fs.writeFile(profiles,JSON.stringify([{id:'shared'}, {...profile,keychainService:'Claude Code-credentials'}]));
 const before=await fs.readFile(profiles);
 await expect(owner.remove(profile,await owner.snapshot(),{recheck:async()=>{}})).rejects.toMatchObject({code:'native_claude_enrollment_account_changed'});
 expect(await fs.readFile(profiles)).toEqual(before);
 await fs.writeFile(profiles,JSON.stringify([{id:'shared'},profile]));const baseline=await owner.snapshot();await fs.appendFile(settings,' ');
 await expect(owner.assertRemoval(profile,baseline,{recheck:async()=>{}})).rejects.toMatchObject({code:'native_claude_enrollment_configuration_changed'});
}));
test('stale file bytes refuse even when the parsed selection is unchanged',()=>fixture(async({owner,profile,profiles})=>{
 const baseline=await owner.snapshot();await fs.appendFile(profiles,' ');const changed=await fs.readFile(profiles);
 await expect(owner.publish(profile,baseline,{recheck:async()=>{}})).rejects.toMatchObject({code:'native_claude_enrollment_configuration_changed'});
 expect(await fs.readFile(profiles)).toEqual(changed);
}));
test('a failed settings write restores only the exact first write',()=>fixture(async({owner,profile,profiles,settings,originalProfiles,originalSettings})=>{
 await expect(owner.publish(profile,await owner.snapshot(),{recheck:async()=>{}})).rejects.toThrow('fixture settings failure');
 expect(await fs.readFile(profiles)).toEqual(originalProfiles);expect(await fs.readFile(settings)).toEqual(originalSettings);
},async(file,bytes)=>{if(path.basename(file)==='settings.json')throw new Error('fixture settings failure');await writeFileAtomic(file,bytes);}));
test('a concurrent edit after the first write survives rollback refusal',()=>fixture(async({owner,profile,profiles,settings,originalSettings})=>{
 const baseline=await owner.snapshot();let count=0;
 await expect(owner.publish(profile,baseline,{recheck:async()=>{if(++count===4)await fs.writeFile(profiles,'[{"id":"new-owner"}]');}})).rejects.toMatchObject({code:'native_claude_enrollment_selection_uncertain'});
 expect(await fs.readFile(profiles,'utf8')).toBe('[{"id":"new-owner"}]');expect(await fs.readFile(settings)).toEqual(originalSettings);
}));
test('revocation after the first write restores the original profile bytes',()=>fixture(async({owner,profile,profiles,originalProfiles})=>{
 const baseline=await owner.snapshot();let count=0;
 await expect(owner.publish(profile,baseline,{recheck:async()=>{if(++count===4)throw new Error('revoked');}})).rejects.toThrow('revoked');
 expect(await fs.readFile(profiles)).toEqual(originalProfiles);
}));
test('symlinked files and noncanonical enrollment identities refuse',()=>fixture(async({owner,profile,profiles,root})=>{
 const baseline=await owner.snapshot();
 await expect(owner.publish({...profile,keychainService:'Claude Code-credentials'},baseline,{recheck:async()=>{}})).rejects.toMatchObject({code:'native_claude_enrollment_receipt_invalid'});
 await fs.rename(profiles,path.join(root,'other.json'));await fs.symlink(path.join(root,'other.json'),profiles);
 await expect(owner.snapshot()).rejects.toMatchObject({code:'native_claude_enrollment_configuration_invalid'});
}));
