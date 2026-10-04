import fs from 'node:fs/promises';
import path from 'node:path';
import {nativeWebfetchBinaryDirectory} from './native-read-paths.js';

const fail=code=>Object.assign(new Error(code),{code,status:403,statusCode:403});
const within=(root,file)=>file===root||file.startsWith(root+path.sep);

/** Registered project settings are the existing durable owner. Request paths
 * alone never add a native location; every boot rederives canonical scopes. */
export function createNativeProjectLocations({baseLocations,launch,getRegisteredProjects}) {
 const protectedRoots=[...new Set([...baseLocations.flatMap(location=>location.protectedRoots??[]),launch.webDataDirectory,
  launch.webConfigDirectory,launch.opencodeConfigDirectory,...Object.values(launch.global)])];
 return async()=>{
  const projects=await getRegisteredProjects();
  if(!Array.isArray(projects)||projects.length>128)throw fail('native_project_directory_invalid');
  const locations=baseLocations.map(location=>({...location,readRoots:[...(location.readRoots??[location.directory]),
   nativeWebfetchBinaryDirectory(launch.global.tmp,location.directory)],protectedRoots:[...new Set([...(location.protectedRoots??[]),...protectedRoots])]}));
  for(const project of projects){
   const directory=project?.path;
   if(typeof directory!=='string'||!path.isAbsolute(directory)||directory!==path.resolve(directory)||/[\u0000-\u001f]/.test(directory))throw fail('native_project_directory_invalid');
   if(locations.some(location=>location.directory===directory))continue;
   // A removed saved project is still inspectable in settings; it does not
   // grant a location or prevent unrelated valid projects from opening.
   const stat=await fs.lstat(directory).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
   if(!stat)continue;
   if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(directory)!==directory)throw fail('native_project_directory_invalid');
   if(protectedRoots.some(root=>within(root,directory)))throw fail('native_project_directory_protected');
   locations.push({directory,readRoots:[directory,nativeWebfetchBinaryDirectory(launch.global.tmp,directory)],protectedRoots});
  }
  if(locations.length>128)throw fail('native_project_directory_invalid');
  return locations;
 };
}
