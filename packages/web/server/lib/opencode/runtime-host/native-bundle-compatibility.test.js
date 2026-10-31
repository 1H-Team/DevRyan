import { expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSqliteDriver } from '../sqlite-driver.js';
import { assertReviewedNativeCoreDigest, inspectNativeCloneLayout, isReviewedNativeClonePair, REVIEWED_NATIVE_CLONE_RELEASES, REVIEWED_NATIVE_CLONE_LAYOUT,
  REVIEWED_NATIVE_FRESH_CLONE_LAYOUT, REVIEWED_NATIVE_CLONE_MIGRATION_LEVEL, REVIEWED_NATIVE_CLONE_REBUILDS, REVIEWED_NATIVE_PROJECT_ARCHIVE_CLONE_LAYOUT,
  REVIEWED_NATIVE_PROJECT_ARCHIVE_FRESH_CLONE_LAYOUT, REVIEWED_NATIVE_BLOB_STORE_FRESH_CLONE_LAYOUT, REVIEWED_NATIVE_SCHEDULE_FRESH_CLONE_LAYOUT, REVIEWED_NATIVE_SESSION_PART_FRESH_CLONE_LAYOUT, REVIEWED_NATIVE_JOB_FRESH_CLONE_LAYOUT, reviewedNativeCloneSourceLayout, verifyNativeCloneCompatibility } from './native-bundle-compatibility.js';

const manifest = version => ({ opencodeVersion: version, inputs: { coreDigest: REVIEWED_NATIVE_CLONE_RELEASES[version] },
  compiledContracts: ['devryan-v2-clone/1', 'devryan.bundle.credentials/2', 'devryan.bundle.credential-owners/2'] });
test.each([['2.0.20', '2.0.24'], ['2.0.24', '2.0.20'], ['2.0.20', '2.0.26'], ['2.0.24', '2.0.26'], ['2.0.20', '2.0.30'], ['2.0.24', '2.0.30'], ['2.0.26', '2.0.30'], ['2.0.20', '2.0.32'], ['2.0.26', '2.0.32'], ['2.0.30', '2.0.32', '2.1.0'], ['2.0.32', '2.0.30'], ['2.0.32', '2.1.0'], ['2.0.26', '2.1.0'], ['2.1.0', '2.1.2'], ['2.1.2', '2.1.0'], ['2.0.32', '2.1.2'], ['2.0.26', '2.1.2'], ['2.1.2', '2.1.3'], ['2.1.3', '2.1.2'], ['2.1.0', '2.1.3'], ['2.1.3', '2.1.0'], ['2.0.26', '2.1.3'], ['2.1.3', '2.1.4'], ['2.1.4', '2.1.3'], ['2.1.2', '2.1.4'], ['2.1.4', '2.1.0'], ['2.0.26', '2.1.4'], ['2.1.4', '2.2.0'], ['2.1.0', '2.2.0'], ['2.0.32', '2.2.0'], ['2.0.26', '2.2.0'], ['2.1.4', '2.2.1'], ['2.0.32', '2.2.1'], ['2.1.4', '2.2.2'], ['2.0.32', '2.2.2'], ['2.1.4', '2.2.5'], ['2.0.32', '2.2.5']])('only the reviewed exact release graphs and layout permit %s to %s', (source, target) => {
  const left = manifest(source), right = manifest(target);
  const reviewed = reviewedNativeCloneSourceLayout(source, 'legacy');
  expect(isReviewedNativeClonePair(left, right, reviewed)).toBe(true);
  for (const version of ['2.0.21', '2.0.25', '2.0.27', `${source}-dev`, ` ${source} `, null, undefined]) {
    expect(isReviewedNativeClonePair({ ...left, opencodeVersion: version }, right, reviewed)).toBe(false);
    expect(isReviewedNativeClonePair(left, { ...right, opencodeVersion: version }, reviewed)).toBe(false);
  }
  for (const coreDigest of ['0'.repeat(64), right.inputs.coreDigest, '', undefined]) {
    expect(isReviewedNativeClonePair({ ...left, inputs: { coreDigest } }, right, reviewed)).toBe(false);
  }
  for (const coreDigest of ['0'.repeat(64), left.inputs.coreDigest, '', undefined]) {
    expect(isReviewedNativeClonePair(left, { ...right, inputs: { coreDigest } }, reviewed)).toBe(false);
  }
  for (const [key, value] of [['structureSha256', '0'.repeat(64)], ['migrationsSha256', '0'.repeat(64)], ['userVersion', 1]]) {
    expect(isReviewedNativeClonePair(left, right, { ...reviewed, [key]: value })).toBe(false);
  }
  expect(isReviewedNativeClonePair(left, right, undefined)).toBe(false);
});
test('same-core compatibility is preserved, and cross-release database evidence cannot be omitted', () => {
  const left = manifest('2.0.20');
  expect(() => verifyNativeCloneCompatibility({ left, right: structuredClone(left) })).not.toThrow();
  expect(() => verifyNativeCloneCompatibility({ left, right: manifest('2.0.24'), databasePath: '/does-not-exist' }))
    .toThrow('bundle_v2_upgrade_compatibility_required');
  for (const contract of ['devryan-v2-clone/1', 'devryan.bundle.credentials/2']) {
    const right = { ...left, compiledContracts: left.compiledContracts.filter(value => value !== contract) };
    expect(() => verifyNativeCloneCompatibility({ left, right })).toThrow('bundle_v2_upgrade_compatibility_required');
  }
});
test('a database never clones from 2.0.26 into a release with fewer reviewed migrations', () => {
  expect(Object.keys(REVIEWED_NATIVE_CLONE_MIGRATION_LEVEL).sort()).toEqual(Object.keys(REVIEWED_NATIVE_CLONE_RELEASES).sort());
  for (const target of ['2.0.20', '2.0.24']) {
    expect(isReviewedNativeClonePair(manifest('2.0.26'), manifest(target), REVIEWED_NATIVE_CLONE_LAYOUT)).toBe(false);
    expect(() => verifyNativeCloneCompatibility({ left: manifest('2.0.26'), right: manifest(target), databasePath: '/does-not-exist' }))
      .toThrow('bundle_v2_upgrade_compatibility_required');
  }
});
test('a fresh-install database qualifies only with its exact reviewed structure and no legacy migration table', () => {
  const left = manifest('2.0.20'), right = manifest('2.0.26');
  expect(isReviewedNativeClonePair(left, right, REVIEWED_NATIVE_FRESH_CLONE_LAYOUT)).toBe(true);
  for (const [key, value] of [['structureSha256', REVIEWED_NATIVE_CLONE_LAYOUT.structureSha256], ['structureSha256', '0'.repeat(64)],
    ['migrationsSha256', REVIEWED_NATIVE_CLONE_LAYOUT.migrationsSha256], ['migrationsSha256', undefined], ['userVersion', 1]]) {
    expect(isReviewedNativeClonePair(left, right, { ...REVIEWED_NATIVE_FRESH_CLONE_LAYOUT, [key]: value })).toBe(false);
  }
  expect(isReviewedNativeClonePair(right, left, REVIEWED_NATIVE_FRESH_CLONE_LAYOUT)).toBe(false);
});
test('layout inspection hashes the legacy migration table only when the database has one', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'native-clone-layout-'));
  try {
    const file = path.join(directory, 'fresh.db');
    writeFileSync(file, '');
    const db = resolveSqliteDriver().open(file);
    try { db.exec('CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER)'); } finally { db.close(); }
    const fresh = inspectNativeCloneLayout(file);
    expect(fresh).toMatchObject({ migrationsSha256: null, userVersion: 0 });
    const legacy = resolveSqliteDriver().open(file);
    try { legacy.exec('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT)'); } finally { legacy.close(); }
    const imported = inspectNativeCloneLayout(file);
    expect(imported.migrationsSha256).toMatch(/^[a-f0-9]{64}$/); expect(imported.structureSha256).not.toBe(fresh.structureSha256);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// Schema-only DDL dumped from real controller databases (no rows).
const fixtureLayout = (directory, name, mutate) => {
  const file = path.join(directory, `${name}.db`);
  writeFileSync(file, '');
  const db = resolveSqliteDriver().open(file);
  try {
    db.exec(readFileSync(new URL(`./test-fixtures/native-clone-layouts/${name}.sql`, import.meta.url), 'utf8'));
    mutate?.(db);
  } finally { db.close(); }
  return inspectNativeCloneLayout(file);
};
test('a database migrated in place has the same reviewed layout as a fresh one', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'native-clone-layout-'));
  try {
    expect(fixtureLayout(directory, '2.0.26-fresh')).toEqual({ ...REVIEWED_NATIVE_FRESH_CLONE_LAYOUT });
    // 2.0.30 upgraded this 2.0.26 database with ALTER TABLE project ADD time_archived:
    // different DDL text and column order than a fresh 2.0.30/2.0.32 database.
    const migrated = fixtureLayout(directory, '2.0.26-fresh-migrated-by-2.0.30');
    expect(migrated).toEqual({ ...REVIEWED_NATIVE_PROJECT_ARCHIVE_FRESH_CLONE_LAYOUT });
    expect(fixtureLayout(directory, '2.0.32-fresh')).toEqual(migrated);
    const source = path.join(directory, 'source.db');
    writeFileSync(source, '');
    const db = resolveSqliteDriver().open(source);
    try { db.exec(readFileSync(new URL('./test-fixtures/native-clone-layouts/2.0.26-fresh-migrated-by-2.0.30.sql', import.meta.url), 'utf8')); } finally { db.close(); }
    expect(() => verifyNativeCloneCompatibility({ left: manifest('2.0.30'), right: manifest('2.0.32'), databasePath: source })).not.toThrow();
    expect(() => verifyNativeCloneCompatibility({ left: manifest('2.0.26'), right: manifest('2.0.32'), databasePath: source }))
      .toThrow('bundle_v2_upgrade_compatibility_required');
    // Any real structural difference still refuses.
    for (const change of ['ALTER TABLE project ADD extra text', 'ALTER TABLE project DROP COLUMN commands', 'CREATE TABLE extra (id text)',
      'CREATE INDEX project_worktree_idx ON project (worktree)', 'DROP INDEX session_v2_parent_idx', 'PRAGMA user_version = 1']) {
      expect(fixtureLayout(directory, '2.0.32-fresh', db => db.exec(change))).not.toEqual(migrated);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the project archive migration cannot clone back into an older release', () => {
  for (const version of ['2.0.20', '2.0.24', '2.0.26']) {
    expect(isReviewedNativeClonePair(manifest('2.0.30'), manifest(version), REVIEWED_NATIVE_CLONE_LAYOUT)).toBe(false);
    expect(isReviewedNativeClonePair(manifest('2.0.30'), manifest(version), REVIEWED_NATIVE_FRESH_CLONE_LAYOUT)).toBe(false);
  }
});

test('a release keeps the source DDL of its own migration level', () => {
  for (const version of ['2.0.20', '2.0.24', '2.0.26']) {
    expect(reviewedNativeCloneSourceLayout(version, 'legacy')).toBe(REVIEWED_NATIVE_CLONE_LAYOUT);
    expect(reviewedNativeCloneSourceLayout(version, 'fresh-install')).toBe(REVIEWED_NATIVE_FRESH_CLONE_LAYOUT);
  }
  for (const version of ['2.0.30', '2.0.32', '2.1.0', '2.1.2', '2.1.3', '2.1.4']) {
    expect(reviewedNativeCloneSourceLayout(version, 'legacy')).toBe(REVIEWED_NATIVE_PROJECT_ARCHIVE_CLONE_LAYOUT);
    expect(reviewedNativeCloneSourceLayout(version, 'fresh-install')).toBe(REVIEWED_NATIVE_PROJECT_ARCHIVE_FRESH_CLONE_LAYOUT);
  }
  // No legacy-imported 2.2.0 database has been measured, so none is a reviewed source.
  expect(reviewedNativeCloneSourceLayout('2.2.0', 'legacy')).toBeUndefined();
  expect(reviewedNativeCloneSourceLayout('2.2.0', 'fresh-install')).toBe(REVIEWED_NATIVE_BLOB_STORE_FRESH_CLONE_LAYOUT);
  expect(reviewedNativeCloneSourceLayout('2.2.1', 'legacy')).toBeUndefined();
  expect(reviewedNativeCloneSourceLayout('2.2.1', 'fresh-install')).toBe(REVIEWED_NATIVE_SCHEDULE_FRESH_CLONE_LAYOUT);
  expect(reviewedNativeCloneSourceLayout('2.2.2', 'legacy')).toBeUndefined();
  expect(reviewedNativeCloneSourceLayout('2.2.2', 'fresh-install')).toBe(REVIEWED_NATIVE_SESSION_PART_FRESH_CLONE_LAYOUT);
  expect(reviewedNativeCloneSourceLayout('2.2.5', 'legacy')).toBeUndefined();
  expect(reviewedNativeCloneSourceLayout('2.2.5', 'fresh-install')).toBe(REVIEWED_NATIVE_JOB_FRESH_CLONE_LAYOUT);
  for (const version of ['2.0.31', '2.0.33', undefined]) expect(reviewedNativeCloneSourceLayout(version, 'legacy')).toBeUndefined();
  expect(reviewedNativeCloneSourceLayout('2.0.30', 'imported')).toBeUndefined();
  // A project-archive database never passes as a pre-archive layout, nor the reverse.
  for (const layout of [REVIEWED_NATIVE_PROJECT_ARCHIVE_CLONE_LAYOUT, REVIEWED_NATIVE_PROJECT_ARCHIVE_FRESH_CLONE_LAYOUT]) {
    expect(isReviewedNativeClonePair(manifest('2.0.26'), manifest('2.0.32'), layout)).toBe(false);
  }
  for (const layout of [REVIEWED_NATIVE_CLONE_LAYOUT, REVIEWED_NATIVE_FRESH_CLONE_LAYOUT]) {
    expect(isReviewedNativeClonePair(manifest('2.0.30'), manifest('2.0.32'), layout)).toBe(false);
  }
  expect(isReviewedNativeClonePair(manifest('2.0.30'), manifest('2.0.32'), REVIEWED_NATIVE_PROJECT_ARCHIVE_FRESH_CLONE_LAYOUT)).toBe(true);
  expect(isReviewedNativeClonePair(manifest('2.0.32'), manifest('2.0.30'), REVIEWED_NATIVE_PROJECT_ARCHIVE_FRESH_CLONE_LAYOUT)).toBe(true);
});

test('the exact rebuilt 2.0.26 graph upgrades while unknown rebuilds refuse', () => {
  const source = { ...manifest('2.0.26'), inputs: { coreDigest: REVIEWED_NATIVE_CLONE_REBUILDS['2.0.26'] } };
  expect(isReviewedNativeClonePair(source, manifest('2.0.30'), REVIEWED_NATIVE_FRESH_CLONE_LAYOUT)).toBe(true);
  expect(isReviewedNativeClonePair({ ...source, inputs: { coreDigest: 'a'.repeat(64) } }, manifest('2.0.30'), REVIEWED_NATIVE_FRESH_CLONE_LAYOUT)).toBe(false);
});

test('a production build must carry the reviewed core graph of the host pin', async () => {
  const { TARGET_OPENCODE_VERSION } = await import('../version-policy.js');
  expect(Object.hasOwn(REVIEWED_NATIVE_CLONE_RELEASES, TARGET_OPENCODE_VERSION)).toBe(true);
  expect(() => assertReviewedNativeCoreDigest(manifest(TARGET_OPENCODE_VERSION))).not.toThrow();
  expect(() => assertReviewedNativeCoreDigest({ ...manifest('2.0.26'), inputs: { coreDigest: REVIEWED_NATIVE_CLONE_REBUILDS['2.0.26'] } }, '2.0.26')).not.toThrow();
  for (const build of [manifest('2.0.30'), { ...manifest(TARGET_OPENCODE_VERSION), inputs: { coreDigest: 'a'.repeat(64) } },
    { ...manifest(TARGET_OPENCODE_VERSION), inputs: {} }, undefined]) {
    expect(() => assertReviewedNativeCoreDigest(build)).toThrow(expect.objectContaining({ code: 'native_core_digest_unreviewed' }));
  }
});


test('2.1.0, 2.1.2, 2.1.3 and 2.1.4 message formats cannot clone back into retained older readers', () => {
  for (const source of ['2.1.0', '2.1.2', '2.1.3', '2.1.4']) {
    for (const target of ['2.0.30', '2.0.32']) {
      expect(isReviewedNativeClonePair(manifest(source), manifest(target), REVIEWED_NATIVE_PROJECT_ARCHIVE_FRESH_CLONE_LAYOUT)).toBe(false);
      expect(isReviewedNativeClonePair(manifest(target), manifest(source), REVIEWED_NATIVE_PROJECT_ARCHIVE_FRESH_CLONE_LAYOUT)).toBe(true);
    }
  }
});

test('2.2.0 blob-store databases cannot clone back into 2.1.x readers', () => {
  for (const target of ['2.1.0', '2.1.2', '2.1.3', '2.1.4']) {
    for (const layout of [REVIEWED_NATIVE_BLOB_STORE_FRESH_CLONE_LAYOUT, REVIEWED_NATIVE_PROJECT_ARCHIVE_FRESH_CLONE_LAYOUT]) {
      expect(isReviewedNativeClonePair(manifest('2.2.0'), manifest(target), layout)).toBe(false);
    }
    expect(() => verifyNativeCloneCompatibility({ left: manifest('2.2.0'), right: manifest(target), databasePath: '/does-not-exist' }))
      .toThrow('bundle_v2_upgrade_compatibility_required');
  }
  // A 2.1.x source is checked against its own level 3 layout, never the 2.2.0 one.
  expect(isReviewedNativeClonePair(manifest('2.1.4'), manifest('2.2.0'), REVIEWED_NATIVE_BLOB_STORE_FRESH_CLONE_LAYOUT)).toBe(false);
  expect(isReviewedNativeClonePair(manifest('2.1.4'), manifest('2.2.0'), REVIEWED_NATIVE_PROJECT_ARCHIVE_FRESH_CLONE_LAYOUT)).toBe(true);
});

test('2.2.1 schedule databases cannot clone back into 2.2.0 readers', () => {
  for (const layout of [REVIEWED_NATIVE_SCHEDULE_FRESH_CLONE_LAYOUT, REVIEWED_NATIVE_BLOB_STORE_FRESH_CLONE_LAYOUT]) {
    expect(isReviewedNativeClonePair(manifest('2.2.1'), manifest('2.2.0'), layout)).toBe(false);
  }
  expect(() => verifyNativeCloneCompatibility({ left: manifest('2.2.1'), right: manifest('2.2.0'), databasePath: '/does-not-exist' }))
    .toThrow('bundle_v2_upgrade_compatibility_required');
  // A 2.2.0 source is checked against its own level 4 layout, never the 2.2.1 one.
  expect(isReviewedNativeClonePair(manifest('2.2.0'), manifest('2.2.1'), REVIEWED_NATIVE_SCHEDULE_FRESH_CLONE_LAYOUT)).toBe(false);
  expect(isReviewedNativeClonePair(manifest('2.2.0'), manifest('2.2.1'), REVIEWED_NATIVE_BLOB_STORE_FRESH_CLONE_LAYOUT)).toBe(true);
});

test('2.2.2 session-part databases cannot clone back into 2.2.1 readers', () => {
  for (const layout of [REVIEWED_NATIVE_SESSION_PART_FRESH_CLONE_LAYOUT, REVIEWED_NATIVE_SCHEDULE_FRESH_CLONE_LAYOUT]) {
    expect(isReviewedNativeClonePair(manifest('2.2.2'), manifest('2.2.1'), layout)).toBe(false);
  }
  expect(() => verifyNativeCloneCompatibility({ left: manifest('2.2.2'), right: manifest('2.2.1'), databasePath: '/does-not-exist' }))
    .toThrow('bundle_v2_upgrade_compatibility_required');
  // A 2.2.1 source is checked against its own level 5 layout, never the 2.2.2 one.
  expect(isReviewedNativeClonePair(manifest('2.2.1'), manifest('2.2.2'), REVIEWED_NATIVE_SESSION_PART_FRESH_CLONE_LAYOUT)).toBe(false);
  expect(isReviewedNativeClonePair(manifest('2.2.1'), manifest('2.2.2'), REVIEWED_NATIVE_SCHEDULE_FRESH_CLONE_LAYOUT)).toBe(true);
});

test('2.2.5 job databases cannot clone back into 2.2.2 readers', () => {
  for (const layout of [REVIEWED_NATIVE_JOB_FRESH_CLONE_LAYOUT, REVIEWED_NATIVE_SESSION_PART_FRESH_CLONE_LAYOUT]) {
    expect(isReviewedNativeClonePair(manifest('2.2.5'), manifest('2.2.2'), layout)).toBe(false);
  }
  expect(() => verifyNativeCloneCompatibility({ left: manifest('2.2.5'), right: manifest('2.2.2'), databasePath: '/does-not-exist' }))
    .toThrow('bundle_v2_upgrade_compatibility_required');
  // A 2.2.2 source is checked against its own level 6 layout, never the 2.2.5 one.
  expect(isReviewedNativeClonePair(manifest('2.2.2'), manifest('2.2.5'), REVIEWED_NATIVE_JOB_FRESH_CLONE_LAYOUT)).toBe(false);
  expect(isReviewedNativeClonePair(manifest('2.2.2'), manifest('2.2.5'), REVIEWED_NATIVE_SESSION_PART_FRESH_CLONE_LAYOUT)).toBe(true);
});
