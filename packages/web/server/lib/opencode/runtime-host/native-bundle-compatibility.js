import { createHash } from 'node:crypto';
import { resolveSqliteDriver } from '../db-maintenance-core.js';

const fail = () => Object.assign(new Error('bundle_v2_upgrade_compatibility_required'), { code: 'bundle_v2_upgrade_compatibility_required', status: 503 });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// These exact compiled core graphs produced identical schema and migration
// layouts in isolated original-controller initializations. Other builds need
// independent qualification; a version number alone grants no compatibility.
export const REVIEWED_NATIVE_CLONE_RELEASES = Object.freeze({
  '2.0.20': '474e0dc7e8a3c9befabaf876dc56b01e911146fd4088de7cad112858b5b665e9',
  '2.0.24': '036b5d1137133663fce481ecfe5fc65929ac1749cd7fb1719e1ae93b40dc6321',
  '2.0.26': '9f5a227676de99f375459ba7b5be9f78a9c215ca62e8d7ffe9cfe920b24ea808',
});
// 2.0.26 adds the data-only migration 20261007190000_azure_cli_external_credential,
// whose `external` credential values older releases cannot decode. The DDL layout
// is unchanged, so a clone never moves a database to a lower migration level.
export const REVIEWED_NATIVE_CLONE_MIGRATION_LEVEL = Object.freeze({ '2.0.20': 0, '2.0.24': 0, '2.0.26': 1 });
// A database imported from a legacy source keeps its __drizzle_migrations table.
export const REVIEWED_NATIVE_CLONE_LAYOUT = Object.freeze({
  schemaSha256: '86eba4fd4db542bd82ef56f76c1e5eba80af1efc021e10cd5a7f59d70e5f1bf0',
  migrationsSha256: 'b0c489f7584f30b688a23e9cc6326c1c37b1dfb166ba14e5d55ee3cf33f08d9e',
  userVersion: 0,
});
// Every 2.x install creates its database from an empty source, without that
// table. The actual 2.0.20 controller's fresh database and a fresh 2.0.26
// database have this identical DDL; their `migration` rows differ only by the
// 2.0.26 data-only migration (docs/audits/2026-10-09/startup-bundle-upgrade).
export const REVIEWED_NATIVE_FRESH_CLONE_LAYOUT = Object.freeze({
  schemaSha256: '32957fae72f298bc107761ba6b9e3336fdee06a70f9be26e189a54e72f7898ec',
  migrationsSha256: null,
  userVersion: 0,
});
const reviewedLayouts = [REVIEWED_NATIVE_CLONE_LAYOUT, REVIEWED_NATIVE_FRESH_CLONE_LAYOUT];
export function isReviewedNativeClonePair(left, right, layout) {
  return left?.opencodeVersion !== right?.opencodeVersion
    && Object.hasOwn(REVIEWED_NATIVE_CLONE_RELEASES, left?.opencodeVersion)
    && Object.hasOwn(REVIEWED_NATIVE_CLONE_RELEASES, right?.opencodeVersion)
    && left.inputs?.coreDigest === REVIEWED_NATIVE_CLONE_RELEASES[left.opencodeVersion]
    && right.inputs?.coreDigest === REVIEWED_NATIVE_CLONE_RELEASES[right.opencodeVersion]
    && REVIEWED_NATIVE_CLONE_MIGRATION_LEVEL[left.opencodeVersion] <= REVIEWED_NATIVE_CLONE_MIGRATION_LEVEL[right.opencodeVersion]
    && reviewedLayouts.some(reviewed => Object.entries(reviewed).every(([key, value]) => layout?.[key] === value));
}
/** Read only schema/migration metadata, never credential or account values. */
export function inspectNativeCloneLayout(databasePath) {
  const db = resolveSqliteDriver().open(databasePath, { readonly: true });
  try {
    db.prepare('BEGIN').run();
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const legacy = schema.some(row => row.type === 'table' && row.name === '__drizzle_migrations');
    const migrations = legacy ? hash(db.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all()) : null;
    return { schemaSha256: hash(schema), migrationsSha256: migrations, userVersion: db.prepare('PRAGMA user_version').get().user_version };
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
    if (!isReviewedNativeClonePair(left, right, REVIEWED_NATIVE_CLONE_LAYOUT)) throw fail();
    for (const manifest of [left, right]) {
      if (!['devryan-v2-clone/1', 'devryan.bundle.credentials/2', 'devryan.bundle.credential-owners/2']
        .every(contract => manifest.compiledContracts?.includes(contract))) throw fail();
    }
    if (!isReviewedNativeClonePair(left, right, inspectNativeCloneLayout(databasePath))) throw fail();
  } catch { throw fail(); }
}
