import {isWindowsPrivateControlName} from '../../../../../harness-runtime/lib/windows-private-files.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readBundleRecoveryEnvelope } from './bundle-owned-continuations.js';
import { git } from '../../../../../harness-runtime/lib/session-changes-git.js';
import { openChangeStore, changeKey } from '../../../../../harness-runtime/lib/session-changes-store.js';
import { bundleFailure, containsPath, isRecord, readBundleJSON as readBundleJSONOwned, saveBundleJSON as saveBundleJSONOwned, sha256, canonicalJSON } from './bundle-migration-inventory.js';

const entries = async directory => fs.readdir(directory,{withFileTypes:true}).catch(error => {
  if (error.code === 'ENOENT') return []; throw error;
});
const sessionFields = new Set(['sessionID','sessionId','rootSessionId','parentSessionId','childSessionId','sourceSessionId']);
const messageFields = new Set(['messageID','messageId','userMessageID','assistantMessageID','anchorID','activeUserID','stepID','failedID','recoveryID','continuationID','sourceMessageId','targetMessageID','boundaryMessageID','notificationID','turnID']);
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
const removedReferences = async (db,directory,sessionIDs) => {
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
    if (!Array.isArray(intent.members) || !intent.members.length || intent.members.length>10000
      || !ids(intent.members.map(member=>member?.id)) || !ids(intent.removed) || !Array.isArray(intent.dispositions)
      || !ids(intent.dispositions.map(row=>row?.sessionID))) invalid();
    const members=new Map(intent.members.map(member=>[member.id,member]));
    if (!members.has(intent.rootSessionID) || intent.removed.some(id=>!members.has(id))
      || intent.dispositions.some(row=>!members.has(row.sessionID) || !ids(row.inboxIDs) || !ids(row.pendingIDs))
      || intent.state==='completed' && intent.removed.length!==members.size) invalid();
    for (const member of intent.members) {
      if (member.directory!==directory || !Number.isInteger(member.generation) || member.generation<0) invalid();
      if (sessionIDs && !sessionIDs.includes(member.id)
        && intent.members.some(child=>child.parentID===member.id && sessionIDs.includes(child.id))) invalid();
      const seen=new Set();
      for(let current=member;current.id!==intent.rootSessionID;current=members.get(current.parentID)) {
        if(seen.has(current.id) || !members.has(current.parentID)) invalid(); seen.add(current.id);
      }
      const session=await db.get(`sessions/${changeKey(member.id)}.json`), acked=intent.removed.includes(member.id);
      const disposition=intent.dispositions.find(row=>row.sessionID===member.id);
      if (!session || session.id!==member.id || session.directory!==directory || session.generation!==member.generation
        || (session.parentID ?? null)!==(member.parentID ?? null) || session.pending
        || !session.nativeAdmission?.holds?.some(hold=>hold.removalID===intent.id && hold.ownerID===`native-removal:${intent.id}`)
        || (acked ? session.nativeRemoved!==intent.id || !disposition || session.nativeAdmission.continuations?.length
          : session.nativeRemoved!==undefined && session.nativeRemoved!==null)) invalid();
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
const mapDirectory = (directory,maps) => {
  if (typeof directory !== 'string') return directory;
  const mapping = maps.find(row => containsPath(row.sourceDirectory,directory));
  if (mapping) return path.join(mapping.targetDirectory,path.relative(mapping.sourceDirectory,directory));
  if (maps.some(row => containsPath(row.targetDirectory,directory))) return directory;
  throw bundleFailure('bundle_harness_directory_unmapped');
};
const relocateRecord = (record,maps,owned) => {
  if (Array.isArray(record)) return record.map(item=>relocateRecord(item,maps,owned));
  if (record===null || typeof record!=='object') return record;
  if (!isRecord(record)) throw bundleFailure('bundle_harness_record_invalid');
  const next = structuredClone(record);
  for (const field of ['directory','projectDirectory']) if (typeof next[field] === 'string') next[field] = mapDirectory(next[field],maps);
  for (const field of ['viewDirectory','workingDirectory','auxiliaryDirectory']) if (typeof next[field]==='string') {
    if (!owned || !containsPath(owned.source,next[field])) throw bundleFailure('bundle_execution_path_unknown');
    next[field]=path.join(owned.target,path.relative(owned.source,next[field]));
  }
  for (const [key,item] of Object.entries(next)) if (!['input','output','body','request','metadata','text','parts'].includes(key)
    && (Array.isArray(item) || isRecord(item))) next[key]=relocateRecord(item,maps,owned);
  return next;
};
/** Reads/reconciles the existing stores; it never creates an execution ledger. */
export async function inspectBundleHarness(webDataDirectory,{projectMap=[],relocate=false,checkpointID='checkpoint',sessionIDs,messageIDs,
  sourceWebDataDirectory=webDataDirectory,preservedRefs,verifiedContinuations=[],windowsOwner,windowsLedgerOwner,gitRunner,nativeFiles,runWindowsInspection}={}) {
  const windows=process.platform==='win32'||windowsOwner!==undefined||nativeFiles!==undefined;
  const documentOptions={windowsOwner:windowsLedgerOwner??windowsOwner};
  const readBundleJSON=nativeFiles?.readJSON??(file=>readBundleJSONOwned(file,documentOptions)),saveBundleJSON=nativeFiles?.saveJSON??((file,value)=>saveBundleJSONOwned(file,value,documentOptions));
  const runGit=gitRunner?.git??git;
  if(windows&&!nativeFiles&&typeof windowsOwner?.tree!=='function')throw bundleFailure('private_windows_storage_authority_unavailable');
  const collected = {sessions:new Set(),messages:new Set(),messageScopes:new Map()}, refs = [];
  const removed={sessions:new Set(),messages:new Set()}, verifiedFiles=new Set(),shellPins=[];
  const storage = path.join(webDataDirectory,'harness','session-mutations');
  const storesToInspect=(await entries(storage)).filter(entry=>!windows||!isWindowsPrivateControlName(entry.name));
  if(windows&&!gitRunner&&storesToInspect.length){
   if(typeof runWindowsInspection!=='function')throw bundleFailure('private_windows_git_relocation_unavailable');
   return runWindowsInspection({projectMap,relocate,checkpointID,sessionIDs,messageIDs,sourceWebDataDirectory,preservedRefs,verifiedContinuations});
  }
  for (const entry of storesToInspect) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) throw bundleFailure('bundle_harness_layout_invalid');
    if(windows&&relocate&&!nativeFiles)throw bundleFailure('private_windows_git_relocation_unavailable');
    const root = path.join(storage,entry.name), gitDirectory = path.join(root,'git');
    const before = (await runGit(root,['--git-dir',gitDirectory,'for-each-ref','--format=%(refname) %(objectname)'])).toString().trim().split('\n').filter(Boolean);
    const db = await openChangeStore(root,gitDirectory,{gitRunner,...nativeFiles?{syncObjects:nativeFiles.deferObjectDurability}:{}});
    if (!db.exists || await db.get('materialization.json')) throw bundleFailure('bundle_materialization_pending');
    const meta = await db.get('meta.json');
    if (!meta || meta.version !== 1 || changeKey(meta.directory) !== entry.name) throw bundleFailure('bundle_harness_layout_invalid');
    const disposed=await removedReferences(db,meta.directory,sessionIDs);
    for(const id of disposed.sessions) removed.sessions.add(id);
    for(const id of disposed.messages) removed.messages.add(id);
    const target=relocate?mapDirectory(meta.directory,projectMap):meta.directory,
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
      if (/^refs\/devryan\/leases\/[a-f0-9-]{36}$/.test(name)) stores.push({store:await openChangeStore(root,gitDirectory,{ref:name,gitRunner,...nativeFiles?{syncObjects:nativeFiles.deferObjectDurability}:{}}),ref:name});
    }
    for (const {store,ref} of stores) {
      for await (const {key,value:record} of store.records()) {
        if (key.startsWith('transactions/') && record.state === 'prepared') throw bundleFailure('migration_revert_pending');
        if (key.startsWith('sessions/') && record.pending) throw bundleFailure('migration_revert_pending');
        if (key.startsWith('leases/') && (!['published','cancelled'].includes(record.state) || record.cleanupPending)) throw bundleFailure('bundle_execution_unsettled');
        let shellException;
        if (key.startsWith('leases/') && record.executionKind==='process' && !record.cancelledBeforeStart) {
          if (typeof record.viewDirectory!=='string' || !containsPath(owned.source,record.viewDirectory)) throw bundleFailure('bundle_execution_path_unknown');
          const file=path.join(root,path.relative(owned.source,path.dirname(record.viewDirectory)),'termination.json'), receipt=await readBundleJSON(file);
          if (!isRecord(receipt) || receipt.terminated!==true || receipt.confined!==true || !Number.isInteger(receipt.exitCode)
            || typeof receipt.cancelled!=='boolean') throw bundleFailure('bundle_execution_unsettled');
          const session=await store.get(`sessions/${changeKey(record.scope?.sessionID??'')}.json`),shell=record.nativeShellJob;
          const pending=verifiedContinuations.find(proof=>proof.inboxSha256!==null&&proof.sessionID===record.scope?.sessionID&&proof.directory===meta.directory
            &&proof.id===shell?.notificationID&&proof.itemProof?.type==='synthetic'&&proof.itemProof.hash===shell.itemHash&&proof.itemProof.delivery===shell.itemDelivery);
          if(!relocate&&pending&&session&&!session.pending&&session.generation===record.generation&&record.directory===meta.directory
            &&Number.isSafeInteger(record.generation)&&record.generation>=0&&typeof shell.itemHash==='string'&&/^[a-f0-9]{64}$/.test(shell.itemHash)
            &&(shell.deliveredID===undefined||shell.deliveredID===shell.notificationID)&&['queue','steer'].includes(shell.itemDelivery)){shellException=[{...pending,paths:['nativeShellJob.notificationID']}];
            shellPins.push({root,gitDirectory,ref,key,sessionKey:`sessions/${changeKey(record.scope.sessionID)}.json`,file,recordHash:sha256(canonicalJSON(record)),sessionHash:sha256(canonicalJSON(session)),receiptHash:sha256(canonicalJSON(receipt))});
          }
        }
        references(record,collected,null,shellException);
        if (relocate) store.set(key,relocateRecord(record,projectMap,owned));
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
    const directory=mapDirectory(expected.directory,projectMap), root=path.join(storage,changeKey(directory));
    const ref=/^refs\/devryan\/(state|leases\/[a-f0-9-]{36})$/.test(expected.ref)
      ? `refs/devryan/migration/${preservedRefs.checkpointID}/${expected.ref.slice('refs/devryan/'.length)}`:expected.ref;
    const oid=(await runGit(root,['--git-dir',path.join(root,'git'),'rev-parse','--verify',ref])).toString().trim();
    if (oid!==expected.oid) throw bundleFailure('bundle_harness_reference_lost');
  }
  for (const directory of ['provider-recovery','context']) for (const entry of await entries(path.join(webDataDirectory,'harness',directory))) {
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
      const next = relocateRecord(record,projectMap);
      if (directory === 'context' && record.kind === 'task') {
        // Derived task keys include the canonical directory. Without an exact
        // source scope, leave the candidate closed instead of losing its cache.
        const sourceScope = projectMap.find(row => entry.name === `task_${sha256(`${record.sessionID}:${row.sourceDirectory}`)}.json`);
        if (!sourceScope) throw bundleFailure('bundle_context_scope_unknown');
        const targetFile = path.join(path.dirname(file),`task_${sha256(`${record.sessionID}:${sourceScope.targetDirectory}`)}.json`);
        const previous=windows&&!nativeFiles?await windowsOwner.read(file):undefined;await saveBundleJSON(targetFile,next); if (targetFile !== file){if(nativeFiles)await nativeFiles.deleteFile(file);else if(windows)await windowsOwner.delete(file,{expected:previous});else await fs.rm(file);}
      } else await saveBundleJSON(file,next);
    }
  }
  for(const pin of shellPins){try{const current=await openChangeStore(pin.root,pin.gitDirectory,{ref:pin.ref,gitRunner,...nativeFiles?{syncObjects:nativeFiles.deferObjectDurability}:{}}),record=await current.get(pin.key),session=await current.get(pin.sessionKey);
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
      references(task,collected);
    }
    if (relocate) await saveBundleJSON(ledgerFile,{...ledger,tasks:ledger.tasks.map(task => relocateRecord(task,projectMap))});
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const entry of await entries(path.join(webDataDirectory,'harness','evidence','records'))) {
    if(windows&&isWindowsPrivateControlName(entry.name))continue;
    if (!entry.isFile() || !entry.name.endsWith('.json')) throw bundleFailure('bundle_evidence_layout_invalid');
    const file=path.join(webDataDirectory,'harness','evidence','records',entry.name),record=await readBundleJSON(file);
    if (!isRecord(record) || !['complete','gap'].includes(record.status)) throw bundleFailure('bundle_evidence_unsettled');
    references(record,collected);
    if (relocate) await saveBundleJSON(file,relocateRecord(record,projectMap));
  }
  if (sessionIDs) for (const id of collected.sessions) if (!sessionIDs.includes(id) && !removed.sessions.has(id)) throw bundleFailure('bundle_session_reference_lost');
  if (messageIDs) for (const id of collected.messages) if (!messageIDs.includes(id)
    && ![...collected.messageScopes.get(id)].every(owner=>owner===null ? removed.messages.has(id) : removed.sessions.has(owner))) throw bundleFailure('bundle_message_reference_lost');
  return {refs,sessionReferences:[...collected.sessions].sort(),messageReferences:[...collected.messages].sort()};
}
