import {isWindowsPrivateControlName} from '../../../../../harness-runtime/lib/windows-private-files.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readBundleRecoveryEnvelope } from './bundle-owned-continuations.js';
import { git } from '../../../../../harness-runtime/lib/session-changes-git.js';
import { openChangeStore, changeKey } from '../../../../../harness-runtime/lib/session-changes-store.js';
import { isRebootRecoveredLease } from '../../../../../harness-runtime/lib/session-reboot-recovery.js';
import { isTerminalManagedTaskStatus } from '../../../../../orchestration-runtime/contract.js';
import { bundleFailure, containsPath, isRecord, readBundleJSON as readBundleJSONOwned, saveBundleJSON as saveBundleJSONOwned, sha256, canonicalJSON } from './bundle-migration-inventory.js';

export const PER_FILE_RECORD=/^(?:files|revisions|runs|bases)\//;
const entries = async directory => fs.readdir(directory,{withFileTypes:true}).catch(error => {
  if (error.code === 'ENOENT') return []; throw error;
});
const keyForTransaction = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id) ? `transactions/${changeKey(id)}.json` : null;
const sessionFields = new Set(['sessionID','sessionId','rootSessionId','parentSessionId','childSessionId','sourceSessionId']);
const messageFields = new Set(['messageID','messageId','userMessageID','assistantMessageID','anchorID','objectiveID','sourceUserMessageID','previousStepID','activeUserID','stepID','failedID','recoveryID','continuationID','sourceMessageId','targetMessageID','boundaryMessageID','notificationID','turnID']);
/** Field names the inspection collects as session and message references. */
export const BUNDLE_REFERENCE_FIELDS=Object.freeze([...sessionFields,...messageFields]);
const references = (value, collected, sessionID=null, exception, route=[]) => {
  if (Array.isArray(value)) { for (const [index,item] of value.entries()) {
    if(route.join('.')==='record.guardedIDs'&&typeof item==='string'){
      if(!exception?.some(proof=>proof.id===item&&proof.sessionID===sessionID&&proof.paths?.includes([...route,index].join('.')))){collected.messages.add(item);const scopes=collected.messageScopes.get(item)??new Set();scopes.add(sessionID);collected.messageScopes.set(item,scopes);}
    }else references(item,collected,sessionID,exception,[...route,String(index)]);
  } return; }
  if (!isRecord(value)) return;
  const owner = value.sessionID ?? value.sessionId ?? value.scope?.sessionID ?? sessionID;
  for (const [key,item] of Object.entries(value)) {
    if (typeof item === 'string' && sessionFields.has(key)) collected.sessions.add(item);
    if (typeof item === 'string' && messageFields.has(key) && !exception?.some(proof=>item===proof.id&&owner===proof.sessionID
      && (proof.paths??['record.continuationID','record.nativeContinuation.messageID','record.nativeContinuation.prompt.messageID']).includes([...route,key].join('.')))) {
      collected.messages.add(item);
      const scopes=collected.messageScopes.get(item) ?? new Set();
      scopes.add(typeof owner==='string' ? owner : null); collected.messageScopes.set(item,scopes);
    }
    if (!['input','output','body','request','metadata','text','parts'].includes(key)) references(item,collected,owner,exception,[...route,key]);
  }
};
// A native delete may commit before its Node ACK. The existing durable intent
// and staged disposition permit startup recovery; a missing row alone does not.
// A `completed` removal is history: a defect in it is reported through `report`
// and it keeps excusing only the references it can still prove.
const removedReferences = async (db,directory,sessionIDs,report) => {
  const sessions=new Set(), messages=new Set();
  const invalid=()=>{throw bundleFailure('bundle_native_removal_invalid');};
  const ids=value=>Array.isArray(value) && value.every(id=>typeof id==='string' && id.length>0)
    && new Set(value).size===value.length;
  for await (const {key,value:intent} of db.entries('native-removals')) {
    if (!isRecord(intent) || typeof intent.id!=='string' || key!==`native-removals/${changeKey(intent.id)}.json`
      || intent.directory!==directory || typeof intent.ownerID!=='string' || !intent.ownerID
      || !['preparing','committed','completed'].includes(intent.state)) invalid();
    if (intent.state==='preparing') {
      if (sessionIDs && intent.members?.some(member=>!sessionIDs.includes(member.id))) throw bundleFailure('bundle_session_reference_lost');
      continue;
    }
    const defect=()=>{if(intent.state!=='completed'||!report)invalid();report('bundle_native_removal_invalid',key);};
    if (!Array.isArray(intent.members) || !intent.members.length || intent.members.length>10000
      || !ids(intent.members.map(member=>member?.id)) || !ids(intent.removed) || !Array.isArray(intent.dispositions)
      || !ids(intent.dispositions.map(row=>row?.sessionID))) { defect(); continue; }
    const members=new Map(intent.members.map(member=>[member.id,member]));
    if (!members.has(intent.rootSessionID) || intent.removed.some(id=>!members.has(id))
      || intent.dispositions.some(row=>!members.has(row.sessionID) || !ids(row.inboxIDs) || !ids(row.pendingIDs))
      || intent.state==='completed' && intent.removed.length!==members.size) { defect(); continue; }
    for (const member of intent.members) {
      if (member.directory!==directory || !Number.isInteger(member.generation) || member.generation<0) defect();
      if (sessionIDs && !sessionIDs.includes(member.id)
        && intent.members.some(child=>child.parentID===member.id && sessionIDs.includes(child.id))) invalid();
      const seen=new Set();
      for(let current=member;current.id!==intent.rootSessionID;current=members.get(current.parentID)) {
        if(seen.has(current.id) || !members.has(current.parentID)) { defect(); break; } seen.add(current.id);
      }
      const session=await db.get(`sessions/${changeKey(member.id)}.json`), acked=intent.removed.includes(member.id);
      const disposition=intent.dispositions.find(row=>row.sessionID===member.id);
      // A child session registered by its parent's call carries no directory until it is next touched.
      if (!session || session.id!==member.id || session.directory!==undefined&&session.directory!==directory || session.generation!==member.generation
        || (session.parentID ?? null)!==(member.parentID ?? null) || session.pending
        || !session.nativeAdmission?.holds?.some(hold=>hold.removalID===intent.id && hold.ownerID===`native-removal:${intent.id}`)
        || (acked ? session.nativeRemoved!==intent.id || !disposition || session.nativeAdmission.continuations?.length
          : session.nativeRemoved!==undefined && session.nativeRemoved!==null)) defect();
      if (acked && sessionIDs?.includes(member.id)) invalid();
      if (sessionIDs && !sessionIDs.includes(member.id) && !disposition) throw bundleFailure('bundle_session_reference_lost');
      if (sessionIDs && !sessionIDs.includes(member.id) && disposition) {
        sessions.add(member.id);
        for(const id of [...disposition.inboxIDs,...disposition.pendingIDs]) messages.add(id);
      }
    }
  }
  return {sessions,messages};
};
const mapDirectory = async (directory,maps,getRegistered) => {
  if (typeof directory !== 'string') return directory;
  const mapping = maps.find(row => containsPath(row.sourceDirectory,directory));
  if (mapping) return path.join(mapping.targetDirectory,path.relative(mapping.sourceDirectory,directory));
  if (maps.some(row => containsPath(row.targetDirectory,directory))) return directory;
  if ((await getRegistered()).has(directory)) return directory;
  throw bundleFailure('bundle_harness_directory_unmapped');
};
const relocateRecord = async (record,maps,owned,getRegistered) => {
  if (Array.isArray(record)) return Promise.all(record.map(item=>relocateRecord(item,maps,owned,getRegistered)));
  if (record===null || typeof record!=='object') return record;
  if (!isRecord(record)) throw bundleFailure('bundle_harness_record_invalid');
  const next = structuredClone(record);
  for (const field of ['directory','projectDirectory']) if (typeof next[field] === 'string') next[field] = await mapDirectory(next[field],maps,getRegistered);
  for (const field of ['viewDirectory','workingDirectory','auxiliaryDirectory']) if (typeof next[field]==='string') {
    if (!owned || !containsPath(owned.source,next[field])) throw bundleFailure('bundle_execution_path_unknown');
    next[field]=path.join(owned.target,path.relative(owned.source,next[field]));
  }
  for (const [key,item] of Object.entries(next)) if (!['input','output','body','request','metadata','text','parts'].includes(key)
    && (Array.isArray(item) || isRecord(item))) next[key]=await relocateRecord(item,maps,owned,getRegistered);
  return next;
};
// Copied settings own additional projects; identity preservation never grants
// their parent, siblings, or an arbitrary directory found in a harness record.
const registeredIdentityDirectories=async(readJSON,webDataDirectory,sourceWebDataDirectory,maps)=>{
  let settings;
  try {settings=await readJSON(path.join(webDataDirectory,'settings.json'));}
  catch(error){if(error.code==='ENOENT')return new Set();throw error;}
  const projects=settings?.projects??[];
  if(!Array.isArray(projects)||projects.length>128)throw bundleFailure('bundle_harness_registered_project_invalid');
  const protectedRoots=[webDataDirectory,sourceWebDataDirectory,
    ...[webDataDirectory,sourceWebDataDirectory].filter(directory=>path.basename(directory)==='web-data').map(directory=>path.dirname(directory))];
  const registered=new Set();
  for(const project of projects){
    const directory=project?.path;
    if(typeof directory!=='string'||!path.isAbsolute(directory)||path.resolve(directory)!==directory||/[\u0000-\u001f]/.test(directory))throw bundleFailure('bundle_harness_registered_project_invalid');
    if(maps.some(row=>containsPath(row.sourceDirectory,directory)||containsPath(row.targetDirectory,directory)))continue;
    if(protectedRoots.some(root=>containsPath(root,directory)))throw bundleFailure('bundle_harness_registered_project_invalid');
    const stat=await fs.lstat(directory).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
    if(stat&&(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(directory)!==directory))throw bundleFailure('bundle_harness_registered_project_invalid');
    registered.add(directory);
  }
  return registered;
};
/** Reads/reconciles the existing stores; it never creates an execution ledger. */
export async function inspectBundleHarness(webDataDirectory,{projectMap=[],relocate=false,checkpointID='checkpoint',sessionIDs,messageIDs,
  sourceWebDataDirectory=webDataDirectory,preservedRefs,verifiedContinuations=[],nativeUsers=[],verifiedCancellations=[],archivedSessionIDs=[],windowsOwner,windowsLedgerOwner,gitRunner,nativeFiles,runWindowsInspection,storeOptions={}}={}) {
  const windows=process.platform==='win32'||windowsOwner!==undefined||nativeFiles!==undefined;
  const documentOptions={windowsOwner:windowsLedgerOwner??windowsOwner};
  const readBundleJSON=nativeFiles?.readJSON??(file=>readBundleJSONOwned(file,documentOptions)),saveBundleJSON=nativeFiles?.saveJSON??((file,value)=>saveBundleJSONOwned(file,value,documentOptions));
  const runGit=gitRunner?.git??git;
  if(windows&&!nativeFiles&&typeof windowsOwner?.tree!=='function')throw bundleFailure('private_windows_storage_authority_unavailable');
  const collected = {sessions:new Set(),messages:new Set(),messageScopes:new Map()}, refs = [];
  // Refuse only in-flight or foreign state. A defect in a terminal record or a
  // stray entry is a finding: identifiers only, reported by the caller. Moving
  // records to another directory still needs every one of them to be exact.
  const findings=[],strict=relocate&&projectMap.some(row=>row.sourceDirectory!==row.targetDirectory);
  const finding=(code,ledger,key)=>{
    if(strict)throw bundleFailure(code);
    const row={code,ledger:String(ledger).slice(0,12),key:String(key).replace(/[^A-Za-z0-9._/-]/g,'_').slice(0,160)};
    if(findings.length<256&&!findings.some(item=>item.code===row.code&&item.ledger===row.ledger&&item.key===row.key))findings.push(row);
  };
  const removed={sessions:new Set(),messages:new Set()}, verifiedFiles=new Set(),shellPins=[],tombstones=[];
  const storage = path.join(webDataDirectory,'harness','session-mutations');
  const storesToInspect=(await entries(storage)).filter(entry=>!windows||!isWindowsPrivateControlName(entry.name));
  if(windows&&!gitRunner&&storesToInspect.length){
   if(typeof runWindowsInspection!=='function')throw bundleFailure('private_windows_git_relocation_unavailable');
   return runWindowsInspection({projectMap,relocate,checkpointID,sessionIDs,messageIDs,sourceWebDataDirectory,preservedRefs,verifiedContinuations,nativeUsers,verifiedCancellations,archivedSessionIDs});
  }
  let registered;
  const getRegistered=()=>registered??=registeredIdentityDirectories(readBundleJSON,webDataDirectory,sourceWebDataDirectory,projectMap);
  for (const entry of storesToInspect) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) { finding('bundle_harness_layout_invalid','session-mutations',entry.name); continue; }
    if(windows&&relocate&&!nativeFiles)throw bundleFailure('private_windows_git_relocation_unavailable');
    const root = path.join(storage,entry.name), gitDirectory = path.join(root,'git');
    const before = (await runGit(root,['--git-dir',gitDirectory,'for-each-ref','--format=%(refname) %(objectname)'])).toString().trim().split('\n').filter(Boolean);
    const db = await openChangeStore(root,gitDirectory,{...storeOptions,gitRunner,...nativeFiles?{syncObjects:nativeFiles.deferObjectDurability}:{}});
    if (!db.exists || await db.get('materialization.json')) throw bundleFailure('bundle_materialization_pending');
    const meta = await db.get('meta.json');
    if (!meta || meta.version !== 1 || changeKey(meta.directory) !== entry.name) throw bundleFailure('bundle_harness_layout_invalid');
    const disposed=await removedReferences(db,meta.directory,sessionIDs,(code,key)=>finding(code,entry.name,key));
    for(const id of disposed.sessions) removed.sessions.add(id);
    for(const id of disposed.messages) removed.messages.add(id);
    const target=relocate?await mapDirectory(meta.directory,projectMap,getRegistered):meta.directory,
      targetRoot=path.join(storage,changeKey(target)), owned={source:path.join(sourceWebDataDirectory,'harness','session-mutations',entry.name),target:targetRoot};
    for (const ref of before) {
      const [name,oid] = ref.split(' ');
      refs.push({directory:meta.directory,ref:name,oid});
      if (relocate && /^refs\/devryan\/(state|leases\/[a-f0-9-]{36})$/.test(name)) {
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(checkpointID)) throw bundleFailure('bundle_checkpoint_invalid');
        await runGit(root,['--git-dir',gitDirectory,'update-ref',`refs/devryan/migration/${checkpointID}/${name.slice('refs/devryan/'.length)}`,oid]);
      }
    }
    const stores = [{store:db,ref:'refs/devryan/state'}];
    if (relocate) for (const ref of before) {
      const name = ref.split(' ')[0];
      if (/^refs\/devryan\/leases\/[a-f0-9-]{36}$/.test(name)) stores.push({store:await openChangeStore(root,gitDirectory,{...storeOptions,ref:name,gitRunner,...nativeFiles?{syncObjects:nativeFiles.deferObjectDurability}:{}}),ref:name});
    }
    for (const {store,ref} of stores) {
      // Native history may clip reverted turns when a later user turn commits.
      // Excuse only reference paths bound to the durable revert, selected
      // operations, their leases and the persisted later user.
      const clipped = new Map();
      if(!relocate && messageIDs) for(const proof of verifiedCancellations){
        if(!containsPath(meta.directory,proof.directory)||messageIDs.includes(proof.id))continue;
        const key=`prompts/${changeKey(`${proof.sessionID}\0${proof.id}`)}.json`,prompt=await store.get(key);
        const session=await store.get(`sessions/${changeKey(proof.sessionID)}.json`);
        if(session?.id===proof.sessionID&&session.directory===proof.directory&&prompt?.sessionID===proof.sessionID&&prompt.messageID===proof.id&&prompt.provisional!==true
          &&prompt.candidateHash===proof.payloadHash&&/^[a-f0-9]{64}$/.test(prompt.fingerprint??''))
          clipped.set(key,[{id:proof.id,sessionID:proof.sessionID,paths:['messageID']}]);
      }
      if (!relocate && messageIDs && nativeUsers.length) {
        const prompts = [];
        for await (const row of store.entries('prompts')) prompts.push(row);
        for await (const { key: transactionKey, value: tx } of store.entries('transactions')) {
          if (!tx || tx.kind !== undefined || tx.state !== 'committed' || tx.phase !== 'committed' || tx.redo !== false
            || !['tree','session'].includes(tx.scope) || !Number.isSafeInteger(tx.boundarySequence)
            || keyForTransaction(tx.id) !== transactionKey || !Array.isArray(tx.members) || !tx.members.includes(tx.rootSessionID)
            || new Set(tx.members).size!==tx.members.length || !Array.isArray(tx.targets) || !tx.targets.length
            || new Set(tx.targets.map(target=>target?.id)).size!==tx.targets.length
            || tx.targets.some(target=>!tx.members.includes(target?.id)||typeof target.targetMessageID!=='string')
            || !Array.isArray(tx.boundaries) || tx.boundaries.length!==tx.targets.length
            || tx.boundaries.some((boundary,index)=>boundary?.id!==tx.targets[index].id||boundary.revert!==null)
            || !Array.isArray(tx.result?.files) || !Array.isArray(tx.result?.sessions)
            || tx.result.redoAvailable !== true || canonicalJSON(tx.result.sessions)!==canonicalJSON(tx.targets)) continue;
          const targetIndex=tx.targets.findIndex(target=>target.id===tx.rootSessionID);
          if(targetIndex<0)continue;
          let membershipValid=true;
          for(const id of tx.members){
            const seen=new Set();let member=await store.get(`sessions/${changeKey(id)}.json`);
            if(!member||member.id!==id){membershipValid=false;break;}
            while(member.id!==tx.rootSessionID){
              if(seen.has(member.id)||typeof member.parentID!=='string'||!tx.members.includes(member.parentID)){membershipValid=false;break;}
              seen.add(member.id);member=await store.get(`sessions/${changeKey(member.parentID)}.json`);
              if(!member){membershipValid=false;break;}
            }
            if(!membershipValid)break;
          }
          if(!membershipValid)continue;
          const old = prompts.find(row => row.value?.sessionID === tx.rootSessionID && row.value.messageID === tx.targets[targetIndex].targetMessageID
            && row.value.sequence === tx.boundarySequence && row.value.reverted === true && row.value.provisional !== true
            && /^[a-f0-9]{64}$/.test(row.value.fingerprint ?? '') && /^[a-f0-9]{64}$/.test(row.value.candidateHash ?? '')
            && row.key === `prompts/${changeKey(`${row.value.sessionID}\0${row.value.messageID}`)}.json`);
          if (!old || messageIDs.includes(old.value.messageID)) continue;
          const later = prompts.some(row => row.value?.sessionID === tx.rootSessionID && row.value.provisional !== true
            && row.value.reverted !== true && Number.isSafeInteger(row.value.sequence) && row.value.sequence > tx.boundarySequence
            && /^[a-f0-9]{64}$/.test(row.value.fingerprint ?? '') && /^[a-f0-9]{64}$/.test(row.value.candidateHash ?? '')
            && row.key === `prompts/${changeKey(`${row.value.sessionID}\0${row.value.messageID}`)}.json`
            && nativeUsers.some(user => user.id === row.value.messageID && user.sessionID === tx.rootSessionID
              && user.fingerprint === row.value.fingerprint && messageIDs.includes(user.id)));
          if (!later) continue;
          // A writer's transcript IDs are retained in both the selected
          // operation and its published lease. The transaction's exact list,
          // call pointer and canonical prompt bind every exception to the
          // committed revert; a missing or foreign join leaves it unavailable.
          const selected=[];
          for await (const id of store.list(`transactions/${tx.id}/operations`)) selected.push(id);
          if(tx.result.files.length && !selected.length) continue;
          const owned=[];let valid=true;
          for(const id of selected){
            const operationKey=`operations/${changeKey(id)}.json`,operation=await store.get(operationKey),scope=operation?.scope;
            const owner=prompts.find(row=>row.value?.sessionID===scope?.sessionID&&row.value.messageID===scope?.userMessageID
              &&row.value.reverted===true&&row.value.provisional!==true&&row.value.sequence===operation.promptSequence
              &&(row.value.origins?.[tx.rootSessionID]??row.value.sequence)>=tx.boundarySequence&&/^[a-f0-9]{64}$/.test(row.value.fingerprint??'')
              &&/^[a-f0-9]{64}$/.test(row.value.candidateHash??'')&&row.key===`prompts/${changeKey(`${scope.sessionID}\0${row.value.messageID}`)}.json`);
            if(!operation||operation.id!==id||operation.active!==false||!tx.members.includes(scope?.sessionID)||!owner
              ||(operation.origins?.[tx.rootSessionID]??operation.sequence)<tx.boundarySequence
              ||!Number.isSafeInteger(operation.sequence)||operation.sequence<=operation.promptSequence
              ||typeof scope.callID!=='string'||typeof scope.messageID!=='string'||typeof scope.userMessageID!=='string'){valid=false;break;}
            const callKey=`calls/${changeKey(`${scope.sessionID}\0${scope.callID}`)}.json`;
            const pointer=await store.get(callKey);
            const effectScope=Object.fromEntries(['sessionID','messageID','userMessageID','callID'].map(field=>[field,scope[field]]));
            if((pointer?.effect===undefined)!==(pointer?.effectScope===undefined)
              ||pointer?.effectScope!==undefined&&canonicalJSON(pointer.effectScope)!==canonicalJSON(effectScope)){valid=false;break;}
            const leaseKey=typeof pointer?.token==='string'?`leases/${changeKey(pointer.token)}.json`:null;
            const lease=leaseKey?await store.get(leaseKey):null;
            if(!lease||lease.token!==pointer.token||lease.state!=='published'||lease.cleanupPending
              ||lease.result?.operationID!==id||lease.result?.sequence!==operation.sequence||lease.promptSequence!==operation.promptSequence
              ||canonicalJSON(lease.scope)!==canonicalJSON(scope)){valid=false;break;}
            owned.push({operationKey,leaseKey,callKey,scope,owner,effectScope:pointer.effectScope});
          }
          if(!valid)continue;
          const proof = { id:old.value.messageID,sessionID:tx.rootSessionID };
          clipped.set(old.key,[{...proof,paths:['messageID']}]);
          clipped.set(transactionKey,[{...proof,sessionID:null,paths:[`targets.${targetIndex}.targetMessageID`,`result.sessions.${targetIndex}.targetMessageID`]}]);
          for(const {operationKey,leaseKey,callKey,scope,owner,effectScope} of owned){
            if(scope.sessionID!==tx.rootSessionID)continue;
            const records=[{id:scope.userMessageID,sessionID:scope.sessionID,paths:['scope.userMessageID']},
              {id:scope.messageID,sessionID:scope.sessionID,paths:['scope.messageID']}];
            clipped.set(operationKey,records);clipped.set(leaseKey,records);
            if(effectScope)clipped.set(callKey,[{id:scope.userMessageID,sessionID:scope.sessionID,paths:['effectScope.userMessageID']},
              {id:scope.messageID,sessionID:scope.sessionID,paths:['effectScope.messageID']}]);
            if(!messageIDs.includes(owner.value.messageID))clipped.set(owner.key,[{id:owner.value.messageID,sessionID:scope.sessionID,paths:['messageID']}]);
          }
        }
      }
      // Per-file content records (documents, revisions, text runs, lease
      // bases) name operations and paths, never sessions or messages, and no
      // check below reads them; on a 13k-file project they were three
      // quarters of a startup scan (4.3 s for three ledgers). Relocation
      // rewrites every record, so it still reads all of them.
      for await (const {key,value:record} of store.records(undefined, relocate ? {} : { include: key => !PER_FILE_RECORD.test(key) })) {
        if (key.startsWith('transactions/') && record.state === 'prepared') throw bundleFailure('migration_revert_pending');
        if (key.startsWith('sessions/') && record.pending) throw bundleFailure('migration_revert_pending');
        if (key.startsWith('leases/') && (!['published','cancelled'].includes(record.state) || record.cleanupPending)) throw bundleFailure('bundle_execution_unsettled');
        let shellException, promptException;
        if (key.startsWith('prompts/') && record.provisional !== undefined) {
          const fields = ['sessionID','messageID','sequence','origins','provisional','parentID','fingerprint','candidateHash'];
          const validID = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,1024}$/.test(value);
          const session = validID(record.sessionID) ? await store.get(`sessions/${changeKey(record.sessionID)}.json`) : null;
          if (record.provisional !== true || Object.keys(record).some(field => !fields.includes(field))
            || !validID(record.messageID) || key !== `prompts/${changeKey(`${record.sessionID}\0${record.messageID}`)}.json`
            || !Number.isSafeInteger(record.sequence) || record.sequence < 1 || record.sequence > meta.sequence
            || !isRecord(record.origins) || Object.entries(record.origins).some(([id,sequence]) => !validID(id) || !Number.isSafeInteger(sequence) || sequence < 0 || sequence > record.sequence)
            || !/^[a-f0-9]{64}$/.test(record.fingerprint ?? '') || !/^[a-f0-9]{64}$/.test(record.candidateHash ?? '')
            || !session || session.id !== record.sessionID || typeof session.directory !== 'string' || !containsPath(meta.directory,session.directory)
            || (session.parentID ?? null) !== record.parentID) throw bundleFailure('bundle_harness_record_invalid');
          const ancestors = new Set();
          for (let id = record.parentID; id;) {
            if (ancestors.has(id)) throw bundleFailure('bundle_harness_record_invalid');
            ancestors.add(id);
            const parent = await store.get(`sessions/${changeKey(id)}.json`);
            if (!parent || parent.id !== id) throw bundleFailure('bundle_harness_record_invalid');
            id = parent.parentID ?? null;
          }
          if (Object.keys(record.origins).some(id => !ancestors.has(id))) throw bundleFailure('bundle_harness_record_invalid');
          // A reservation alone is not a message or permission to execute.
          promptException = [{ id:record.messageID,sessionID:record.sessionID,paths:['messageID'] }];
        } else if (!relocate && key.startsWith('prompts/') && /^[a-f0-9]{64}$/.test(record.fingerprint ?? '')
          && /^[a-f0-9]{64}$/.test(record.candidateHash ?? '') && key === `prompts/${changeKey(`${record.sessionID}\0${record.messageID}`)}.json`) {
          const session = await store.get(`sessions/${changeKey(record.sessionID)}.json`);
          const proof = verifiedContinuations.find(item => /^[a-f0-9]{64}$/.test(item.inboxSha256 ?? '') && item.id === record.messageID
            && session?.id === record.sessionID && typeof session.directory === 'string' && item.sessionID === record.sessionID
            && item.directory === session.directory && containsPath(meta.directory,session.directory) && item.itemProof?.type === 'user'
            && item.itemProof.hash === record.candidateHash && item.admissionFingerprint === record.fingerprint);
          if (proof) promptException = [{ ...proof, paths:['messageID'] }];
        }
        // The lease is already terminal here, so its evidence is history.
        const leaseEvidence=key.startsWith('leases/')&&(record.rebootRecovery&&!isRebootRecoveredLease(record)?'bundle_execution_unsettled'
          :(isRebootRecoveredLease(record)||record.executionKind==='process'&&!record.cancelledBeforeStart)
            &&(typeof record.viewDirectory!=='string'||!containsPath(owned.source,record.viewDirectory))?'bundle_execution_path_unknown':null);
        if (leaseEvidence) finding(leaseEvidence,entry.name,key);
        else if (key.startsWith('leases/') && record.executionKind==='process' && !record.cancelledBeforeStart && !isRebootRecoveredLease(record)) {
          const file=path.join(root,path.relative(owned.source,path.dirname(record.viewDirectory)),'termination.json');
          const receipt=await readBundleJSON(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
          if (!isRecord(receipt) || receipt.terminated!==true || receipt.confined!==true || !Number.isInteger(receipt.exitCode)
            || typeof receipt.cancelled!=='boolean') finding('bundle_execution_unsettled',entry.name,key);
          else {
          const session=await store.get(`sessions/${changeKey(record.scope?.sessionID??'')}.json`),shell=record.nativeShellJob;
          const pending=verifiedContinuations.find(proof=>proof.inboxSha256!==null&&proof.sessionID===record.scope?.sessionID&&proof.directory===meta.directory
            &&proof.id===shell?.notificationID&&proof.itemProof?.type==='synthetic'&&proof.itemProof.hash===shell.itemHash&&proof.itemProof.delivery===shell.itemDelivery);
          if(!relocate&&pending&&session&&!session.pending&&session.generation===record.generation&&record.directory===meta.directory
            &&Number.isSafeInteger(record.generation)&&record.generation>=0&&typeof shell.itemHash==='string'&&/^[a-f0-9]{64}$/.test(shell.itemHash)
            &&(shell.deliveredID===undefined||shell.deliveredID===shell.notificationID)&&['queue','steer'].includes(shell.itemDelivery)){shellException=[{...pending,paths:['nativeShellJob.notificationID']}];
            shellPins.push({root,gitDirectory,ref,key,sessionKey:`sessions/${changeKey(record.scope.sessionID)}.json`,file,recordHash:sha256(canonicalJSON(record)),sessionHash:sha256(canonicalJSON(session)),receiptHash:sha256(canonicalJSON(receipt))});
          }
          }
        }
        // A cancelled shell run never delivers its completion notice, so the
        // message ID it reserved for that notice is reported, not required.
        // A notice OpenCode accepted into an archived session's inbox never
        // becomes a message either: a clone leaves exactly that row behind.
        const cancelledShell=record.nativeShellJob;
        if (!shellException && record.state==='cancelled' && isRecord(cancelledShell) && typeof cancelledShell.notificationID==='string'
          && typeof record.scope?.sessionID==='string' && (cancelledShell.deliveredID===undefined
            || cancelledShell.deliveredID===cancelledShell.notificationID && archivedSessionIDs.includes(record.scope.sessionID)
              && Array.isArray(messageIDs) && !messageIDs.includes(cancelledShell.notificationID))) {
          finding('bundle_shell_notice_undelivered',entry.name,key);
          shellException=[{id:cancelledShell.notificationID,sessionID:record.scope.sessionID,paths:['nativeShellJob.notificationID']}];
        }
        // A cancelled-call marker only blocks a late start of that call. It is
        // history, so a message or session it names that is gone is reported.
        if (key.startsWith('cancelled-calls/')) {
          const named={sessions:new Set(),messages:new Set(),messageScopes:new Map()};
          references(record,named);
          tombstones.push({ledger:entry.name,key,named});
        } else references(record,collected,null,promptException ?? shellException ?? clipped.get(key));
        if (relocate) store.set(key,await relocateRecord(record,projectMap,owned,getRegistered));
      }
      if (relocate) await store.commit();
    }
    if (relocate) {
      if (targetRoot !== root) {
        try { await fs.lstat(targetRoot); throw bundleFailure('bundle_harness_relocation_conflict'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if(nativeFiles)await nativeFiles.renameDirectory(root,targetRoot);else if(windows)await windowsOwner.renameTree(root,targetRoot,await windowsOwner.tree(root));else await fs.rename(root,targetRoot);
      }
    }
  }
  if (preservedRefs) for (const expected of preservedRefs.refs) {
    const directory=await mapDirectory(expected.directory,projectMap,getRegistered), root=path.join(storage,changeKey(directory));
    const ref=/^refs\/devryan\/(state|leases\/[a-f0-9-]{36})$/.test(expected.ref)
      ? `refs/devryan/migration/${preservedRefs.checkpointID}/${expected.ref.slice('refs/devryan/'.length)}`:expected.ref;
    const oid=(await runGit(root,['--git-dir',path.join(root,'git'),'rev-parse','--verify',ref])).toString().trim();
    if (oid!==expected.oid) throw bundleFailure('bundle_harness_reference_lost');
  }
  for (const directory of ['provider-recovery','provider-stream','context']) for (const entry of await entries(path.join(webDataDirectory,'harness',directory))) {
    if(windows&&isWindowsPrivateControlName(entry.name))continue;
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(webDataDirectory,'harness',directory,entry.name);
    const exception=!relocate && directory==='provider-recovery' ? verifiedContinuations.filter(proof=>proof.file===file) : [];
    const loaded=exception.length ? await readBundleRecoveryEnvelope(file,{windowsOwner:nativeFiles?{read:async file=>({bytes:await nativeFiles.readEnvelope(file)})}:windowsOwner}) : undefined;
    if (exception.length) {
      if (exception.some(proof=>loaded.sha256!==proof.fileSha256) || verifiedFiles.has(file)) throw bundleFailure('bundle_message_reference_lost');
      verifiedFiles.add(file);
    }
    const record=loaded?.envelope ?? await readBundleJSON(file);
    if (!isRecord(record)) throw bundleFailure('bundle_harness_record_invalid');
    references(record,collected,null,exception);
    if (relocate) {
      const next = await relocateRecord(record,projectMap,undefined,getRegistered);
      if (directory === 'context' && record.kind === 'task') {
        // Derived task keys include the canonical directory. Without an exact
        // source scope, leave the candidate closed instead of losing its cache.
        let sourceScope = projectMap.find(row => entry.name === `task_${sha256(`${record.sessionID}:${row.sourceDirectory}`)}.json`);
        if(!sourceScope)sourceScope=[...await getRegistered()].map(directory=>({sourceDirectory:directory,targetDirectory:directory}))
          .find(row => entry.name === `task_${sha256(`${record.sessionID}:${row.sourceDirectory}`)}.json`);
        if (!sourceScope) throw bundleFailure('bundle_context_scope_unknown');
        const targetFile = path.join(path.dirname(file),`task_${sha256(`${record.sessionID}:${sourceScope.targetDirectory}`)}.json`);
        const previous=windows&&!nativeFiles?await windowsOwner.read(file):undefined;await saveBundleJSON(targetFile,next); if (targetFile !== file){if(nativeFiles)await nativeFiles.deleteFile(file);else if(windows)await windowsOwner.delete(file,{expected:previous});else await fs.rm(file);}
      } else await saveBundleJSON(file,next);
    }
  }
  for(const pin of shellPins){try{const current=await openChangeStore(pin.root,pin.gitDirectory,{...storeOptions,ref:pin.ref,gitRunner,...nativeFiles?{syncObjects:nativeFiles.deferObjectDurability}:{}}),record=await current.get(pin.key),session=await current.get(pin.sessionKey);
    if(!record||!session||sha256(canonicalJSON(record))!==pin.recordHash||sha256(canonicalJSON(session))!==pin.sessionHash
      ||sha256(canonicalJSON(await readBundleJSON(pin.file)))!==pin.receiptHash)throw bundleFailure('migration_pending_input_unsupported');
  }catch{throw bundleFailure('migration_pending_input_unsupported');}}
  if (verifiedFiles.size!==new Set(verifiedContinuations.map(proof=>proof.file).filter(Boolean)).size) throw bundleFailure('bundle_message_reference_lost');
  const ledgerFile = path.join(webDataDirectory,'orchestration','ledger.json');
  try {
    const ledger = await readBundleJSON(ledgerFile);
    if (!isRecord(ledger) || !Array.isArray(ledger.tasks)) throw bundleFailure('bundle_task_ledger_invalid');
    for (const task of ledger.tasks) {
      if (!isRecord(task) || ['starting','running','cancelling'].includes(task.status)) throw bundleFailure('bundle_task_unsettled');
      // A task's messages belong to its child session. A finished task is
      // history, so a session or message it names that is gone is reported.
      const owner=typeof task.childSessionId==='string' ? task.childSessionId : null;
      if (isTerminalManagedTaskStatus(task.status)) {
        const named={sessions:new Set(),messages:new Set(),messageScopes:new Map()};
        references(task,named,owner);
        tombstones.push({ledger:'orchestration',key:`tasks/${task.taskId}`,named});
      } else references(task,collected,owner);
    }
    if (relocate) await saveBundleJSON(ledgerFile,{...ledger,tasks:await Promise.all(ledger.tasks.map(task => relocateRecord(task,projectMap,undefined,getRegistered)))});
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const entry of await entries(path.join(webDataDirectory,'harness','evidence','records'))) {
    if(windows&&isWindowsPrivateControlName(entry.name))continue;
    if (!entry.isFile() || !entry.name.endsWith('.json')) { finding('bundle_evidence_layout_invalid','evidence',entry.name); continue; }
    const file=path.join(webDataDirectory,'harness','evidence','records',entry.name),record=await readBundleJSON(file);
    if (!isRecord(record) || !['complete','gap'].includes(record.status)) finding('bundle_evidence_unsettled','evidence',entry.name);
    if (!isRecord(record)) continue;
    // Settled evidence is history, like a finished task: a session or message
    // it names that was later deleted is reported, not a reason to refuse launch.
    if (['complete','gap'].includes(record.status)) {
      const named={sessions:new Set(),messages:new Set(),messageScopes:new Map()};
      references(record,named);
      tombstones.push({ledger:'evidence',key:entry.name,named});
    } else references(record,collected);
    if (relocate) await saveBundleJSON(file,await relocateRecord(record,projectMap,undefined,getRegistered));
  }
  if (sessionIDs) for (const id of collected.sessions) if (!sessionIDs.includes(id) && !removed.sessions.has(id)) throw bundleFailure('bundle_session_reference_lost');
  if (messageIDs) for (const id of collected.messages) if (!messageIDs.includes(id)
    && ![...collected.messageScopes.get(id)].every(owner=>owner===null ? removed.messages.has(id) : removed.sessions.has(owner))) throw bundleFailure('bundle_message_reference_lost');
  for (const {ledger,key,named} of tombstones) {
    if (sessionIDs && [...named.sessions].some(id=>!sessionIDs.includes(id) && !removed.sessions.has(id))) finding('bundle_session_reference_lost',ledger,key);
    if (messageIDs && [...named.messages].some(id=>!messageIDs.includes(id)
      && ![...named.messageScopes.get(id)].every(owner=>owner===null ? removed.messages.has(id) : removed.sessions.has(owner)))) finding('bundle_message_reference_lost',ledger,key);
  }
  return {refs,sessionReferences:[...collected.sessions].sort(),messageReferences:[...collected.messages].sort(),findings};
}
