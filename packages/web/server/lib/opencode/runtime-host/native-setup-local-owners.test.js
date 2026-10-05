import { expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createSessionVault } from '../../multi-user/vault.js';
import { createLocalBotOwner } from '../../bots/local-owner.js';
import { createSupabaseConnection } from '../../multi-user/supabase-connection.js';
import { captureNativeSetupOwners, restoreNativeSetupOwners } from './native-setup-local-owners.js';

const fixture = async action => {
 const base=path.resolve('../../.cache/v2-validation');await fs.mkdir(base,{recursive:true});
 const root=await fs.mkdtemp(path.join(base,'setup-owner-'));
 try{await action(root);}finally{await fs.rm(root,{recursive:true,force:true});}
};
test('logical setup preserves original durable owners through the vault without session grants',async()=>fixture(async root=>{
 const source=path.join(root,'source'),target=path.join(root,'target');
 const vault=await createSessionVault({dataDirectory:source});
 const managedID='10000000-0000-4000-8000-000000000001',botID='20000000-0000-4000-8000-000000000002',createdAt='2026-01-01T00:00:00Z';
 await vault.set('supabase-local-owner',{principal:{id:managedID,role:'admin',scope:'managed',policy:{terminal:true},assignments:['private']},sessions:[{tokenHash:'a'.repeat(64),expiresAt:9999999999999}]});
 await vault.set('bots-local-owner',{version:1,id:botID,createdAt,sessions:[{tokenHash:'b'.repeat(64),expiresAt:9999999999999}]});
 await vault.set('unrelated',{access:'fixture-access'});
 const before=await fs.readFile(vault.paths.vaultPath);
 const logical=await captureNativeSetupOwners(source);
 expect(logical).toEqual({localOwners:{'supabase-local-owner':{id:managedID,scope:'managed'},'bots-local-owner':{id:botID,createdAt}}});
 expect(await fs.readFile(vault.paths.vaultPath)).toEqual(before);
 await fs.mkdir(target);await fs.writeFile(path.join(target,'native-setup-local-owners.json'),JSON.stringify({schema:1,owners:logical.localOwners}));
 await restoreNativeSetupOwners(target);
 const restored=await createSessionVault({dataDirectory:target});
 expect(restored.get('supabase-local-owner')).toEqual({principal:{id:managedID,role:'admin',scope:'managed',assignments:[],policy:{}},sessions:[]});
 expect(restored.get('unrelated')).toBeNull();
 const bot=await createLocalBotOwner({vault:restored});expect(bot.id).toBe(botID);
 await bot.issueSession();await restoreNativeSetupOwners(target);
 const resumed=await createSessionVault({dataDirectory:target});
 expect(resumed.get('bots-local-owner').sessions).toHaveLength(1);
 expect(resumed.get('bots-local-owner').createdAt).toBe(createdAt);
 expect(await fs.readFile(restored.paths.keyPath)).not.toEqual(await fs.readFile(vault.paths.keyPath));
}));
test('absent owners do not create source storage and partial or conflicting ownership refuses',async()=>fixture(async root=>{
 const absent=path.join(root,'absent');expect(await captureNativeSetupOwners(absent)).toEqual({localOwners:{}});
 await expect(fs.stat(absent)).rejects.toMatchObject({code:'ENOENT'});
 await fs.mkdir(absent);await fs.writeFile(path.join(absent,'multi-user-vault.key'),'incomplete');
 await expect(captureNativeSetupOwners(absent)).rejects.toMatchObject({code:'native_setup_local_owner_invalid'});
 const vault=await createSessionVault({dataDirectory:path.join(root,'vault')});
 await vault.restoreSetupOwners({'supabase-local-owner':{id:'10000000-0000-4000-8000-000000000001',scope:'local-admin'}});
 await expect(vault.restoreSetupOwners({'supabase-local-owner':{id:'20000000-0000-4000-8000-000000000002',scope:'managed'}})).rejects.toMatchObject({code:'native_setup_local_owner_invalid'});
 expect(vault.get('supabase-local-owner').principal.id).toBe('10000000-0000-4000-8000-000000000001');
 expect(()=>vault.restoreSetupOwners({'bots-local-owner':{id:'10000000-0000-4000-8000-000000000001',createdAt:'2026-01-01',sessions:[]}})).toThrow('native_setup_local_owner_invalid');
}));
const snapshot=async(target,owners)=>{await fs.mkdir(target,{recursive:true});await fs.writeFile(path.join(target,'native-setup-local-owners.json'),JSON.stringify({schema:1,owners}));};
const localAdmin={'supabase-local-owner':{id:'10000000-0000-4000-8000-000000000001',scope:'local-admin'}};
test('restore is one-shot: a later app owner change through rememberOwner survives every following start',async()=>fixture(async root=>{
 const target=path.join(root,'target');await snapshot(target,localAdmin);
 await restoreNativeSetupOwners(target);
 const connection=await createSupabaseConnection({config:{configured:true,enabled:false,dataDirectory:target,url:'https://supabase.invalid',publishableKey:'fixture-public',secretKey:'fixture-secret'},fetchImpl:async()=>{throw Error('fixture has no network');}});
 try{await connection.rememberOwner({id:'20000000-0000-4000-8000-000000000002',role:'admin',scope:'managed',assignments:[],policy:{}},{getHeader:()=>undefined,setHeader:()=>{}});}
 finally{await connection.dispose?.();}
 for(const start of [1,2])await restoreNativeSetupOwners(target);
 const vault=await createSessionVault({dataDirectory:target});
 expect(vault.get('supabase-local-owner').principal).toMatchObject({id:'20000000-0000-4000-8000-000000000002',scope:'managed'});
}));
test('a revoked restored owner is not resurrected on later starts',async()=>fixture(async root=>{
 const target=path.join(root,'target');await snapshot(target,localAdmin);
 await restoreNativeSetupOwners(target);
 const app=await createSessionVault({dataDirectory:target});await app.delete('supabase-local-owner');await app.drain();
 await restoreNativeSetupOwners(target);
 expect((await createSessionVault({dataDirectory:target})).get('supabase-local-owner')).toBeNull();
}));
test('a start that died after restoring but before consuming the snapshot restores again and then stops',async()=>fixture(async root=>{
 const target=path.join(root,'target');await snapshot(target,localAdmin);
 const died=await createSessionVault({dataDirectory:target});await died.restoreSetupOwners(localAdmin);await died.drain();
 await restoreNativeSetupOwners(target);
 expect((await createSessionVault({dataDirectory:target})).get('supabase-local-owner').principal).toMatchObject({id:localAdmin['supabase-local-owner'].id,scope:'local-admin'});
 const app=await createSessionVault({dataDirectory:target});await app.set('supabase-local-owner',{principal:{id:'30000000-0000-4000-8000-000000000003',role:'admin',scope:'managed',assignments:[],policy:{}},sessions:[]});
 await restoreNativeSetupOwners(target);
 expect((await createSessionVault({dataDirectory:target})).get('supabase-local-owner').principal.id).toBe('30000000-0000-4000-8000-000000000003');
}));
test('a bundle whose owner the app replaced after an unconsumed restore starts again without re-applying the snapshot',async()=>fixture(async root=>{
 const target=path.join(root,'target');await snapshot(target,localAdmin);
 const earlier=await createSessionVault({dataDirectory:target});await earlier.restoreSetupOwners(localAdmin);await earlier.drain();
 await earlier.set('supabase-local-owner',{principal:{id:'40000000-0000-4000-8000-000000000004',role:'admin',scope:'managed',assignments:[],policy:{}},sessions:[]});
 for(const start of [1,2])await restoreNativeSetupOwners(target);
 expect((await createSessionVault({dataDirectory:target})).get('supabase-local-owner').principal.id).toBe('40000000-0000-4000-8000-000000000004');
 expect(await fs.readdir(target)).toContain('native-setup-local-owners.restored.json');
}));
const child=(script,...args)=>new Promise((resolve,reject)=>{const c=spawn(process.execPath,[script,...args],{stdio:['ignore','pipe','inherit']});let out='';c.stdout.on('data',chunk=>out+=chunk);c.on('error',reject);c.on('close',()=>resolve(out.trim()));});
test('concurrent first starts restore the snapshot once and neither start fails',async()=>fixture(async root=>{
 const script=path.join(root,'start.mjs');
 await fs.writeFile(script,`const {restoreNativeSetupOwners}=await import(${JSON.stringify(new URL('./native-setup-local-owners.js',import.meta.url).href)});
const go=Number(process.argv[3]);while(Date.now()<go){}
try{await restoreNativeSetupOwners(process.argv[2]);console.log('ok');}catch(error){console.log('FAIL '+(error.code??error.message));}`);
 for(let round=0;round<20;round++){
  const target=path.join(root,`target-${round}`);await snapshot(target,localAdmin);
  const go=String(Date.now()+700);
  expect(await Promise.all([child(script,target,go),child(script,target,go)])).toEqual(['ok','ok']);
  expect((await createSessionVault({dataDirectory:target})).get('supabase-local-owner').principal).toMatchObject({id:localAdmin['supabase-local-owner'].id,scope:'local-admin'});
  expect((await fs.readdir(target)).sort()).toEqual(['multi-user-vault.json','multi-user-vault.key','native-setup-local-owners.restored.json']);
 }
}),120_000);
test('a start that crashed holding the restore lock, or lost the snapshot to another start, does not block or fail',async()=>fixture(async root=>{
 const target=path.join(root,'target');await snapshot(target,localAdmin);
 const dead=spawn(process.execPath,['-e','']);const pid=await new Promise(resolve=>dead.on('close',()=>resolve(dead.pid)));
 await fs.writeFile(path.join(target,'native-setup-local-owners.lock'),JSON.stringify({ownerToken:'f'.repeat(32),pid,createdAt:Date.now()})+'\n');
 await restoreNativeSetupOwners(target);
 expect((await fs.readdir(target)).sort()).toEqual(['multi-user-vault.json','multi-user-vault.key','native-setup-local-owners.restored.json']);
 const other=path.join(root,'other');await snapshot(other,localAdmin);const snapshotFile=path.join(other,'native-setup-local-owners.json');
 const readFile=fs.readFile;fs.readFile=async(file,...rest)=>{if(String(file)===snapshotFile)throw Object.assign(Error('ENOENT injected'),{code:'ENOENT'});return readFile.call(fs,file,...rest);};
 try{await restoreNativeSetupOwners(other);}finally{fs.readFile=readFile;}
 const rename=fs.rename;fs.rename=async(from,...rest)=>{if(String(from)===snapshotFile)throw Object.assign(Error('ENOENT injected'),{code:'ENOENT'});return rename.call(fs,from,...rest);};
 try{await restoreNativeSetupOwners(other);}finally{fs.rename=rename;}
 expect((await createSessionVault({dataDirectory:other})).get('supabase-local-owner').principal.id).toBe(localAdmin['supabase-local-owner'].id);
}));
const lockOf=target=>path.join(target,'native-setup-local-owners.lock');
const liveLock=createdAt=>JSON.stringify({ownerToken:'e'.repeat(32),pid:1,createdAt})+'\n';
test('a crashed start\'s restore lock whose pid a live unrelated process reused is reclaimed by age',async()=>fixture(async root=>{
 const target=path.join(root,'target');await snapshot(target,localAdmin);
 await fs.writeFile(lockOf(target),liveLock(Date.now()-120_000));
 const started=Date.now();await restoreNativeSetupOwners(target);
 expect(Date.now()-started).toBeLessThan(2_000);
 expect((await fs.readdir(target)).sort()).toEqual(['multi-user-vault.json','multi-user-vault.key','native-setup-local-owners.restored.json']);
 expect((await createSessionVault({dataDirectory:target})).get('supabase-local-owner').principal.id).toBe(localAdmin['supabase-local-owner'].id);
}),20_000);
test('a fresh restore lock held by a live process still serializes',async()=>fixture(async root=>{
 const {withCrossProcessFileLock}=await import('../../../../../harness-runtime/lib/atomic-file.js');
 const target=path.join(root,'target');await snapshot(target,localAdmin);
 let restore;
 await withCrossProcessFileLock(lockOf(target),async()=>{
  restore=restoreNativeSetupOwners(target);await new Promise(resolve=>setTimeout(resolve,300));
  expect(await fs.readdir(target)).toContain('native-setup-local-owners.json');
 });
 await restore;expect(await fs.readdir(target)).toContain('native-setup-local-owners.restored.json');
 const foreign=path.join(root,'foreign');await snapshot(foreign,localAdmin);await fs.writeFile(lockOf(foreign),liveLock(Date.now()));
 await expect(restoreNativeSetupOwners(foreign)).rejects.toMatchObject({code:'LOCK_TIMEOUT'});
 expect(await fs.readdir(foreign)).toContain('native-setup-local-owners.json');
}),20_000);
test('a stale lock another start reclaimed and re-locked before this start removes it is handed back',async()=>fixture(async root=>{
 const target=path.join(root,'target');await snapshot(target,localAdmin);
 await fs.writeFile(lockOf(target),liveLock(Date.now()-120_000));
 const fresh=liveLock(Date.now()+60_000),rename=fs.rename;
 fs.rename=async(from,...rest)=>{if(String(from)===lockOf(target)){await fs.rm(from);await fs.writeFile(from,fresh);}return rename.call(fs,from,...rest);};
 try{await expect(restoreNativeSetupOwners(target)).rejects.toMatchObject({code:'LOCK_TIMEOUT'});}finally{fs.rename=rename;}
 expect(await fs.readFile(lockOf(target),'utf8')).toBe(fresh);
 expect((await fs.readdir(target)).sort()).toEqual(['native-setup-local-owners.json','native-setup-local-owners.lock']);
}),20_000);
