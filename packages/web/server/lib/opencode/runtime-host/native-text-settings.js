import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
const fail=code=>Object.assign(new Error(code),{code,status:503});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const within=(root,file)=>{const relative=path.relative(root,file);return relative===''||relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);};
const git=file=>file.split(path.sep).includes('.git');
const fileRef=value=>typeof value==='string'?value.trim().match(/^\{file:(.+)\}$/i):null;
/** Exact data files only. URLs and unqualified glob/ancestor policies cannot become ambient discovery. */
export async function captureNativeTextSettings({loaded,directory,launch,captureSlimPrompts=false}){
 const agents=structuredClone(loaded.agents),commands=structuredClone(loaded.commands),references=[],instructions=[],slimPrompts={};
 const roots=await Promise.all([directory,launch.opencodeConfigDirectory,launch.global.home].map(root=>fs.realpath(root)));
 let total=0;
 async function capture(file){
  const canonical=await fs.realpath(file);
  if(git(file)||git(canonical)||!roots.some(root=>within(root,canonical)))throw fail('native_text_source_unreviewed');
  const descriptor=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const stat=await descriptor.stat();if(!stat.isFile()||stat.size>1024*1024)throw fail('native_text_source_too_large');
   total+=stat.size;if(total>4*1024*1024||references.length>=256)throw fail('native_text_sources_too_large');
   const bytes=await descriptor.readFile();
   if(bytes.length!==stat.size||await fs.realpath(file)!==canonical)throw fail('native_configuration_sources_changed');
   const current=await fs.stat(canonical);if(current.ino!==stat.ino||current.dev!==stat.dev||current.mtimeMs!==stat.mtimeMs||current.ctimeMs!==stat.ctimeMs)throw fail('native_configuration_sources_changed');
   const content=new TextDecoder('utf-8',{fatal:true}).decode(bytes),reference={path:canonical,content,size:bytes.length,sha256:hash(bytes)};
   references.push(reference);return reference;
  }finally{await descriptor.close();}
 }
 const resolvePrompt=reference=>{const value=reference[1].trim();if(!value)throw fail('native_text_reference_invalid');return path.isAbsolute(value)?value:path.join(launch.opencodeConfigDirectory,value);};
 for(const agent of Object.values(agents)){const match=fileRef(agent.prompt);if(match)agent.prompt=(await capture(resolvePrompt(match))).content;}
 for(const command of Object.values(commands)){const match=fileRef(command.template);if(match)command.template=(await capture(resolvePrompt(match))).content;}
 if(loaded.legacy.instructions!==undefined){
  if(!Array.isArray(loaded.legacy.instructions))throw fail('native_instructions_invalid');
  for(const configured of loaded.legacy.instructions){
   if(typeof configured!=='string'||!configured)throw fail('native_instruction_invalid');
   const match=fileRef(configured),file=match?resolvePrompt(match):configured;
   if(!path.isAbsolute(file)||/[\*?\[\]{}]/.test(file)||/^https?:/i.test(file))throw fail('native_instruction_source_unqualified');
   instructions.push(await capture(file));
  }
 }
 if(captureSlimPrompts){
  const preset=loaded.slim?.activePreset??loaded.slim?.mergedConfig?.preset;
  if(preset!==undefined&&preset!==null&&(typeof preset!=='string'||! /^[a-zA-Z0-9_-]+$/.test(preset)))throw fail('native_slim_preset_invalid');
  const folders=[...(preset?[path.join(directory,'.opencode','prompts',preset)]:[]),path.join(directory,'.opencode','prompts'),
    ...(preset?[path.join(launch.opencodeConfigDirectory,'prompts',preset)]:[]),path.join(launch.opencodeConfigDirectory,'prompts')];
  for(const folder of folders){
   let entries;try{entries=await fs.readdir(folder,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')continue;throw error;}
   for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
    if(!entry.name.endsWith('.md'))continue;
    if(!entry.isFile()||entry.isSymbolicLink())throw fail('native_text_source_unreviewed');
    const stem=entry.name.slice(0,-3),append=stem.endsWith('_append'),name=append?stem.slice(0,-7):stem;
    if(!/^[a-zA-Z0-9_-]+$/.test(name))throw fail('native_slim_prompt_name_invalid');
    const key=append?'appendPrompt':'prompt',value=slimPrompts[name]??={};
    if(Object.hasOwn(value,key))continue;
    value[key]=(await capture(path.join(folder,entry.name))).content;
   }
  }
 }
 return {agents,commands,instructions,textReferences:references,slimPrompts};
}
export async function verifyNativeTextSettings(references){
 for(const reference of references){
  const file=await fs.open(reference.path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const stat=await file.stat();if(!stat.isFile()||stat.size!==reference.size||await fs.realpath(reference.path)!==reference.path||hash(await file.readFile())!==reference.sha256)throw fail('native_configuration_sources_changed');}
  finally{await file.close();}
 }
}
