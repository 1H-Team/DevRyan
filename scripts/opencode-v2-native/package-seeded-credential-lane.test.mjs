import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveSqliteDriver } from '../../packages/web/server/lib/opencode/db-maintenance-core.js';
import { writeNativeSetupSeed, assertNativeSetupSeedConsumed, NATIVE_SETUP_CREDENTIAL_STAMP, SEEDED_INTEGRATION_ID } from './package-seeded-credential-lane.mjs';

const withRoot = async action => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-seeded-credential-')));
  try { return await action(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
};
const database = async (file, stamp) => {
  await fs.writeFile(file, '', { flag: 'wx' });
  const db = resolveSqliteDriver().open(file);
  try {
    db.prepare('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
    if (stamp !== undefined) db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(NATIVE_SETUP_CREDENTIAL_STAMP, JSON.stringify(stamp));
  } finally { db.close(); }
};

test('the fixture seed is the production auth.json projection of one fake API key, written once and private', () => withRoot(async root => {
  const seed = await writeNativeSetupSeed(root);
  assert.equal(seed.seedPath, path.join(root, 'native-setup-credentials.json'));
  const bytes = await fs.readFile(seed.seedPath);
  assert.equal(bytes.length, seed.bytes); assert.equal(seed.count, 1); assert.match(seed.sha256, /^[a-f0-9]{64}$/);
  const value = JSON.parse(bytes);
  assert.deepEqual(Object.keys(value), ['schema', 'credentials']); assert.equal(value.schema, 1);
  assert.deepEqual(value.credentials.map(row => [row.integrationID, row.label, row.value.type]), [[SEEDED_INTEGRATION_ID, 'API key', 'key']]);
  assert.equal((await fs.stat(seed.seedPath)).mode & 0o777, 0o600);
  await assert.rejects(writeNativeSetupSeed(root), { code: 'EEXIST' });
}));

test('seed consumption requires the unlinked seed and the controller stamp binding its exact digest and count', () => withRoot(async root => {
  const seed = await writeNativeSetupSeed(path.join(root));
  const consumed = { seedPath: seed.seedPath, sha256: seed.sha256, count: seed.count };
  const stamped = path.join(root, 'stamped.db'); await database(stamped, { schema: 1, sha256: seed.sha256, count: 1 });
  await assert.rejects(assertNativeSetupSeedConsumed({ ...consumed, databasePath: stamped }), /survived its first boot/);
  await fs.rm(seed.seedPath);
  assert.deepEqual(await assertNativeSetupSeedConsumed({ ...consumed, databasePath: stamped }), { schema: 1, sha256: seed.sha256, count: 1 });
  const unstamped = path.join(root, 'unstamped.db'); await database(unstamped);
  await assert.rejects(assertNativeSetupSeedConsumed({ ...consumed, databasePath: unstamped }), /never stamped/);
  const foreign = path.join(root, 'foreign.db'); await database(foreign, { schema: 1, sha256: 'a'.repeat(64), count: 1 });
  await assert.rejects(assertNativeSetupSeedConsumed({ ...consumed, databasePath: foreign }), /does not bind the seeded bytes/);
  const counted = path.join(root, 'counted.db'); await database(counted, { schema: 1, sha256: seed.sha256, count: 0 });
  await assert.rejects(assertNativeSetupSeedConsumed({ ...consumed, databasePath: counted }), /does not bind the seeded bytes/);
}));
