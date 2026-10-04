import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createMigrationFixture, createEmptyRuntimeFixture, createMigrationRefusalCopy, fixtureSha256 } from './migration-fixture.mjs';
import { repositoryRoot } from './artifacts.mjs';
import { resolveSqliteDriver } from '../../packages/web/server/lib/opencode/db-maintenance-core.js';
import { captureMigrationInventory } from '../../packages/web/server/lib/opencode/runtime-host/bundle-migration-inventory.js';

const temporaryRoot = path.join(repositoryRoot, '.cache/v2-validation/tmp');
await fs.mkdir(temporaryRoot, { recursive: true });

test('legacy fixture executes truthful DDL and retains two relocations, references and exact source identities', async () => {
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'migration-fixture-'));
  try {
    const fixture = await createMigrationFixture({ root });
    const { expected, sourceLaunch } = fixture;
    const db = resolveSqliteDriver().open(sourceLaunch.opencodeDatabasePath, { readonly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session').get().n, 6);
      assert.deepEqual(db.prepare('SELECT name FROM __drizzle_migrations').all().map(row => row.name), expected.appliedMigrations);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('migration','kv','session_v2')").get().n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session WHERE parent_id IS NOT NULL').get().n, 2);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session WHERE time_archived IS NOT NULL').get().n, 2);
      assert.deepEqual(db.prepare('SELECT id FROM message ORDER BY id').all().map(row => row.id), [...expected.messageIDs].sort());
      for (const compaction of expected.compactions) assert.equal(JSON.parse(db.prepare('SELECT data FROM message WHERE id=?').get(compaction.foldedSummaryID).data).summary, true);
      assert.deepEqual(JSON.parse(db.prepare('SELECT permission FROM session LIMIT 1').get().permission).map(rule => rule.action), ['ask', 'allow', 'deny', 'allow']);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally { db.close(); }
    assert.notEqual(sourceLaunch.webConfigDirectory, sourceLaunch.opencodeConfigDirectory);
    assert.equal(sourceLaunch.global.config, sourceLaunch.opencodeConfigDirectory);
    for (const config of expected.configurations) assert.equal(fixtureSha256(await fs.readFile(config.file)), config.sha256);
    for (const attachment of expected.attachments) {
      assert.equal(fixtureSha256(await fs.readFile(new URL(attachment.originalURI))), attachment.sha256);
      assert.equal(attachment.size, Buffer.byteLength(`attachment ${attachment.originalURI.includes('alpha') ? 'alpha' : 'beta'} exact bytes\r\n`));
    }
    assert.equal(fixture.projectMap.length, 2);
    for (const project of expected.projects) {
      assert.ok(project.refs.some(ref => ref.startsWith('refs/devryan/fixture-checkpoint ')));
      assert.equal(await fs.readFile(path.join(project.directory, 'seed.txt'), 'utf8'), await fs.readFile(path.join(project.targetDirectory, 'seed.txt'), 'utf8'));
      assert.equal(await fs.readFile(path.join(project.directory, '.git/HEAD'), 'utf8'), await fs.readFile(path.join(project.targetDirectory, '.git/HEAD'), 'utf8'));
    }
    assert.equal(fixtureSha256(await fs.readFile(sourceLaunch.opencodeDatabasePath)), expected.databaseSha256);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('staged Revert, unknown marker and unsupported remembered denial fail closed on independent fixture copies', async () => {
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'migration-refusals-'));
  try {
    const fixture = await createMigrationFixture({ root });
    for (const kind of ['pending-revert', 'remembered-deny', 'unknown-marker']) {
      const negative = await createMigrationRefusalCopy(fixture, kind);
      const before = fixtureSha256(await fs.readFile(negative.databasePath));
      const db = resolveSqliteDriver().open(negative.databasePath, { readonly: true });
      try { assert.throws(() => captureMigrationInventory({ all: (sql, params = []) => db.prepare(sql).all(...params) }),
        error => error.code === negative.expectedCode); } finally { db.close(); }
      assert.equal(fixtureSha256(await fs.readFile(negative.databasePath)), before);
    }
    assert.equal(fixtureSha256(await fs.readFile(fixture.sourceLaunch.opencodeDatabasePath)), fixture.expected.databaseSha256);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});


test('native initialization seed preserves setup and workspaces without old conversations or journals', async () => {
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'empty-native-fixture-'));
  try {
    const fixture = await createEmptyRuntimeFixture({root});
    const db = resolveSqliteDriver().open(fixture.sourceLaunch.opencodeDatabasePath,{readonly:true});
    try {
      for(const table of ['session','message','part']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM project').get().n,2);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    } finally { db.close(); }
    assert.deepEqual(fixture.expected.sessions,[]); assert.deepEqual(fixture.expected.messageIDs,[]);
    assert.deepEqual(fixture.expected.compactions,[]); assert.deepEqual(await fs.readdir(fixture.sourceLaunch.webDataDirectory),[]);
    for(const row of fixture.projectMap) assert.equal(await fs.readFile(path.join(row.sourceDirectory,'seed.txt'),'utf8'),
      await fs.readFile(path.join(row.targetDirectory,'seed.txt'),'utf8'));
    for(const row of fixture.expected.configurations) assert.equal(fixtureSha256(await fs.readFile(row.file)),row.sha256);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
