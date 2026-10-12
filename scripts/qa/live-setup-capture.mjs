import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {qaHash,readQaPinnedFile,assertQaPrivateDirectory,isQaLiveSetupFile,projectQaLiveSetupFile,parseQaSavedGraph,prepareLiveSetupMirror} from './live-setup-mirror.mjs';
import {createQaNativePreparationFactory} from './native-profile-factory.mjs';
import {verifyQaNativeInput,prepareQaNativeBundle,createQaNativeLaunchEnvironment,readQaNativeSelectionView} from './native-profile-preparation.mjs';
import {verifyNativeRuntimeArtifacts} from '../../packages/web/server/lib/opencode/runtime-host/native-artifacts.js';
import {translateNativeConfiguration} from '../../packages/web/server/lib/opencode/runtime-host/native-configuration-data.js';
import {defaultNativeRegistrations} from '../../packages/web/server/lib/opencode/runtime-host/native-default-bundle.js';

const fail=code=>Object.assign(new Error(code),{code});
const configFiles=['config.json','opencode.json','opencode.jsonc','oh-my-opencode-slim.json','oh-my-opencode-slim.jsonc','AGENTS.md','.openchamber/config.json'];
const setupFolders=['agent','agents','command','commands','prompts','skill','skills'];
const accountEntry=/^\.env|^\.?(?:auth|credentials?|accounts?|vault|secrets?|tokens?|keychains?)(?:$|[._-])|^\.(?:ssh|netrc|npmrc|pypirc)$|^id_(?:rsa|dsa|ecdsa|ed25519)(?:$|\.)|\.(?:pem|key|p12|pfx|jks|keystore)$|\.(?:db|sqlite|sqlite3)(?:-wal|-shm)?$/i;

async function ownedSource(file,directory){
  if(!path.isAbsolute(file??'')||path.resolve(file)!==file||await fs.realpath(file)!==file)throw fail('qa_capture_source_path_invalid');
  const stat=await fs.lstat(file);
  if(stat.isSymbolicLink()||(directory?!stat.isDirectory():!stat.isFile())||(stat.mode&0o022)
    ||typeof process.getuid==='function'&&stat.uid!==process.getuid()||!directory&&(stat.nlink!==1||stat.size>1024*1024))throw fail('qa_capture_source_invalid');
  return stat;
}

async function readSource(file){
  const before=await ownedSource(file,false),handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const unchanged=stat=>['dev','ino','size','mtimeMs','ctimeMs'].every(key=>stat[key]===before[key]);
  try{
    if(!unchanged(await handle.stat())||await fs.realpath(file)!==file)throw fail('qa_capture_source_changed');
    const bytes=Buffer.alloc(before.size+1);let length=0;
    while(length<bytes.length){const row=await handle.read(bytes,length,bytes.length-length,null);if(!row.bytesRead)break;length+=row.bytesRead;}
    if(length!==before.size||!unchanged(await handle.stat())||!unchanged(await fs.lstat(file))||await fs.realpath(file)!==file)throw fail('qa_capture_source_changed');
    return bytes.subarray(0,length);
  }finally{await handle.close();}
}

export async function deriveCapturedGraph({preparedInput,mirror,outputRoot,createFactory=createQaNativePreparationFactory,prepareBundle=prepareQaNativeBundle,readSelection=readQaNativeSelectionView}){
  const provisional=path.join(outputRoot,'provisional'),runtimeRoot=path.join(provisional,'runtime'),workspace=path.join(provisional,'workspace');
  await fs.mkdir(provisional,{mode:0o700});
  try{
    for(const directory of [runtimeRoot,workspace])await fs.mkdir(directory,{mode:0o700});
    const factory=await createFactory({preparedInput,mirror,bootstrapCredentials:async()=>{throw fail('qa_capture_credentials_forbidden');}});
    const source=await factory.prepareSource({runtimeRoot,workspace,sourceHome:preparedInput.sourceHome,artifactRoot:preparedInput.artifactRoot});
    const {binding}=await prepareBundle({runtimeRoot,source,bundleID:'qa-capture'});
    await fs.writeFile(path.join(binding.descriptor.launch.global.home,'.devryan-qa-home'),'DevRyan isolated native QA\n',{flag:'wx',mode:0o600});
    const view=await readSelection(binding,createQaNativeLaunchEnvironment({binding,runtimeRoot}),workspace);
    return parseQaSavedGraph(Object.fromEntries(['agentSelections','nativeBackupSelections','nativeCompactionSettings','councilMembers'].map(key=>[key,view[key]])));
  }finally{await fs.rm(provisional,{recursive:true,force:true});}
}

/** Explicit setup roots only. The CLI has no ambient-home or credential input. */
export async function captureLiveSetup({opencodeDirectory,webConfigDirectory,artifactRoot,outputRoot,verifyArtifacts=verifyNativeRuntimeArtifacts,deriveGraph=deriveCapturedGraph}){
  await ownedSource(opencodeDirectory,true);await ownedSource(webConfigDirectory,true);
  await assertQaPrivateDirectory(artifactRoot);await assertQaPrivateDirectory(path.dirname(outputRoot));
  if(!path.isAbsolute(outputRoot??'')||path.resolve(outputRoot)!==outputRoot)throw fail('qa_capture_output_path_invalid');
  const manifestPath=path.join(artifactRoot,'native-bundle.json'),manifestSha256=qaHash(await readQaPinnedFile(manifestPath,undefined,4*1024*1024));
  const artifacts=await verifyArtifacts({manifestPath,manifestSha256,launcher:path.join(artifactRoot,`DevRyan-execution-${process.platform}-${process.arch}`)});
  await fs.mkdir(outputRoot,{mode:0o700});await assertQaPrivateDirectory(outputRoot);
  const sourceHome=path.join(outputRoot,'source'),files=[];let total=0,entries=0;
  await fs.mkdir(sourceHome,{mode:0o700});
  const write=async(relative,bytes)=>{
    const file=path.join(sourceHome,relative);await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.writeFile(file,bytes,{flag:'wx',mode:0o400});
    files.push({path:relative,sha256:qaHash(bytes)});
  };
  const capture=async(file,relative)=>{
    if(!isQaLiveSetupFile(relative)||accountEntry.test(path.basename(file)))throw fail('qa_capture_file_not_allowed');
    const bytes=await readSource(file);total+=bytes.length;
    if(total>16*1024*1024||files.length>=4096)throw fail('qa_capture_size_limit');
    await write(relative,projectQaLiveSetupFile(relative,bytes).bytes);
  };
  const walk=async(directory,relative)=>{
    await ownedSource(directory,true);
    for(const entry of (await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      if(++entries>8192)throw fail('qa_capture_size_limit');
      const file=path.join(directory,entry.name),target=relative+'/'+entry.name;
      if(accountEntry.test(entry.name))throw fail('qa_capture_file_not_allowed');
      if(entry.isSymbolicLink())throw fail('qa_capture_source_path_invalid');
      if(entry.isDirectory())await walk(file,target);
      else if(entry.isFile())await capture(file,target);
      else throw fail('qa_capture_source_invalid');
    }
  };
  try{
    for(const relative of configFiles){
      const file=path.join(opencodeDirectory,relative);
      try{await fs.lstat(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
      await capture(file,'opencode/'+relative);
    }
    for(const folder of setupFolders){
      const file=path.join(opencodeDirectory,folder);
      try{await fs.lstat(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
      await walk(file,'opencode/'+folder);
    }
    const settings=path.join(webConfigDirectory,'settings.json');
    let hasSettings=true;try{await fs.lstat(settings);}catch(error){if(error.code!=='ENOENT')throw error;hasSettings=false;}
    if(hasSettings)await capture(settings,'web-config/settings.json');
    if(!files.length)throw fail('qa_capture_setup_empty');
    for(const directory of ['home','opencode','web-config'])await fs.mkdir(path.join(sourceHome,directory),{recursive:true,mode:0o700});
    const inputFiles=[...files];
    await write('reviewed-native.json',Buffer.from(JSON.stringify({schema:1,configuration:translateNativeConfiguration({legacy:{},agents:{}}),locations:[],catalogRequirements:{agents:[],models:[],plugins:[],tools:[]}})+'\n'));
    await write('reviewed-plugins.json',Buffer.from(JSON.stringify({schema:1,plugins:defaultNativeRegistrations(artifacts.manifest.inputs.reviewedPlugins)})+'\n'));
    const preparedInput={sourceHome,artifactRoot,files:files.sort((a,b)=>a.path.localeCompare(b.path))};
    await verifyQaNativeInput(preparedInput);
    const mirror={reviewedNativeFile:'reviewed-native.json',reviewedPluginFile:'reviewed-plugins.json',opencodeConfigDirectory:'opencode',webConfigDirectory:'web-config',homeDirectory:'home'};
    const graph=parseQaSavedGraph(await deriveGraph({preparedInput,mirror,outputRoot}));
    await verifyQaNativeInput(preparedInput);
    const graphFile=path.join(outputRoot,'graph.json'),inputFile=path.join(outputRoot,'input.json');
    const graphBytes=Buffer.from(JSON.stringify(graph,null,2)+'\n'),inputBytes=Buffer.from(JSON.stringify({preparedInput:{sourceHome,artifactRoot,files:inputFiles}},null,2)+'\n');
    await fs.writeFile(graphFile,graphBytes,{flag:'wx',mode:0o400});await fs.writeFile(inputFile,inputBytes,{flag:'wx',mode:0o400});
    return await prepareLiveSetupMirror({inputFile,inputSha256:qaHash(inputBytes),graphFile,graphSha256:qaHash(graphBytes),artifactRoot,outputRoot:path.join(outputRoot,'approved'),verifyArtifacts});
  }catch(error){
    await fs.writeFile(path.join(outputRoot,'failed.json'),JSON.stringify({status:'failed',code:/^(qa_|native_|bundle_)[a-z0-9_]{1,100}$/.test(error.code??'')?error.code:'qa_capture_failed'})+'\n',{flag:'wx',mode:0o600});throw error;
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const args=process.argv.slice(2),allowed=['--opencode-directory','--web-config-directory','--artifact-root','--output-root'],flags=new Map();
    for(let index=0;index<args.length;index+=2){if(!allowed.includes(args[index])||flags.has(args[index])||!args[index+1]||args[index+1].startsWith('--'))throw fail('qa_capture_flags_invalid');flags.set(args[index],args[index+1]);}
    if(flags.size!==allowed.length)throw fail('qa_capture_flags_invalid');
    process.stdout.write(JSON.stringify(await captureLiveSetup({opencodeDirectory:flags.get('--opencode-directory'),webConfigDirectory:flags.get('--web-config-directory'),artifactRoot:flags.get('--artifact-root'),outputRoot:flags.get('--output-root')}))+'\n');
  }catch(error){process.stderr.write(JSON.stringify({status:'refused',code:/^(qa_|native_|bundle_)[a-z0-9_]{1,100}$/.test(error.code??'')?error.code:'qa_capture_failed'})+'\n');process.exitCode=1;}
}
