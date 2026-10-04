import fs from 'node:fs/promises';
import path from 'node:path';
const fail=code=>Object.assign(new Error(code),{code,status:503});
const within=(root,file)=>{const relative=path.relative(root,file);return relative===''||relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);};

/** Local configured data sources only; acquisition and executable loading are separate owners. */
export async function configuredNativeSkillDirectories({settings,directory,launch}) {
 if(settings===undefined)return [];
 if(settings===null||typeof settings!=='object')throw fail('native_skill_source_unqualified');
 const paths=Array.isArray(settings)?settings:settings?.paths??[];
 const urls=Array.isArray(settings)?[]:settings?.urls??[];
 if(!Array.isArray(paths)||!Array.isArray(urls)||urls.length)throw fail('native_skill_remote_source_unqualified');
 const result=[];
 for(const value of paths){
  if(typeof value!=='string'||!value||/^[a-z][a-z0-9+.-]*:/i.test(value))throw fail('native_skill_source_unqualified');
  const expanded=value==='~'?launch.global.home:value.startsWith('~/')?path.join(launch.global.home,value.slice(2)):value;
  const lexical=path.resolve(directory,expanded);
  if(lexical.split(path.sep).includes('.git')||![directory,launch.opencodeConfigDirectory,launch.global.home].some(root=>within(root,lexical)))throw fail('native_skill_source_unreviewed');
  let canonical;
  try{canonical=await fs.realpath(lexical);}catch(error){if(error.code==='ENOENT'){result.push(lexical);continue;}throw error;}
  if(canonical!==lexical||!(await fs.lstat(lexical)).isDirectory())throw fail('native_skill_source_unreviewed');
  result.push(canonical);
 }
 return [...new Set(result)];
}

export async function discoverConfiguredNativeSkills({directories,directory,parseMarkdown}) {
 const skills=[];let count=0;
 async function walk(folder){
  let entries;try{entries=await fs.readdir(folder,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
   if(++count>8192)throw fail('native_skill_catalog_too_large');
   if(entry.name==='.git')continue;
   const file=path.join(folder,entry.name);
   if(entry.isSymbolicLink())throw fail('native_skill_source_unreviewed');
   if(entry.isDirectory())await walk(file);
   else if(entry.isFile()&&entry.name==='SKILL.md'){
    if((await fs.stat(file)).size>4*1024*1024)throw fail('native_skill_too_large');
    const parsed=parseMarkdown(file),name=parsed.frontmatter?.name;
    if(typeof name!=='string'||!name.trim())continue;
    skills.push({name:name.trim(),path:file,source:'opencode',scope:within(directory,file)?'project':'user'});
   }
  }
 }
 for(const root of directories)await walk(root);
 return skills;
}
