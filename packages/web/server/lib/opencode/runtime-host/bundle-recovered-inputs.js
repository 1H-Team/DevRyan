import fs from 'node:fs/promises';
import path from 'node:path';
import {readRecoveredNativeInputs,nativeInputCancellation} from './native-recovered-input.js';
import {readBundleRecoveryEnvelope,verifyBundleOwnedContinuations} from './bundle-owned-continuations.js';
import {assertBundlePendingInput,bundleFailure,canonicalJSON,sha256} from './bundle-migration-inventory.js';

const invalid=()=>{throw bundleFailure('migration_pending_input_unsupported');};
const referencePaths=(record,id)=>{
  const paths=[];
  for(const field of ['anchorID','recoveryID','continuationID','activeUserID','stepID'])if(record[field]===id)paths.push(`record.${field}`);
  if(record.recoveryExecution&&record.recoveryID===id&&record.recoveryPrompt?.messageID===id)paths.push('record.recoveryPrompt.messageID');
  if(record.nativeContinuation?.messageID===id)paths.push('record.nativeContinuation.messageID');
  if(record.nativeContinuation?.prompt.messageID===id)paths.push('record.nativeContinuation.prompt.messageID');
  record.guardedIDs.forEach((value,index)=>{if(value===id)paths.push(`record.guardedIDs.${index}`);});
  return paths;
};
/** Constructor-only startup integrity. The installed epoch fence, never this
 * read-only proof, decides whether any retained input can execute. */
export async function verifyBundleRecoveredInputs(db,webDataDirectory,{cancelledOnly=false}={}) {
 try {
  if(cancelledOnly)assertBundlePendingInput(db);
  const inputs=cancelledOnly?[]:readRecoveredNativeInputs(db),proofs=inputs.filter(input=>input.location==='queued').map(input=>({
    id:input.messageID,sessionID:input.sessionID,directory:input.directory,itemProof:{type:input.type,delivery:input.delivery,hash:input.payloadHash},inboxSha256:input.rowHash,sessionSha256:input.sessionHash,
    sourceSha256:sha256(canonicalJSON(db.all('SELECT id,type,seq,data FROM session_message WHERE session_id=? ORDER BY seq',[input.sessionID])))}));
  const directory=path.join(webDataDirectory,'harness','provider-recovery');
  const files=await fs.readdir(directory,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  if(files.length>4096)invalid();
  for(const entry of files){
    if(!entry.name.endsWith('.json'))continue;
    if(!entry.isFile()||!/^[a-f0-9]{64}\.json$/.test(entry.name))invalid();
    const file=path.join(directory,entry.name),loaded=await readBundleRecoveryEnvelope(file),record=loaded.envelope.record;
    const session=db.all('SELECT * FROM session_v2 WHERE id=?',[record.sessionID]);
    for(const proof of proofs.filter(proof=>proof.sessionID===record.sessionID)){
      if(session.length!==1||record.directory!==session[0].directory||record.executionGeneration!==2)invalid();
      const paths=referencePaths(record,proof.id);
      if(paths.length)Object.assign(proof,{file,fileSha256:loaded.sha256,paths});
    }
    for(const disposition of record.recoveredInputDispositions??[]){
      if(session.length===0)continue; // Existing exact session-removal proof remains responsible for these references.
      if(cancelledOnly&&disposition.phase!=='cancelled')invalid();
      const input=inputs.find(input=>input.messageID===disposition.inputID);
      if(input){if(disposition.phase==='cancelled'||input.sessionID!==record.sessionID||input.payloadHash!==disposition.payloadHash
        ||input.enqueuedSeq!==disposition.enqueuedSeq||input.type!==disposition.type||input.delivery!==disposition.delivery)invalid();continue;}
      const cancellation=nativeInputCancellation(db,{...disposition,messageID:disposition.inputID,sessionID:record.sessionID});
      if(!cancellation||session.length!==1||record.directory!==session[0].directory||record.executionGeneration!==2
        ||disposition.phase==='cancelled'&&(disposition.eventID!==cancellation.eventID||disposition.eventSeq!==cancellation.seq))invalid();
      const paths=referencePaths(record,disposition.inputID);
      if(paths.length)proofs.push({id:disposition.inputID,sessionID:record.sessionID,inboxSha256:null,
        sessionSha256:sha256(canonicalJSON(session[0])),sourceSha256:sha256(canonicalJSON(db.all('SELECT id,type,seq,data FROM session_message WHERE session_id=? ORDER BY seq',[record.sessionID]))),
        file,fileSha256:loaded.sha256,paths,cancellation:{enqueuedSeq:disposition.enqueuedSeq,payloadHash:disposition.payloadHash,type:disposition.type,delivery:disposition.delivery,...cancellation}});
    }
  }
  // Retain the stricter persisted contract for reservations not yet enqueued.
  for(const proof of cancelledOnly?[]:await verifyBundleOwnedContinuations(db,webDataDirectory,{allowUnownedPending:true,cancelledContinuations:proofs.filter(proof=>proof.cancellation)})){
    if(!proofs.some(item=>item.id===proof.id))proofs.push(proof);
  }
  if(proofs.length>128||new Set(proofs.map(proof=>proof.id)).size!==proofs.length)invalid();
  return proofs;
 }catch {invalid();}
}
