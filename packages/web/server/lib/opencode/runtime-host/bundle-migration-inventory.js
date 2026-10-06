import {recoveredInputHash} from './native-recovered-input-hash.js';
import {nativeInputCancellation} from './native-input-cancellation.js';
import {BUNDLE_DOCUMENT_MAX_BYTES} from './bundle-document-limits.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { toV2PermissionRuleset } from '../v2/admission.js';
import { writeFileAtomic } from '../../../../../harness-runtime/lib/atomic-file.js';

export const bundleFailure = (code) => Object.assign(new Error(code), { code, status: 409 });
export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const canonicalJSON = value => JSON.stringify(value, (_key, item) => isRecord(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const containsPath = (root, value) => value === root || value.startsWith(root + path.sep);
export const saveBundleJSON = async (file, value, options={}) => {
  const bytes = canonicalJSON(value) + '\n';
  if (Buffer.byteLength(bytes)>BUNDLE_DOCUMENT_MAX_BYTES) throw bundleFailure('bundle_document_too_large');
  await writeFileAtomic(file, bytes, { mode: 0o600, directoryMode: 0o700, windowsOwner:options.windowsOwner });
  return sha256(bytes);
};
export const readBundleJSON = async (file,options={}) => {
  if(process.platform==='win32'){
    if(typeof options.windowsOwner?.read!=='function')throw bundleFailure('private_windows_read_authority_unavailable');
    const {bytes}=await options.windowsOwner.read(file);
    if(bytes.length>BUNDLE_DOCUMENT_MAX_BYTES)throw bundleFailure('bundle_document_invalid');
    return JSON.parse(bytes.toString('utf8'));
  }
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BUNDLE_DOCUMENT_MAX_BYTES) throw bundleFailure('bundle_document_invalid');
  return JSON.parse(await fs.readFile(file, 'utf8'));
};
const text = value => { if (typeof value !== 'string' || !value) throw bundleFailure('migration_source_invalid'); return value; };
const parse = value => value === null || value === undefined ? null : JSON.parse(text(value));
const table = (db, name) => db.all('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=?', [name]).length > 0;
export const hasMigrationTable = table;
export const migrationMarker = db => {
  if (!table(db, 'kv')) return null;
  const rows = db.all('SELECT value FROM kv WHERE key=?', ['migration.v1-v2']);
  if (!rows.length) return null;
  let value;
  try { value=parse(rows[0].value); } catch { throw bundleFailure('migration_marker_invalid'); }
  if (!isRecord(value) || !['sessions', 'completed'].includes(value.phase)
    || Object.keys(value).some(key => !['phase', 'cursor'].includes(key))
    || (value.phase === 'completed' && value.cursor !== undefined)
    || (value.cursor !== undefined && (typeof value.cursor !== 'string' || !value.cursor))) throw bundleFailure('migration_marker_invalid');
  return value;
};
export const assertBundlePendingInput = (db, verifiedContinuations=[]) => {
  const invalid=()=>{throw bundleFailure('migration_pending_input_unsupported');};
  if (table(db,'session_pending') && db.all('SELECT 1 FROM session_pending LIMIT 1').length) invalid();
  if (!verifiedContinuations.length) {
    if (table(db,'session_inbox') && db.all('SELECT 1 FROM session_inbox LIMIT 1').length) invalid();
    return;
  }
  const rows=table(db,'session_inbox') ? db.all('SELECT * FROM session_inbox ORDER BY session_id,enqueued_seq LIMIT 129') : [];
  if (rows.length>128 || verifiedContinuations.length>128 || new Set(verifiedContinuations.map(row=>row.id)).size!==verifiedContinuations.length) invalid();
  for (const row of rows) if (!verifiedContinuations.some(proof=>proof.id===row.id && proof.sessionID===row.session_id
    && proof.inboxSha256===sha256(canonicalJSON(row)))) invalid();
  for (const proof of verifiedContinuations) {
    const inbox=rows.find(row=>row.id===proof.id);
    if (proof.inboxSha256===null ? inbox!==undefined : !inbox || proof.inboxSha256!==sha256(canonicalJSON(inbox))) invalid();
    if(proof.itemProof&&(!inbox||proof.itemProof.type!==inbox.type||proof.itemProof.delivery!==inbox.delivery
      ||proof.itemProof.hash!==recoveredInputHash({type:inbox.type,delivery:inbox.delivery,payload:JSON.parse(inbox.payload)})))invalid();
    const session=db.all('SELECT * FROM session_v2 WHERE id=?',[proof.sessionID]);
    const source=db.all('SELECT id,type,seq,data FROM session_message WHERE session_id=? ORDER BY seq',[proof.sessionID]);
    if (proof.cancellation && canonicalJSON(nativeInputCancellation(db,{...proof.cancellation,messageID:proof.id,sessionID:proof.sessionID}))!==canonicalJSON({eventID:proof.cancellation.eventID,seq:proof.cancellation.seq,receiptSha256:proof.cancellation.receiptSha256})) invalid();
    if (session.length!==1 || proof.directory!==undefined&&session[0].directory!==proof.directory || sha256(canonicalJSON(session[0]))!==proof.sessionSha256
      || sha256(canonicalJSON(source))!==proof.sourceSha256 || db.all('SELECT id FROM session_message WHERE id=?',[proof.id]).length) invalid();
  }
};
export const assertNoPendingMigration = db => {
  for (const name of ['session', 'session_v2']) if (table(db, name)) {
    const columns = db.all(`PRAGMA table_info(${name})`).map(row => row.name);
    if (columns.includes('revert') && db.all(`SELECT id FROM ${name} WHERE revert IS NOT NULL`).length) throw bundleFailure('migration_revert_pending');
  }
  assertBundlePendingInput(db);
  migrationMarker(db);
};
const permissions = value => {
  if (value === null) return null;
  if (!Array.isArray(value)) throw bundleFailure('migration_permissions_unsupported');
  const rules = toV2PermissionRuleset(value);
  if (!rules) throw bundleFailure('migration_permissions_unsupported');
  if (value.some(rule => ['write','patch','apply_patch'].includes(rule.permission))) throw bundleFailure('migration_writer_permission_domain_unsupported');
  return rules;
};
export const captureMigrationInventory = db => {
  assertNoPendingMigration(db);
  const sessions = table(db, 'session') ? db.all('SELECT * FROM session ORDER BY id').map(row => ({
    id: text(row.id), projectID: text(row.project_id), parentID: row.parent_id ?? null,
    workspaceID: row.workspace_id ?? null, directory: text(row.directory), path: row.path ?? null,
    permission: permissions(parse(row.permission)), metadataSha256: sha256(row.metadata ?? 'null'),
    archivedAt: row.time_archived ?? null,
  })) : [];
  if (sessions.some(row => row.workspaceID !== null)) throw bundleFailure('migration_workspace_unsupported');
  const projects = table(db, 'project') ? db.all('SELECT * FROM project ORDER BY id').map(row => ({
    id: text(row.id), worktree: text(row.worktree), sandboxes: parse(row.sandboxes) ?? [],
  })) : [];
  const messages = table(db, 'message') ? db.all('SELECT id,session_id,data FROM message ORDER BY session_id,id').map(row => {
    const data = parse(row.data);
    if (!isRecord(data) || !['user', 'assistant'].includes(data.role)) throw bundleFailure('migration_message_invalid');
    return { id: text(row.id), sessionID: text(row.session_id), role: data.role, parentID: data.parentID ?? null,
      summary: data.summary === true, sourceSha256: sha256(row.data) };
  }) : [];
  const parts = table(db, 'part') ? db.all('SELECT id,message_id,session_id,data FROM part ORDER BY session_id,id').map(row => {
    const data = parse(row.data);
    if (!isRecord(data) || typeof data.type !== 'string') throw bundleFailure('migration_part_invalid');
    return { id: text(row.id), sessionID: text(row.session_id), messageID: text(row.message_id), type: data.type,
      callID: data.type === 'tool' ? text(data.callID) : null,
      url: data.type === 'file' ? text(data.url) : null, mime: data.type === 'file' ? text(data.mime) : null,
      sourceSha256: sha256(row.data) };
  }) : [];
  const ids = new Set(sessions.map(row => row.id)), projectIDs = new Set(projects.map(row => row.id));
  const messageIDs = new Map(messages.map(row => [row.id, row]));
  if (sessions.some(row => !projectIDs.has(row.projectID) || (row.parentID && !ids.has(row.parentID)))
    || messages.some(row => !ids.has(row.sessionID) || (row.parentID && !messageIDs.has(row.parentID)))
    || parts.some(row => messageIDs.get(row.messageID)?.sessionID !== row.sessionID)) throw bundleFailure('migration_reference_lost');
  const remembered = [];
  if (table(db, 'permission')) {
    const columns = db.all('PRAGMA table_info(permission)').map(row => row.name);
    if (columns.includes('data')) {
      for (const row of db.all('SELECT project_id,data FROM permission ORDER BY project_id')) {
        const rules = permissions(parse(row.data));
        if (!projectIDs.has(row.project_id) || !rules || rules.some(rule => rule.effect !== 'allow')) throw bundleFailure('migration_permissions_unsupported');
        for (const rule of rules) remembered.push({ projectID: row.project_id, action: rule.action, resource: rule.resource });
      }
    } else if (columns.includes('action') && columns.includes('resource')) {
      for (const row of db.all('SELECT project_id,action,resource FROM permission ORDER BY project_id,action,resource')) {
        if (!projectIDs.has(row.project_id)) throw bundleFailure('migration_reference_lost');
        remembered.push({ projectID: row.project_id, action: text(row.action), resource: text(row.resource) });
      }
    } else throw bundleFailure('migration_permissions_unsupported');
  }
  return { schema: 1, sessions, projects, messages, parts, remembered, attachments: [] };
};
export const applyMigrationProjectMap = async (db, inventory, maps, protectedRoots = []) => {
  if (!Array.isArray(maps) || maps.length > 256) throw bundleFailure('migration_project_map_invalid');
  const mapping = new Map();
  for (const map of maps) {
    if (!isRecord(map) || !['identity', 'synthetic-copy'].includes(map.mode)
      || !path.isAbsolute(map.sourceDirectory ?? '') || !path.isAbsolute(map.targetDirectory ?? '')) throw bundleFailure('migration_project_map_invalid');
    const source = await fs.realpath(map.sourceDirectory), target = await fs.realpath(map.targetDirectory);
    if (source !== map.sourceDirectory || target !== map.targetDirectory || mapping.has(source)
      || (map.mode === 'identity' ? source !== target : source === target)) throw bundleFailure('migration_project_map_invalid');
    if ([...mapping].some(([from, to]) => containsPath(from, source) || containsPath(source, from)
      || containsPath(to, target) || containsPath(target, to))) throw bundleFailure('migration_project_map_invalid');
    mapping.set(source, target);
  }
  const mapped = value => {
    if (value === null) return null;
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw bundleFailure('migration_project_path_invalid');
    const root = [...mapping.keys()].find(root => containsPath(root, value));
    if (!root) {
      if ([...mapping.values()].some(root => containsPath(root,value))) return value;
      throw bundleFailure('migration_project_path_unmapped');
    }
    return path.join(mapping.get(root), path.relative(root, value));
  };
  for (const project of inventory.projects) {
    if (project.id === 'global') continue;
    if (!Array.isArray(project.sandboxes)) throw bundleFailure('migration_project_path_invalid');
    db.run('UPDATE project SET worktree=?,sandboxes=? WHERE id=?', [mapped(project.worktree), JSON.stringify(project.sandboxes.map(mapped)), project.id]);
  }
  const sessionColumns = db.all('PRAGMA table_info(session)').map(row => row.name);
  for (const session of inventory.sessions) {
    if (sessionColumns.includes('path')) db.run('UPDATE session SET directory=?,path=? WHERE id=?', [mapped(session.directory), mapped(session.path), session.id]);
    else db.run('UPDATE session SET directory=? WHERE id=?',[mapped(session.directory),session.id]);
  }
  if (table(db, 'project_directory')) for (const row of db.all('SELECT * FROM project_directory')) {
    db.run('UPDATE project_directory SET directory=? WHERE project_id=? AND directory=?', [mapped(row.directory), row.project_id, row.directory]);
  }
  const convertAttachment=async(partID,url,mime)=>{
    if (typeof url!=='string' || typeof mime!=='string') throw bundleFailure('migration_attachment_invalid');
    if (url.startsWith('data:')) return url;
    if (!url.startsWith('file:')) throw bundleFailure('migration_attachment_unsupported');
    const sourceFile = fileURLToPath(url), targetFile = mapped(sourceFile);
    const canonical = await fs.realpath(sourceFile), targetCanonical = await fs.realpath(targetFile);
    if (canonical !== sourceFile || targetCanonical !== targetFile || sourceFile.split(path.sep).includes('.git')
      || targetFile.split(path.sep).includes('.git') || protectedRoots.some(root => containsPath(root, sourceFile) || containsPath(root, targetFile))) throw bundleFailure('migration_attachment_protected');
    const stat = await fs.lstat(sourceFile);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw bundleFailure('migration_attachment_invalid');
    const bytes = await fs.readFile(sourceFile), targetBytes = await fs.readFile(targetFile);
    if (sha256(bytes) !== sha256(targetBytes) || !/^[a-zA-Z0-9.+_-]+\/[a-zA-Z0-9.+_-]+$/.test(mime)) throw bundleFailure('migration_attachment_changed');
    if (!inventory.attachments.some(item => item.partID===partID && item.originalURI===url)) inventory.attachments.push({partID,originalURI:url,sha256:sha256(bytes),bytes:bytes.length,disposition:'data'});
    return `data:${mime};base64,${bytes.toString('base64')}`;
  };
  for (const part of inventory.parts.filter(part => part.type === 'file')) {
    const row = db.all('SELECT data FROM part WHERE id=?', [part.id])[0], data = parse(row.data);
    db.run('UPDATE part SET data=? WHERE id=?',[JSON.stringify({...data,url:await convertAttachment(part.id,part.url,part.mime)}),part.id]);
  }
  for (const part of inventory.parts.filter(part=>part.type==='tool')) {
    const row=db.all('SELECT data FROM part WHERE id=?',[part.id])[0], data=parse(row.data);
    if (!isRecord(data.state) || data.state.attachments===undefined) continue;
    if (!Array.isArray(data.state.attachments)) throw bundleFailure('migration_attachment_invalid');
    const attachments=[];
    for (const file of data.state.attachments) {
      if (!isRecord(file)) throw bundleFailure('migration_attachment_invalid');
      attachments.push({...file,url:await convertAttachment(part.id,file.url,file.mime)});
    }
    db.run('UPDATE part SET data=? WHERE id=?',[JSON.stringify({...data,state:{...data.state,attachments}}),part.id]);
  }
};
export const restoreMigrationPermissions = (db, inventory) => {
  for (const session of inventory.sessions) db.run('UPDATE session_v2 SET permission=? WHERE id=?', [session.permission === null ? null : JSON.stringify(session.permission), session.id]);
  for (const rule of inventory.remembered) db.run('INSERT OR IGNORE INTO permission(id,project_id,action,resource,time_created,time_updated) VALUES(?,?,?,?,?,?)',
    [`per_${sha256(canonicalJSON(rule)).slice(0,24)}`, rule.projectID, rule.action, rule.resource, 0, 0]);
};
export const verifyMigrationReferences = (db, inventory, {phase='prepared',projectMap=[],verifiedContinuations=[],migrationReceiptMarker='completed'}={}) => {
  if (phase === 'prepared') assertNoPendingMigration(db);
  else if (phase === 'resume') {
    assertBundlePendingInput(db,verifiedContinuations);
    const marker=migrationMarker(db);
    const freshSource=migrationReceiptMarker==='not-needed'&&['sessions','projects','messages','parts','remembered','attachments'].every(key=>Array.isArray(inventory[key])&&!inventory[key].length);
    if (!(marker?.phase==='completed'||freshSource&&marker===null)) throw bundleFailure('migration_marker_invalid');
  } else throw bundleFailure('bundle_verification_phase_invalid');
  const sessions = db.all('SELECT id,project_id,parent_id,directory,metadata,permission,time_archived,revert FROM session_v2 ORDER BY id');
  const native = db.all('SELECT id,session_id,type,seq,data FROM session_message ORDER BY session_id,seq');
  const byID = new Map(sessions.map(row => [row.id, row])), messages = new Map(native.map(row => [row.id, row]));
  // Resume may retain the coordinator's completed conversation-only Revert.
  // The harness verifier still rejects prepared transactions/materialization.
  for (const session of sessions) if (session.revert !== null) {
    const revert = parse(session.revert);
    if (!isRecord(revert) || typeof revert.messageID !== 'string' || !revert.messageID
      || Object.keys(revert).some(key => !['messageID', 'partID', 'files'].includes(key))
      || revert.partID !== undefined && (typeof revert.partID !== 'string' || !revert.partID)
      || revert.files !== undefined && (!Array.isArray(revert.files) || revert.files.length)) throw bundleFailure('bundle_native_revert_invalid');
    if (messages.get(revert.messageID)?.session_id !== session.id) throw bundleFailure('migration_reference_lost');
  }
  for (const source of inventory.sessions) {
    const row = byID.get(source.id);
    const mapping=projectMap.find(map => containsPath(map.sourceDirectory,source.directory));
    const expectedDirectory=mapping ? path.join(mapping.targetDirectory,path.relative(mapping.sourceDirectory,source.directory)):source.directory;
    if (!row || row.project_id !== source.projectID || row.parent_id !== source.parentID || row.directory !== expectedDirectory
      || (phase==='prepared' && (sha256(row.metadata ?? 'null') !== source.metadataSha256
        || row.time_archived !== source.archivedAt || canonicalJSON(parse(row.permission)) !== canonicalJSON(source.permission)))) throw bundleFailure('migration_reference_lost');
    const rules=parse(row.permission);
    if (rules !== null && (!Array.isArray(rules) || rules.some(rule => !isRecord(rule) || typeof rule.action !== 'string' || typeof rule.resource !== 'string'
      || !['allow','deny','ask'].includes(rule.effect)))) throw bundleFailure('migration_permissions_unsupported');
  }
  const compactParents = new Set(inventory.parts.filter(part => part.type === 'compaction').map(part => part.messageID));
  const dispositions = inventory.messages.map(source => {
    const folded = source.summary && compactParents.has(source.parentID);
    if (folded) {
      if (messages.has(source.id) || !messages.has(source.parentID)) throw bundleFailure('migration_compaction_invalid');
      return { id: source.id, disposition: 'folded-compaction-summary', targetID: source.parentID };
    }
    const row = messages.get(source.id);
    if (!row || row.session_id !== source.sessionID) throw bundleFailure('migration_reference_lost');
    return { id: source.id, disposition: 'preserved', targetID: source.id };
  });
  for (const source of inventory.parts.filter(part => part.callID)) {
    const row = messages.get(source.messageID), data = row && parse(row.data);
    if (!isRecord(data) || !Array.isArray(data.content) || !data.content.some(item => isRecord(item) && item.type === 'tool' && item.id === source.callID)) throw bundleFailure('migration_tool_reference_lost');
  }
  for (const rule of inventory.remembered) if (!db.all('SELECT id FROM permission WHERE project_id=? AND action=? AND resource=?', [rule.projectID, rule.action, rule.resource]).length) throw bundleFailure('migration_permission_lost');
  return { schema: 1, sessionIDs: sessions.map(row => row.id), messages: dispositions,
    nativeMessageIDs: native.map(row => row.id), attachments: inventory.attachments,
    remembered: inventory.remembered, permissions: inventory.sessions.map(row => ({ id: row.id, rules: row.permission })) };
};
