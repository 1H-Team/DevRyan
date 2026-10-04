import {afterEach,expect,it} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {seedNativeSetup,projectNativeSetupSettings} from './native-setup-seed.js';
import {projectNativeSetupCredentials} from './native-setup-credential-data.js';
import {resolveNativeProviderConfiguration} from './native-provider-configuration.js';
import {relocateNativeSetupProfiles} from './native-setup-profiles.js';
const roots=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
async function fixture(){
 const base=path.resolve(import.meta.dirname,'../../../../../../.cache/v2-validation');await fs.mkdir(base,{recursive:true});
 const root=await fs.mkdtemp(path.join(base,'native-setup-'));roots.push(root);
 const launch=base=>({webDataDirectory:path.join(base,'web'),webConfigDirectory:path.join(base,'web-config'),opencodeConfigDirectory:path.join(base,'config'),opencodeDataDirectory:path.join(base,'data'),home:path.join(base,'home'),global:{home:path.join(base,'home')}});
 const source=launch(path.join(root,'source')),target=launch(path.join(root,'target'));
 for(const value of [source,target])for(const dir of [value.webDataDirectory,value.webConfigDirectory,value.opencodeConfigDirectory,value.opencodeDataDirectory,value.home])await fs.mkdir(dir,{recursive:true});
 const write=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value));};
 return {root,source,target,write};
}
it('preserves setup and credentials but excludes conversation authority, journals and caches',async()=>{
 const f=await fixture();await f.write(path.join(f.source.webDataDirectory,'settings.json'),{themeId:'dark',projects:[{id:'project',path:f.root,selectedSessionId:'old'}],desktopHosts:[],selectedSessionId:'old',orchestration:{},opencodeBinary:'/old'});
 await f.write(path.join(f.source.webDataDirectory,'quota','cache.json'),{old:true});
 for(const name of ['diagnostic-journal.jsonl','session-title-outbox.json','tasks.json','receipts.json'])await f.write(path.join(f.source.webDataDirectory,name),{old:true});
 await f.write(path.join(f.source.opencodeDataDirectory,'opencode.db'),{old:true});
 await f.write(path.join(f.source.opencodeDataDirectory,'auth.json'),{openai:{type:'oauth',access:'fixture-access',refresh:'fixture-refresh',expires:123,accountId:'fixture-account'}});
 await f.write(path.join(f.source.opencodeConfigDirectory,'.openchamber','config.json'),{roles:{builder:{model:'a'}}});
 await f.write(path.join(f.source.opencodeConfigDirectory,'ponytail','config.json'),{enabled:true});
 await seedNativeSetup(f);
 expect(JSON.parse(await fs.readFile(path.join(f.target.webDataDirectory,'settings.json'),'utf8'))).toEqual({themeId:'dark',projects:[{id:'project',path:f.root}],desktopHosts:[]});
 expect((await fs.readdir(f.target.webDataDirectory)).sort()).toEqual(['native-setup-seed.json','settings.json']);
 expect(await fs.readdir(f.target.opencodeDataDirectory)).toEqual([]);
 expect(JSON.parse(await fs.readFile(path.join(f.target.opencodeConfigDirectory,'native-setup-credentials.json'),'utf8')).credentials[0].value).toEqual({type:'oauth',methodID:'chatgpt-browser',access:'fixture-access',refresh:'fixture-refresh',expires:123,metadata:{accountID:'fixture-account'}});
 expect(JSON.parse(await fs.readFile(path.join(f.target.opencodeConfigDirectory,'ponytail','config.json'),'utf8'))).toEqual({enabled:true});
 const first=await seedNativeSetup(f);await f.write(path.join(f.source.webDataDirectory,'settings.json'),{themeId:'changed'});expect(await seedNativeSetup(f)).toEqual(first);
 await f.write(path.join(f.target.webDataDirectory,'settings.json'),{themeId:'tampered'});await expect(seedNativeSetup(f)).rejects.toMatchObject({code:'native_setup_seed_changed'});
});
it('relocates exact Meridian account files and preserves original keychain identity',async()=>{
 const f=await fixture(),account=path.join(f.source.home,'.claude');
 await f.write(path.join(account,'.credentials.json'),{claudeAiOauth:{accessToken:'fixture'}});await f.write(path.join(account,'history.jsonl'),{privateHistory:true});
 await f.write(path.join(f.source.home,'.config','meridian','profiles.json'),[{id:'default',type:'claude-max'}]);
 await seedNativeSetup(f);const [profile]=JSON.parse(await fs.readFile(path.join(f.target.home,'.config','meridian','profiles.json'),'utf8'));
 expect(profile.keychainService).toBe('Claude Code-credentials');expect(profile.claudeConfigDir.startsWith(f.target.home+path.sep)).toBe(true);
 expect(await fs.readdir(profile.claudeConfigDir)).toEqual(['.credentials.json']);
 const configuration=await resolveNativeProviderConfiguration({globals:{home:f.target.home,config:f.target.opencodeConfigDirectory,data:f.target.opencodeDataDirectory},environment:{}});expect(configuration.profiles[0]).toMatchObject(profile);
 await f.write(path.join(f.target.home,'.config','meridian','profiles.json'),[{...profile,keychainService:{invalid:true}}]);
 await expect(resolveNativeProviderConfiguration({globals:{home:f.target.home,config:f.target.opencodeConfigDirectory,data:f.target.opencodeDataDirectory},environment:{}})).rejects.toMatchObject({code:'native_provider_configuration_invalid'});
 const moved=await relocateNativeSetupProfiles({profiles:[profile],sourceHome:f.target.home,targetHome:path.join(f.root,'next'),copyAccount:async()=>{}});
 expect(moved[0].keychainService).toBe(profile.keychainService);expect(moved[0].claudeConfigDir).not.toBe(profile.claudeConfigDir);
 await expect(relocateNativeSetupProfiles({profiles:[{...profile,keychainService:'foreign-service'}],sourceHome:f.target.home,targetHome:f.root,copyAccount:async()=>{}})).rejects.toMatchObject({code:'native_setup_profiles_invalid'});
});
it('refuses symlinks and tampered retry markers without reading outside setup roots',async()=>{
 const f=await fixture();await fs.symlink(path.join(f.root,'outside'),path.join(f.source.opencodeConfigDirectory,'opencode.json'));
 await expect(seedNativeSetup(f)).rejects.toMatchObject({code:'native_setup_source_invalid'});await fs.unlink(path.join(f.source.opencodeConfigDirectory,'opencode.json'));
 await f.write(path.join(f.target.webDataDirectory,'native-setup-seed.json'),{schema:1,files:[{path:path.join(f.target.webDataDirectory,'..','outside'),sha256:'a'.repeat(64)}]});
 await expect(seedNativeSetup(f)).rejects.toMatchObject({code:'native_setup_seed_invalid'});
});
it('projects known credential forms and never carries old session pointers',()=>{
 expect(projectNativeSetupSettings({lastSessionID:'old',activeProjectId:'project',projects:[{path:'/project',tasks:[1]}]})).toEqual({activeProjectId:'project',projects:[{path:'/project'}]});
 expect(projectNativeSetupCredentials({'github-copilot/':{type:'oauth',access:'fixture',refresh:'refresh',expires:0}}).credentials[0].value.methodID).toBe('device');
 expect(()=>projectNativeSetupCredentials({openai:{type:'unknown'}})).toThrow('native_setup_credentials_invalid');
 expect(()=>projectNativeSetupCredentials({openai:{type:'api',key:'fixture'},'openai/':{type:'api',key:'fixture'}})).toThrow('native_setup_credentials_invalid');
});
it('retains custom/user layers, preferred Slim JSONC, logical setup and retries only identical partial files',async()=>{
 const f=await fixture();
 await f.write(path.join(f.source.opencodeConfigDirectory,'config.json'),{user:true});
 const custom=path.join(f.source.home,'custom.json');await f.write(custom,{custom:true});f.source.opencodeConfigFile=custom;
 await fs.writeFile(path.join(f.source.opencodeConfigDirectory,'oh-my-opencode-slim.jsonc'),'{ // saved\n "agents":{}\n}');
 await f.write(path.join(f.source.webDataDirectory,'magic-prompts.json'),{version:1,overrides:{'review.instructions':'Saved prompt'}});
 await f.write(path.join(f.source.webDataDirectory,'cloudflare-managed-remote-tunnels.json'),{version:2,tunnels:[{id:'fixture',name:'fixture',hostname:'fixture.test',token:'synthetic-token',originPort:3000,activeConnector:{private:true}}]});
 const captureLogicalSetup=async()=>({localOwners:{'bots-local-owner':{id:'10000000-0000-4000-8000-000000000001',createdAt:'2026-01-01T00:00:00Z'}}});
 // A later invalid source preserves earlier copied setup for an identical retry.
 await f.write(path.join(f.source.opencodeDataDirectory,'auth.json'),{invalid:{type:'bad'}});
 await expect(seedNativeSetup({...f,captureLogicalSetup})).rejects.toMatchObject({code:'native_setup_credentials_invalid'});
 expect(await fs.stat(path.join(f.target.webDataDirectory,'native-setup-seed.json')).catch(error=>error.code)).toBe('ENOENT');
 await f.write(path.join(f.source.opencodeDataDirectory,'auth.json'),{fixture:{type:'api',key:'synthetic'}});
 const marker=await seedNativeSetup({...f,captureLogicalSetup});expect(new Set(marker.files.map(row=>row.path)).size).toBe(marker.files.length);
 expect(JSON.parse(await fs.readFile(path.join(f.target.opencodeConfigDirectory,'config.json'),'utf8'))).toEqual({user:true});
 expect(JSON.parse(await fs.readFile(path.join(f.target.opencodeConfigDirectory,'native-custom-config.json'),'utf8'))).toEqual({custom:true});
 expect(await fs.readFile(path.join(f.target.opencodeConfigDirectory,'oh-my-opencode-slim.jsonc'),'utf8')).toContain('// saved');
 expect(JSON.parse(await fs.readFile(path.join(f.target.webDataDirectory,'native-setup-local-owners.json'),'utf8')).owners['bots-local-owner']).toEqual({id:'10000000-0000-4000-8000-000000000001',createdAt:'2026-01-01T00:00:00Z'});
 expect(JSON.parse(await fs.readFile(path.join(f.target.webDataDirectory,'cloudflare-managed-remote-tunnels.json'),'utf8')).tunnels[0]).not.toHaveProperty('activeConnector');
});
