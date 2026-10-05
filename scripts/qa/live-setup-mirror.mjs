import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Schema} from 'effect';
import {ConfigCompaction} from '@opencode/schema/config/compaction';
import {parseConfigJsonc} from '../../packages/web/server/lib/opencode/jsonc-config.js';
import {translateNativeConfiguration} from '../../packages/web/server/lib/opencode/runtime-host/native-configuration-data.js';
import {defaultNativeRegistrations} from '../../packages/web/server/lib/opencode/runtime-host/native-default-bundle.js';
import {verifyNativeRuntimeArtifacts} from '../../packages/web/server/lib/opencode/runtime-host/native-artifacts.js';
import {verifyQaNativeInput} from './native-profile-preparation.mjs';

export const qaRepository=fileURLToPath(new URL('../../',import.meta.url)).replace(/\/$/,'');
export const qaCache=path.join(qaRepository,'.cache');
export const qaHash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>Object.assign(new Error(code),{code});
const inside=(root,file)=>file.startsWith(root+path.sep);
const relativePath=value=>typeof value==='string'&&value&&!path.isAbsolute(value)&&!value.split(/[\\/]/).some(part=>!part||part==='.'||part==='..');
const omitted=new Set(['auth','credentials','credential','apiKey','api_key','accessToken','access_token','refreshToken','refresh_token','oauthToken','password','clientSecret','client_secret','sessionToken','usageSessionToken','managedRemoteTunnelToken','managedRemoteTunnelPresetTokens','keychainService','claudeConfigDir','activeConnector','key','token','refresh','access','secret','authorization','Authorization','cookie','Cookie','headers','httpHeaders','env','environment']);
const eligible=file=>/^(opencode\/(?:agent|agents|command|commands|prompts|skill|skills)\/|home\/(?:\.agents\/skills|\.opencode\/(?:skill|skills))\/)/.test(file)
  ||['opencode/.openchamber/config.json','opencode/config.json','opencode/opencode.json','opencode/opencode.jsonc','opencode/oh-my-opencode-slim.json','opencode/oh-my-opencode-slim.jsonc','opencode/AGENTS.md','web-config/settings.json'].includes(file);

export async function assertQaPrivateDirectory(directory){
  if(!path.isAbsolute(directory??'')||path.resolve(directory)!==directory||!inside(qaCache,directory)||await fs.realpath(directory)!==directory)throw fail('qa_live_private_path_required');
  const stat=await fs.lstat(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700||typeof process.getuid==='function'&&stat.uid!==process.getuid())throw fail('qa_live_private_path_required');
  return stat;
}

/** Repository-cache inputs only. A stable descriptor and path must name the
 * same owned regular file for the complete bounded read. */
export async function readQaPinnedFile(file,sha256,maximum=1024*1024){
  if(!path.isAbsolute(file??'')||path.resolve(file)!==file||!inside(qaCache,file)||await fs.realpath(file)!==file
    ||sha256!==undefined&&!/^[a-f0-9]{64}$/.test(sha256))throw fail('qa_live_input_path_invalid');
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const before=await handle.stat();
    if(!before.isFile()||before.nlink!==1||before.size>maximum||(before.mode&0o022)||typeof process.getuid==='function'&&before.uid!==process.getuid())throw fail('qa_live_input_invalid');
    const bytes=Buffer.alloc(before.size+1);let length=0;
    while(length<bytes.length){const row=await handle.read(bytes,length,bytes.length-length,null);if(!row.bytesRead)break;length+=row.bytesRead;}
    const after=await handle.stat(),current=await fs.lstat(file);
    for(const row of [after,current])if(!row.isFile()||row.nlink!==1||['dev','ino','size','mtimeMs','ctimeMs'].some(key=>row[key]!==before[key]))throw fail('qa_live_input_changed');
    if(length!==before.size||await fs.realpath(file)!==file||sha256!==undefined&&qaHash(bytes.subarray(0,length))!==sha256)throw fail('qa_live_input_changed');
    return bytes.subarray(0,length);
  }finally{await handle.close();}
}

export function removeQaLiveCredentials(value){
  if(Array.isArray(value))return value.map(removeQaLiveCredentials);
  if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!omitted.has(key)).map(([key,item])=>[key,removeQaLiveCredentials(item)]));
  return value;
}

export function parseQaSavedGraph(graph){
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const exact=(value,keys)=>object(value)&&Object.keys(value).every(key=>keys.includes(key));
  const name=value=>typeof value==='string'&&/^[A-Za-z0-9._-]{1,128}$/.test(value);
  const model=value=>typeof value==='string'&&/^[A-Za-z0-9._-]{1,128}\/[A-Za-z0-9._/-]{1,256}$/.test(value);
  const variant=value=>value===null||typeof value==='string'&&/^[A-Za-z0-9._-]{1,64}$/.test(value);
  const selection=value=>exact(value,['model','variant'])&&model(value.model)&&variant(value.variant);
  if(!exact(graph,['agentSelections','nativeBackupSelections','nativeCompactionSettings','councilMembers'])||!object(graph.agentSelections)
    ||!Object.keys(graph.agentSelections).length||Object.keys(graph.agentSelections).length>64)throw fail('qa_live_saved_graph_invalid');
  for(const [agent,row] of Object.entries(graph.agentSelections))if(!name(agent)||!exact(row,['model','variant','promptSha256'])||!model(row.model)
    ||!variant(row.variant)||!/^[a-f0-9]{64}$/.test(row.promptSha256??''))throw fail('qa_live_saved_graph_invalid');
  const backups=graph.nativeBackupSelections,slim=backups?.slim;
  if(!exact(backups,['slim','devryan'])||!object(backups.devryan)||!exact(slim,['runtimeChains','modelArrays','fallback','effectiveExecutionVariant'])
    ||!object(slim.runtimeChains)||!object(slim.modelArrays)||slim.effectiveExecutionVariant!=='default'
    ||!exact(slim.fallback,['enabled','maxRetries','initialRetryDelayMs','retryDelayMs']))throw fail('qa_live_saved_graph_invalid');
  for(const [agent,chain] of Object.entries(slim.runtimeChains)){
    const models=slim.modelArrays[agent];
    if(!Object.hasOwn(graph.agentSelections,agent)||!Array.isArray(chain)||!chain.length||chain.length>64||!Array.isArray(models)||models.length!==chain.length
      ||chain.some((id,index)=>!model(id)||!exact(models[index],['id','variant'])||models[index].id!==id||!variant(models[index].variant)))throw fail('qa_live_saved_graph_invalid');
  }
  if(Object.keys(slim.modelArrays).some(agent=>!Object.hasOwn(slim.runtimeChains,agent)))throw fail('qa_live_saved_graph_invalid');
  for(const [key,value] of Object.entries(slim.fallback))if(key==='enabled'?typeof value!=='boolean':!Number.isSafeInteger(value)||value<0||value>(key==='maxRetries'?100:600000))throw fail('qa_live_saved_graph_invalid');
  for(const [agent,row] of Object.entries(backups.devryan))if(!Object.hasOwn(graph.agentSelections,agent)||!selection(row))throw fail('qa_live_saved_graph_invalid');
  if(!Array.isArray(graph.councilMembers)||graph.councilMembers.length>64)throw fail('qa_live_saved_graph_invalid');
  for(const row of graph.councilMembers)if(!exact(row,['providerId','modelId','variant','agent','timeoutMs'])||!name(row.providerId)||!model(row.providerId+'/'+row.modelId)
    ||!variant(row.variant)||!Object.hasOwn(graph.agentSelections,row.agent)||!Number.isSafeInteger(row.timeoutMs)||row.timeoutMs<1||row.timeoutMs>900000)throw fail('qa_live_saved_graph_invalid');
  try{Schema.decodeUnknownSync(ConfigCompaction.Info)(graph.nativeCompactionSettings,{onExcessProperty:'error'});}catch{throw fail('qa_live_saved_graph_invalid');}
  return structuredClone(graph);
}

/** Only approved nonsecret setup entries are read. Accounts, databases,
 * journals, vaults and installed-home discovery never enter this walk. */
export async function prepareLiveSetupMirror({inputFile,inputSha256,graphFile,graphSha256,artifactRoot,outputRoot,verifyArtifacts=verifyNativeRuntimeArtifacts}){
  if(!/^[a-f0-9]{64}$/.test(inputSha256??'')||!/^[a-f0-9]{64}$/.test(graphSha256??''))throw fail('qa_live_input_digest_required');
  const inputBytes=await readQaPinnedFile(inputFile,inputSha256,4*1024*1024),graphBytes=await readQaPinnedFile(graphFile,graphSha256,4*1024*1024);
  const input=JSON.parse(inputBytes),savedGraph=parseQaSavedGraph(JSON.parse(graphBytes)),source=input.preparedInput?.sourceHome,rows=input.preparedInput?.files;
  if(!Array.isArray(rows)||!rows.length||rows.length>4096||!path.isAbsolute(source??'')||!inside(qaCache,source)||await fs.realpath(source)!==source)throw fail('qa_live_mirror_input_required');
  await assertQaPrivateDirectory(artifactRoot);
  const manifestPath=path.join(artifactRoot,'native-bundle.json'),manifestBytes=await readQaPinnedFile(manifestPath,undefined,4*1024*1024);
  const artifacts=await verifyArtifacts({manifestPath,manifestSha256:qaHash(manifestBytes),launcher:path.join(artifactRoot,`DevRyan-execution-${process.platform}-${process.arch}`)});
  await assertQaPrivateDirectory(path.dirname(outputRoot));await fs.mkdir(outputRoot,{mode:0o700});await assertQaPrivateDirectory(outputRoot);
  const sourceHome=path.join(outputRoot,'mirror'),records=[],seen=new Set();let total=0,disabledMcpEntries=0;
  await fs.mkdir(sourceHome,{mode:0o700});
  const write=async(relative,bytes)=>{
    const file=path.join(sourceHome,relative);await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.writeFile(file,bytes,{flag:'wx',mode:0o400});
    return qaHash(bytes);
  };
  try{
    for(const row of rows){
      if(!relativePath(row.path)||seen.has(row.path)||!/^[a-f0-9]{64}$/.test(row.sha256??'')||Object.keys(row).some(key=>!['path','sha256'].includes(key)))throw fail('qa_live_mirror_manifest_invalid');
      seen.add(row.path);if(!eligible(row.path))continue;
      const bytes=await readQaPinnedFile(path.join(source,row.path),row.sha256);total+=bytes.length;if(total>16*1024*1024)throw fail('qa_live_mirror_size_limit');
      let projected=bytes;
      if(/\.jsonc?$/.test(row.path)){
        const value=removeQaLiveCredentials(parseConfigJsonc(bytes.toString('utf8')));
        if(row.path==='web-config/settings.json')for(const key of ['projects','approvedDirectories','lastDirectory','activeProjectId','selectedSessionId','selectedSessionID','sessions','drafts','tasks','desktopHosts','desktopSshInstances'])delete value[key];
        if(value.mcp){
          if(typeof value.mcp!=='object'||Array.isArray(value.mcp))throw fail('qa_live_mirror_mcp_invalid');
          for(const entry of Object.values(value.mcp)){
            if(!entry||typeof entry!=='object'||Array.isArray(entry))throw fail('qa_live_mirror_mcp_invalid');entry.enabled=false;disabledMcpEntries++;
          }
        }
        projected=Buffer.from(JSON.stringify(value,null,2)+'\n');
      }
      records.push({path:row.path,sha256:await write(row.path,projected),sourceSha256:row.sha256,credentialProjection:!bytes.equals(projected)});
    }
    for(const directory of ['home','opencode','web-config'])await fs.mkdir(path.join(sourceHome,directory),{recursive:true,mode:0o700});
    // Actual configuration owners resolve all copied layers, Markdown agents
    // and overrides. The base supplies only the translator's safe defaults.
    for(const [relative,value] of Object.entries({'reviewed-native.json':{schema:1,configuration:translateNativeConfiguration({legacy:{},agents:{}}),locations:[],catalogRequirements:{agents:[],models:[],plugins:[],tools:[]}},
      'reviewed-plugins.json':{schema:1,plugins:defaultNativeRegistrations(artifacts.manifest.inputs.reviewedPlugins)}}))records.push({path:relative,sha256:await write(relative,JSON.stringify(value)+'\n')});
    const preparedInput={sourceHome,artifactRoot,files:records.map(({path,sha256})=>({path,sha256})).sort((a,b)=>a.path.localeCompare(b.path))};
    const inputDigest=await verifyQaNativeInput(preparedInput),preparation={schema:1,status:'prepared-no-credentials-no-runtime',preparedInput,inputDigest,
      mirror:{reviewedNativeFile:'reviewed-native.json',reviewedPluginFile:'reviewed-plugins.json',opencodeConfigDirectory:'opencode',webConfigDirectory:'web-config',homeDirectory:'home'},savedGraph,records,
      sourceInputs:{inputSha256,graphSha256},artifact:{manifestSha256:artifacts.manifestSha256,buildID:artifacts.manifest.buildId},disabledMcpEntries,
      qualification:'auth-handoff-only; live MCP qualification remains separate'};
    const preparationFile=path.join(outputRoot,'preparation.json');await fs.writeFile(preparationFile,JSON.stringify(preparation,null,2)+'\n',{flag:'wx',mode:0o400});
    return {preparationFile,sha256:qaHash(await readQaPinnedFile(preparationFile)),files:records.length};
  }catch(error){await fs.writeFile(path.join(outputRoot,'failed.json'),JSON.stringify({status:'failed',code:/^qa_[a-z_]{1,100}$/.test(error.code??'')?error.code:'qa_live_mirror_failed'})+'\n',{flag:'wx',mode:0o600});throw error;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const args=process.argv.slice(2),flags=new Map(),allowed=new Set(['--input','--input-sha256','--graph','--graph-sha256','--artifact-root','--output-root']);
    for(let index=0;index<args.length;index+=2){if(!allowed.has(args[index])||flags.has(args[index])||!args[index+1]||args[index+1].startsWith('--'))throw fail('qa_live_flags_invalid');flags.set(args[index],args[index+1]);}
    if(flags.size!==allowed.size)throw fail('qa_live_flags_invalid');
    process.stdout.write(JSON.stringify(await prepareLiveSetupMirror({inputFile:flags.get('--input'),inputSha256:flags.get('--input-sha256'),graphFile:flags.get('--graph'),graphSha256:flags.get('--graph-sha256'),artifactRoot:flags.get('--artifact-root'),outputRoot:flags.get('--output-root')}))+'\n');
  }catch(error){process.stderr.write(JSON.stringify({status:'refused',code:/^qa_[a-z_]{1,100}$/.test(error.code??'')?error.code:'qa_live_mirror_failed'})+'\n');process.exitCode=1;}
}
