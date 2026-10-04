import {test,expect,afterEach} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {runNativeBundleCredentialProcess} from './native-bundle-credential-process.js';
import {parseNativeBundleCredentialBoot,NATIVE_BUNDLE_CREDENTIAL_CONTRACT,nativeBundleCredentialFingerprint} from './native-bundle-credential-contract.js';
const roots=[];afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
const fixture=async()=>{
 const root=await fs.mkdtemp(path.resolve('../../.cache/v2-validation/credential-process-'));roots.push(root);
 const global=Object.fromEntries(['home','config','data','state','cache','tmp','bin','log','repos'].map(key=>[key,path.join(root,key==='config'?'config/opencode':'global/'+key)]));
 for(const value of Object.values(global))await fs.mkdir(value,{recursive:true});
 await fs.mkdir(path.join(root,'opencode'));await fs.writeFile(path.join(root,'opencode','opencode.db'),'fixture only');await fs.mkdir(path.join(root,'web-data'));
 const binary=path.join(root,'fixture-controller');
 const snapshot={protocol:NATIVE_BUNDLE_CREDENTIAL_CONTRACT,credentials:[],refreshBlockState:null,claudeLifecycle:null};
 await fs.writeFile(binary,`#!${process.execPath}\nlet input='';for await(const bytes of process.stdin)input+=bytes;const request=JSON.parse(input);process.stdout.write(JSON.stringify({protocol:request.protocol,requestID:request.requestID,instanceID:request.instanceID,buildID:request.buildID,ok:true,result:{protocol:request.protocol,status:'captured',snapshot:${JSON.stringify(snapshot)},sha256:${JSON.stringify(nativeBundleCredentialFingerprint(snapshot))}}}));\n`,{mode:0o700});
 const descriptor={bundleID:'baseline',launch:{global,controllerBinary:binary,opencodeDatabasePath:path.join(root,'opencode','opencode.db'),webDataDirectory:path.join(root,'web-data'),artifactManifestPath:path.join(root,'manifest.json'),artifactManifestSha256:'a'.repeat(64)}};
 return {descriptor,snapshot,verifyArtifacts:async()=>({controller:binary,manifest:{buildId:'b'.repeat(64),compiledContracts:[NATIVE_BUNDLE_CREDENTIAL_CONTRACT]}})};
};
test('private process requires advertised contract and exact closed constructor scope before spawning',async()=>{
 const f=await fixture();let checks=0;
 const result=await runNativeBundleCredentialProcess({...f,action:{protocol:NATIVE_BUNDLE_CREDENTIAL_CONTRACT,action:'capture'},assertHeld:async()=>{checks++;}});
 expect(result).toEqual({protocol:NATIVE_BUNDLE_CREDENTIAL_CONTRACT,status:'captured',snapshot:f.snapshot,sha256:nativeBundleCredentialFingerprint(f.snapshot)});expect(checks).toBe(3);
 await expect(runNativeBundleCredentialProcess({...f,action:{protocol:NATIVE_BUNDLE_CREDENTIAL_CONTRACT,action:'capture'},assertHeld:async()=>{},verifyArtifacts:async()=>({controller:f.descriptor.launch.controllerBinary,manifest:{buildId:'b'.repeat(64)}})})).rejects.toMatchObject({code:'bundle_credential_contract_incompatible'});
 await expect(runNativeBundleCredentialProcess({...f,action:{protocol:NATIVE_BUNDLE_CREDENTIAL_CONTRACT,action:'capture'},assertHeld:async()=>{throw Error('not held');}})).rejects.toThrow('not held');
});
test('private boot rejects outside paths, target substitution and unknown effects',async()=>{
 const f=await fixture(),boot={protocol:NATIVE_BUNDLE_CREDENTIAL_CONTRACT,requestID:'request',instanceID:'instance',buildID:'a'.repeat(64),bundleID:'baseline',databasePath:f.descriptor.launch.opencodeDatabasePath,webDataDirectory:f.descriptor.launch.webDataDirectory,globals:f.descriptor.launch.global,action:{protocol:NATIVE_BUNDLE_CREDENTIAL_CONTRACT,action:'capture'}};
 expect(parseNativeBundleCredentialBoot(boot)).toBe(boot);
 expect(()=>parseNativeBundleCredentialBoot({...boot,webDataDirectory:'/tmp/outside'})).toThrow('bundle_credential_binding_invalid');
 expect(()=>parseNativeBundleCredentialBoot({...boot,action:{...boot.action,sql:'not permitted'}})).toThrow('bundle_credential_action_invalid');
 expect(()=>parseNativeBundleCredentialBoot({...boot,action:{protocol:NATIVE_BUNDLE_CREDENTIAL_CONTRACT,action:'project',source:f.snapshot,binding:{sourceBundleID:'candidate',targetBundleID:'substituted',targetManifestSha256:'b'.repeat(64),expectedTargetSha256:'c'.repeat(64),sourceSha256:nativeBundleCredentialFingerprint(f.snapshot)}}})).toThrow('bundle_credential_binding_invalid');
});
test('compatible new controller can capture old state only, never project using a foreign artifact',async()=>{
 const f=await fixture(),sha='d'.repeat(64),core='e'.repeat(64);
 const captureArtifacts={manifestSha256:sha,manifestPath:path.join(path.dirname(path.dirname(path.dirname(f.descriptor.launch.webDataDirectory))),'artifacts',sha,'native-bundle.json')};
 const original={controller:f.descriptor.launch.controllerBinary,manifest:{buildId:'b'.repeat(64),opencodeVersion:'2.0.20',inputs:{coreDigest:core}}};
 const next={controller:f.descriptor.launch.controllerBinary,manifest:{...original.manifest,compiledContracts:[NATIVE_BUNDLE_CREDENTIAL_CONTRACT,'devryan-v2-clone/1']}};
 const verifyArtifacts=async input=>input.manifestPath===captureArtifacts.manifestPath?next:original;
 const options={...f,captureArtifacts,verifyArtifacts,assertHeld:async()=>{},action:{protocol:NATIVE_BUNDLE_CREDENTIAL_CONTRACT,action:'capture'}};
 expect((await runNativeBundleCredentialProcess(options)).status).toBe('captured');
 await expect(runNativeBundleCredentialProcess({...options,verifyArtifacts:async input=>input.manifestPath===captureArtifacts.manifestPath?{...next,manifest:{...next.manifest,inputs:{coreDigest:'f'.repeat(64)}}}:original})).rejects.toMatchObject({code:'bundle_credential_contract_incompatible'});
 await expect(runNativeBundleCredentialProcess({...options,captureArtifacts:{...captureArtifacts,manifestPath:path.join(path.dirname(captureArtifacts.manifestPath),'../other/native-bundle.json')}})).rejects.toMatchObject({code:'bundle_credential_contract_incompatible'});
 await expect(runNativeBundleCredentialProcess({...options,action:{protocol:NATIVE_BUNDLE_CREDENTIAL_CONTRACT,action:'project',source:f.snapshot,binding:{sourceBundleID:'candidate',targetBundleID:'baseline',targetManifestSha256:'a'.repeat(64),expectedTargetSha256:nativeBundleCredentialFingerprint(f.snapshot),sourceSha256:nativeBundleCredentialFingerprint(f.snapshot)}}})).rejects.toMatchObject({code:'bundle_credential_contract_incompatible'});
});
