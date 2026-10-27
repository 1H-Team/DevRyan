import {createHash} from 'node:crypto';
import {createNativeOwnedRequests} from './native-owned-requests.js';

const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=code=>Object.assign(new Error(code),{code,status:403,statusCode:403});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fields=(value,allowed)=>record(value)&&Object.keys(value).every(key=>allowed.includes(key));
const id=value=>typeof value==='string'&&/^msg[A-Za-z0-9_-]{1,128}$/.test(value);

/** The canonical store supplies attachment bytes. The controller receives only
 * rendered original document text and identities for its native context parts. */
export function createNativeDocumentRuntime({admissionOwner,documentOwner,reviewedConfiguration,readUserAttachments,locations,origin}){
 if(origin?.kind!=='plugin'||origin.id!=='devryan.document-reader'||!documentOwner?.ownersFor
  ||!reviewedConfiguration?.createOwnedNativeDocument||typeof readUserAttachments!=='function')throw fail('native_document_runtime_required');
 const requests=createNativeOwnedRequests('native_document');
 const location=directory=>{
  const found=locations.find(row=>row.directory===directory);
  if(!found||found.activeRegistrationIDs&&!found.activeRegistrationIDs.includes(origin.id))throw fail('native_document_inactive');
 };
 const owned=(input,assertCurrent,signal)=>reviewedConfiguration.createOwnedNativeDocument({originals:reviewedConfiguration.reviewedDocumentOriginals,
  directory:input.directory,ownersFor:()=>documentOwner.ownersFor({sessionID:input.sessionID,directory:input.directory,assertCurrent,signal})});
 const operations={
  async tool(input,{signal=new AbortController().signal}={}){
   if(!fields(input,['requestID','permit','authorization','directory','sessionID','messageID','callID','tool','input'])||input.tool!=='devryan_document'
    ||JSON.stringify(input.authorization?.input?.provenance)!==JSON.stringify(origin))throw fail('native_document_tool_scope_invalid');
   location(input.directory);
   return admissionOwner.withPermit(input,async()=>{
    const check=async()=>{signal.throwIfAborted();await admissionOwner.recheckExecution(input);signal.throwIfAborted();};
    await check();const result=await owned(input,check,signal).tool.execute(input.input,{sessionID:input.sessionID,abort:signal});await check();return result;
   });
  },
  async context(input,{signal=new AbortController().signal}={}){
   if(!fields(input,['requestID','permit','directory','sessionID','phase','messageIDs'])||input.phase!=='context'||!Array.isArray(input.messageIDs)
    ||input.messageIDs.length>2000||!input.messageIDs.every(id)||new Set(input.messageIDs).size!==input.messageIDs.length)throw fail('native_document_context_invalid');
   location(input.directory);const captured=await admissionOwner.captureSessionHookAuthorization(input);
   const check=async()=>{signal.throwIfAborted();await captured();signal.throwIfAborted();};
   await check();const rows=await readUserAttachments(input);await check();
   const operation=owned(input,check,signal),replacements=[];let size=0;
   for(const {messageID,part} of rows){
    if(!input.messageIDs.includes(messageID))continue;
    const text=await operation.transformAttachment(part,{sessionID:input.sessionID,abort:signal});
    if(text===null)continue;
    // Native 2.0.20 stores canonical uploads as base64; no URL from a hook is read.
    const comma=part.url.indexOf(',');if(comma<0||!part.url.slice(0,comma).endsWith(';base64'))throw fail('native_document_attachment_invalid');
    const bytes=Buffer.from(part.url.slice(comma+1),'base64');
    const replacement={messageID,partID:part.id,text,mime:part.mime??'',name:part.filename??'',sha256:hash(bytes),
     textLength:bytes.toString('utf8').length,textSha256:hash(bytes.toString('utf8'))};
    size+=Buffer.byteLength(JSON.stringify(replacement));if(size>3*1024*1024)throw fail('native_document_context_limit');
    replacements.push(replacement);
   }
   let parentNote=false;
   if(!replacements.length){
    const owners=await documentOwner.ownersFor({sessionID:input.sessionID,directory:input.directory,assertCurrent:check,signal});
    parentNote=(await owners.listAccessibleDocuments(input.sessionID,input.directory)).some(row=>row.depth>0);
   }
   await check();return {replacements,parentNote};
  },
 };
 return {tool:(input,context)=>requests.run(input,context,operations.tool),context:(input,context)=>requests.run(input,context,operations.context),
  settle:requests.settle,close:requests.close};
}
