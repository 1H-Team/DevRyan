import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyStorage, auditStorage, storageMain, validateManifest } from './storage.mjs';
import { hash, run, treeIdentity } from './storage-policy.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const idle = async () => ({ known: true, paths: [] });
const resign = manifest => { const { manifestId: _id, ...body } = manifest; return { ...body, manifestId: hash(JSON.stringify(body)) }; };
async function fixture(action) {
  await mkdir(path.join(repository, '.cache/storage-tests'), { recursive: true });
  const root = await mkdtemp(path.join(repository, '.cache/storage-tests/fixture-'));
  try {
    await run('git', ['init', '-q'], { cwd: root });
    await writeFile(path.join(root, '.gitignore'), '.cache/\npackages/desktop/src-tauri/target/\n');
    await run('git', ['add', '.gitignore'], { cwd: root });
    const items = [];
    for (const [index, name] of ['aold', 'bmiddle', 'cnewest'].entries()) {
      const scope = `.cache/qa/packaged-electron-${name}`;
      const app = `${scope}/app/mac-arm64/DevRyan QA.app`;
      await mkdir(path.join(root, app, 'Contents/Resources'), { recursive: true });
      await writeFile(path.join(root, app, 'Contents/Resources/app.asar'), 'fixture archive');
      const evidence = { schemaVersion: 1, output: path.join(root, scope), appPath: path.join(root, app),
        archiveSha256: hash('fixture archive'), nativeSmoke: { sqlite: 'passed', pty: 'passed' } };
      await writeFile(path.join(root, scope, 'package-evidence.json'), JSON.stringify(evidence));
      const retention = { schemaVersion: 1, createdAt: '2026-01-01T00:00:00Z',
        completedAt: `2026-01-0${index + 1}T00:00:00Z`, pinned: false, payloadState: 'ready' };
      await writeFile(path.join(root, scope, 'storage-retention.json'), JSON.stringify(retention));
      await writeFile(path.join(root, scope, 'result.json'), '{"outcome":"passed"}');
      items.push({ scope, app, evidence, retention });
    }
    await action({ root, items, audit: () => auditStorage(root, { usage: idle }) });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('preview preserves payloads; apply deletes only superseded executable and keeps immutable evidence', () => fixture(async ({ root, items, audit }) => {
  const before = await readFile(path.join(root, items[0].scope, 'package-evidence.json'));
  const manifest = await audit();
  assert.deepEqual(manifest.entries.filter(e => e.eligible).map(e => e.path), [items[0].app]);
  await treeIdentity(path.join(root, items[0].app));
  const report = await applyStorage(manifest, root, { usage: idle });
  assert.equal(report.ok, true);
  await assert.rejects(readFile(path.join(root, items[0].app, 'Contents/Resources/app.asar')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(path.join(root, items[0].scope, 'package-evidence.json')), before);
  assert.equal(JSON.parse(await readFile(path.join(root, items[0].scope, 'storage-retention.json'))).payloadState, 'historical');
  assert.equal((await audit()).entries.filter(e => e.eligible).length, 0);
  assert.equal((await applyStorage(manifest, root, { usage: idle })).ok, false);
}));

test('pinned, referenced baselines and active packages are protected', () => fixture(async ({ root, items, audit }) => {
  await writeFile(path.join(root, items[0].scope, 'storage-retention.json'), JSON.stringify({ ...items[0].retention, pinned: true }));
  assert.equal((await audit()).entries[0].eligible, false);
  await writeFile(path.join(root, items[0].scope, 'storage-retention.json'), JSON.stringify(items[0].retention));
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs/audit.md'), `Required baseline: ${items[0].scope}/package-evidence.json`);
  assert.equal((await audit()).entries[0].eligible, false);
  await rm(path.join(root, 'docs/audit.md'));
  const active = await auditStorage(root, { usage: async () => ({ known: true, paths: [{ pid: 123, path: path.join(root, items[0].app, 'Contents/Resources/app.asar') }] }) });
  assert.equal(active.entries[0].eligible, false);
  const unknown = await auditStorage(root, { usage: async () => ({ known: false, paths: [] }) });
  assert.equal(unknown.entries.filter(e => e.eligible).length, 0);
}));

test('ordinary audit evidence references survive without pinning every superseded executable', () => fixture(async ({ root, items, audit }) => {
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs/audit.md'), `Historical result: ${items[0].scope}/package-evidence.json`);
  const entry = (await audit()).entries[0];
  assert.equal(entry.eligible, true);
  assert.deepEqual(entry.references, [{ source: 'docs/audit.md', required: false }]);
}));

test('a native donor is kept even when it would otherwise be superseded', () => fixture(async ({ root, items, audit }) => {
  await writeFile(path.join(root, items[1].scope, 'package-evidence.json'), JSON.stringify({
    ...items[1].evidence, nativeSourceApp: path.join(root, items[0].app),
  }));
  const entry = (await audit()).entries.find(e => e.path === items[0].app);
  assert.equal(entry.eligible, false);
  assert.ok(entry.reasons.includes('Native-module donor'));
  await writeFile(path.join(root, items[1].scope, 'storage-retention.json'), JSON.stringify({
    ...items[1].retention, payloadState: 'historical',
  }));
  assert.ok((await audit()).entries.find(e => e.path === items[0].app).reasons.includes('Native-module donor'));
}));

test('the clean CLI without apply is read-only, including quiet noninteractive use', () => fixture(async ({ root, items }) => {
  const before = await treeIdentity(path.join(root, items[0].app));
  const metadataFile = path.join(root, items[0].scope, 'storage-retention.json');
  const metadata = await readFile(metadataFile);
  assert.equal(await storageMain(['clean', '--quiet'], root), 0);
  assert.deepEqual(await treeIdentity(path.join(root, items[0].app)), before);
  assert.deepEqual(await readFile(metadataFile), metadata);
}));

test('changed manifest, forged paths, overlapping paths and source files cannot be removed', () => fixture(async ({ root, items, audit }) => {
  const manifest = await audit();
  assert.throws(() => validateManifest({ ...manifest, root: '/' }, root), /manifest/);
  assert.throws(() => validateManifest(resign({ ...manifest, entries: [{ ...manifest.entries[0], path: '../outside' }] }), root), /Unrecognized/);
  assert.throws(() => validateManifest(resign({ ...manifest, entries: [manifest.entries[0], manifest.entries[0]] }), root), /Overlapping/);
  const source = `${items[0].app}/user-work.txt`;
  await writeFile(path.join(root, source), 'never remove');
  await run('git', ['add', '-f', '--', source], { cwd: root });
  assert.equal((await audit()).entries[0].eligible, false);
  assert.equal((await applyStorage(manifest, root, { usage: idle })).ok, false);
  assert.equal(await readFile(path.join(root, source), 'utf8'), 'never remove');
}));

test('changed payload and newly introduced pin invalidate an old manifest', () => fixture(async ({ root, items, audit }) => {
  let manifest = await audit();
  await writeFile(path.join(root, items[0].app, 'Contents/Resources/app.asar'), 'changed archive');
  assert.equal((await applyStorage(manifest, root, { usage: idle })).ok, false);
  await writeFile(path.join(root, items[0].app, 'Contents/Resources/app.asar'), 'fixture archive');
  manifest = await audit();
  await writeFile(path.join(root, items[0].scope, 'storage-retention.json'), JSON.stringify({ ...items[0].retention, pinned: true }));
  assert.equal((await applyStorage(manifest, root, { usage: idle })).ok, false);
}));

test('symlink escapes and aliased candidate roots fail closed', () => fixture(async ({ root, items, audit }) => {
  const outside = path.join(root, 'protected');
  await writeFile(outside, 'protected');
  await symlink(outside, path.join(root, items[0].app, 'outside'));
  assert.equal((await audit()).entries[0].eligible, false);
  await rm(path.join(root, items[0].app, 'outside'));
  const manifest = await audit();
  await rm(path.join(root, items[0].app), { recursive: true });
  await symlink(path.join(root, items[1].app), path.join(root, items[0].app));
  assert.equal((await applyStorage(manifest, root, { usage: idle })).ok, false);
  assert.equal(await readFile(outside, 'utf8'), 'protected');
}));

test('partial failures are durable, non-successful and never leave the package marked ready', () => fixture(async ({ root, items, audit }) => {
  const report = await applyStorage(await audit(), root, { usage: idle, remove: async () => { throw new Error('simulated IO failure'); } });
  assert.equal(report.ok, false);
  assert.equal(report.results[0].outcome, 'partial-failure');
  assert.equal(JSON.parse(await readFile(path.join(root, items[0].scope, 'storage-retention.json'))).payloadState, 'removing');
  assert.equal(JSON.parse(await readFile(path.join(root, report.reportFile))).ok, false);
  await assert.rejects(readFile(path.join(root, '.cache/storage/apply.lock')), { code: 'ENOENT' });
}));

test('process usage is checked again immediately before each deletion', () => fixture(async ({ root, items, audit }) => {
  let calls = 0;
  const report = await applyStorage(await audit(), root, { usage: async () => ++calls === 1
    ? idle() : { known: true, paths: [{ pid: 99, path: path.join(root, items[0].app) }] } });
  assert.equal(report.ok, false);
  await treeIdentity(path.join(root, items[0].app));
}));

test('registered dirty worktrees are retained, including ignored generated payloads', () => fixture(async ({ root, items, audit }) => {
  await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
  const nested = `${items[0].app}/workspace`;
  await run('git', ['worktree', 'add', '--detach', nested, 'HEAD'], { cwd: root });
  await writeFile(path.join(root, nested, 'important.txt'), 'uncommitted source');
  assert.equal((await audit()).entries[0].eligible, false);
  assert.equal(await readFile(path.join(root, nested, 'important.txt'), 'utf8'), 'uncommitted source');
}));

test('Cargo cleanup requires recognized outputs and every descendant to be older than fourteen days', () => fixture(async ({ root, audit }) => {
  const base = 'packages/desktop/src-tauri';
  await mkdir(path.join(root, base, 'target/release'), { recursive: true });
  await writeFile(path.join(root, base, 'Cargo.toml'), '[package]');
  await writeFile(path.join(root, base, 'target/.rustc_info.json'), '{}');
  await writeFile(path.join(root, base, 'target/release/generated'), 'build output');
  let entry = (await audit()).entries.find(e => e.kind === 'cargo-cache');
  assert.equal(entry.eligible, false);
  const past = new Date(Date.now() - 16 * 86400000);
  await utimes(path.join(root, base, 'target/release/generated'), past, past);
  await utimes(path.join(root, base, 'target/release'), past, past);
  entry = (await audit()).entries.find(e => e.kind === 'cargo-cache');
  assert.equal(entry.eligible, true);
}));

test('CLI invalid inputs fail identically regardless of output mode; no implicit apply', () => fixture(async ({ root }) => {
  for (const mode of [[], ['--json'], ['--quiet']]) {
    await assert.rejects(storageMain(['audit', '--apply', 'missing.json', ...mode], root), /Incompatible/);
    await assert.rejects(storageMain(['clean', '--unknown', ...mode], root), /Invalid/);
    await assert.rejects(storageMain(['clean', '--apply', '../outside', ...mode], root), /Invalid repository/);
  }
  await assert.rejects(storageMain(['clean', '--apply'], root), /Missing/);
}));

test('malformed manifest errors never echo file contents and arbitrary repository files are not manifest inputs', () => fixture(async ({ root }) => {
  await mkdir(path.join(root, '.cache/storage'), { recursive: true });
  await writeFile(path.join(root, '.cache/storage/malformed.json'), 'PRIVATE_SENTINEL_NOT_JSON');
  await assert.rejects(storageMain(['clean', '--apply', '.cache/storage/malformed.json'], root), error =>
    error.message === 'Invalid JSON storage metadata' && !error.message.includes('PRIVATE_SENTINEL'));
  await writeFile(path.join(root, 'private.json'), 'PRIVATE_SENTINEL_NOT_JSON');
  await assert.rejects(storageMain(['clean', '--apply', 'private.json'], root), /Manifest input must be/);
}));
