import {createHash} from 'node:crypto';

const fail=()=>Object.assign(new Error('native_setup_credentials_ack_invalid'),{code:'native_setup_credentials_ack_invalid',status:503});

/** The host captures the native identity before starting the controller. Only
 * that exact file may be deleted after the credential transaction is acknowledged. */
export async function captureNativeSetupCredentialSeed(file,windowsOwner){
 if(typeof windowsOwner?.read!=='function'||typeof windowsOwner?.delete!=='function')throw Object.assign(fail(),{code:'private_windows_storage_authority_unavailable'});
 let previous;try{previous=await windowsOwner.read(file);}catch(error){if(error.code==='ENOENT')return {expected:null,settle:async ack=>{if(!ack||!['absent','already-applied'].includes(ack.status))throw fail();}};throw error;}
 if(previous.bytes.length>1024*1024)throw fail();
 let seed;try{seed=JSON.parse(previous.bytes.toString('utf8'));}catch{throw fail();}
 if(seed?.schema!==1||!Array.isArray(seed.credentials)||seed.credentials.length>128)throw fail();
 const expected={sha256:createHash('sha256').update(previous.bytes).digest('hex'),count:seed.credentials.length};
 return {expected,settle:async ack=>{
  if(!ack||!['applied','already-applied'].includes(ack.status)||ack.sha256!==expected.sha256||ack.count!==expected.count)throw fail();
  await windowsOwner.delete(file,{expected:previous});
 }};
}
