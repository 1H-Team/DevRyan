import {createHash} from 'node:crypto';
import {createNativeOwnedRequests} from './native-owned-requests.js';
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=code=>Object.assign(new Error(code),{code,status:403,statusCode:403});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
/** Canonical user rows stay in Node. Only image identities and original notices
 * cross back into the native context graph. */
export function createNativeImageRuntime({admissionOwner,executionHost,readContext,locations}){
 const requests=createNativeOwnedRequests('native_image');
 const transform=async(input,{signal})=>{
  if(!record(input)||Object.keys(input).some(key=>!['requestID','permit','directory','sessionID','phase','messageIDs'].includes(key))
   ||input.phase!=='context'||!Array.isArray(input.messageIDs)||input.messageIDs.length>2000
   ||!input.messageIDs.every(id=>typeof id==='string'&&/^msg[A-Za-z0-9_-]{1,128}$/.test(id))||new Set(input.messageIDs).size!==input.messageIDs.length)throw fail('native_image_context_invalid');
  input={...input,messageIDs:[...input.messageIDs]};
  const location=locations.find(row=>row.directory===input.directory);
  if(!location||location.activeRegistrationIDs&&!location.activeRegistrationIDs.includes('devryan.slim'))throw fail('native_slim_inactive');
  const captured=await admissionOwner.captureSessionHookAuthorization(input);
  const check=async()=>{signal.throwIfAborted();await captured();signal.throwIfAborted();};
  await check();const before=await readContext(input);await check();
  const anchor=before.latestTurnParent;
  if(!record(anchor)||typeof anchor.id!=='string'||!['user','synthetic','compaction'].includes(anchor.type)||!/^([a-f0-9]{64})$/.test(anchor.fingerprint??'')
   ||!Array.isArray(before.records)||!input.messageIDs.includes(anchor.id))throw fail('native_image_message_stale');
  const result=await executionHost.nativeContextAssets({directory:input.directory,sessionID:input.sessionID,messageID:anchor.id,messageIDs:input.messageIDs,permit:input.permit},{signal});
  await check();const after=await readContext(input);await check();
  if(JSON.stringify(before)!==JSON.stringify(after))throw fail('native_image_message_changed');
  const replacements=[];let size=0;
  for(const message of result.messages){
   if(!input.messageIDs.includes(message.info.id))continue;
   const original=before.records.find(row=>row.info.id===message.info.id);if(!original)throw fail('native_image_message_changed');
   const notices=message.parts.filter(part=>!original.parts.some(source=>JSON.stringify(source)===JSON.stringify(part)));
   if(!notices.length)continue;
   if(notices.length!==1||notices[0].type!=='text'||typeof notices[0].text!=='string')throw fail('native_image_context_result_invalid');
   const removed=original.parts.filter(part=>!message.parts.some(retained=>JSON.stringify(retained)===JSON.stringify(part)));
   const images=removed.map(part=>{
    if(part.type!=='file'||typeof part.mime!=='string'||!part.mime.startsWith('image/')||typeof part.url!=='string')throw fail('native_image_context_result_invalid');
    const comma=part.url.indexOf(',');if(comma<0||!part.url.slice(0,comma).endsWith(';base64'))throw fail('native_image_context_result_invalid');
    return {sha256:hash(Buffer.from(part.url.slice(comma+1),'base64')),mime:part.mime,name:part.filename??''};
   });
   const replacement={messageID:message.info.id,text:notices[0].text,images};size+=Buffer.byteLength(JSON.stringify(replacement));
   if(size>3*1024*1024)throw fail('native_image_context_limit');replacements.push(replacement);
  }
  await check();return {replacements,imagesSkipped:result.imagesSkipped};
 };
 return {transform:(input,context)=>requests.run(input,context,transform),settle:requests.settle,close:requests.close};
}
