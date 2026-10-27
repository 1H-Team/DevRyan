import {createHash} from 'node:crypto';

const fail=()=>Object.assign(new Error('native_task_publication_scope_expired'),{code:'native_task_publication_scope_expired',statusCode:409});
export async function readManagedPublicationMessages(readPage, input, messageIDs) {
 const wanted=new Set([...messageIDs,input.messageID]), requested=new Set(wanted), found=new Set(), messages=[], cursors=new Set();
 if(wanted.size>2000||[...wanted].some(id=>typeof id!=='string'||!id))throw fail();
 let before,count=0,bytes=0,pages=0;
 while(wanted.size){
  if(++pages>20)throw Object.assign(new Error('native_task_publication_messages_limit'),{code:'native_task_publication_messages_limit',statusCode:409});
  const page=await readPage(input,{limit:200,...before?{before}:{}});
  if(!Array.isArray(page?.records)||page.records.some(row=>row.info?.sessionID!==input.sessionID||typeof row.info.id!=='string'||!Array.isArray(row.parts)))throw fail();
  count+=page.records.length;bytes+=Buffer.byteLength(JSON.stringify(page.records));
  if(count>2000||bytes>64*1024*1024)throw Object.assign(new Error('native_task_publication_messages_limit'),{code:'native_task_publication_messages_limit',statusCode:409});
  const selected=page.records.filter(row=>requested.has(row.info.id));
  for(const row of selected){if(found.has(row.info.id))throw fail();found.add(row.info.id);wanted.delete(row.info.id);}
  messages.unshift(...selected);
  if(!wanted.size)return messages;
  before=page.cursor;if(typeof before!=='string'||!before||cursors.has(before))throw fail();cursors.add(before);
 }
 return messages;
}
/** Constructor readers own live scope and canonical order. Caller input cannot
 * supply readiness, primary identity or transcript publication authority. */
export function createNativeManagedPublicationReader({readConfiguration,recheckExecution,readPrimaryRecord,readMessages}){
 return async (input,{messageIDs=[]}={})=>{
  if(!input?.nativeAttempt||!['traceID','spanID'].every(field=>typeof input.nativeAttempt[field]==='string'&&/^[a-f0-9]{1,128}$/.test(input.nativeAttempt[field])))throw fail();
  const configuration=readConfiguration(input);await recheckExecution(input);
  const primary=await readPrimaryRecord(input.sessionID),messages=await readMessages(input,messageIDs);
  await recheckExecution(input);
  if(JSON.stringify(readConfiguration(input))!==JSON.stringify(configuration)||!primary||primary.directory!==input.directory||primary.stepID!==input.messageID
   ||primary.nativeStepWitness?.attempt?.traceID!==input.nativeAttempt?.traceID||primary.nativeStepWitness?.attempt?.spanID!==input.nativeAttempt?.spanID
   ||!Number.isSafeInteger(primary.cancellationGeneration))throw fail();
  const latest=await readPrimaryRecord(input.sessionID);
  if(latest.revision!==primary.revision)throw fail();
  return {messages,identity:{...configuration,objectiveID:primary.objectiveID??primary.anchorID,cancellationGeneration:primary.cancellationGeneration,
   stepID:primary.stepID,attempt:structuredClone(input.nativeAttempt),permitSha256:createHash('sha256').update(input.permit.token).digest('hex')}};
 };
}
