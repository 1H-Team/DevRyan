import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeProviderConfigurationOperation } from './native-provider-configuration-operation.js';

const fixtures=[];
afterEach(()=>{for(const root of fixtures.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function fixture(providerID='openai') {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR ?? path.resolve('.cache'),'provider-config-')));fixtures.push(root);
  const config=path.join(root,'config'),project=path.join(root,'project');fs.mkdirSync(config);fs.mkdirSync(project);
  const snapshot={locations:[{directory:project,configuration:{providers:{[providerID]:{models:{saved:{}}}}}}]};
  let current=snapshot,ready=true,authorized=true;
  const row={id:'cred_real',integrationID:providerID,valueType:'key',expectedFingerprint:'a'.repeat(64)};
  const credentialMetadata=vi.fn(async()=>[row]),credentialOperation=vi.fn(async()=>null);
  const reauthorize=vi.fn(async()=>{if(!authorized)throw Object.assign(new Error('revoked'),{code:'revoked',statusCode:403});});
  const run=createNativeProviderConfigurationOperation({descriptor:{generation:2,launch:{opencodeConfigDirectory:config},projectMap:[{targetDirectory:project}]},
    getSnapshot:()=>current,isReady:()=>ready,captureWebAuthorization:async()=>reauthorize,credentialMetadata,credentialOperation});
  const write=(scope,bytes)=>{const file=path.join(scope==='project'?project:config,'opencode.jsonc');fs.writeFileSync(file,bytes);return file;};
  return {root,config,project,run,write,credentialMetadata,credentialOperation,row,revoke:()=>{authorized=false;},replace:()=>{current={...snapshot};},stop:()=>{ready=false;}};
}
describe('selected native provider configuration owner',()=>{
  it('removes both saved provider shapes/comments without changing unrelated settings or a global-only project',async()=>{
    const f=fixture(),user=f.write('user','{\n // keep comment\n "provider":{"openai":{},"other":{}},"providers":{"openai":{}},"model":"other/m"\n}');
    const project=f.write('project','{"provider":{"openai":{}}}');const before=fs.readFileSync(user,'utf8');
    const committed=[];await f.run({providerID:'openai',scope:'all'},async owner=>{await owner.verifyConfiguration();await owner.disconnectCredentials(()=>committed.push('auth'));await owner.removeConfiguration(scope=>committed.push(scope));});
    const next=fs.readFileSync(user,'utf8');expect(next).toContain('// keep comment');expect(next).toContain('"other"');expect(next).toMatch(/"model"\s*:\s*"other\/m"/);expect(next).not.toContain('"openai"');
    expect(fs.readFileSync(`${user}.openchamber.backup`,'utf8')).toBe(before);expect(fs.readFileSync(project,'utf8')).toContain('openai');expect(committed).toEqual(['auth','user']);
    expect(f.credentialOperation.mock.calls[0][0]).toMatchObject({operation:'openai.credential.remove',expectedFingerprint:f.row.expectedFingerprint,directory:f.project});
  });
  it('preserves exact selected project sources and removes all four project layers',async()=>{
    const f=fixture('cursor-acp');fs.mkdirSync(path.join(f.project,'.opencode'));
    const files=['opencode.json','opencode.jsonc','.opencode/opencode.json','.opencode/opencode.jsonc'].map(name=>path.join(f.project,name));
    files.forEach(file=>fs.writeFileSync(file,'{"providers":{"cursor-acp":{},"other":{}}}'));
    await f.run({providerID:'cursor-acp',directory:f.project,scope:'project'},owner=>owner.removeConfiguration(()=>{}));
    for(const file of files){expect(fs.readFileSync(file,'utf8')).not.toContain('cursor-acp');expect(fs.readFileSync(file,'utf8')).toContain('other');}
    expect(f.credentialOperation).not.toHaveBeenCalled();
  });
  it('rejects malformed later config before deleting any credentials',async()=>{
    const f=fixture();f.write('user','{"provider":{"openai":{}}}');fs.writeFileSync(path.join(f.config,'config.json'),'{ broken');
    await expect(f.run({providerID:'openai',scope:'all'},owner=>owner.disconnectCredentials(()=>{}))).rejects.toMatchObject({code:'INVALID_JSONC'});expect(f.credentialOperation).not.toHaveBeenCalled();
  });
  it.each(['source','backup'])('refuses %s symlinks before credential deletion',async kind=>{
    const f=fixture(),file=f.write('user','{"provider":{"openai":{}}}'),outside=path.join(f.root,'outside.json');fs.writeFileSync(outside,'{}');
    if(kind==='source')fs.rmSync(file);fs.symlinkSync(outside,kind==='source'?file:`${file}.openchamber.backup`);
    await expect(f.run({providerID:'openai',scope:'all'},owner=>owner.disconnectCredentials(()=>{}))).rejects.toMatchObject({code:'native_provider_configuration_symlink'});expect(f.credentialOperation).not.toHaveBeenCalled();expect(fs.readFileSync(outside,'utf8')).toBe('{}');
  });
  it('rejects a new config layer created while native credential removal awaits; retains actual acknowledged removal',async()=>{
    const f=fixture(),file=f.write('user','{"provider":{"openai":{}}}');f.credentialOperation.mockImplementation(async()=>{fs.writeFileSync(path.join(f.config,'config.json'),'{}');});
    let removed=false;await expect(f.run({providerID:'openai',scope:'all'},async owner=>{await owner.disconnectCredentials(()=>{removed=true;});await owner.removeConfiguration(()=>{});})).rejects.toMatchObject({code:'native_provider_configuration_changed'});
    expect(removed).toBe(true);expect(fs.readFileSync(file,'utf8')).toContain('openai');
  });
  it.each(['revoke','replace'])('refuses %s during metadata await before credential/config effects',async mode=>{
    const f=fixture(),file=f.write('user','{"provider":{"openai":{}}}');f.credentialMetadata.mockImplementation(async()=>{f[mode]();return[f.row];});
    await expect(f.run({providerID:'openai',scope:'all'},owner=>owner.disconnectCredentials(()=>{}))).rejects.toBeTruthy();expect(f.credentialOperation).not.toHaveBeenCalled();expect(fs.readFileSync(file,'utf8')).toContain('openai');
  });
  it('returns native auth-only metadata and finite copied sources without mutating credentials',async()=>{
    const f=fixture('cursor-acp');f.write('user','{"provider":{"cursor-acp":{}}}');
    const result=await f.run({providerID:'cursor-acp',directory:f.project,scope:'read'},async owner=>({...owner.readSources(),auth:await owner.readAuthenticationSource()}));
    expect(result.auth).toEqual({exists:true,path:null});expect(result.user.exists).toBe(true);expect(f.credentialOperation).not.toHaveBeenCalled();
  });
  it('refuses changed backup after awaited metadata before credentials and source commit',async()=>{
    const f=fixture(),file=f.write('user','{"provider":{"openai":{}}}');f.credentialMetadata.mockImplementation(async()=>{fs.writeFileSync(`${file}.openchamber.backup`,'{}');return[f.row];});
    await expect(f.run({providerID:'openai',scope:'all'},owner=>owner.disconnectCredentials(()=>{}))).rejects.toMatchObject({code:'native_provider_configuration_changed'});expect(f.credentialOperation).not.toHaveBeenCalled();expect(fs.readFileSync(file,'utf8')).toContain('openai');
  });
  it('freezes exact read scope and refuses borrowing it for credential deletion',async()=>{
    const f=fixture(),input={providerID:'openai',scope:'read'};
    await expect(f.run(input,async owner=>{input.scope='all';await owner.disconnectCredentials(()=>{});})).rejects.toMatchObject({code:'native_provider_configuration_scope_invalid'});expect(f.credentialMetadata).not.toHaveBeenCalled();expect(f.credentialOperation).not.toHaveBeenCalled();
  });
  it('closes captured callbacks after the original operation settles',async()=>{
    const f=fixture();let retained;
    await f.run({providerID:'openai',scope:'read'},async owner=>{retained=owner;});
    await expect(retained.readAuthenticationSource()).rejects.toMatchObject({code:'native_provider_configuration_runtime_changed'});expect(()=>retained.readSources()).toThrow();expect(f.credentialMetadata).not.toHaveBeenCalled();
  });
  it.each([{providerID:'foreign',scope:'all'},{providerID:'openai',scope:'bad'},{providerID:'openai',scope:'project'},{providerID:'openai',scope:'all',directory:'/unreviewed'}])('refuses unreviewed request %j',async input=>{
    const f=fixture();await expect(f.run(input,()=>null)).rejects.toBeTruthy();expect(f.credentialMetadata).not.toHaveBeenCalled();expect(f.credentialOperation).not.toHaveBeenCalled();
  });
});
