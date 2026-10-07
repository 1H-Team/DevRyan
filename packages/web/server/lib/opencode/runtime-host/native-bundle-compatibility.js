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
});
export const REVIEWED_NATIVE_CLONE_LAYOUT = Object.freeze({
  schemaSha256: '86eba4fd4db542bd82ef56f76c1e5eba80af1efc021e10cd5a7f59d70e5f1bf0',
  migrationsSha256: 'b0c489f7584f30b688a23e9cc6326c1c37b1dfb166ba14e5d55ee3cf33f08d9e',
  userVersion: 0,
});
export function isReviewedNativeClonePair(left, right, layout) {
  return left?.opencodeVersion !== right?.opencodeVersion
    && Object.hasOwn(REVIEWED_NATIVE_CLONE_RELEASES, left?.opencodeVersion)
    && Object.hasOwn(REVIEWED_NATIVE_CLONE_RELEASES, right?.opencodeVersion)
    && left.inputs?.coreDigest === REVIEWED_NATIVE_CLONE_RELEASES[left.opencodeVersion]
    && right.inputs?.coreDigest === REVIEWED_NATIVE_CLONE_RELEASES[right.opencodeVersion]
    && Object.entries(REVIEWED_NATIVE_CLONE_LAYOUT).every(([key, value]) => layout?.[key] === value);
}
/** Read only schema/migration metadata, never credential or account values. */
export function inspectNativeCloneLayout(databasePath) {
  const db = resolveSqliteDriver().open(databasePath, { readonly: true });
  try {
    db.prepare('BEGIN').run();
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const migrations = db.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all();
    return { schemaSha256: hash(schema), migrationsSha256: hash(migrations), userVersion: db.prepare('PRAGMA user_version').get().user_version };
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
