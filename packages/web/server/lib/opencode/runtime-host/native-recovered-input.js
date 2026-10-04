import { Schema } from 'effect';
import { SessionInbox } from '@opencode/schema/session-inbox';
import { SessionMessage } from '@opencode/schema/session-message';
import { resolveSqliteDriver } from '../db-maintenance-core.js';
import { canonicalJSON, hasMigrationTable, sha256, bundleFailure } from './bundle-migration-inventory.js';
import { isNativeTurnParent } from '../../../../../shared-runtime/lib/native-message-status.js';
import {nativeInputCancellation,nativeInputEnqueue} from './native-input-cancellation.js';
import {nativeShellCompletionFingerprint} from './native-shell-completion.js';
import {recoveredInputHash} from './native-recovered-input-hash.js';
export {recoveredInputHash} from './native-recovered-input-hash.js';

const LIMIT=128, BYTES=16*1024*1024, INPUT_BYTES=1024*1024;
const fail=code=>{const error=bundleFailure(code);error.statusCode=409;throw error;};
const encodedItem=Schema.toEncoded(SessionInbox.Item);
const encodedMessage=Schema.toEncoded(SessionMessage.Info);
const decodeItem=value=>Schema.decodeUnknownSync(encodedItem)(value,{onExcessProperty:'error'});
const decodeMessage=row=>Schema.decodeUnknownSync(encodedMessage)({...JSON.parse(row.data),id:row.id,type:row.type},{onExcessProperty:'error'});
const completed=message=>message.type==='assistant'&&Number.isSafeInteger(message.time.completed)&&message.time.completed>=0;

/** Accepted SQLite input is authoritative content, never an execution grant. */
export function readRecoveredNativeInputs(db,startedIDs=[],sessionIDFilter) {
  if(startedIDs.length>LIMIT||startedIDs.some(id=>typeof id!=='string'||!/^msg_[A-Za-z0-9]+$/.test(id)))fail('native_recovered_input_invalid');
  if(hasMigrationTable(db,'session_pending')&&db.all('SELECT 1 FROM session_pending LIMIT 1').length)fail('migration_pending_input_unsupported');
  const cache=new Map();let transcriptBytes=0;
  const stateFor=sessionID=>{
    if(cache.has(sessionID))return cache.get(sessionID);
    const bounds=db.all('SELECT count(*) AS count,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM session_message WHERE session_id=?',[sessionID])[0];
    transcriptBytes+=bounds.bytes;
    if(bounds.count>10000||transcriptBytes>BYTES)fail('native_recovered_input_limit');
    const history=db.all('SELECT id,session_id,type,seq,data FROM session_message WHERE session_id=? ORDER BY seq LIMIT 10001',[sessionID]);
    const session=db.all('SELECT * FROM session_v2 WHERE id=?',[sessionID]);
    let previous=-1;
    const messages=history.map(row=>{if(row.session_id!==sessionID||!Number.isSafeInteger(row.seq)||row.seq<=previous)fail('native_recovered_input_invalid');previous=row.seq;return decodeMessage(row);});
    const state={history,messages,session,historyHash:sha256(canonicalJSON(history))};cache.set(sessionID,state);return state;
  };
  const queued=hasMigrationTable(db,'session_inbox')?db.all(`SELECT * FROM session_inbox ${sessionIDFilter?'WHERE session_id=?':''} ORDER BY session_id,enqueued_seq LIMIT 129`,sessionIDFilter?[sessionIDFilter]:[]):[];
  const condition=`${sessionIDFilter?'s.id=? AND ':''}s.time_archived IS NULL AND s.revert IS NULL AND (m.type IN ('user','synthetic','compaction') AND NOT EXISTS
    (SELECT 1 FROM session_message a WHERE a.session_id=m.session_id AND a.seq>m.seq AND a.type='assistant')
    ${startedIDs.length?`OR m.id IN (${startedIDs.map(()=>'?').join(',')})`:''})`;
  const candidateBounds=db.all(`SELECT count(*) AS count,coalesce(sum(length(CAST(m.data AS BLOB))),0) AS bytes
    FROM session_message m JOIN session_v2 s ON s.id=m.session_id WHERE ${condition}`,sessionIDFilter?[sessionIDFilter,...startedIDs]:startedIDs)[0];
  if(queued.length>LIMIT||candidateBounds.count>10000||candidateBounds.bytes>BYTES)fail('native_recovered_input_limit');
  const promoted=db.all(`SELECT m.id,m.session_id,m.type,m.seq,m.data FROM session_message m JOIN session_v2 s ON s.id=m.session_id
    WHERE ${condition} ORDER BY m.session_id,m.seq LIMIT 10001`,sessionIDFilter?[sessionIDFilter,...startedIDs]:startedIDs);
  const unfinished=db.all(`SELECT a.session_id,a.seq FROM session_message a JOIN session_v2 s ON s.id=a.session_id
    WHERE s.time_archived IS NULL AND s.revert IS NULL AND a.type='assistant'
      AND a.seq=(SELECT max(b.seq) FROM session_message b WHERE b.session_id=a.session_id AND b.type='assistant')
      AND json_extract(a.data,'$.time.completed') IS NULL ${sessionIDFilter?'AND s.id=?':''} LIMIT 129`,sessionIDFilter?[sessionIDFilter]:[]);
  if(unfinished.length>LIMIT)fail('native_recovered_input_limit');
  for(const assistant of unfinished){
    const state=stateFor(assistant.session_id);
    const parent=state.history.filter(row=>row.seq<assistant.seq).toReversed().find(row=>isNativeTurnParent(state.messages[state.history.indexOf(row)]));
    if(parent&&!promoted.some(row=>row.id===parent.id))promoted.push(parent);
  }
  const inputs=[],seen=new Set();let bytes=0;
  for(const row of [...queued,...promoted]) {
    const location=Object.hasOwn(row,'payload')?'queued':'promoted';
    const raw=location==='queued'?row.payload:row.data;
    if(typeof raw!=='string'||Buffer.byteLength(raw)>INPUT_BYTES)fail('native_recovered_input_limit');
    const {session,history,messages,historyHash}=stateFor(row.session_id);
    if(location==='promoted' && (session[0]?.time_archived || session[0]?.revert
      || !isNativeTurnParent(messages[history.findIndex(message=>message.id===row.id)])
      || row.type==='compaction'&&['completed','failed'].includes(messages[history.findIndex(message=>message.id===row.id)].status)))continue;
    if(seen.has(row.id)||typeof row.id!=='string'||!/^msg_[A-Za-z0-9]+$/.test(row.id))fail('native_recovered_input_invalid');
    seen.add(row.id);
    if(seen.size>LIMIT)fail('native_recovered_input_limit');
    if(location==='queued'&&db.all('SELECT id FROM session_message WHERE id=?',[row.id]).length)fail('native_recovered_input_invalid');
    if(session.length!==1||session[0].time_archived||session[0].revert)fail('native_recovered_input_invalid');
    bytes+=Buffer.byteLength(raw);if(bytes>BYTES)fail('native_recovered_input_limit');
    let item,originSeq=row.seq;
    if(location==='queued')item=decodeItem({type:row.type,delivery:row.delivery,payload:JSON.parse(raw)});
    else {
      const message=decodeMessage(row);
      const {id:_id,type:_type,time:_time,...payload}=message;
      const enqueue=db.all(`SELECT seq FROM event WHERE aggregate_id=? AND type='session.inbox.enqueued.1' AND seq<? AND json_extract(data,'$.inboxID')=? ORDER BY seq DESC LIMIT 129`,[row.session_id,row.seq,row.id]);
      if(enqueue.length>LIMIT)fail('native_recovered_input_limit');
      const accepted=enqueue[0];
      originSeq=accepted?.seq??row.seq;
      const original=accepted&&nativeInputEnqueue(db,{messageID:row.id,sessionID:row.session_id,enqueuedSeq:accepted.seq},row.seq);
      item=decodeItem({type:row.type,delivery:original?.delivery??'queue',payload:row.type==='compaction'?{}:payload});
    }
    if(['files','agents','skills'].some(key=>(item.payload[key]?.length??0)>LIMIT))fail('native_recovered_input_limit');
    if(!Number.isSafeInteger(location==='queued'?row.enqueued_seq:row.seq)||(location==='queued'?row.enqueued_seq:row.seq)<0)fail('native_recovered_input_invalid');
    const historyBytes=Buffer.byteLength(canonicalJSON(history));
    if(history.length>10000||historyBytes>BYTES)fail('native_recovered_input_limit');
    const lastAssistant=messages.filter(message=>message.type==='assistant').at(-1);
    const incompleteAssistant=lastAssistant? !completed(lastAssistant):false;
    const following=location==='promoted'?history.find(message=>message.type==='assistant'&&message.seq>row.seq):undefined;
    const settled=Boolean(following&&completed(messages[history.indexOf(following)])&&!history.some(message=>message.seq>row.seq&&message.seq<following.seq
      &&isNativeTurnParent(messages[history.indexOf(message)])));
    inputs.push({messageID:row.id,sessionID:row.session_id,directory:session[0].directory,
      type:item.type,delivery:item.delivery,location,item,payloadHash:recoveredInputHash(item),
      enqueuedSeq:location==='queued'?row.enqueued_seq:originSeq,
      rowHash:sha256(canonicalJSON(row)),sessionHash:sha256(canonicalJSON(session[0])),
      historyHash,session:session[0],incompleteAssistant,settled});
  }
  return inputs;
}

export function withRecoveredInputDatabase(file,action) {
  const raw=resolveSqliteDriver().open(file,{readonly:true});
  try {return action({all:(sql,params=[])=>raw.prepare(sql).all(...params)});} finally {raw.close();}
}

export {nativeInputCancellation} from './native-input-cancellation.js';

/** Startup-only fence. No normal live inbox item is registered here. */
export function createNativeRecoveredInputOwner({databasePath,primaryRuntime,captureAuthorization,runOwned,readiness,withSessionLock}) {
  const sessions=new Map(), grants=new Map();let epoch;
  const read=action=>withRecoveredInputDatabase(databasePath,action);
  const currentInputs=sessionID=>read(db=>readRecoveredNativeInputs(db,sessions.get(sessionID)?.startedIDs??[],sessionID));
  const owns=(r,id)=>Boolean(r&&[r.anchorID,r.recoveryID,r.continuationID,...r.guardedIDs].includes(id));
  const tuple=r=>({owner:r.owner,cancellationGeneration:r.cancellationGeneration,anchorID:r.anchorID,recoveryID:r.recoveryID,
    providerID:r.providerID,modelID:r.modelID,agent:r.agent,variant:r.variant,
    tools:r.tools,recoveryExecution:r.recoveryExecution,recoveryPrompt:r.recoveryPrompt,nativeContinuation:r.nativeContinuation});
  const stamp=(inputs,r)=>sha256(canonicalJSON({epoch,inputs:inputs.map(({messageID,payloadHash,rowHash,sessionHash,historyHash})=>
    ({messageID,payloadHash,rowHash,sessionHash,historyHash})),record:r?{revision:r.revision,...tuple(r)}:null}));
  const refresh=async sessionID=>{
    if(!sessions.has(sessionID))return [];
    const inputs=currentInputs(sessionID),r=await primaryRuntime.readRecord(sessionID);
    const unresolved=(r?.recoveredInputDispositions??[]).filter(item=>item.phase==='requested');
    const completed=inputs.filter(input=>input.settled&&sessions.get(sessionID).startedIDs?.includes(input.messageID));
    const retained=inputs.filter(input=>!completed.includes(input));
    if(!retained.length&&!unresolved.length){sessions.delete(sessionID);grants.delete(sessionID);return [];}
    sessions.set(sessionID,{inputs:retained,unresolved,startedIDs:sessions.get(sessionID)?.startedIDs??[]});return retained;
  };
  const eligible=(input,inputs,r)=>{
    if((r?.recoveredInputDispositions??[]).some(item=>item.phase==='requested'))return 'discard_in_progress';
    if(inputs.length!==1)return 'competing_input';
    if(input.type!=='user'||input.incompleteAssistant)return input.incompleteAssistant?'incomplete_assistant':'unsupported_input';
    if(!r||r.executionGeneration!==2||r.directory!==input.directory||r.nativeContinuation||r.activeUserID)return 'unowned_input';
    const fallback=input.messageID===r.recoveryID,selection=fallback?r.recoveryExecution:r;
    const model=JSON.parse(input.session.model??'null');
    if(!selection||input.session.agent!==selection.agent||model?.providerID!==selection.providerID
      ||model.id!==selection.modelID||(model.variant??'default')!==selection.variant)return 'selection_changed';
    if(fallback?(!r.recoveryPrompt||r.attemptCount!==1):input.messageID!==r.anchorID||r.stepID||r.attemptCount!==0)return 'unowned_input';
    if(fallback){
      const content=r.recoveryPrompt.parts.map(part=>part.text??'').join('');
      if(input.item.payload.text!==content||(input.item.payload.files?.length??0)||(input.item.payload.agents?.length??0)||(input.item.payload.skills?.length??0)
        ||Object.entries(r.recoveryPrompt.tools).some(([tool,enabled])=>enabled&&!['read','glob','grep'].includes(tool)))return 'payload_changed';
    }
    return null;
  };
  const captured=async(sessionID,scope)=>{
    if(!sessions.has(sessionID))fail('recovery_revision_conflict');
    const inputs=await refresh(sessionID),r=await primaryRuntime.readRecord(sessionID),input=inputs.find(item=>item.messageID===scope.messageID);
    if(!input||input.payloadHash!==scope.payloadHash||stamp(inputs,r)!==scope.revision)fail('recovery_revision_conflict');
    return {inputs,r,input};
  };
  const confirmGrant=async grant=>{
    if(grants.get(grant.input.sessionID)!==grant||grant.epoch!==epoch)fail('native_recovered_input_fenced');
    await grant.authorize();
    const r=await primaryRuntime.readRecord(grant.input.sessionID);
    if((r?.recoveredInputDispositions??[]).some(item=>item.phase==='requested'))fail('native_recovered_input_fenced');
    const expectedTuple=tuple(grant.record??{}),actualTuple=tuple(r??{});
    // Step acknowledgement alone may consume this exact persisted continuation.
    if(grant.record?.nativeContinuation&&!r?.nativeContinuation&&r?.continuationID===grant.input.messageID&&r?.stepID&&r.stepID!==grant.record.stepID){
      const history=read(db=>{const bounds=db.all('SELECT count(*) AS count,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM session_message WHERE session_id=?',[grant.input.sessionID])[0];
        if(bounds.count>10000||bounds.bytes>BYTES)fail('native_recovered_input_limit');return db.all('SELECT id,type,seq,data FROM session_message WHERE session_id=? ORDER BY seq LIMIT 10001',[grant.input.sessionID]);});
      const index=history.findIndex(row=>row.id===r.stepID&&row.type==='assistant');
      const parent=history.slice(0,index).toReversed().find(row=>isNativeTurnParent(decodeMessage(row)));
      if(index<0||parent?.id!==grant.input.messageID)fail('native_recovered_input_fenced');
      decodeMessage(history[index]);delete expectedTuple.nativeContinuation;delete actualTuple.nativeContinuation;
    }
    if(grant.record&&canonicalJSON(actualTuple)!==canonicalJSON(expectedTuple))fail('native_recovered_input_fenced');
    const state=read(db=>db.all('SELECT * FROM session_v2 WHERE id=?',[grant.input.sessionID])[0]);
    const scope=value=>Object.fromEntries(['id','directory','parent_id','agent','model','permission','revert','time_archived'].map(key=>[key,value[key]]));
    if(!state||canonicalJSON(scope(state))!==canonicalJSON(scope(grant.input.session)))fail('native_recovered_input_fenced');
  };
  const beginGrant=async(input,r,authorize,action)=>{
    if(grants.has(input.sessionID)||sessions.get(input.sessionID)?.unresolved.length)fail('native_recovered_input_busy');
    const grant={epoch,input,record:r,authorize};grants.set(input.sessionID,grant);
    sessions.get(input.sessionID).startedIDs=[input.messageID];
    try{await confirmGrant(grant);return await action(()=>confirmGrant(grant));}
    catch(cause){grants.delete(input.sessionID);throw cause;}
  };
  return {
    async isRecoveryDispatchPending(record, liveDispatch) {
      try {
        readiness();
        if(record.executionGeneration!==2 || record.instanceID!==epoch || !record.recoveryID
          || !['recovery_reserved','recovering'].includes(record.state))return false;
        const grant=grants.get(record.sessionID);
        if(grant){
          if(grant.input.messageID!==record.recoveryID)return false;
          await confirmGrant(grant);
        }else if(!liveDispatch?.itemHash)return false;
        const current=await primaryRuntime.readRecord(record.sessionID);
        if(!current || current.revision!==record.revision || canonicalJSON(tuple(current))!==canonicalJSON(tuple(record)))return false;
        const inputs=read(db=>readRecoveredNativeInputs(db,[record.recoveryID],record.sessionID));
        const input=inputs.find(item=>item.messageID===record.recoveryID);
        if(inputs.length!==1 || !input || input.settled || input.type!=='user'
          || input.payloadHash!==(grant?grant.input.payloadHash:liveDispatch.itemHash))return false;
        if(input.location==='promoted' && read(db=>{
          const tail=db.all('SELECT id,type,seq,data FROM session_message WHERE session_id=? AND seq>(SELECT seq FROM session_message WHERE id=? AND session_id=?) ORDER BY seq DESC LIMIT 1',
            [record.sessionID,record.recoveryID,record.sessionID])[0];
          return tail?.type==='idle' && decodeMessage(tail).outcome==='failed';
        }))return false;
        const model=JSON.parse(input.session.model??'null'),selection=record.recoveryExecution;
        // Status preservation does not replay an already-started assistant.
        return Boolean(selection && input.session.agent===selection.agent && model?.providerID===selection.providerID
          && model.id===selection.modelID && (model.variant??'default')===selection.variant);
      }catch{return false;}
    },
    async install(instanceID){epoch=instanceID;sessions.clear();grants.clear();
      const records=await primaryRuntime.nativeStartupRecords(),startedIDs=[];
      for(const r of records)if(r.recoveredInput||r.stepID){
        const userID=r.recoveredInput?.inputID??r.activeUserID??r.continuationID??r.recoveryID??r.anchorID;
        const unfinished=read(db=>{
          const marker=r.recoveredInput&&db.all('SELECT seq FROM session_message WHERE id=? AND session_id=?',[userID,r.sessionID])[0];
          const boundary=marker?db.all(`SELECT id,length(CAST(data AS BLOB)) AS bytes FROM session_message WHERE session_id=? AND type='assistant' AND seq>? ORDER BY seq LIMIT 1`,[r.sessionID,marker.seq])[0]
            :r.recoveredInput?undefined:db.all(`SELECT id,length(CAST(data AS BLOB)) AS bytes FROM session_message WHERE id=? AND session_id=? AND type='assistant'`,[r.stepID,r.sessionID])[0];
          if(!boundary)return Boolean(r.recoveredInput);
          if(boundary.bytes>BYTES)fail('native_recovered_input_limit');
          const assistant=db.all('SELECT id,type,data FROM session_message WHERE id=? AND session_id=?',[boundary.id,r.sessionID])[0];
          return !completed(decodeMessage(assistant));
        });
        if(unfinished)startedIDs.push(userID);
      }
      for(const input of read(db=>readRecoveredNativeInputs(db,startedIDs))){const value=sessions.get(input.sessionID)??{inputs:[],unresolved:[],startedIDs:[]};value.inputs.push(input);
        if(startedIDs.includes(input.messageID))value.startedIDs.push(input.messageID);sessions.set(input.sessionID,value);}
      for(const r of records){
        const unresolved=(r.recoveredInputDispositions??[]).filter(item=>item.phase==='requested');
        if(unresolved.length)sessions.set(r.sessionID,{inputs:sessions.get(r.sessionID)?.inputs??[],startedIDs:sessions.get(r.sessionID)?.startedIDs??[],unresolved});
        for(const intent of unresolved){const cancellation=read(db=>nativeInputCancellation(db,{...intent,messageID:intent.inputID,sessionID:r.sessionID}));
          if(cancellation)await primaryRuntime.settleRecoveredInputDiscard({sessionID:r.sessionID,messageID:intent.inputID,payloadHash:intent.payloadHash,
            enqueuedSeq:intent.enqueuedSeq,eventID:cancellation.eventID,eventSeq:cancellation.seq},async()=>{});}
        await refresh(r.sessionID);
      }
      return [...sessions.keys()];
    },
    has:sessionID=>sessions.has(sessionID),
    async snapshot(sessionID){if(!sessions.has(sessionID))return undefined;
      const inputs=await refresh(sessionID);if(!sessions.has(sessionID))return undefined;
      const r=await primaryRuntime.readRecord(sessionID),grant=grants.get(sessionID);
      return {revision:stamp(inputs,r),state:grant?'resuming':sessions.get(sessionID).unresolved.some(intent=>!inputs.some(input=>input.messageID===intent.inputID))?'discarding':'paused',
        inputs:inputs.map(input=>({messageID:input.messageID,payloadHash:input.payloadHash,type:input.type,delivery:input.delivery,
          location:input.location,preview:(input.item.payload.text??'').slice(0,160),attachmentCount:input.item.payload.files?.length??0,
          canResume:!grant&&eligible(input,inputs,r)===null,canDiscard:!grant&&input.location==='queued'&&input.type==='user',reason:eligible(input,inputs,r)}))};
    },
    async details(sessionID,scope){readiness();const {input}=await captured(sessionID,scope);
      await (await captureAuthorization(input))();
      return {messageID:input.messageID,payloadHash:input.payloadHash,type:input.type,delivery:input.delivery,location:input.location,
        text:input.item.payload.text??'',files:(input.item.payload.files??[]).map(file=>({uri:file.source.type==='uri'?file.source.uri:`data:${file.mime};base64,${file.data}`,...file.name?{name:file.name}:{},mime:file.mime})),agents:(input.item.payload.agents??[]).map(agent=>({name:agent.name})),skills:input.item.payload.skills??[]};
    },
    async action(sessionID,action,scope,context){return withSessionLock(sessionID,async()=>{readiness();const {input,inputs,r}=await captured(sessionID,scope);
      const authorize=await captureAuthorization(input);await authorize();
      if(action==='resume-input'){
        if(eligible(input,inputs,r)!==null)fail('native_recovered_input_unsupported');
        const check=async()=>{await authorize();await captured(sessionID,scope);};
        return beginGrant(input,r,authorize,async()=>{
          const grant=grants.get(sessionID);
          // The existing grant pins the requested owner before publication of
          // the durable adoption, so a concurrent poll sees one exact scope.
          grant.record={...r,owner:context.owner??null};
          const adopted=await primaryRuntime.adoptRecoveredInput({sessionID,messageID:input.messageID,payloadHash:input.payloadHash,
            recordRevision:r.revision,cancellationGeneration:r.cancellationGeneration,previousOwner:r.owner,owner:context.owner??null,
            instanceID:epoch,enqueuedSeq:input.enqueuedSeq,delivery:input.delivery},check);
          grant.record=adopted;
          return runOwned({action:'resume',input,recheck:()=>confirmGrant(grant)});
        });
      }
      if(input.location!=='queued'||input.type!=='user'||grants.has(sessionID))fail('native_recovered_input_unsupported');
      if(owns(r,input.messageID))await primaryRuntime.requestRecoveredInputDiscard({sessionID,messageID:input.messageID,
        payloadHash:input.payloadHash,enqueuedSeq:input.enqueuedSeq,type:input.type,delivery:input.delivery,
        recordRevision:r.revision,cancellationGeneration:r.cancellationGeneration,previousOwner:r.owner},async()=>{await authorize();await captured(sessionID,scope);});
      if(owns(r,input.messageID)){sessions.get(sessionID).unresolved.push({inputID:input.messageID});grants.delete(sessionID);}
      const cancellationRecord=owns(r,input.messageID)?await primaryRuntime.readRecord(sessionID):null;
      const recheck=async()=>{await authorize();if(cancellationRecord&&canonicalJSON(await primaryRuntime.readRecord(sessionID))!==canonicalJSON(cancellationRecord))fail('recovery_revision_conflict');const current=currentInputs(sessionID).find(item=>item.messageID===input.messageID);
        if(!current||current.payloadHash!==input.payloadHash||current.rowHash!==input.rowHash)fail('recovery_revision_conflict');};
      await runOwned({action:'discard',input,recheck});
      const cancellation=read(db=>nativeInputCancellation(db,input));if(!cancellation)fail('native_recovered_input_cancellation_uncertain');
      if(owns(r,input.messageID))await primaryRuntime.settleRecoveredInputDiscard({sessionID,messageID:input.messageID,payloadHash:input.payloadHash,
        enqueuedSeq:input.enqueuedSeq,eventID:cancellation.eventID,eventSeq:cancellation.seq},authorize);
      await refresh(sessionID);});
    },
    async automatic(input,record,authorize,action){if(!sessions.has(input.sessionID))return action(authorize);
      const rows=await refresh(input.sessionID);let row=rows.find(item=>item.messageID===input.messageID);
      let expected=input.expectedItem;
      if(!expected&&input.shellReceipt){const receipt=input.shellReceipt;
        if(row?.location==='promoted'&&['queue','steer'].includes(receipt.itemDelivery)){const item={...row.item,delivery:receipt.itemDelivery};row={...row,item,delivery:receipt.itemDelivery,payloadHash:recoveredInputHash(item)};}
        const payload=row?.item.payload,metadata=payload?.metadata,devryan=metadata?.devryan;
        const fingerprint=nativeShellCompletionFingerprint({sessionID:input.sessionID,messageID:input.messageID,token:receipt.token,text:payload?.text});
        if(!row||row.type!=='synthetic'||row.delivery!==receipt.itemDelivery||row.payloadHash!==receipt.itemHash||payload.description!==receipt.command||metadata?.source!=='shell'||metadata.jobID!==receipt.jobID||metadata.shellID!==receipt.jobID||metadata.exit!==receipt.exitCode||!['completed','error','cancelled'].includes(metadata.state)||devryan?.origin!=='native_shell'||devryan.admission?.fingerprint!==fingerprint)fail('native_recovered_input_fenced');
        expected=row.item;
      }
      if(rows.length!==1||!row||!expected||row.payloadHash!==recoveredInputHash(expected))fail('native_recovered_input_fenced');
      return beginGrant(row,record,authorize,action);
    },
    assertOperation(request,entry){if(!request.sessionID||!sessions.has(request.sessionID))return;
      if(['execution.interrupt','session.abort','session.stop'].includes(request.operation))return;
      const grant=grants.get(request.sessionID);
      if(entry?.recoveredInputCancellation&&['inbox.cancel','recovered.input.cancel'].includes(request.operation))return;
      if(!grant||['admission.prompt','admission.command','session.prompt','session.command','session.switchAgent','session.switchModel',
        'session.setPermissions','session.compact','inbox.compaction','inbox.steer','inbox.queue','session.synthetic','inbox.admit','inbox.reconcile'].includes(request.operation))fail('native_recovered_input_fenced');
      if(entry&&entry.recoveredInputGrant!==grant)fail('native_recovered_input_fenced');
      return grant;
    },
    async beforePublish({events,pending,grant}){
      const cancellations=[];
      for(const event of events){const sessionID=event.data?.sessionID;if(!sessions.has(sessionID))continue;
        const owned=grants.get(sessionID);
        if(event.type==='session.inbox.cancelled'&&grant?.recoveredInputCancellation?.messageID===event.data.inboxID){
          await grant.reauthorize();
          const input=pending.find(item=>item.sessionID===sessionID&&item.id===event.data.inboxID);
          if(!input||input.payloadHash!==grant.recoveredInputCancellation.payloadHash||input.enqueuedSeq!==grant.recoveredInputCancellation.enqueuedSeq)fail('recovery_revision_conflict');
          cancellations.push({sessionID,inboxID:input.id});
          continue;
        }
        if(!owned||grant?.recoveredInputGrant!==owned)fail('native_recovered_input_fenced');
        await confirmGrant(owned);
        const rows=pending.filter(item=>item.sessionID===sessionID);
        if(rows.some(item=>item.id!==owned.input.messageID||item.payloadHash!==owned.input.payloadHash))fail('native_recovered_input_fenced');
        if(event.type==='session.inbox.delivered'&&event.data.inboxID!==owned.input.messageID
          ||event.type==='session.inbox.enqueued'||event.type==='session.inbox.delivery.changed')fail('native_recovered_input_fenced');
      }
      return cancellations;
    },
    async published(sessionID){if(sessions.has(sessionID))await refresh(sessionID);},
  };
}
