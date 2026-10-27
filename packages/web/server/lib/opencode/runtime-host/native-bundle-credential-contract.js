import path from 'node:path';
import {createHash} from 'node:crypto';

export const NATIVE_BUNDLE_CREDENTIAL_CONTRACT='devryan.bundle.credentials/2';
export const NATIVE_BUNDLE_CREDENTIAL_BYTES=1024*1024+64*1024;
const fail=code=>Object.assign(new Error(code),{code,status:503});
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export const nativeBundleCredentialFingerprint=value=>createHash('sha256').update(JSON.stringify(value,(_key,item)=>record(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)).digest('hex');
const hash=nativeBundleCredentialFingerprint;
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const absolute=value=>typeof value==='string'&&path.isAbsolute(value)&&path.normalize(value)===value&&!/[\u0000-\u001f]/.test(value);

/** Shared finite private-stdin contract. No arbitrary effect or caller path. */
export function parseNativeBundleCredentialBoot(value){
 if(!record(value)||Object.keys(value).some(key=>!['protocol','requestID','instanceID','buildID','bundleID','databasePath','webDataDirectory','globals','action'].includes(key))
  ||value.protocol!==NATIVE_BUNDLE_CREDENTIAL_CONTRACT||!id(value.requestID)||!id(value.instanceID)||!id(value.bundleID)||!digest(value.buildID)
  ||!absolute(value.databasePath)||!absolute(value.webDataDirectory)||!record(value.globals)||!record(value.action))throw fail('bundle_credential_action_invalid');
 const root=path.dirname(path.dirname(value.databasePath));
 if(value.databasePath!==path.join(root,'opencode','opencode.db')||value.webDataDirectory!==path.join(root,'web-data'))throw fail('bundle_credential_binding_invalid');
 const keys=['home','config','data','state','cache','tmp','bin','log','repos'];
 if(Object.keys(value.globals).length!==keys.length||keys.some(key=>value.globals[key]!==path.join(root,key==='config'?'config/opencode':'global/'+key)))throw fail('bundle_credential_binding_invalid');
 const action=value.action;
 if(action.protocol!==NATIVE_BUNDLE_CREDENTIAL_CONTRACT||!['capture','project'].includes(action.action)
  ||Object.keys(action).some(key=>!(action.action==='capture'?['protocol','action']:['protocol','action','source','binding']).includes(key)))throw fail('bundle_credential_action_invalid');
 if(action.action==='project'){
  const binding=action.binding;
  if(!record(action.source)||!record(binding)||Object.keys(binding).length!==5||!id(binding.sourceBundleID)||binding.targetBundleID!==value.bundleID
   ||binding.sourceBundleID===binding.targetBundleID||!digest(binding.targetManifestSha256)||!digest(binding.expectedTargetSha256)||!digest(binding.sourceSha256)
   ||hash(action.source)!==binding.sourceSha256)throw fail('bundle_credential_binding_invalid');
 }
 if(Buffer.byteLength(JSON.stringify(value))>NATIVE_BUNDLE_CREDENTIAL_BYTES)throw fail('bundle_credential_input_bound');
 return value;
}
