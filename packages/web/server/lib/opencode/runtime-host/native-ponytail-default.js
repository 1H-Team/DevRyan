import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
const modes=['off','lite','full','ultra'];
// Original getDefaultMode lowercases without trimming; review is never a default.
const valid=value=>typeof value==='string'&&modes.includes(value.toLowerCase())?value.toLowerCase():null;
export async function captureNativePonytailDefault({launch,environmentDefaultMode}){
 const environment=valid(environmentDefaultMode);if(environment)return {defaultMode:environment,source:'environment',references:[]};
 const root=launch.global.config??launch.opencodeConfigDirectory,file=path.join(root,'ponytail','config.json');
 let descriptor;try{descriptor=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error){if(error.code==='ENOENT')return {defaultMode:'full',source:'default',references:[]};throw error;}
 try{
  if(await fs.realpath(file)!==file)throw new Error('native_ponytail_configuration_unreviewed');
  const stat=await descriptor.stat();if(!stat.isFile()||stat.size>64*1024)throw new Error('native_ponytail_configuration_invalid');
  const bytes=await descriptor.readFile();if(bytes.length!==stat.size)throw new Error('native_configuration_sources_changed');
  const content=new TextDecoder('utf-8',{fatal:true}).decode(bytes),reference={path:file,content,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  let configured;try{configured=valid(JSON.parse(content.replace(/^\uFEFF/,'')).defaultMode);}catch{}
  return {defaultMode:configured??'full',source:configured?'configuration':'default',references:[reference]};
 }finally{await descriptor.close();}
}
