import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSessionVault, fingerprintSessionVaultCredentials } from './vault.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('encrypted Supabase session vault', () => {
  it('stores tokens encrypted at rest with private file permissions', async () => {
    const directory = await fs.mkdtemp(path.resolve(import.meta.dirname, '../../../../../.cache/v2-validation/devryan-vault-'));
    temporaryDirectories.push(directory);
    const vault = await createSessionVault({ dataDirectory: directory });
    await vault.set('app-session', {
      accessToken: 'access-token-plaintext',
      refreshToken: 'refresh-token-plaintext',
      expiresAt: 1234,
      sessionTokenHash: 'hashed-app-session-token',
    });

    const encrypted = await fs.readFile(vault.paths.vaultPath, 'utf8');
    expect(encrypted).not.toContain('access-token-plaintext');
    expect(encrypted).not.toContain('refresh-token-plaintext');
    expect(encrypted).not.toContain('hashed-app-session-token');
    expect((await fs.stat(vault.paths.keyPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(vault.paths.vaultPath)).mode & 0o777).toBe(0o600);

    const reloaded = await createSessionVault({ dataDirectory: directory });
    expect(reloaded.get('app-session')).toEqual({
      accessToken: 'access-token-plaintext',
      refreshToken: 'refresh-token-plaintext',
      expiresAt: 1234,
      sessionTokenHash: 'hashed-app-session-token',
    });
    expect(reloaded.findByTokenHash('hashed-app-session-token')).toMatchObject({ sessionId: 'app-session' });
    expect(reloaded.findByTokenHash('unknown')).toBeNull();
  });
});

const ownerRecord=()=>({principal:{id:'11111111-1111-4111-8111-111111111111',role:'admin',scope:'local-admin',assignments:[],policy:{}},sessions:[{tokenHash:'synthetic-hash',expiresAt:123456789}]});
async function fingerprintFixture(){
 const directory=await fs.mkdtemp(path.resolve(import.meta.dirname,'../../../../../.cache/v2-validation/vault-fingerprint-'));temporaryDirectories.push(directory);
 const vault=await createSessionVault({dataDirectory:directory});await vault.set('supabase-local-owner',ownerRecord());
 const fingerprint=async()=>fingerprintSessionVaultCredentials({keyBytes:await fs.readFile(vault.paths.keyPath),vaultBytes:await fs.readFile(vault.paths.vaultPath)});
 return {vault,directory,fingerprint};
}
it('original encrypted codec excludes only valid root ownership and preserves every credential record',async()=>{
 const f=await fingerprintFixture();await f.vault.set('unknown-owner',{accessToken:'synthetic-secret',refreshToken:'synthetic-refresh',expiresAt:99});
 const before=await f.fingerprint();
 await f.vault.set('supabase-local-sessions',{ses_local_A:{userId:ownerRecord().principal.id,directory:'/no-longer-existing/history'}});
 expect(await f.fingerprint()).toBe(before);
 await f.vault.set('supabase-local-sessions',{ses_local_B:{userId:ownerRecord().principal.id,directory:'/different/history'}});
 expect(await f.fingerprint()).toBe(before);
 await f.vault.set('unknown-owner',{accessToken:'synthetic-next',refreshToken:'synthetic-refresh',expiresAt:99});
 expect(await f.fingerprint()).not.toBe(before);
});
it.each(['owner','token','expiry','policy','unknown','unknown-delete','unknown-add'])('logical fingerprint retains changed %s credential/grant state',async kind=>{
 const f=await fingerprintFixture();await f.vault.set('unknown-owner',{credential:'synthetic'});const before=await f.fingerprint(),owner=ownerRecord();
 if(kind==='owner')owner.principal.id='22222222-2222-4222-8222-222222222222';
 else if(kind==='token')owner.sessions[0].tokenHash='synthetic-next-hash';
 else if(kind==='expiry')owner.sessions[0].expiresAt--;
 else if(kind==='policy')owner.principal.policy={write:false};
 else if(kind==='unknown')await f.vault.set('unknown-owner',{credential:'synthetic-next'});
 else if(kind==='unknown-delete')await f.vault.delete('unknown-owner');
 else await f.vault.set('another-owner',{credential:'synthetic'});
 if(['owner','token','expiry','policy'].includes(kind))await f.vault.set('supabase-local-owner',owner);
 expect(await f.fingerprint()).not.toBe(before);
});
it.each(['foreign','extra','array','relative','alias','bad-id','oversized','ownerless','long-id','control-directory'])('malformed %s ownership is never excluded as runtime data',async kind=>{
 const f=await fingerprintFixture(),entry={userId:ownerRecord().principal.id,directory:'/history'};let map={ses_owned:entry};
 if(kind==='foreign')entry.userId='22222222-2222-4222-8222-222222222222';
 else if(kind==='extra')entry.accessToken='synthetic';
 else if(kind==='array')map=[];
 else if(kind==='relative')entry.directory='history';
 else if(kind==='alias')entry.directory='/history/../different';
 else if(kind==='bad-id')map={arbitrary:entry};
 else if(kind==='long-id')map={['ses_'+ 'x'.repeat(160)]:entry};
 else if(kind==='control-directory')entry.directory='/history\0credential';
 else if(kind==='oversized')map=Object.fromEntries(Array.from({length:20001},(_,i)=>['ses_'+i,entry]));
 else await f.vault.delete('supabase-local-owner');
 await f.vault.set('supabase-local-sessions',map);
 await expect(f.fingerprint()).rejects.toMatchObject({code:'session_vault_fingerprint_invalid'});
});
it('paired original authenticated codec refuses corrupt key, ciphertext and envelope aliases',async()=>{
 const f=await fingerprintFixture();const keyBytes=await fs.readFile(f.vault.paths.keyPath),vaultBytes=await fs.readFile(f.vault.paths.vaultPath);
 expect(()=>fingerprintSessionVaultCredentials({keyBytes:Buffer.from('invalid'),vaultBytes})).toThrow('session_vault_fingerprint_invalid');
 const envelope=JSON.parse(vaultBytes.toString());envelope.ciphertext=Buffer.from('invalid').toString('base64');
 expect(()=>fingerprintSessionVaultCredentials({keyBytes,vaultBytes:Buffer.from(JSON.stringify(envelope))})).toThrow('session_vault_fingerprint_invalid');
 expect(()=>fingerprintSessionVaultCredentials({keyBytes,vaultBytes:Buffer.from(JSON.stringify({...JSON.parse(vaultBytes.toString()),unknown:'synthetic'}))})).toThrow('session_vault_fingerprint_invalid');
});
