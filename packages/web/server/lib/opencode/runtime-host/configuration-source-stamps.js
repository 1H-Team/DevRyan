import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const fail=code=>Object.assign(new Error(code),{code,status:503});
/** Metadata only: do not read credentials or execute packages to fence settings. */
export async function captureConfigurationSourceStamp({launch,directories,skillSources=[],additionalPaths=[]}) {
 const roots=[launch.opencodeConfigDirectory,launch.webConfigDirectory,
   path.join(launch.global.home,'.agents','skills'),path.join(launch.global.home,'.opencode'),
   launch.reviewedPluginManifestPath,launch.reviewedNativeConfigPath,
   ...directories.flatMap(directory=>[path.join(directory,'.opencode'),path.join(directory,'.agents','skills')]),
   ...skillSources.map(source=>source.directory),...additionalPaths].filter(Boolean);
 const rows=[];let entries=0;
 async function visit(file){
   if(++entries>8192)throw fail('native_configuration_sources_too_large');
   let stat;try{stat=await fs.lstat(file,{bigint:true});}catch(error){if(error.code==='ENOENT'){rows.push([file,'absent']);return;}throw error;}
   rows.push([file,String(stat.dev),String(stat.ino),String(stat.size),String(stat.mtimeNs),String(stat.ctimeNs),String(stat.mode)]);
   // Symlinks are stamped, never traversed. Actual resource readers separately
   // enforce canonical roots and non-symlink descriptors before capturing bytes.
   if(!stat.isDirectory()||stat.isSymbolicLink())return;
   for(const entry of (await fs.readdir(file)).sort()){
     if(['.git','node_modules','.cache'].includes(entry))continue;
     await visit(path.join(file,entry));
   }
 }
 for(const root of [...new Set(roots)].sort())await visit(root);
 return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
