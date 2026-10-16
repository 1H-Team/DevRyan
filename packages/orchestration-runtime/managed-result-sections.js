import {sliceManagedResultText,ManagedResultReferenceError} from './managed-result-projection.js';

const prefix='dvr_result_section_v2.';
const encoder=new TextEncoder();
const fault=()=>new ManagedResultReferenceError('invalid_result_cursor','Managed result metadata cursor is invalid');
const stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
  ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const encode=value=>prefix+btoa(Array.from(encoder.encode(JSON.stringify(value)),byte=>String.fromCharCode(byte)).join('')).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
const decode=cursor=>{
  if(typeof cursor!=='string'||cursor.length>4096||!cursor.startsWith(prefix))throw fault();
  try{
    const encoded=cursor.slice(prefix.length);if(!/^[A-Za-z0-9_-]+$/.test(encoded))throw fault();
    const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(encoded.replace(/-/g,'+').replace(/_/g,'/')),character=>character.charCodeAt(0))));
    if(!value||Object.keys(value).length!==8||value.v!==2||value.s!=='metadata'
      ||typeof value.t!=='string'||!value.t.startsWith('dvr_task_')||typeof value.e!=='string'||!value.e.startsWith('dvr_result_')
      ||typeof value.h!=='string'||!/^[a-f0-9]{64}$/.test(value.h)
      ||![value.o,value.b,value.z].every(n=>Number.isSafeInteger(n)&&n>=0)||value.b>value.z)throw fault();
    return value;
  }catch{throw fault();}
};
export const isManagedMetadataCursor=cursor=>typeof cursor==='string'&&cursor.startsWith(prefix);

/** Pages an ephemeral projection only. Canonical records and required references
 * remain intact in the section and must all be delivered before disposition. */
export async function prepareManagedResultMetadata(value){
  const taskId=value?.task?.taskId,envelopeId=value?.resultEnvelope?.envelopeId;
  if(typeof taskId!=='string'||typeof envelopeId!=='string')throw fault();
  const {resultReference:_report,metadataReference:_metadata,...metadata}=structuredClone(value);
  // Observation time is not retained result identity. Current check coverage,
  // exit receipts and every reference still participate in the digest.
  if(metadata.resultHeader?.verification)delete metadata.resultHeader.verification.observedAt;
  const content=stable(metadata),totalBytes=encoder.encode(content).byteLength;
  const digest=await globalThis.crypto.subtle.digest('SHA-256',encoder.encode(content));
  const identitySha256=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  const page=(offset,returned,maxPageBytes)=>{
    const sliced=sliceManagedResultText(content,offset,maxPageBytes),returnedBytes=returned+sliced.pageBytes,complete=sliced.nextOffset===content.length;
    return {section:'metadata',taskId,envelopeId,identitySha256,totalBytes,text:sliced.text,returnedBytes,complete,
      nextCursor:complete?null:encode({v:2,s:'metadata',t:taskId,e:envelopeId,h:identitySha256,o:sliced.nextOffset,b:returnedBytes,z:totalBytes})};
  };
  return {
    project(maxPageBytes,resultReference=value.resultReference){
      const task={taskId,rootSessionId:value.task.rootSessionId,directory:value.task.directory,status:value.task.status,
        ...(value.task.manualRecoveryRequired===undefined?{}:{manualRecoveryRequired:value.task.manualRecoveryRequired})};
      const envelope={envelopeId,taskId,rootSessionId:task.rootSessionId,directory:task.directory,status:task.status,
        action:value.resultEnvelope.action,partial:value.resultEnvelope.partial,resumable:value.resultEnvelope.resumable,
        ...(value.resultEnvelope.autoResume?{autoResume:{enabled:value.resultEnvelope.autoResume.enabled,state:value.resultEnvelope.autoResume.state}}:{})};
      return {task,resultEnvelope:envelope,...resultReference?{resultReference}:{},metadataReference:page(0,0,maxPageBytes),
        resultContractVersion:2};
    },
    read(resultCursor,maxPageBytes){
      const cursor=decode(resultCursor);
      if(cursor.t!==taskId||cursor.e!==envelopeId||cursor.h!==identitySha256||cursor.z!==totalBytes)
        throw new ManagedResultReferenceError('result_reference_mismatch','Managed result metadata changed');
      if(cursor.o>=content.length||encoder.encode(content.slice(0,cursor.o)).byteLength!==cursor.b
        ||cursor.o>0&&/[\uD800-\uDBFF]/.test(content[cursor.o-1])&&/[\uDC00-\uDFFF]/.test(content[cursor.o]))throw fault();
      return {metadataReference:page(cursor.o,cursor.b,maxPageBytes),resultContractVersion:2};
    },
  };
}
