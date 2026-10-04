import {afterEach,expect,it} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createNativeProjectLocations} from './native-project-locations.js';
import {createSettingsRuntime} from '../settings-runtime.js';
import {createSettingsNormalizationRuntime} from '../settings-normalization-runtime.js';
const roots=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
async function fixture(){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'registered-native-')));roots.push(root);
 const base=path.join(root,'first'),second=path.join(root,'second'),privateRoot=path.join(root,'private');
 for(const folder of [base,second,privateRoot])await fs.mkdir(folder);
 let projects=[];
 const launch={webDataDirectory:privateRoot,webConfigDirectory:privateRoot,opencodeConfigDirectory:privateRoot,global:{tmp:privateRoot,home:privateRoot}};
 return {base,second,privateRoot,set:values=>{projects=values;},read:createNativeProjectLocations({baseLocations:[{directory:base,readRoots:[base],protectedRoots:[privateRoot]}],launch,getRegisteredProjects:async()=>projects})};
}
it('rederives only registered canonical projects and preserves exact protected roots',async()=>{
 const f=await fixture();expect((await f.read()).map(location=>location.directory)).toEqual([f.base]);
 f.set([{path:f.second}]);const locations=await f.read();expect(locations.map(location=>location.directory)).toEqual([f.base,f.second]);
 expect(locations[1].readRoots[0]).toBe(f.second);expect(locations[1].readRoots).not.toContain(path.dirname(f.second));expect(locations[1].protectedRoots).toContain(f.privateRoot);
 f.set([]);expect((await f.read()).map(location=>location.directory)).toEqual([f.base]);
});
it('refuses malformed/symlink/protected locations without turning paths into a grant',async()=>{
 const f=await fixture();const alias=f.second+'-alias';await fs.symlink(f.second,alias);
 for(const directory of ['relative',f.second+'/..',alias,f.privateRoot]){
  f.set([{path:directory}]);await expect(f.read()).rejects.toMatchObject({code:directory===f.privateRoot?'native_project_directory_protected':'native_project_directory_invalid'});
 }
 f.set(Array.from({length:129},()=>({path:f.second})));await expect(f.read()).rejects.toMatchObject({code:'native_project_directory_invalid'});
});

it('keeps a removed saved project inspectable without granting its missing location',async()=>{
 const f=await fixture();f.set([{path:f.second+'-missing'}]);expect((await f.read()).map(row=>row.directory)).toEqual([f.base]);
});


it('original application project callbacks accept missing settings without weakening location guards',async()=>{
 const f=await fixture();
 const settings=createSettingsRuntime({fsPromises:fs, path, SETTINGS_FILE_PATH:path.join(f.privateRoot,'missing-settings.json')});
 const normalization=createSettingsNormalizationRuntime({os, path, processLike:process, homeDirectory:f.privateRoot});
 const source=await fs.readFile(new URL('../../../application.js',import.meta.url),'utf8');
 const expressions=[...source.matchAll(/getRegisteredProjects:\s*async\s*\(\)\s*=>\s*(sanitizeProjects\(\(await readSettingsFromDisk(?:Migrated)?\(\)\)\?\.projects\)(?:\s*\?\?\s*\[\])?)/g)].map(match=>match[1]);
 expect(expressions).toHaveLength(2);
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 for(const expression of expressions){
  const readProjects=new AsyncFunction('sanitizeProjects','readSettingsFromDisk','readSettingsFromDiskMigrated',`return ${expression};`);
  const projects=await readProjects(normalization.sanitizeProjects,settings.readSettingsFromDisk,settings.readSettingsFromDisk);
  expect(projects).toEqual([]);
  f.set(projects);expect((await f.read()).map(row=>row.directory)).toEqual([f.base]);
  const alias=f.second+'-composition-alias';
  await fs.symlink(f.second,alias).catch(error=>{if(error.code!=='EEXIST')throw error;});
  const malformed=await readProjects(normalization.sanitizeProjects,async()=>({projects:[{id:'alias',path:alias}]}),async()=>({projects:[{id:'alias',path:alias}]}));
  f.set(malformed);await expect(f.read()).rejects.toMatchObject({code:'native_project_directory_invalid'});
 }
});
