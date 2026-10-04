import { expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSessionVault } from '../../multi-user/vault.js';
import { createLocalBotOwner } from '../../bots/local-owner.js';
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
