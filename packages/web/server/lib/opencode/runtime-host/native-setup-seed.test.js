import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {execFileSync} from 'node:child_process';
import {seedNativeSetup,projectNativeSetupSettings} from './native-setup-seed.js';
import {projectNativeSetupCredentials} from './native-setup-credential-data.js';
import {resolveNativeProviderConfiguration} from './native-provider-configuration.js';
import {relocateNativeSetupProfiles} from './native-setup-profiles.js';
import {protectNativeSetupSource,resetAbandonedNativeSetupSource,removeNativeSetupSource,NATIVE_SETUP_SEED_MAX_FILES,NATIVE_SETUP_SEED_MAX_FILE_BYTES,NATIVE_SETUP_SEED_MAX_TOTAL_BYTES} from './native-setup-source.js';
const roots=[];
let warn;beforeEach(()=>{warn=vi.spyOn(console,'warn').mockImplementation(()=>{});});
afterEach(async()=>{warn.mockRestore();await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
async function fixture(){
 const base=path.resolve(import.meta.dirname,'../../../../../../.cache/v2-validation');await fs.mkdir(base,{recursive:true});
 const root=await fs.mkdtemp(path.join(base,'native-setup-'));roots.push(root);
 const launch=base=>({webDataDirectory:path.join(base,'web'),webConfigDirectory:path.join(base,'web-config'),opencodeConfigDirectory:path.join(base,'config'),opencodeDataDirectory:path.join(base,'data'),home:path.join(base,'home'),global:{home:path.join(base,'home')}});
 const source=launch(path.join(root,'source')),target=launch(path.join(root,'target'));
 for(const value of [source,target])for(const dir of [value.webDataDirectory,value.webConfigDirectory,value.opencodeConfigDirectory,value.opencodeDataDirectory,value.home])await fs.mkdir(dir,{recursive:true});
 const write=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value));};
 const text=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,value);};
 return {root,source,target,write,text,launch};
}
// The production layout: the target is the private fresh-native-source beside the control root.
const production=f=>{const state=path.join(f.root,'state'),controlRoot=path.join(state,'runtime-bundles'),sourceRoot=path.join(state,'fresh-native-source');
 return {controlRoot,sourceRoot,target:{webDataDirectory:path.join(sourceRoot,'web-data'),webConfigDirectory:path.join(sourceRoot,'web-config'),opencodeConfigDirectory:path.join(sourceRoot,'opencode-config'),global:{home:path.join(sourceRoot,'home')}}};};
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
it('skips symlinks leaving HOME and refuses tampered retry markers without reading outside setup roots',async()=>{
 const f=await fixture();await f.text(path.join(f.root,'outside'),'{"outside":true}');await fs.symlink(path.join(f.root,'outside'),path.join(f.source.opencodeConfigDirectory,'opencode.json'));
 expect((await seedNativeSetup(f)).skipped).toEqual([{relativePath:'opencode.json',reason:'symlink_outside_home'}]);
 expect(await fs.readdir(f.target.opencodeConfigDirectory)).toEqual([]);
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
 await f.text(path.join(f.source.opencodeDataDirectory,'auth.json'),'{"invalid":');
 await expect(seedNativeSetup({...f,captureLogicalSetup})).rejects.toMatchObject({code:'native_setup_credentials_invalid',relativePath:'auth.json'});
 expect(await fs.stat(path.join(f.target.webDataDirectory,'native-setup-seed.json')).catch(error=>error.code)).toBe('ENOENT');
 await f.write(path.join(f.source.opencodeDataDirectory,'auth.json'),{fixture:{type:'api',key:'synthetic'}});
 const marker=await seedNativeSetup({...f,captureLogicalSetup});expect(new Set(marker.files.map(row=>row.path)).size).toBe(marker.files.length);
 expect(JSON.parse(await fs.readFile(path.join(f.target.opencodeConfigDirectory,'config.json'),'utf8'))).toEqual({user:true});
 expect(JSON.parse(await fs.readFile(path.join(f.target.opencodeConfigDirectory,'native-custom-config.json'),'utf8'))).toEqual({custom:true});
 expect(await fs.readFile(path.join(f.target.opencodeConfigDirectory,'oh-my-opencode-slim.jsonc'),'utf8')).toContain('// saved');
 expect(JSON.parse(await fs.readFile(path.join(f.target.webDataDirectory,'native-setup-local-owners.json'),'utf8')).owners['bots-local-owner']).toEqual({id:'10000000-0000-4000-8000-000000000001',createdAt:'2026-01-01T00:00:00Z'});
 expect(JSON.parse(await fs.readFile(path.join(f.target.webDataDirectory,'cloudflare-managed-remote-tunnels.json'),'utf8')).tunnels[0]).not.toHaveProperty('activeConnector');
});
it('imports only top-level project records and skips OS metadata in every copied folder',async()=>{
 const f=await fixture(),projects=path.join(f.source.webConfigDirectory,'projects'),text=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,value);};
 await f.write(path.join(projects,'path_a.json'),{id:'a',path:f.root,name:'A',selectedSessionId:'old',sessions:['s']});await f.write(path.join(projects,'path_b.json'),{id:'b',tasks:[1]});
 for(const name of ['1.md','2.md','3.md'])await text(path.join(projects,'path_a','plans',name),'# saved v1 plan');
 await text(path.join(projects,'path_a','nested','deep','note.txt'),'nested');await text(path.join(projects,'path_c','plans','z.md'),'plan');
 await text(path.join(projects,'notes.txt'),'not a record');await text(path.join(projects,'._path_a.json'),'\0\x05\x16\x07');await text(path.join(projects,'Icon\r'),'');
 for(const directory of [projects,path.join(f.source.opencodeConfigDirectory,'skills'),path.join(f.source.opencodeConfigDirectory,'skills','foo'),path.join(f.source.opencodeConfigDirectory,'agents'),
  path.join(f.source.webConfigDirectory,'themes'),path.join(f.source.webDataDirectory,'project-icons'),path.join(f.source.home,'.agents','skills')])await text(path.join(directory,'.DS_Store'),'\0\0\0\x01Bud1');
 await text(path.join(f.source.opencodeConfigDirectory,'skills','foo','SKILL.md'),'skill');await text(path.join(f.source.opencodeConfigDirectory,'skills','foo','._SKILL.md'),'\0');
 await text(path.join(f.source.opencodeConfigDirectory,'agents','a.md'),'agent');await f.write(path.join(f.source.webConfigDirectory,'themes','t.json'),{id:'t'});
 await text(path.join(f.source.webDataDirectory,'project-icons','a.png'),'png');await text(path.join(f.source.home,'.agents','skills','s','SKILL.md'),'home skill');
 const marker=await seedNativeSetup(f),target=path.join(f.target.webConfigDirectory,'projects');
 expect((await fs.readdir(target)).sort()).toEqual(['path_a.json','path_b.json']);
 expect(JSON.parse(await fs.readFile(path.join(target,'path_a.json'),'utf8'))).toEqual({id:'a',path:f.root,name:'A'});expect(JSON.parse(await fs.readFile(path.join(target,'path_b.json'),'utf8'))).toEqual({id:'b'});
 expect(await fs.readdir(path.join(f.target.opencodeConfigDirectory,'skills','foo'))).toEqual(['SKILL.md']);expect(await fs.readdir(path.join(f.target.opencodeConfigDirectory,'agents'))).toEqual(['a.md']);
 expect(await fs.readdir(path.join(f.target.webConfigDirectory,'themes'))).toEqual(['t.json']);expect(await fs.readdir(path.join(f.target.webDataDirectory,'project-icons'))).toEqual(['a.png']);
 expect(await fs.readdir(path.join(f.target.global.home,'.agents','skills'))).toEqual(['s']);
 expect(marker.files.some(row=>/\.DS_Store|\/\._|plans|Icon\r/.test(row.path))).toBe(false);
 expect(await fs.readFile(path.join(projects,'path_a','plans','1.md'),'utf8')).toBe('# saved v1 plan');
});
it('names the failing source file relative to its root without contents or absolute paths',async()=>{
 const f=await fixture(),projects=path.join(f.source.webConfigDirectory,'projects');
 await fs.mkdir(projects,{recursive:true});await fs.writeFile(path.join(projects,'x.json'),'{"secret":"fixture-secret"');
 const error=await seedNativeSetup(f).catch(value=>value);
 expect(error).toMatchObject({code:'native_setup_json_invalid',message:'native_setup_json_invalid',relativePath:'projects/x.json'});expect(JSON.stringify({...error})).not.toContain('fixture-secret');
 await f.write(path.join(projects,'x.json'),[1]);await expect(seedNativeSetup(f)).rejects.toMatchObject({code:'native_setup_json_invalid',relativePath:'projects/x.json'});await fs.rm(path.join(projects,'x.json'));
 await fs.writeFile(path.join(f.source.webDataDirectory,'settings.json'),'[');await expect(seedNativeSetup(f)).rejects.toMatchObject({code:'native_setup_json_invalid',relativePath:'settings.json'});
});
it('skips symlinks escaping HOME in copied folders and reports one sanitized summary',async()=>{
 const f=await fixture(),skills=path.join(f.source.opencodeConfigDirectory,'skills');await f.text(path.join(skills,'real','SKILL.md'),'real');
 await f.text(path.join(f.root,'outside','secret.md'),'fixture-outside');await fs.symlink(path.join(f.root,'outside'),path.join(skills,'real','bad\u0007link'));await fs.symlink(f.root,path.join(skills,'linked'));
 const marker=await seedNativeSetup(f);
 expect(marker.skipped).toEqual([{relativePath:'skills/linked',reason:'symlink_outside_home'},{relativePath:'skills/real/badlink',reason:'symlink_outside_home'}]);expect(marker.skippedCount).toBe(2);
 expect(await fs.readdir(path.join(f.target.opencodeConfigDirectory,'skills'))).toEqual(['real']);expect(await fs.readdir(path.join(f.target.opencodeConfigDirectory,'skills','real'))).toEqual(['SKILL.md']);
 expect(warn).toHaveBeenCalledTimes(1);expect(warn.mock.calls[0][0]).toContain('symlink_outside_home=2');expect(warn.mock.calls[0][0]).not.toContain(f.root);
 expect(JSON.stringify(marker)).not.toContain('fixture-outside');expect(await seedNativeSetup(f)).toMatchObject({files:marker.files,skipped:[]});
});
it('reseeds an abandoned first attempt only without a completed marker, selection or draft',async()=>{
 const f=await fixture(),state=path.join(f.root,'state'),controlRoot=path.join(state,'runtime-bundles'),sourceRoot=path.join(state,'fresh-native-source');await fs.mkdir(controlRoot,{recursive:true});
 const target={webDataDirectory:path.join(sourceRoot,'web-data'),webConfigDirectory:path.join(sourceRoot,'web-config'),opencodeConfigDirectory:path.join(sourceRoot,'opencode-config'),global:{home:path.join(sourceRoot,'home')}};
 const attempt=async()=>{await resetAbandonedNativeSetupSource({controlRoot,sourceRoot});await protectNativeSetupSource({controlRoot,sourceRoot});return seedNativeSetup({source:f.source,target});};
 const settings=path.join(f.source.webDataDirectory,'settings.json'),record=path.join(f.source.webConfigDirectory,'projects','x.json'),seeded=path.join(target.webDataDirectory,'settings.json');
 await f.write(settings,{themeId:'first'});await fs.mkdir(path.dirname(record),{recursive:true});await fs.writeFile(record,'{broken');
 await expect(attempt()).rejects.toMatchObject({code:'native_setup_json_invalid',relativePath:'projects/x.json'});
 expect(JSON.parse(await fs.readFile(seeded,'utf8'))).toEqual({themeId:'first'});
 await f.write(settings,{themeId:'second'});await f.write(record,{id:'x'});
 // A prepared draft or a selection keeps the identical-retry rule for every other partial state.
 await fs.mkdir(path.join(controlRoot,'bundles','default-native'),{recursive:true});
 await expect(attempt()).rejects.toMatchObject({code:'native_setup_seed_changed'});expect(JSON.parse(await fs.readFile(seeded,'utf8'))).toEqual({themeId:'first'});
 await fs.rm(path.join(controlRoot,'bundles'),{recursive:true});await fs.writeFile(path.join(controlRoot,'selection.json'),'{}');
 await expect(attempt()).rejects.toMatchObject({code:'native_setup_seed_changed'});await fs.rm(path.join(controlRoot,'selection.json'));
 // A symlinked seeded subtree is never followed or removed.
 await fs.rename(target.global.home,path.join(state,'home'));await fs.symlink(path.join(state,'home'),target.global.home);
 await expect(resetAbandonedNativeSetupSource({controlRoot,sourceRoot})).rejects.toMatchObject({code:'native_setup_source_ownership_invalid'});
 expect(JSON.parse(await fs.readFile(seeded,'utf8'))).toEqual({themeId:'first'});await fs.unlink(target.global.home);await fs.rename(path.join(state,'home'),target.global.home);
 const marker=await attempt();expect(JSON.parse(await fs.readFile(seeded,'utf8'))).toEqual({themeId:'second'});
 expect(JSON.parse(await fs.readFile(path.join(target.webConfigDirectory,'projects','x.json'),'utf8'))).toEqual({id:'x'});expect(await fs.readFile(path.join(sourceRoot,'.devryan-fresh-source.json'),'utf8')).toContain(controlRoot);
 // A completed seed is never reset; tampering still fails closed.
 expect(await attempt()).toEqual(marker);await f.write(seeded,{themeId:'tampered'});
 await expect(attempt()).rejects.toMatchObject({code:'native_setup_seed_changed'});expect(JSON.parse(await fs.readFile(seeded,'utf8'))).toEqual({themeId:'tampered'});
});
it('follows skills-CLI links and stow-managed roots, files and ~/.agents inside HOME',async()=>{
 const f=await fixture(),home=f.source.home,dotfiles=path.join(home,'dotfiles');
 await f.text(path.join(dotfiles,'agents','skills','s1','SKILL.md'),'canonical skill');await fs.symlink(path.join(dotfiles,'agents'),path.join(home,'.agents'));
 await fs.rm(f.source.opencodeConfigDirectory,{recursive:true});await f.write(path.join(dotfiles,'opencode','opencode.json'),{stow:true});await fs.symlink(path.join(dotfiles,'opencode'),f.source.opencodeConfigDirectory);
 await f.text(path.join(dotfiles,'AGENTS.md'),'linked rules');await fs.symlink(path.join(dotfiles,'AGENTS.md'),path.join(dotfiles,'opencode','AGENTS.md'));
 await fs.mkdir(path.join(dotfiles,'opencode','skills'));await fs.symlink('../../../.agents/skills/s1',path.join(dotfiles,'opencode','skills','s1'));
 const marker=await seedNativeSetup(f),config=f.target.opencodeConfigDirectory;
 expect(marker.skipped).toEqual([]);expect(warn).not.toHaveBeenCalled();
 expect(JSON.parse(await fs.readFile(path.join(config,'opencode.json'),'utf8'))).toEqual({stow:true});expect(await fs.readFile(path.join(config,'AGENTS.md'),'utf8')).toBe('linked rules');
 for(const file of [path.join(config,'skills','s1','SKILL.md'),path.join(f.target.global.home,'.agents','skills','s1','SKILL.md')]){
  expect(await fs.readFile(file,'utf8')).toBe('canonical skill');expect((await fs.lstat(file)).isFile()).toBe(true);expect((await fs.lstat(path.dirname(file))).isSymbolicLink()).toBe(false);
 }
 expect(await seedNativeSetup(f)).toMatchObject({files:marker.files});
});
it('never follows links into DevRyan state or the seed target, and stops cycles',async()=>{
 const f=await fixture(),home=f.source.home,skills=path.join(f.source.opencodeConfigDirectory,'skills'),state=path.join(home,'.local','state','devryan');
 // A target inside HOME, as in production (~/.local/state/devryan/fresh-native-source).
 const target=f.launch(path.join(home,'seed-target'));await fs.mkdir(path.join(state,'runtime-bundles'),{recursive:true});await f.text(path.join(state,'runtime-bundles','selection.json'),'{}');
 await fs.mkdir(skills,{recursive:true});await fs.symlink(path.join(state,'runtime-bundles'),path.join(skills,'state'));await fs.symlink(target.opencodeConfigDirectory,path.join(skills,'seed'));
 await f.text(path.join(home,'.agents','skills','c','SKILL.md'),'cycle');await fs.symlink(path.join(home,'.agents','skills','c'),path.join(home,'.agents','skills','c','loop'));
 await fs.symlink(path.join(home,'missing'),path.join(skills,'dangling'));
 const marker=await seedNativeSetup({...f,target});
 expect(marker.skipped).toEqual([{relativePath:'skills/dangling',reason:'symlink_unresolved'},{relativePath:'skills/seed',reason:'protected'},{relativePath:'skills/state',reason:'protected'},
  {relativePath:'.agents/skills/c/loop',reason:'symlink_cycle'}]);
 expect(await fs.readdir(path.join(target.global.home,'.agents','skills','c'))).toEqual(['SKILL.md']);expect(marker.files.some(row=>row.path.includes('runtime-bundles'))).toBe(false);
});
it('skips VCS/dependency trees and over-budget files, pinning only what verifySeed accepts',async()=>{
 const f=await fixture(),{controlRoot,sourceRoot,target}=production(f),skills=path.join(f.source.opencodeConfigDirectory,'skills');
 await fs.mkdir(controlRoot,{recursive:true});await protectNativeSetupSource({controlRoot,sourceRoot});
 await f.text(path.join(skills,'g','SKILL.md'),'git skill');await f.text(path.join(skills,'g','.git','objects','pack','pack-x.pack'),Buffer.alloc(NATIVE_SETUP_SEED_MAX_FILE_BYTES+1));
 const modules=path.join(f.source.home,'.agents','skills','n','scripts','node_modules');await f.text(path.join(f.source.home,'.agents','skills','n','SKILL.md'),'n');
 for(let index=0;index<4200;index++)await f.text(path.join(modules,'p'+index%50,'f'+index+'.js'),'x');
 await f.text(path.join(skills,'d','data','big.json'),Buffer.alloc(NATIVE_SETUP_SEED_MAX_FILE_BYTES+1,32));await f.text(path.join(skills,'d','data','exact.json'),Buffer.alloc(NATIVE_SETUP_SEED_MAX_FILE_BYTES,32));
 for(let index=0;index<20;index++)await f.text(path.join(skills,'fonts','f'+String(index).padStart(2,'0')+'.ttf'),Buffer.alloc(900*1024,index));
 const marker=await seedNativeSetup({source:f.source,target});
 const reasons=marker.skipped.map(row=>row.relativePath+' '+row.reason);
 expect(reasons).toEqual(expect.arrayContaining(['skills/g/.git excluded','skills/d/data/big.json file_too_large','.agents/skills/n/scripts/node_modules excluded','skills/fonts/f19.ttf total_limit']));
 expect(reasons.filter(row=>row.endsWith('total_limit')).length).toBeGreaterThan(0);
 let total=0;for(const row of marker.files)total+=(await fs.stat(row.path)).size;expect(total).toBeLessThanOrEqual(NATIVE_SETUP_SEED_MAX_TOTAL_BYTES);
 expect(await fs.readFile(path.join(target.opencodeConfigDirectory,'skills','d','data','exact.json'))).toHaveLength(NATIVE_SETUP_SEED_MAX_FILE_BYTES);
 expect(await seedNativeSetup({source:f.source,target})).toMatchObject({files:marker.files});
 await removeNativeSetupSource({controlRoot,sourceRoot,verifySelected:async()=>{}});expect(await fs.stat(sourceRoot).catch(error=>error.code)).toBe('ENOENT');
},60_000);
it('pins at most the verifySeed row budget, generated rows first, with a marker over 1 MiB',async()=>{
 const f=await fixture(),{controlRoot,sourceRoot,target}=production(f),many=path.join(f.source.opencodeConfigDirectory,'skills','many'),prefix='n'.repeat(200);
 await fs.mkdir(controlRoot,{recursive:true});await protectNativeSetupSource({controlRoot,sourceRoot});
 await f.write(path.join(f.source.webDataDirectory,'settings.json'),{themeId:'dark'});await f.write(path.join(f.source.opencodeDataDirectory,'auth.json'),{fixture:{type:'api',key:'synthetic'}});
 for(let index=0;index<NATIVE_SETUP_SEED_MAX_FILES+4;index++)await f.text(path.join(many,prefix+String(index).padStart(5,'0')),'x');
 const captureLogicalSetup=async()=>({localOwners:{'bots-local-owner':{id:'10000000-0000-4000-8000-000000000001',createdAt:'2026-01-01T00:00:00Z'}}});
 const marker=await seedNativeSetup({source:f.source,target,captureLogicalSetup});
 expect(marker.files).toHaveLength(NATIVE_SETUP_SEED_MAX_FILES);expect(marker.skipped.every(row=>row.reason==='file_limit')).toBe(true);expect(marker.skippedCount).toBe(7);
 for(const name of ['settings.json','native-setup-local-owners.json'])expect(marker.files.some(row=>row.path===path.join(target.webDataDirectory,name))).toBe(true);
 expect(marker.files.some(row=>row.path===path.join(target.opencodeConfigDirectory,'native-setup-credentials.json'))).toBe(true);
 expect((await fs.stat(path.join(target.webDataDirectory,'native-setup-seed.json'))).size).toBeGreaterThan(1024*1024);
 expect(await seedNativeSetup({source:f.source,target,captureLogicalSetup})).toMatchObject({files:marker.files});
 await removeNativeSetupSource({controlRoot,sourceRoot,verifySelected:async()=>{}});expect(await fs.stat(sourceRoot).catch(error=>error.code)).toBe('ENOENT');
},120_000);
it('skips FIFOs, sockets and unreadable entries with coded results instead of hanging',async()=>{
 const f=await fixture(),config=f.source.opencodeConfigDirectory;
 await f.text(path.join(config,'skills','ff','SKILL.md'),'ff');execFileSync('mkfifo',[path.join(config,'skills','ff','pipe')]);
 const short=await fs.mkdtemp(path.join(os.tmpdir(),'s-'));roots.push(short);const server=net.createServer();await new Promise(resolve=>server.listen(path.join(short,'h.sock'),resolve));
 try{
  await fs.mkdir(path.join(config,'skills','sock'),{recursive:true});await fs.rename(path.join(short,'h.sock'),path.join(config,'skills','sock','h.sock'));
  await f.text(path.join(config,'agents','x.md'),'root-owned');await fs.chmod(path.join(config,'agents','x.md'),0);await fs.mkdir(path.join(config,'commands','locked'),{recursive:true});await fs.chmod(path.join(config,'commands','locked'),0);
  const marker=await seedNativeSetup(f);
  expect(marker.skipped).toEqual([{relativePath:'agents/x.md',reason:'unreadable'},{relativePath:'commands/locked',reason:'unreadable'},
   {relativePath:'skills/ff/pipe',reason:'unsupported_type'},{relativePath:'skills/sock/h.sock',reason:'unsupported_type'}]);
  expect(await fs.readdir(path.join(f.target.opencodeConfigDirectory,'skills','ff'))).toEqual(['SKILL.md']);
 }finally{server.close();await fs.chmod(path.join(config,'agents','x.md'),0o600).catch(()=>{});await fs.chmod(path.join(config,'commands','locked'),0o700).catch(()=>{});}
},10_000);
it('writes Meridian settings once and seeds profiles with the loader tolerance',async()=>{
 const seed=async(prepare,environment)=>{const f=await fixture();await prepare(f);return {f,marker:await seedNativeSetup({...f,environment}),
  read:async name=>JSON.parse(await fs.readFile(path.join(f.target.home,'.config','meridian',name),'utf8'))};};
 // MERIDIAN_DEFAULT_PROFILE beside a saved settings.json: one merged save.
 let run=await seed(f=>f.write(path.join(f.source.home,'.config','meridian','settings.json'),{theme:'kept',activeProfile:'old'}),{MERIDIAN_DEFAULT_PROFILE:' work '});
 expect(await run.read('settings.json')).toEqual({theme:'kept',activeProfile:'work'});expect(run.marker.skipped).toEqual([]);
 // Empty export = unset; id-less rows and accounts outside HOME are dropped; trailing slashes are normalized.
 run=await seed(async f=>{await f.write(path.join(f.source.home,'.claude-work','.credentials.json'),{claudeAiOauth:{accessToken:'fixture'}});
  await f.write(path.join(f.source.home,'.config','meridian','profiles.json'),[{id:'work',type:'claude-max',claudeConfigDir:path.join(f.source.home,'.claude-work')+'/'},{type:'api'},
   {id:'external',type:'claude-max',claudeConfigDir:'/Volumes/External/.claude'}]);},{MERIDIAN_PROFILES:''});
 const [work,...rest]=await run.read('profiles.json');expect(rest).toEqual([]);expect(work).toMatchObject({id:'work',type:'claude-max'});
 expect(work.claudeConfigDir.startsWith(run.f.target.home+path.sep)).toBe(true);expect(await fs.readdir(work.claudeConfigDir)).toEqual(['.credentials.json']);
 expect(run.marker.skipped).toEqual([{relativePath:'.config/meridian/profiles.json',reason:'profile_id_invalid'},{relativePath:'.config/meridian/profiles.json',reason:'profile_account_outside_home',profile:'external'}]);
 expect(JSON.stringify(run.marker.skipped)).not.toContain('/Volumes');
 // An unparsable export falls back to disk; an unparsable file is no profiles.
 run=await seed(f=>f.write(path.join(f.source.home,'.config','meridian','profiles.json'),[{id:'disk'}]),{MERIDIAN_PROFILES:'{bad'});
 expect(await run.read('profiles.json')).toEqual([{id:'disk'}]);expect(run.marker.skipped).toEqual([{relativePath:'MERIDIAN_PROFILES',reason:'profiles_invalid'}]);
 run=await seed(f=>f.text(path.join(f.source.home,'.config','meridian','profiles.json'),'[{'),{});
 expect(await fs.readdir(path.join(run.f.target.home,'.config','meridian')).catch(error=>error.code)).toBe('ENOENT');expect(run.marker.skipped).toEqual([{relativePath:'.config/meridian/profiles.json',reason:'profiles_invalid'}]);
});
it('projects auth.json like the SDK import: wellknown and undecodable entries are skipped, never fatal',async()=>{
 const f=await fixture();
 await f.write(path.join(f.source.opencodeDataDirectory,'auth.json'),{openai:{type:'api',key:'fixture-key'},'https://opencode.example.com/':{type:'wellknown',key:'K',token:'fixture-token'},
  'github-copilot/':{type:'oauth',access:'fixture-access',refresh:'fixture-refresh',expires:5},broken:{type:'oauth',access:'fixture-access',expires:1},odd:{type:'mystery'}});
 const marker=await seedNativeSetup(f);
 const seeded=JSON.parse(await fs.readFile(path.join(f.target.opencodeConfigDirectory,'native-setup-credentials.json'),'utf8'));
 expect(seeded.credentials.map(row=>row.integrationID)).toEqual(['openai','github-copilot']);
 expect(marker.skipped).toEqual([{relativePath:'auth.json',reason:'credential_wellknown_unsupported'},{relativePath:'auth.json',reason:'credential_invalid',integrationID:'broken'},{relativePath:'auth.json',reason:'credential_invalid',integrationID:'odd'}]);
 expect(JSON.stringify(marker)+warn.mock.calls.join('')).not.toMatch(/fixture-|example\.com/);
});
