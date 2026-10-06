import {test,expect,vi} from 'vitest';
import path from 'node:path';

const operations=vi.hoisted(()=>[]);
vi.mock('../../../../../harness-runtime/lib/windows-private-files.js',()=>({
 createWindowsPrivateFileOwner:({launcher,maxBytes=16*1024*1024})=>{
  operations.push(['construct',launcher,maxBytes]);
  return {launcher,maxBytes,ensureDirectory:async(file)=>{operations.push(['ensureDirectory',file]);return {type:'directory'};},
   recover:async(file)=>{operations.push(['recover',file]);if(file==='foreign-pending')throw Object.assign(new Error('foreign'),{code:'private_windows_publication_conflict'});},
   read:async(file)=>{operations.push(['read',file]);return {bytes:Buffer.from('value')};},
   write:async(file,bytes,options)=>{operations.push(['write',file,bytes.toString(),options]);},
   delete:async(file,options)=>{operations.push(['delete',file,options]);},
   quarantine:async(file,previous)=>{operations.push(['quarantine',file,previous]);},
  };
 }
}));
import {createNativePrivatePersistence} from './native-private-persistence.js';
const directory=path.resolve('.cache/test-fixtures/verified-runtime');
const binding={controlRoot:directory,descriptor:{launch:{artifactManifestPath:path.join(directory,'native-bundle.json'),artifactManifestSha256:'a'.repeat(64),
 controllerBinary:path.join(directory,'controller'),writerBinary:path.join(directory,'writer')}}};
const verified={controller:binding.descriptor.launch.controllerBinary,writer:binding.descriptor.launch.writerBinary,launcher:path.join(directory,'verified-launcher')};

test('artifact refusal constructs no private-file owner and does not access private state',async()=>{
 operations.length=0;
 await expect(createNativePrivatePersistence(binding,{platform:'win32',verifyArtifacts:async()=>{throw Object.assign(new Error('refused'),{code:'native_runtime_artifacts_unverified'});}})).rejects.toMatchObject({code:'native_runtime_artifacts_unverified'});
 expect(operations).toEqual([]);
 await expect(createNativePrivatePersistence(binding,{platform:'win32',verifyArtifacts:async()=>({...verified,writer:'different-writer'})})).rejects.toMatchObject({code:'native_runtime_artifacts_unverified'});
 expect(operations).toEqual([]);
});
test('each bounded operation recovers its exact file and preserves the caller CAS proof',async()=>{
 operations.length=0;let inspected;
 const {windowsOwner,windowsLedgerOwner,windowsLauncher}=await createNativePrivatePersistence(binding,{platform:'win32',verifyArtifacts:async(input)=>{inspected=input;return verified;}});
 expect(inspected.manifestPath).toBe(binding.descriptor.launch.artifactManifestPath);expect(inspected.manifestSha256).toBe('a'.repeat(64));
 expect(windowsLauncher).toBe(verified.launcher);
 expect(windowsOwner.maxBytes).toBe(16*1024*1024);expect(windowsLedgerOwner.maxBytes).toBe(64*1024*1024);
 const previous={bytes:Buffer.from('old'),identity:{fileId:'original'}};
 await windowsOwner.read('one');await windowsOwner.write('two',Buffer.from('new'),{expected:previous});await windowsOwner.delete('three',{expected:previous});await windowsOwner.quarantine('four',previous);
 expect(operations).toEqual([['construct',verified.launcher,16*1024*1024],['construct',verified.launcher,64*1024*1024],['recover','one'],['read','one'],['recover','two'],['write','two','new',{expected:previous}],['recover','three'],['delete','three',{expected:previous}],['recover','four'],['quarantine','four',previous]]);
 operations.length=0;
 await expect(windowsOwner.read('foreign-pending')).rejects.toMatchObject({code:'private_windows_publication_conflict'});
 expect(operations).toEqual([['recover','foreign-pending']]);
});
test('non-Windows composition does not construct or verify a Windows authority',async()=>{
 operations.length=0;const verifyArtifacts=vi.fn();
 expect(await createNativePrivatePersistence(binding,{platform:'darwin',verifyArtifacts})).toEqual({});expect(verifyArtifacts).not.toHaveBeenCalled();expect(operations).toEqual([]);
});

test('nested private directories start at the constructing host root and refuse a foreign scope',async()=>{
 operations.length=0;
 const {windowsOwner}=await createNativePrivatePersistence(binding,{platform:'win32',verifyArtifacts:async()=>verified});
 const nested=path.join(directory,'harness','context');await windowsOwner.ensureDirectory(nested);
 expect(operations.slice(2)).toEqual([['ensureDirectory',directory],['ensureDirectory',path.join(directory,'harness')],['ensureDirectory',nested]]);
 operations.length=0;await expect(windowsOwner.ensureDirectory(path.resolve('.cache/test-fixtures/foreign'))).rejects.toMatchObject({code:'private_windows_storage_scope_invalid'});expect(operations).toEqual([]);
});
test('Windows bootstrap artifact refusal precedes creating any persistence root',async()=>{
 const fs=await import('node:fs/promises');const {provisionDefaultNativeBundle}=await import('./native-default-bundle.js');
 const base=path.resolve('../../.cache/test-fixtures');await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(path.join(base,'windows-bootstrap-refusal-'));
 const descriptor=Object.getOwnPropertyDescriptor(process,'platform');
 try{
  const resources=path.join(root,'resources');await fs.mkdir(resources);await fs.writeFile(path.join(resources,'native-bundle.json'),'{}');
  Object.defineProperty(process,'platform',{...descriptor,value:'win32'});
  await expect(provisionDefaultNativeBundle({home:path.join(root,'home'),cwd:root,env:{},artifactDirectory:resources,
   verifyArtifacts:async()=>{throw Object.assign(new Error('native_runtime_artifacts_unverified'),{code:'native_runtime_artifacts_unverified'});}})).rejects.toMatchObject({code:'native_runtime_artifacts_unverified'});
  expect(await fs.readdir(root)).toEqual(['resources']);
 }finally{Object.defineProperty(process,'platform',descriptor);await fs.rm(root,{recursive:true,force:true});}
});
