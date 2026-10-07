import fs from 'node:fs/promises';
import {createNativeMigrationFiles} from './native-migration-files.js';
import path from 'node:path';
import { Database as SQLite } from 'bun:sqlite';
import { Effect, Layer, Logger, Schema } from 'effect';
import { Database } from '@opencode/core/database/database';
import { V1Migration } from '@opencode/core/database/v1-migration';
import { SessionTable } from '@opencode/core/session/sql';
import { Global } from '@opencode/util/global';
import { parseNativeMigrationRequest, type MigrationRequest, type MigrationReceipt } from './native-process-protocol.js';
import { applyMigrationProjectMap, assertNoPendingMigration, bundleFailure, canonicalJSON, captureMigrationInventory,
  containsPath, hasMigrationTable, migrationMarker, readBundleJSON, restoreMigrationPermissions, saveBundleJSON,
  sha256, verifyMigrationReferences, type MigrationDatabase } from './bundle-migration-inventory.js';

const NullableString = Schema.NullOr(Schema.String);
const Rule = Schema.Struct({ action: Schema.String, resource: Schema.String, effect: Schema.Literals(['allow','deny','ask']) });
const Inventory = Schema.Struct({ schema: Schema.Literal(1),
  sessions: Schema.Array(Schema.Struct({ id: Schema.String, projectID: Schema.String, parentID: NullableString,
    workspaceID: NullableString, directory: Schema.String, path: NullableString, permission: Schema.NullOr(Schema.Array(Rule)),
    metadataSha256: Schema.String, archivedAt: Schema.NullOr(Schema.Number) })),
  projects: Schema.Array(Schema.Struct({ id: Schema.String, worktree: Schema.String, sandboxes: Schema.Array(Schema.String) })),
  messages: Schema.Array(Schema.Struct({ id: Schema.String, sessionID: Schema.String, role: Schema.Literals(['user','assistant']),
    parentID: NullableString, summary: Schema.Boolean, sourceSha256: Schema.String })),
  parts: Schema.Array(Schema.Struct({ id: Schema.String, sessionID: Schema.String, messageID: Schema.String, type: Schema.String,
    callID: NullableString, url: NullableString, mime: NullableString, sourceSha256: Schema.String })),
  remembered: Schema.Array(Schema.Struct({ projectID: Schema.String, action: Schema.String, resource: Schema.String })),
  attachments: Schema.Array(Schema.Struct({ partID: Schema.String, originalURI: Schema.String, sha256: Schema.String,
    bytes: Schema.Number, disposition: Schema.Literal('data') })) });
const Snapshot = Schema.Struct({ schema: Schema.Literal(1), requestSha256: Schema.String, inventory: Inventory });
const adapter = (db: SQLite): MigrationDatabase => ({
  all: (sql, params = []) => db.query<unknown, (string | number | null)[]>(sql).all(...params),
  run: (sql, params = []) => { db.query<unknown, (string | number | null)[]>(sql).run(...params); },
});
const absent = async (file: string) => {
  try { await fs.lstat(file); throw bundleFailure('migration_ambient_source_present'); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
};
const ownedFile = async (root: string, file: string) => {
  if (!path.isAbsolute(file) || !containsPath(root, file) || await fs.realpath(path.dirname(file)) !== path.dirname(file)) throw bundleFailure('migration_path_invalid');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw bundleFailure('migration_path_invalid');
};

/** Offline copy importer. Deliberately does not acquire a server or any plugin. */
export async function runMigrationRequest(input: MigrationRequest,options:{readonly nativeInstanceID?:string}={}): Promise<MigrationReceipt> {
  const request = parseNativeMigrationRequest(input);
  const files=process.platform==='win32'?await createNativeMigrationFiles(request,options.nativeInstanceID):undefined;
  const readDocument=files?.read??readBundleJSON,saveDocument=files?.save??saveBundleJSON;
  const root = await fs.realpath(path.dirname(request.isolatedRoot));
  if (request.isolatedRoot !== path.join(root, 'global') || !containsPath(root, request.receiptPath)
    || !containsPath(root, request.candidateDatabasePath) || await fs.realpath(path.dirname(request.receiptPath)) !== path.dirname(request.receiptPath)) throw bundleFailure('migration_path_invalid');
  await ownedFile(root, request.candidateDatabasePath);
  const globals = Object.fromEntries(['home','data','config','state','cache','tmp','bin','log','repos'].map(key => [key,path.join(request.isolatedRoot,key)]));
  if(!files)await fs.mkdir(request.isolatedRoot, { recursive:true, mode:0o700 });
  await absent(path.join(request.isolatedRoot,'data','auth.json'));
  const nextPath = request.auxiliary.kind === 'copy' ? request.auxiliary.databasePath : path.join(root,'sources','absent-opencode-next.db');
  if (request.auxiliary.kind === 'absent') await absent(nextPath);
  else {
    await ownedFile(root,nextPath);
    if (sha256(await fs.readFile(nextPath)) !== request.auxiliary.sha256) throw bundleFailure('migration_auxiliary_changed');
    const auxiliary = new SQLite(nextPath, { readonly:true, strict:true });
    try {
      const db = adapter(auxiliary); assertNoPendingMigration(db);
      // This slice never accepts an auxiliary silently skipped by the SDK.
      if (!hasMigrationTable(db,'project') || !hasMigrationTable(db,'session') || !hasMigrationTable(db,'session_message')) throw bundleFailure('migration_auxiliary_incompatible');
      for (const row of db.all("SELECT name FROM sqlite_master WHERE type='table'")) {
        if (typeof row!=='object' || row===null || !('name' in row) || typeof row.name!=='string') throw bundleFailure('migration_auxiliary_incompatible');
        if (row.name.startsWith('sqlite_') || ['__drizzle_migrations','migration'].includes(row.name)) continue;
        const table='"'+row.name.replaceAll('"','""')+'"';
        const where=row.name==='kv' ? " WHERE key!='migration.v1-v2'" : '';
        if (db.all(`SELECT 1 FROM ${table}${where} LIMIT 1`).length) throw bundleFailure('migration_auxiliary_graph_unsupported');
      }
    } finally { auxiliary.close(); }
  }
  if(!files)await fs.mkdir(path.join(root,'sources'),{recursive:true,mode:0o700});
  const snapshotPath = request.receiptPath + '.source.json';
  const requestSha256 = sha256(canonicalJSON(request));
  let snapshot: typeof Snapshot.Type;
  const raw = new SQLite(request.candidateDatabasePath,{strict:true});
  try {
    const db = adapter(raw); assertNoPendingMigration(db);
    try {
      snapshot = Schema.decodeUnknownSync(Snapshot)(await readDocument(snapshotPath));
      if (snapshot.requestSha256 !== requestSha256) throw bundleFailure('migration_source_checkpoint_mismatch');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      if (migrationMarker(db)) throw bundleFailure('migration_source_checkpoint_missing');
      snapshot = { schema:1, requestSha256, inventory:captureMigrationInventory(db) };
      await saveDocument(snapshotPath,snapshot);
    }
    raw.exec('BEGIN IMMEDIATE');
    try {
      await applyMigrationProjectMap(db,snapshot.inventory,request.projectMap,[request.isolatedRoot,request.candidateDatabasePath,request.receiptPath,path.join(root,'web-data'),path.join(root,'config')]);
      await saveDocument(snapshotPath,snapshot);
      raw.exec('COMMIT');
    } catch (error) { raw.exec('ROLLBACK'); throw error; }
    await saveDocument(snapshotPath,snapshot);
  } finally { raw.close(); }
  // All roots are explicit. In particular, schema acquisition's credential
  // migration can only inspect this private, absent auth.json.
  const globalLayer = Global.layerWith(globals);
  const databaseLayer = Database.layer({path:request.candidateDatabasePath}).pipe(Layer.provide(globalLayer));
  const program = Effect.gen(function* () {
    const result = yield* V1Migration.run({nextDatabasePath:nextPath});
    const service = yield* Database.Service;
    const sessions = yield* service.db.select().from(SessionTable).all();
    for (const session of sessions.filter(row => snapshot.inventory.sessions.some(item => item.id === row.id))) {
      const messages = yield* service.db.$client.unsafe<V1Migration.SourceMessage>('SELECT id,session_id,time_created,time_updated,data FROM message WHERE session_id=?',[session.id]);
      const parts = yield* service.db.$client.unsafe<V1Migration.SourcePart>('SELECT id,message_id,session_id,time_created,time_updated,data FROM part WHERE session_id=?',[session.id]);
      const transformed = V1Migration.transformSession({session,messages,parts});
      if (transformed.warnings.length) return yield* Effect.fail(bundleFailure('migration_rows_skipped'));
      const actual=yield* service.db.$client.unsafe<{id:string;type:string;seq:number;data:string}>(
        'SELECT id,type,seq,data FROM session_message WHERE session_id=? ORDER BY seq',[session.id]);
      if (canonicalJSON(actual.map(row => ({id:row.id,type:row.type,seq:row.seq,data:JSON.parse(row.data)})))
        !== canonicalJSON(transformed.messages.map(row => ({id:row.id,type:row.type,seq:row.seq,data:row.data})))) {
        return yield* Effect.fail(bundleFailure('migration_transformation_mismatch'));
      }
    }
    return result;
  }).pipe(Effect.provide(Layer.merge(globalLayer,databaseLayer)),
    Effect.provide(Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)],{mergeWithExisting:false})));
  await Effect.runPromise(program);
  const verificationDB = new SQLite(request.candidateDatabasePath,{strict:true});
  let marker: 'completed' | 'not-needed';
  let verificationSha256: string;
  try {
    const db = adapter(verificationDB);
    verificationDB.exec('BEGIN IMMEDIATE');
    try { restoreMigrationPermissions(db,snapshot.inventory); verificationDB.exec('COMMIT'); }
    catch (error) { verificationDB.exec('ROLLBACK'); throw error; }
    const verification = verifyMigrationReferences(db,snapshot.inventory,{projectMap:request.projectMap});
    marker = migrationMarker(db)?.phase === 'completed' ? 'completed' : 'not-needed';
    if (snapshot.inventory.sessions.length && marker !== 'completed') throw bundleFailure('migration_incomplete');
    verificationSha256 = await saveDocument(request.receiptPath+'.verification.json',verification);
  } finally { verificationDB.close(); }
  const receipt: MigrationReceipt = { protocol:'devryan-native-migration/1',requestID:request.requestID,bundleID:request.bundleID,
    databasePath:request.candidateDatabasePath,status:'completed',nativeVersion:'2.0.24',marker,
    sourceInventorySha256:sha256(await fs.readFile(snapshotPath)),verificationSha256 };
  await saveDocument(request.receiptPath,receipt);
  return receipt;
}
