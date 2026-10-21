import { createHash } from 'node:crypto';
import { resolveSqliteDriver } from '../db-maintenance-core.js';
import { TARGET_OPENCODE_VERSION } from '../version-policy.js';

const fail = () => Object.assign(new Error('bundle_v2_upgrade_compatibility_required'), { code: 'bundle_v2_upgrade_compatibility_required', status: 503 });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// These exact compiled core graphs produced identical schema and migration
// layouts in isolated original-controller initializations. Other builds need
// independent qualification; a version number alone grants no compatibility.
export const REVIEWED_NATIVE_CLONE_RELEASES = Object.freeze({
  '2.0.20': '474e0dc7e8a3c9befabaf876dc56b01e911146fd4088de7cad112858b5b665e9',
  '2.0.24': '036b5d1137133663fce481ecfe5fc65929ac1749cd7fb1719e1ae93b40dc6321',
  '2.0.26': '9f5a227676de99f375459ba7b5be9f78a9c215ca62e8d7ffe9cfe920b24ea808',
  '2.0.30': 'fe5b54bf9ab3a5e3d1f5bc952bdff00f81d8ff6635c9ca83fef1c669af4f47e1',
  '2.0.32': '2d0c5bc5ae8f26bb22377f01d6a45584020307731dbb19ea2123af43a9e89c9b',
  '2.1.0': 'd007cf3b957d5efdd8e9930f7e289d99cf48167bae756df25dea7927640519d6',
  '2.1.2': 'f80e411fc11b1f0fc1a702b62c0ddcd559503abea13627afb4e80d286e4fb47c',
});
// The later 2.0.26 build adds observation transforms without changing database layout.
export const REVIEWED_NATIVE_CLONE_REBUILDS = Object.freeze({
  '2.0.26': '287c56936f4c31fdff506e655a599a7ef277e384c144c1548ec48ba9e918b464',
});
const reviewedGraph = manifest => manifest.inputs?.coreDigest === REVIEWED_NATIVE_CLONE_RELEASES[manifest.opencodeVersion]
  || Object.hasOwn(REVIEWED_NATIVE_CLONE_REBUILDS, manifest.opencodeVersion)
    && manifest.inputs?.coreDigest === REVIEWED_NATIVE_CLONE_REBUILDS[manifest.opencodeVersion];
/** A production build must be the host's pinned release with a reviewed core
 * graph; otherwise installed apps could not clone into it at startup. Record a
 * new digest only after qualifying the upgrade from the previous release. */
export function assertReviewedNativeCoreDigest(manifest, target = TARGET_OPENCODE_VERSION) {
  const digest = manifest?.inputs?.coreDigest;
  if (manifest?.opencodeVersion !== target || !reviewedGraph(manifest)) throw Object.assign(
    new Error(`Native build OpenCode ${manifest?.opencodeVersion} core digest ${digest} is not the reviewed graph for ${target}`),
    { code: 'native_core_digest_unreviewed', detail: { opencodeVersion: manifest?.opencodeVersion ?? null, target, coreDigest: digest ?? null } });
}
// 2.0.26 adds the data-only migration 20261007190000_azure_cli_external_credential,
// whose `external` credential values older releases cannot decode. The DDL layout
// is unchanged, so a clone never moves a database to a lower migration level.
export const REVIEWED_NATIVE_CLONE_MIGRATION_LEVEL = Object.freeze({ '2.0.20': 0, '2.0.24': 0, '2.0.26': 1, '2.0.30': 2, '2.0.32': 2, '2.1.0': 3, '2.1.2': 3 });
// 2.0.30 adds project.time_archived; its migrated database cannot clone backwards.
// 2.1.0 writes native compaction windows and drops required legacy message fields.
// Its logical level 3 prevents clones into older readers despite identical DDL.
// 2.1.2 adds no migration and stays at level 3.
// A layout is the database's structure (`inspectNativeCloneLayout`), not its DDL
// text: a database created by an earlier release and migrated in place stores
// `ALTER TABLE … ADD` text with the column last, a fresh one has it inside
// CREATE TABLE. Each value comes from an actual controller database.
// A database imported from a legacy source keeps its __drizzle_migrations table.
export const REVIEWED_NATIVE_CLONE_LAYOUT = Object.freeze({
  structureSha256: '02248a6b5808cff229a46298a6b82c2dd4e0878d8bbdde4d67f2263083d11671',
  migrationsSha256: 'b0c489f7584f30b688a23e9cc6326c1c37b1dfb166ba14e5d55ee3cf33f08d9e',
  userVersion: 0,
});
// Every 2.x install creates its database from an empty source, without that
// table. The 2.0.20, 2.0.24 and 2.0.26 controllers' fresh databases share this
// structure; their `migration` rows differ only by the 2.0.26 data-only migration.
export const REVIEWED_NATIVE_FRESH_CLONE_LAYOUT = Object.freeze({
  structureSha256: '71786c05ef01a162f4c62e96b7d270f221d9e4483511c72ca9eb7aaa208bd93a',
  migrationsSha256: null,
  userVersion: 0,
});
// A migration level 2 database has the project archive column. The legacy value
// comes from the 2.0.30 controller's legacy-imported database in the package
// lane. The fresh value is shared by a 2.0.30/2.0.32 controller's fresh
// database and a 2.0.26 fresh database that 2.0.30 migrated in place.
export const REVIEWED_NATIVE_PROJECT_ARCHIVE_CLONE_LAYOUT = Object.freeze({
  structureSha256: '778643c504f9681272d611ec6a46e0531ca685a01253f60d405fbaca40d86bf8',
  migrationsSha256: REVIEWED_NATIVE_CLONE_LAYOUT.migrationsSha256,
  userVersion: 0,
});
export const REVIEWED_NATIVE_PROJECT_ARCHIVE_FRESH_CLONE_LAYOUT = Object.freeze({
  structureSha256: 'a6f5e58a3e5a5836cfc452853ccf4d17ab05cdba91c7e5da5606cd6b74426a8f',
  migrationsSha256: null,
  userVersion: 0,
});
const REVIEWED_SOURCE_LAYOUTS = Object.freeze({
  0: Object.freeze({ legacy: REVIEWED_NATIVE_CLONE_LAYOUT, 'fresh-install': REVIEWED_NATIVE_FRESH_CLONE_LAYOUT }),
  1: Object.freeze({ legacy: REVIEWED_NATIVE_CLONE_LAYOUT, 'fresh-install': REVIEWED_NATIVE_FRESH_CLONE_LAYOUT }),
  2: Object.freeze({ legacy: REVIEWED_NATIVE_PROJECT_ARCHIVE_CLONE_LAYOUT, 'fresh-install': REVIEWED_NATIVE_PROJECT_ARCHIVE_FRESH_CLONE_LAYOUT }),
  3: Object.freeze({ legacy: REVIEWED_NATIVE_PROJECT_ARCHIVE_CLONE_LAYOUT, 'fresh-install': REVIEWED_NATIVE_PROJECT_ARCHIVE_FRESH_CLONE_LAYOUT }),
});
/** The reviewed `kind` ('legacy' | 'fresh-install') layout a source release's database has. */
export const reviewedNativeCloneSourceLayout = (version, kind) => Object.hasOwn(REVIEWED_NATIVE_CLONE_MIGRATION_LEVEL, version)
  ? REVIEWED_SOURCE_LAYOUTS[REVIEWED_NATIVE_CLONE_MIGRATION_LEVEL[version]]?.[kind] : undefined;
export function isReviewedNativeClonePair(left, right, layout) {
  return left?.opencodeVersion !== right?.opencodeVersion
    && Object.hasOwn(REVIEWED_NATIVE_CLONE_RELEASES, left?.opencodeVersion)
    && Object.hasOwn(REVIEWED_NATIVE_CLONE_RELEASES, right?.opencodeVersion)
    && reviewedGraph(left)
    && reviewedGraph(right)
    && REVIEWED_NATIVE_CLONE_MIGRATION_LEVEL[left.opencodeVersion] <= REVIEWED_NATIVE_CLONE_MIGRATION_LEVEL[right.opencodeVersion]
    && ['legacy', 'fresh-install'].some(kind => Object.entries(reviewedNativeCloneSourceLayout(left.opencodeVersion, kind))
      .every(([key, value]) => layout?.[key] === value));
}
// SQLite DDL text as a comparable string: identifier quotes dropped, whitespace and case folded.
const normalizedSQL = sql => sql?.replace(/[`"[\]]/g, '').replace(/\s+/g, ' ').trim().toLowerCase() ?? null;
/** Read only schema/migration metadata, never credential or account values.
 * The structure is order-insensitive per table (columns by name) and ignores
 * DDL spelling, so the same layout reached by CREATE TABLE or by ALTER TABLE
 * ADD hashes alike, while any column, key, index or constraint change differs. */
export function inspectNativeCloneLayout(databasePath) {
  const db = resolveSqliteDriver().open(databasePath, { readonly: true });
  try {
    db.prepare('BEGIN').run();
    const all = (sql, ...args) => db.prepare(sql).all(...args);
    const schema = all("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name");
    const tables = schema.filter(row => row.type === 'table').map(({ name }) => ({
      name,
      shape: all('SELECT type,ncol,wr,strict FROM pragma_table_list WHERE schema=\'main\' AND name=?', name),
      columns: all('SELECT name,type,"notnull",dflt_value,pk,hidden FROM pragma_table_xinfo(?) ORDER BY name', name),
      foreignKeys: all('SELECT "table","from","to",on_update,on_delete,"match" FROM pragma_foreign_key_list(?) ORDER BY "table","from","to"', name),
      checks: normalizedSQL(schema.find(row => row.type === 'table' && row.name === name).sql).match(/\bcheck\s*\(/g)?.length ?? 0,
      indexes: all('SELECT name,"unique",origin,partial FROM pragma_index_list(?) ORDER BY name', name).map(index => ({
        ...index,
        keys: all('SELECT seqno,name,"desc",coll,"key" FROM pragma_index_xinfo(?) ORDER BY seqno', index.name),
        where: index.partial ? normalizedSQL(schema.find(row => row.name === index.name)?.sql)?.replace(/^.*?\bwhere\b/, '') ?? null : null,
      })),
    }));
    const other = schema.filter(row => row.type === 'trigger' || row.type === 'view')
      .map(row => ({ type: row.type, name: row.name, sql: normalizedSQL(row.sql) }));
    const legacy = schema.some(row => row.type === 'table' && row.name === '__drizzle_migrations');
    const migrations = legacy ? hash(all('SELECT * FROM __drizzle_migrations ORDER BY id')) : null;
    return { structureSha256: hash({ tables, other }), migrationsSha256: migrations, userVersion: db.prepare('PRAGMA user_version').get().user_version };
  } finally {
    try { db.prepare('ROLLBACK').run(); } finally { db.close(); }
  }
}
/** Same-core clones retain their existing contract. Cross-release clones need
 * the finite reviewed graph pair and the actual source layout, in both directions.
 * Credential capture/projection still uses each bundle's exact original controller. */
export function verifyNativeCloneCompatibility({ left, right, databasePath }) {
  if (!right?.compiledContracts?.includes('devryan-v2-clone/1')
    || !right.compiledContracts.includes('devryan.bundle.credentials/2')) throw fail();
  if (left?.opencodeVersion === right.opencodeVersion && /^[a-f0-9]{64}$/.test(left?.inputs?.coreDigest ?? '')
    && left.inputs.coreDigest === right.inputs?.coreDigest) return;
  try {
    if (!isReviewedNativeClonePair(left, right, reviewedNativeCloneSourceLayout(left?.opencodeVersion, 'legacy'))) throw fail();
    for (const manifest of [left, right]) {
      if (!['devryan-v2-clone/1', 'devryan.bundle.credentials/2', 'devryan.bundle.credential-owners/2']
        .every(contract => manifest.compiledContracts?.includes(contract))) throw fail();
    }
    if (!isReviewedNativeClonePair(left, right, inspectNativeCloneLayout(databasePath))) throw fail();
  } catch { throw fail(); }
}
