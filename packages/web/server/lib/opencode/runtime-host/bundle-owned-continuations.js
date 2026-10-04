import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { Schema } from 'effect';
import { SessionInbox } from '@opencode/schema/session-inbox';
import { SessionMessage } from '@opencode/schema/session-message';
import { validatePrimaryRecoveryRecord } from '../../../../../harness-runtime/lib/provider-recovery-policy.js';
import { isNativeTurnParent, isNativeStatusRecord } from '../../../../../shared-runtime/lib/native-message-status.js';
import { buildV2PromptContent, buildV2PromptFingerprint, buildDevryanPromptMetadata, validateDevryanPromptMetadata } from '../v2/admission.js';
import { projectMessagePage } from '../v2/projection/messages.js';
import { bundleFailure, canonicalJSON, hasMigrationTable, isRecord, sha256 } from './bundle-migration-inventory.js';

const MAX_PENDING = 128, MAX_RECORDS = 4096, MAX_MESSAGES = 10000, MAX_RECORD_BYTES = 128 * 1024;
const invalid = () => { throw bundleFailure('migration_pending_input_unsupported'); };
const same = (a,b) => canonicalJSON(a) === canonicalJSON(b);
const id = value => typeof value === 'string' && /^msg_[a-zA-Z0-9]{1,128}$/.test(value);

// Read the existing envelope without creating directories, quarantining data,
// taking the provider owner lock or granting execution authority.
export async function readBundleRecoveryEnvelope(file) {
  if (await fs.realpath(path.dirname(file)) !== path.dirname(file)) invalid();
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat=await handle.stat();
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) invalid();
    const buffer=Buffer.alloc(MAX_RECORD_BYTES+1);
    const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
    if (bytesRead>MAX_RECORD_BYTES || bytesRead!==stat.size) invalid();
    const bytes=buffer.subarray(0,bytesRead), envelope=JSON.parse(bytes.toString('utf8'));
    if (!isRecord(envelope) || !same(Object.keys(envelope).sort(),['key','record','version']) || envelope.version!==1
      || !isRecord(envelope.record) || envelope.key!==sha256(envelope.record.sessionID)
      || path.basename(file)!==envelope.key+'.json') invalid();
    validatePrimaryRecoveryRecord(envelope.record);
    return {envelope,sha256:sha256(bytes)};
  } finally { await handle.close(); }
}

/** Exact queued prompt encoding shared by offline proof and fresh owned dispatch. */
export function bundleContinuationItem(record) {
  const pending=record.nativeContinuation,prompt=pending.prompt,content=buildV2PromptContent(prompt.parts);
  const fingerprint=buildV2PromptFingerprint({sessionID:record.sessionID,messageID:pending.messageID,content,selection:prompt,
    objectiveID:prompt.objectiveID,origin:'managed-primary',resume:true,delivery:'queue',planMode:content.planMode});
  const metadata=buildDevryanPromptMetadata({origin:'managed-primary',agent:record.agent,providerID:record.providerID,
    modelID:record.modelID,variant:record.variant,objectiveID:prompt.objectiveID,planMode:content.planMode,
    parts:content.segments,admission:{v:1,fingerprint}},{text:content.text});
  return {type:'user',delivery:'queue',payload:{text:content.text,metadata:{devryan:metadata}}};
}

/** Offline integrity only. Fresh controller capture/reauthorization remains
 * the sole dispatch authority after launch. Every current inbox row must prove
 * the exact persisted restart contract; ordinary/fallback input has none here. */
export async function verifyBundleOwnedContinuations(db,webDataDirectory,{allowUnownedPending=false,cancelledContinuations=[]}={}) {
  if (hasMigrationTable(db,'session_pending') && db.all('SELECT 1 FROM session_pending LIMIT 1').length) invalid();
  if (!hasMigrationTable(db,'session_inbox')) return [];
  const rows=db.all(`SELECT * FROM session_inbox ORDER BY session_id,enqueued_seq LIMIT ${MAX_PENDING+1}`);
  if (rows.length>MAX_PENDING || new Set(rows.map(row=>row.id)).size!==rows.length
    || !allowUnownedPending&&new Set(rows.map(row=>row.session_id)).size!==rows.length) invalid();
  const verified=[], directory=path.join(webDataDirectory,'harness','provider-recovery');
  const files=await fs.readdir(directory,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  if (files.length>MAX_RECORDS) invalid();
  for (const entry of files) {
    if (!entry.name.endsWith('.json')) continue;
    try {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) invalid();
      const file=path.join(directory,entry.name), loaded=await readBundleRecoveryEnvelope(file);
      const record=loaded.envelope.record, pending=record.nativeContinuation;
      if (!pending) continue;
      if(cancelledContinuations.some(proof=>proof.file===file&&proof.fileSha256===loaded.sha256&&proof.sessionID===record.sessionID&&proof.id===pending.messageID&&proof.cancellation))continue;
      if (verified.length>=MAX_PENDING) invalid();
      const row=rows.find(item=>item.id===pending.messageID), sessionID=record.sessionID;
      if(row&&allowUnownedPending)continue;
      const committed=db.all('SELECT id,session_id,type FROM session_message WHERE id=?',[pending.messageID]);
      if (committed.length) {
        if (row || committed.length!==1 || committed[0].session_id!==sessionID || committed[0].type!=='user') invalid();
        continue; // Native promotion may commit before the primary Step ACK.
      }
      if (!id(pending.messageID) || typeof sessionID!=='string' || !sessionID.startsWith('ses_')
        || record.executionGeneration!==2 || record.state!=='observing'
        || record.attemptCount!==0 || record.recoveryID || record.recoverySuppressed || record.activeUserID || record.stepID
        || !(record.owner===null || typeof record.owner==='string')
        || !Number.isSafeInteger(record.cancellationGeneration) || record.cancellationGeneration<0
        || record.cancellationGeneration!==pending.cancellationGeneration || record.continuationID!==pending.messageID
        || !id(record.anchorID) || !id(pending.sourceUserMessageID) || !id(pending.sourceAssistantMessageID)
        || !Number.isSafeInteger(record.todoContinuationCount) || record.todoContinuationCount<0 || record.todoContinuationCount>12
        || pending.kind==='orchestrator_todo' && (record.agent!=='orchestrator' || record.todoContinuationCount<1 || record.todoContinuationCount>3)
        || pending.kind==='builder_todo' && (!['build','builder'].includes(record.agent) || record.todoContinuationCount<1)
        || record.guardedIDs.length>128 || new Set(record.guardedIDs).size!==record.guardedIDs.length
        || record.guardedIDs.includes(pending.messageID)) invalid();
      if (row && (row.session_id!==sessionID || row.type!=='user' || row.delivery!=='queue'
        || !Number.isSafeInteger(row.enqueued_seq) || row.enqueued_seq<0 || !Number.isSafeInteger(row.time_created) || row.time_created<0
        || typeof row.payload!=='string' || Buffer.byteLength(row.payload)>64*1024)) invalid();
      const payload=row && JSON.parse(row.payload);
      if (row) {
        Schema.decodeUnknownSync(SessionInbox.UserPayload)(payload,{onExcessProperty:'error'});
        Schema.decodeUnknownSync(SessionInbox.Item)({type:row.type,delivery:row.delivery,payload},{onExcessProperty:'error'});
      }
      const sessions=db.all('SELECT * FROM session_v2 WHERE id=?',[sessionID]);
      if (sessions.length!==1) invalid();
      const session=sessions[0], model=session.model===null?null:JSON.parse(session.model);
      if (session.parent_id || session.time_archived || session.revert || session.directory!==record.directory
        || session.agent!==record.agent || !isRecord(model) || model.providerID!==record.providerID || model.id!==record.modelID
        || (model.variant ?? 'default')!==record.variant) invalid();
      const prompt=pending.prompt,content=buildV2PromptContent(prompt.parts);
      // These three existing kinds persist only synthetic text, with explicit
      // selection and the managed-primary queued dispatch contract.
      if (Object.keys(prompt).some(key=>!['messageID','agent','model','variant','tools','objectiveID','parts'].includes(key))
        || !same(prompt.model,{providerID:record.providerID,modelID:record.modelID})
        || content.text.length===0 || content.files.length || content.agents.length) invalid();
      if (row && (!validateDevryanPromptMetadata(payload.metadata?.devryan,{text:payload.text}).ok
        || !same(payload,bundleContinuationItem(record).payload))) invalid();
      const size=db.all('SELECT COUNT(*) AS count,SUM(length(CAST(data AS BLOB))) AS bytes FROM session_message WHERE session_id=?',[sessionID])[0];
      if (size.count>MAX_MESSAGES || size.bytes>16*1024*1024) invalid();
      const native=db.all('SELECT id,type,seq,data FROM session_message WHERE session_id=? ORDER BY seq',[sessionID]);
      const messages=native.map(item=>{
        const stored=JSON.parse(item.data);
        if (!isRecord(stored) || stored.id!==undefined && stored.id!==item.id || stored.type!==undefined && stored.type!==item.type
          || !Number.isSafeInteger(item.seq)) invalid();
        const data={...stored,id:item.id,type:item.type};
        // Decode through the schema, then project the original encoded millis.
        Schema.decodeUnknownSync(SessionMessage.Info)(data);
        return data;
      });
      const projected=projectMessagePage(messages,{sessionID,directory:record.directory,agent:session.agent,model}).records;
      const source=projected.find(message=>message.info.id===pending.sourceAssistantMessageID);
      const user=projected.find(message=>message.info.id===pending.sourceUserMessageID);
      const anchor=projected.find(message=>message.info.id===record.anchorID);
      const objective=projected.find(message=>message.info.id===(record.objectiveID??record.anchorID));
      if (!anchor || anchor.info.role!=='user' || isNativeStatusRecord(anchor) || !objective || objective.info.role!=='user'
        || isNativeStatusRecord(objective) || !user || user.info.role!=='user' || isNativeStatusRecord(user)
        || messages.filter(isNativeTurnParent).at(-1)?.id!==pending.sourceUserMessageID
        || projected.filter(message=>message.info.role==='assistant').at(-1)?.info.id!==pending.sourceAssistantMessageID
        || !source || source.info.role!=='assistant' || source.info.parentID!==pending.sourceUserMessageID
        || source.turnOwnership?.source!=='native-sequence' || source.turnOwnership.userMessageID!==pending.sourceUserMessageID
        || !source.info.time?.completed || source.info.error || source.info.agent!==record.agent
        || source.info.providerID!==record.providerID || source.info.modelID!==record.modelID || source.info.variant!==record.variant
        || row && native.at(-1)?.seq>=row.enqueued_seq) invalid();
      verified.push({id:pending.messageID,sessionID,inboxSha256:row ? sha256(canonicalJSON(row)) : null,sessionSha256:sha256(canonicalJSON(session)),
        sourceSha256:sha256(canonicalJSON(native)),file,fileSha256:loaded.sha256});
    } catch { invalid(); }
  }
  if (!allowUnownedPending && rows.some(row=>!verified.some(proof=>proof.id===row.id && proof.sessionID===row.session_id))) invalid();
  return verified;
}
