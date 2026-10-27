import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { createMigrationFixture } from './migration-fixture.mjs';
import { runMigrationRequest } from '../../packages/web/server/lib/opencode/runtime-host/migration-mode.ts';
import { sha256 } from '../../packages/web/server/lib/opencode/runtime-host/bundle-migration-inventory.js';

const roots=[];
const fixtureDirectory=path.resolve(import.meta.dirname,'../../.cache/v2-validation');
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root,{recursive:true,force:true}))); });
async function fixture() {
  await fs.mkdir(fixtureDirectory,{recursive:true});
  const root=await fs.mkdtemp(path.join(fixtureDirectory,'migration-mode-')); roots.push(root);
  const seed=await createMigrationFixture({root});
  const bundle=path.join(root,'candidate'); await fs.mkdir(path.join(bundle,'opencode'),{recursive:true});
  await fs.mkdir(path.join(bundle,'sources')); await fs.mkdir(path.join(bundle,'global'));
  const source=new Database(seed.sourceLaunch.opencodeDatabasePath,{readonly:true});
  const databasePath=path.join(bundle,'opencode','opencode.db');
  try { await fs.writeFile(databasePath,source.serialize()); } finally { source.close(); }
  const request={protocol:'devryan-native-migration/1',requestID:'fixture-import',bundleID:'fixture-candidate',
    candidateDatabasePath:databasePath,isolatedRoot:path.join(bundle,'global'),receiptPath:path.join(bundle,'sources','migration.json'),
    auxiliary:{kind:'absent'},projectMap:seed.projectMap};
  return {root,seed,request,databasePath};
}
test('actual pinned importer preserves two copied project graphs, attachments and ordered permissions',async () => {
  const f=await fixture(), original=sha256(await fs.readFile(f.seed.sourceLaunch.opencodeDatabasePath));
  const receipt=await runMigrationRequest(f.request);
  expect(receipt.marker).toBe('completed'); expect(receipt.bundleID).toBe('fixture-candidate');
  expect(sha256(await fs.readFile(f.seed.sourceLaunch.opencodeDatabasePath))).toBe(original);
  const db=new Database(f.databasePath,{readonly:true});
  try {
    expect(db.query('SELECT count(*) n FROM session_v2').get().n).toBe(6);
    const roots=db.query('SELECT directory,parent_id,permission FROM session_v2 ORDER BY id').all();
    expect(roots.every(row => f.seed.projectMap.some(map => row.directory===map.targetDirectory))).toBe(true);
    expect(roots.filter(row => row.parent_id!==null).length).toBe(2);
    expect(roots.every(row => JSON.parse(row.permission).map(rule=>rule.effect).join(',')==='ask,allow,deny,allow')).toBe(true);
    expect(db.query('SELECT count(*) n FROM permission WHERE action=\'read\'').get().n).toBe(2);
    const verification=JSON.parse(await fs.readFile(f.request.receiptPath+'.verification.json','utf8'));
    expect(verification.messages.filter(row=>row.disposition==='folded-compaction-summary').length).toBe(2);
    expect(verification.attachments.length).toBe(2);
    expect(receipt.verificationSha256).toBe(sha256(await fs.readFile(f.request.receiptPath+'.verification.json')));
  } finally { db.close(); }
  expect(await runMigrationRequest(f.request)).toEqual(receipt);
});
test('unknown marker refuses before SDK mutates the candidate',async () => {
  const f=await fixture();
  const db=new Database(f.databasePath);
  db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  db.query('INSERT INTO kv VALUES(?,?)').run('migration.v1-v2','{"phase":"unknown"}'); db.close();
  const before=sha256(await fs.readFile(f.databasePath));
  await expect(runMigrationRequest(f.request)).rejects.toMatchObject({code:'migration_marker_invalid'});
  expect(sha256(await fs.readFile(f.databasePath))).toBe(before);
});
test('ambient auth and incompatible auxiliary sources never get imported',async () => {
  const f=await fixture(); await fs.mkdir(path.join(f.request.isolatedRoot,'data'));
  await fs.writeFile(path.join(f.request.isolatedRoot,'data','auth.json'),'{}');
  await expect(runMigrationRequest(f.request)).rejects.toMatchObject({code:'migration_ambient_source_present'});
  await fs.rm(path.join(f.request.isolatedRoot,'data','auth.json'));
  const auxiliary=path.join(path.dirname(f.request.receiptPath),'auxiliary.db');
  const db=new Database(auxiliary); db.exec('CREATE TABLE unrelated(id TEXT)'); db.close();
  await expect(runMigrationRequest({...f.request,auxiliary:{kind:'copy',databasePath:auxiliary,sha256:sha256(await fs.readFile(auxiliary))}}))
    .rejects.toMatchObject({code:'migration_auxiliary_incompatible'});
});
test('staged Revert and pending auxiliary input refuse without acquiring native schema',async () => {
  const f=await fixture(), db=new Database(f.databasePath);
  db.query('UPDATE session SET revert=? WHERE id=?').run('{"messageID":"msg_ses_migration_root_1_user"}','ses_migration_root_1'); db.close();
  const before=sha256(await fs.readFile(f.databasePath));
  await expect(runMigrationRequest(f.request)).rejects.toMatchObject({code:'migration_revert_pending'});
  expect(sha256(await fs.readFile(f.databasePath))).toBe(before);
  const auxiliary=path.join(path.dirname(f.request.receiptPath),'pending-auxiliary.db'), aux=new Database(auxiliary);
  aux.exec('CREATE TABLE session_inbox(id TEXT); INSERT INTO session_inbox VALUES(\'pending-real-input\')'); aux.close();
  await expect(runMigrationRequest({...f.request,auxiliary:{kind:'copy',databasePath:auxiliary,sha256:sha256(await fs.readFile(auxiliary))}}))
    .rejects.toMatchObject({code:'migration_pending_input_unsupported'});
});
test('writer-domain rules and remembered denials never silently widen native permissions',async () => {
  const f=await fixture(), db=new Database(f.databasePath);
  db.query('UPDATE session SET permission=? WHERE id=?').run('[{"permission":"write","pattern":"*","action":"allow"}]','ses_migration_root_1'); db.close();
  await expect(runMigrationRequest(f.request)).rejects.toMatchObject({code:'migration_writer_permission_domain_unsupported'});
  const g=await fixture(), other=new Database(g.databasePath);
  other.query('UPDATE permission SET data=?').run('[{"permission":"read","pattern":"*","action":"deny"}]'); other.close();
  await expect(runMigrationRequest(g.request)).rejects.toMatchObject({code:'migration_permissions_unsupported'});
});
test('tool-result attachments convert only digest-matching explicit copied project files',async()=>{
  const f=await fixture(),db=new Database(f.databasePath);
  const part=db.query("SELECT id,data FROM part WHERE json_extract(data,'$.type')='tool' LIMIT 1").get(),data=JSON.parse(part.data);
  const attachment=f.seed.expected.attachments.find(row=>row.sessionID===data.sessionID)??f.seed.expected.attachments[0];
  data.state.attachments=[{id:'prt_legacy_tool_attachment',sessionID:data.sessionID,messageID:data.messageID,type:'file',mime:'text/plain',filename:'attachment.txt',url:attachment.originalURI}];
  db.query('UPDATE part SET data=? WHERE id=?').run(JSON.stringify(data),part.id);db.close();
  await runMigrationRequest(f.request);
  const result=new Database(f.databasePath,{readonly:true});
  try {
    const native=JSON.parse(result.query('SELECT data FROM session_message WHERE id=?').get(data.messageID).data);
    expect(native.content.find(row=>row.type==='tool'&&row.id===data.callID).state.content.find(row=>row.type==='file').uri).toStartWith('data:text/plain;base64,');
  } finally {result.close();}
  const g=await fixture(); await fs.writeFile(path.join(g.seed.projectMap[0].targetDirectory,'attachment.txt'),'changed copy bytes');
  await expect(runMigrationRequest(g.request)).rejects.toMatchObject({code:'migration_attachment_changed'});
});
test('corrupt migration state is an explicit refusal before native acquisition',async()=>{
  const f=await fixture(),db=new Database(f.databasePath);db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  db.query('INSERT INTO kv VALUES(?,?)').run('migration.v1-v2','not-json');db.close();
  await expect(runMigrationRequest(f.request)).rejects.toMatchObject({code:'migration_marker_invalid'});
});
test('an auxiliary graph or approval is explicitly unavailable rather than silently skipped',async()=>{
  const f=await fixture(), auxiliary=path.join(path.dirname(f.request.receiptPath),'nonempty-auxiliary.db'),db=new Database(auxiliary);
  db.exec("CREATE TABLE project(id TEXT); CREATE TABLE session(id TEXT); CREATE TABLE session_message(id TEXT); CREATE TABLE permission(id TEXT); INSERT INTO permission VALUES('owned-approval')");db.close();
  await expect(runMigrationRequest({...f.request,auxiliary:{kind:'copy',databasePath:auxiliary,sha256:sha256(await fs.readFile(auxiliary))}}))
    .rejects.toMatchObject({code:'migration_auxiliary_graph_unsupported'});
});
