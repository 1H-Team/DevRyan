import path from 'node:path';
import {createWindowsPrivateFileOwner} from '../../../../../harness-runtime/lib/windows-private-files.js';
import {executionArtifacts} from '../execution-artifacts.js';
import {verifyNativeRuntimeArtifacts} from './native-artifacts.js';

const fail=code=>Object.assign(new Error(code),{code,status:503,statusCode:503});

/** Native verification precedes any mutable private storage construction. */
export async function createNativePrivatePersistence(binding, {platform=process.platform, verifyArtifacts=verifyNativeRuntimeArtifacts}={}) {
  if(platform!=='win32')return {};
  const launch=binding.descriptor.launch;
  const verified=await verifyArtifacts({manifestPath:launch.artifactManifestPath,manifestSha256:launch.artifactManifestSha256,
    launcher:executionArtifacts(path.dirname(launch.artifactManifestPath)).launcher});
  if(verified.controller!==launch.controllerBinary||verified.writer!==launch.writerBinary)throw fail('native_runtime_artifacts_unverified');
  return createPrivatePersistenceFromVerifiedArtifacts({artifacts:verified,roots:[binding.controlRoot,launch.webDataDirectory,launch.webConfigDirectory,launch.opencodeConfigDirectory,...Object.values(launch.global??{})]});
}

/** Only the composing host supplies verified artifacts and private storage roots. */
export function createPrivatePersistenceFromVerifiedArtifacts({artifacts,roots}) {
  const owner=createWindowsPrivateFileOwner({launcher:artifacts.launcher});
  const boundedRoots=roots.filter(value=>typeof value==='string'&&path.isAbsolute(value)&&path.normalize(value)===value);
  const ensureDirectory=async directory=>{
    const root=boundedRoots.filter(value=>directory===value||directory.startsWith(value+path.sep)).sort((left,right)=>right.length-left.length)[0];
    if(!root||path.normalize(directory)!==directory||/[\u0000-\u001f]/.test(directory))throw fail('private_windows_storage_scope_invalid');
    const parts=path.relative(root,directory).split(path.sep).filter(Boolean);
    if(parts.length>64)throw fail('private_windows_storage_scope_invalid');
    let current=root;let result=await owner.ensureDirectory(current);
    for(const part of parts){current=path.join(current,part);result=await owner.ensureDirectory(current);}return result;
  };
  // Recover only the exact requested private target. A foreign pending intent
  // remains an explicit refusal rather than acquiring authority over its file.
  const wrap=owned=>{
    const recover=async(file,action)=>{await owned.recover(file);return action();};
    return Object.freeze({...owned,ensureDirectory,
      read:file=>recover(file,()=>owned.read(file)),
      write:(file,bytes,options)=>recover(file,()=>owned.write(file,bytes,options)),
      delete:(file,options)=>recover(file,()=>owned.delete(file,options)),
      quarantine:(file,previous)=>recover(file,()=>owned.quarantine(file,previous))});
  };
  const windowsOwner=wrap(owner);
  const windowsLedgerOwner=wrap(createWindowsPrivateFileOwner({launcher:artifacts.launcher,maxBytes:64*1024*1024}));
  return {windowsOwner,windowsLedgerOwner,windowsLauncher:artifacts.launcher};
}
