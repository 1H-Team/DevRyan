import { expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSqliteDriver } from '../db-maintenance-core.js';
import { inspectNativeCloneLayout, isReviewedNativeClonePair, REVIEWED_NATIVE_CLONE_RELEASES, REVIEWED_NATIVE_CLONE_LAYOUT,
  REVIEWED_NATIVE_FRESH_CLONE_LAYOUT, REVIEWED_NATIVE_CLONE_MIGRATION_LEVEL, verifyNativeCloneCompatibility } from './native-bundle-compatibility.js';

const manifest = version => ({ opencodeVersion: version, inputs: { coreDigest: REVIEWED_NATIVE_CLONE_RELEASES[version] },
  compiledContracts: ['devryan-v2-clone/1', 'devryan.bundle.credentials/2', 'devryan.bundle.credential-owners/2'] });
test.each([['2.0.20', '2.0.24'], ['2.0.24', '2.0.20'], ['2.0.20', '2.0.26'], ['2.0.24', '2.0.26']])('only the reviewed exact release graphs and layout permit %s to %s', (source, target) => {
  const left = manifest(source), right = manifest(target);
  expect(isReviewedNativeClonePair(left, right, REVIEWED_NATIVE_CLONE_LAYOUT)).toBe(true);
  for (const version of ['2.0.21', '2.0.25', '2.0.27', `${source}-dev`, ` ${source} `, null, undefined]) {
    expect(isReviewedNativeClonePair({ ...left, opencodeVersion: version }, right, REVIEWED_NATIVE_CLONE_LAYOUT)).toBe(false);
    expect(isReviewedNativeClonePair(left, { ...right, opencodeVersion: version }, REVIEWED_NATIVE_CLONE_LAYOUT)).toBe(false);
  }
  for (const coreDigest of ['0'.repeat(64), right.inputs.coreDigest, '', undefined]) {
    expect(isReviewedNativeClonePair({ ...left, inputs: { coreDigest } }, right, REVIEWED_NATIVE_CLONE_LAYOUT)).toBe(false);
  }
  for (const coreDigest of ['0'.repeat(64), left.inputs.coreDigest, '', undefined]) {
    expect(isReviewedNativeClonePair(left, { ...right, inputs: { coreDigest } }, REVIEWED_NATIVE_CLONE_LAYOUT)).toBe(false);
  }
  for (const [key, value] of [['schemaSha256', '0'.repeat(64)], ['migrationsSha256', '0'.repeat(64)], ['userVersion', 1]]) {
    expect(isReviewedNativeClonePair(left, right, { ...REVIEWED_NATIVE_CLONE_LAYOUT, [key]: value })).toBe(false);
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
test('a fresh-install database qualifies only with its exact reviewed DDL and no legacy migration table', () => {
  const left = manifest('2.0.20'), right = manifest('2.0.26');
  expect(isReviewedNativeClonePair(left, right, REVIEWED_NATIVE_FRESH_CLONE_LAYOUT)).toBe(true);
  for (const [key, value] of [['schemaSha256', REVIEWED_NATIVE_CLONE_LAYOUT.schemaSha256], ['schemaSha256', '0'.repeat(64)],
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
    expect(imported.migrationsSha256).toMatch(/^[a-f0-9]{64}$/); expect(imported.schemaSha256).not.toBe(fresh.schemaSha256);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
