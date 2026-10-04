import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {existsSync,readFileSync} from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {resolveNativeProviderConfiguration} from '../../packages/web/server/lib/opencode/runtime-host/native-provider-configuration.js';
import {REVIEWED_CLAUDE_STARTUP} from '../../packages/web/server/lib/opencode/runtime-host/reviewed-claude-transform.js';
import {claudeKeychainService} from '../../packages/web/server/lib/opencode/claude-credential-projection.js';
const repository=path.resolve(import.meta.dirname,'../..');
const fixture=async action=>{
 const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/meridian-configuration-'));
 try{const globals=Object.fromEntries(['home','config','data','state','cache','bin','log','repos','tmp'].map(name=>[name,path.join(root,name)]));for(const directory of Object.values(globals))await fs.mkdir(directory,{recursive:true});await fs.mkdir(path.join(globals.home,'.config/meridian'),{recursive:true});await action({root,globals});}finally{await fs.rm(root,{recursive:true,force:true});}
};
test('private Meridian resolution matches the exact captured loader ordering and filtering',()=>fixture(async({globals})=>{
 const source=await fs.readFile(path.join(repository,'scripts/opencode-v2-native/fixtures/reviewed-claude-1.8.0.txt'),'utf8');assert.equal(createHash('sha256').update(source).digest('hex'),REVIEWED_CLAUDE_STARTUP.sourceSha256);
 const start=source.indexOf('var b=()=>'),end=source.indexOf('function A(e)');assert.ok(start>0&&end>start);
 const oracle=environment=>JSON.parse(JSON.stringify(vm.runInNewContext(source.slice(start,end)+';F()', {q:existsSync,W:readFileSync,J:()=>globals.home,v:path.join,process:{env:environment}})));
 const saved=[{id:'private',type:'claude-max',claudeConfigDir:globals.data},{id:'api',type:'api',apiKey:'owned-fixture-key',baseUrl:'http://127.0.0.1:9'},null,{id:4},{id:'oauth',type:'invalid',oauthToken:'owned-fixture-token',unknown:'ignored'}];
 await fs.writeFile(path.join(globals.home,'.config/meridian/profiles.json'),JSON.stringify(saved));await fs.writeFile(path.join(globals.home,'.config/meridian/settings.json'),JSON.stringify({activeProfile:'api'}));
 for(const environment of [{},{MERIDIAN_PROFILES:'bad JSON'},{MERIDIAN_PROFILES:'[]'},{MERIDIAN_PROFILES:'null'},{MERIDIAN_PROFILES:'{}'},{MERIDIAN_PROFILES:JSON.stringify([{id:'env',type:'oauth-token',oauthToken:'synthetic'}]),MERIDIAN_DEFAULT_PROFILE:'  env  '},{MERIDIAN_DEFAULT_PROFILE:'missing'}])assert.deepEqual(await resolveNativeProviderConfiguration({globals,environment}),oracle(environment));
}));
test('private profile and configuration reads reject external directories, symlinks, duplicate IDs and ambient state',()=>fixture(async({root,globals})=>{
 const external=path.join(root,'external');await fs.mkdir(external);
 const resolve=rows=>resolveNativeProviderConfiguration({globals,environment:{MERIDIAN_PROFILES:JSON.stringify(rows)}});
 for(const directory of [external,'relative'])await assert.rejects(resolve([{id:'private',claudeConfigDir:directory}]),/native_provider_profile_escape/);
 const alias=path.join(globals.home,'alias');await fs.symlink(external,alias);await assert.rejects(resolve([{id:'private',claudeConfigDir:alias}]),/native_provider_profile_escape/);
 await assert.rejects(resolve([{id:'same'},{id:'same'}]),/native_provider_configuration_invalid/);
 const file=path.join(root,'external-profiles.json');await fs.writeFile(file,'[{"id":"foreign"}]');await fs.symlink(file,path.join(globals.home,'.config/meridian/profiles.json'));await assert.rejects(resolveNativeProviderConfiguration({globals,environment:{}}),/native_provider_configuration_escape/);
 await assert.rejects(resolveNativeProviderConfiguration({globals}),/native_provider_configuration_environment_required/);
}));
test('explicit access-only policy and expiry survive environment and disk resolution without changing legacy token profiles',()=>fixture(async({globals})=>{
 const row={id:'qa',type:'oauth-token',credentialPolicy:'access-only',oauthToken:'synthetic',oauthTokenExpiresAt:Date.now()+3600000};
 await fs.writeFile(path.join(globals.home,'.config/meridian/profiles.json'),JSON.stringify([row]));
 for(const environment of [{},{MERIDIAN_PROFILES:JSON.stringify([row])}]){
  const result=await resolveNativeProviderConfiguration({globals,environment});
  assert.equal(result.profiles[0].credentialPolicy,'access-only');assert.equal(result.profiles[0].oauthTokenExpiresAt,undefined);assert.deepEqual(result.oauthTokenExpiries,{qa:row.oauthTokenExpiresAt});
 }
 const resolve=row=>resolveNativeProviderConfiguration({globals,environment:{MERIDIAN_PROFILES:JSON.stringify([row])}});
 for(const bad of [{...row,type:'claude-max'},{...row,credentialPolicy:'renew'},{...row,oauthTokenExpiresAt:'infinite'}])await assert.rejects(resolve(bad),/native_provider_configuration_invalid/);
 const legacy=await resolve({id:'legacy',type:'oauth-token',oauthToken:'synthetic'});assert.equal(legacy.oauthTokenExpiries,undefined);assert.equal(legacy.profiles[0].credentialPolicy,undefined);
}));

test('stable enrollment paths require the private constructor root and exact service without granting renewal',()=>fixture(async({root,globals})=>{
 const controlRoot=path.join(root,'control'),enrollments=path.join(controlRoot,'claude-enrollments');
 const directory=path.join(enrollments,'00000000-0000-4000-8000-000000000001');
 await fs.mkdir(controlRoot,{mode:0o700});await fs.mkdir(enrollments,{mode:0o700});await fs.mkdir(directory,{mode:0o700});
 const profile={id:'dedicated',type:'claude-max',claudeConfigDir:directory,keychainService:claudeKeychainService(directory,globals.home)};
 const resolve=(row=profile,ownedRoot=controlRoot)=>resolveNativeProviderConfiguration({globals,controlRoot:ownedRoot,environment:{MERIDIAN_PROFILES:JSON.stringify([row])}});
 const result=await resolve();assert.deepEqual(result.profiles,[profile]);assert.equal(result.profiles[0].renewalAuthority,undefined);
 await assert.rejects(resolve(profile,path.join(root,'foreign')),/native_provider_profile_escape/);
 await assert.rejects(resolve({...profile,keychainService:'Claude Code-credentials'}),/native_provider_profile_escape/);
 await fs.chmod(directory,0o750);await assert.rejects(resolve(),/native_provider_profile_escape/);await fs.chmod(directory,0o700);
 const alias=path.join(enrollments,'00000000-0000-4000-8000-000000000002');await fs.symlink(directory,alias);
 await assert.rejects(resolve({...profile,claudeConfigDir:alias,keychainService:claudeKeychainService(alias,globals.home)}),/native_provider_profile_escape/);
 await assert.rejects(resolveNativeProviderConfiguration({globals,environment:{MERIDIAN_PROFILES:JSON.stringify([profile])}}),/native_provider_profile_escape/);
}));
