import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyStorage, auditStorage, renderReport, storageMain, validateManifest } from './storage.mjs';
import { cacheBudgetWarning, day, hash, run } from './storage-policy.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const idle = async () => ({ known: true, paths: [] });
const resign = manifest => { const { manifestId: _id, ...body } = manifest; return { ...body, manifestId: hash(JSON.stringify(body)) }; };
const machO = () => Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.alloc(300 * 1024, 1)]);
const rg = '.cache/v2-spike/homes/g2-01-seam-smoke/cache/opencode/bin/rg';
const exists = async file => stat(file).then(() => true, () => false);

// Every fixture is judged 30 days in the future so freshly written files count as old, unless a test pins mtimes.
async function fixture(action) {
  await mkdir(path.join(repository, '.cache/storage-tests'), { recursive: true });
  const root = await mkdtemp(path.join(repository, '.cache/storage-tests/prune-'));
  const now = Date.now() + 30 * day;
  try {
    await run('git', ['init', '-q'], { cwd: root });
    await writeFile(path.join(root, '.gitignore'), '.cache/\nnode_modules/\n');
    await run('git', ['add', '.gitignore'], { cwd: root });
    const put = async (relative, content = 'x', time) => {
      const file = path.join(root, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
      if (time !== undefined) await utimes(file, new Date(time), new Date(time));
      return file;
    };
    const age = async (relative, time) => utimes(path.join(root, relative), new Date(time), new Date(time));
    const audit = extra => auditStorage(root, { usage: idle, now, ...extra });
    const entry = (manifest, relative) => manifest.entries.find(item => item.path === relative);
    await action({ root, now, put, age, audit, entry });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('scratch is removed after 24 hours; anything newer is skipped', () => fixture(async ({ root, now, put, age, audit, entry }) => {
  await put('.cache/test-fixtures/old/a.txt');
  await put('.cache/test-fixtures/new/b.txt', 'x', now - 3600000);
  await age('.cache/test-fixtures/new', now - 3600000);
  await put('.cache/wf/tmp-run/c.txt');
  await put('.cache/v2-validation/journal-reader-1/d.txt');
  await put('.cache/qa/tmp/e.txt');
  const manifest = await audit();
  for (const name of ['test-fixtures/old', 'wf/tmp-run', 'v2-validation/journal-reader-1', 'qa/tmp']) {
    const item = entry(manifest, `.cache/${name}`);
    assert.equal(item.eligible, true, name);
    assert.equal(item.kind, 'remove');
    assert.equal(item.class, 'scratch');
  }
  assert.equal(entry(manifest, '.cache/test-fixtures/new'), undefined);
  assert.ok(manifest.skipped.young >= 1);
  for (const item of manifest.entries.filter(candidate => candidate.eligible)) assert.ok(item.identity.latestMtimeMs <= now - day);
}));

test('a cited file is never selected and a cited directory keeps its light files', () => fixture(async ({ root, now, put, audit, entry }) => {
  await put('.cache/qa/run1/result.json', '{}');
  await put('.cache/qa/run1/bin/tool.node', 'binary');
  await put('.cache/qa/run1/bin/other.node', 'binary');
  await put('.cache/qa/run1/runtime/node_modules/pkg/index.js', 'code');
  await put('.cache/wf/cited/log.txt');
  await put('.cache/wf/plain/log.txt');
  await put('.cache/livetest/x.log');
  await mkdir(path.join(root, 'docs'));
  // Two citations on separate lines guard against a parser that only keeps the first match.
  await writeFile(path.join(root, 'docs/audit.md'), 'See .cache/qa/run1/bin/tool.node.\nAnd `.cache/wf/cited`, plus .cache/livetest/x.log (sha).\n');
  const manifest = await audit();
  const strip = entry(manifest, '.cache/qa/run1');
  assert.equal(strip.kind, 'strip');
  assert.deepEqual([...strip.targets].sort(), ['.cache/qa/run1/bin/other.node', '.cache/qa/run1/runtime/node_modules']);
  assert.equal(entry(manifest, '.cache/wf/cited'), undefined, 'cited scratch is neither removed nor stripped');
  assert.equal(entry(manifest, '.cache/wf/plain').kind, 'remove');
  assert.equal(entry(manifest, '.cache/livetest/x.log'), undefined);
  const report = await applyStorage(manifest, root, { usage: idle, now });
  assert.equal(report.ok, true, JSON.stringify(report.results));
  assert.ok(await exists(path.join(root, '.cache/qa/run1/bin/tool.node')));
  assert.ok(await exists(path.join(root, '.cache/qa/run1/result.json')));
  assert.ok(await exists(path.join(root, '.cache/wf/cited/log.txt')));
  assert.equal(await exists(path.join(root, '.cache/qa/run1/bin/other.node')), false);
  assert.equal(await exists(path.join(root, '.cache/qa/run1/runtime')), true, 'only the heavy subtree goes, not its parent');
  assert.equal(await exists(path.join(root, '.cache/qa/run1/runtime/node_modules')), false);
  assert.equal(await exists(path.join(root, '.cache/wf/plain')), false);
}));

test('run evidence keeps light files and waits three days; unowned files wait fourteen', () => fixture(async ({ root, now, put, age, audit, entry }) => {
  await put('.cache/perf/recent/node_modules/a.js', 'x', now - 2 * day);
  await age('.cache/perf/recent/node_modules', now - 2 * day);
  await age('.cache/perf/recent', now - 2 * day);
  await put('.cache/perf/old/node_modules/a.js');
  await put('.cache/stray.log', 'x', now - 5 * day);
  await put('.cache/old-stray.log');
  await put('.cache/cited-stray.log');
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs/a.md'), 'proof: .cache/cited-stray.log');
  const manifest = await audit();
  assert.equal(entry(manifest, '.cache/perf/recent'), undefined);
  assert.equal(entry(manifest, '.cache/perf/old').kind, 'strip');
  assert.equal(entry(manifest, '.cache/stray.log'), undefined);
  assert.equal(entry(manifest, '.cache/old-stray.log').eligible, true);
  assert.equal(entry(manifest, '.cache/cited-stray.log'), undefined);
}));

test('pins in run.json or storage-retention.json keep a run intact; failures beyond five are stripped', () => fixture(async ({ put, audit, entry }) => {
  await put('.cache/qa/pinned-a/node_modules/x.js');
  await put('.cache/qa/pinned-a/run.json', JSON.stringify({ schemaVersion: 1, status: 'passed', pinned: true, completedAt: '2026-01-01T00:00:00Z' }));
  await put('.cache/qa/pinned-b/node_modules/x.js');
  await put('.cache/qa/pinned-b/storage-retention.json', JSON.stringify({ schemaVersion: 1, pinned: true, payloadState: 'ready' }));
  await put('.cache/qa/passed/node_modules/x.js');
  await put('.cache/qa/passed/run.json', JSON.stringify({ schemaVersion: 1, status: 'passed', pinned: false, completedAt: '2026-01-01T00:00:00Z' }));
  for (let i = 1; i <= 7; i++) {
    await put(`.cache/perf/fail-${i}/node_modules/x.js`);
    await put(`.cache/perf/fail-${i}/run.json`, JSON.stringify({ schemaVersion: 1, status: 'failed', pinned: false, completedAt: `2026-01-0${i}T00:00:00Z` }));
  }
  const manifest = await audit();
  for (const name of ['pinned-a', 'pinned-b']) {
    assert.equal(entry(manifest, `.cache/qa/${name}`).eligible, false);
    assert.deepEqual(entry(manifest, `.cache/qa/${name}`).reasons, ['Pinned']);
  }
  assert.equal(entry(manifest, '.cache/qa/passed').eligible, true);
  const kept = manifest.entries.filter(item => item.path.startsWith('.cache/perf/fail-') && !item.eligible).map(item => item.path).sort();
  assert.deepEqual(kept, [3, 4, 5, 6, 7].map(i => `.cache/perf/fail-${i}`));
  assert.equal(entry(manifest, '.cache/perf/fail-1').eligible, true);
  assert.equal(entry(manifest, '.cache/perf/fail-2').eligible, true);
}));

test('worktrees are report-only: never selected, with removal advice only for clean branch checkouts', () => fixture(async ({ root, now, audit, entry, put }) => {
  await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
  await run('git', ['worktree', 'add', '-q', '-b', 'feature', '.cache/worktrees/clean', 'HEAD'], { cwd: root });
  await run('git', ['worktree', 'add', '-q', '--detach', '.cache/worktrees/detached', 'HEAD'], { cwd: root });
  await run('git', ['worktree', 'add', '-q', '-b', 'dirty-branch', '.cache/worktrees/dirty', 'HEAD'], { cwd: root });
  await put('.cache/worktrees/dirty/unsaved.txt', 'work');
  await put('.cache/worktrees/clean/node_modules/x.js');
  const manifest = await audit();
  assert.equal(manifest.entries.filter(item => item.eligible && item.path.startsWith('.cache/worktrees')).length, 0);
  assert.equal(entry(manifest, '.cache/worktrees/clean')?.eligible ?? false, false);
  const byName = name => manifest.worktrees.find(tree => tree.path.endsWith(name));
  assert.match(byName('/clean').advice, /^git worktree remove /);
  assert.equal(byName('/detached').advice, null);
  assert.equal(byName('/dirty').advice, null);
  assert.equal(manifest.families.find(family => family.name === 'worktrees').class, 'worktrees');
  assert.match(renderReport(manifest), /suggest: git worktree remove/);
  assert.equal((await applyStorage(manifest, root, { usage: idle, now })).ok, true);
  assert.ok(await exists(path.join(root, '.cache/worktrees/clean/node_modules/x.js')));
  await run('git', ['worktree', 'remove', '--force', '.cache/worktrees/dirty'], { cwd: root });
  await rm(path.join(root, '.cache/worktrees/clean'), { recursive: true });
  assert.equal((await audit()).worktrees.find(tree => tree.path.endsWith('/clean')).advice, 'git worktree prune');
}));

test('the pinned ripgrep input and its siblings are protected whether or not code cites it', () => fixture(async ({ root, now, put, audit, entry }) => {
  await put(rg, machO());
  await put('.cache/v2-spike/homes/g2-01-seam-smoke/cache/opencode/bin/other', machO());
  await put('.cache/v2-spike/homes/g2-01-seam-smoke/node_modules/m/index.js');
  await put('.cache/v2-spike/homes/g2-01-seam-smoke/state.json', '{}');
  const check = async () => {
    const manifest = await audit();
    const homes = entry(manifest, '.cache/v2-spike/homes');
    assert.equal(homes.kind, 'strip');
    assert.deepEqual([...homes.targets].sort(), ['.cache/v2-spike/homes/g2-01-seam-smoke/cache/opencode/bin/other',
      '.cache/v2-spike/homes/g2-01-seam-smoke/node_modules']);
    for (const item of manifest.entries.filter(candidate => candidate.eligible)) {
      assert.ok(!(item.targets ?? [item.path]).some(target => target === rg || rg.startsWith(`${target}/`)), 'rg is never a target');
    }
    return manifest;
  };
  await check();
  await mkdir(path.join(root, 'scripts/opencode-v2-native'), { recursive: true });
  await writeFile(path.join(root, 'scripts/opencode-v2-native/artifacts.mjs'), `export const DEFAULT_RG = path.join(root, '${rg}');\n`);
  const manifest = await check();
  const forged = resign({ ...manifest, entries: [{ ...homes(manifest), kind: 'remove', path: rg, targets: undefined }] });
  assert.throws(() => validateManifest(forged, root), /Unrecognized/);
  const escaping = resign({ ...manifest, entries: [{ ...homes(manifest), targets: [rg] }] });
  assert.throws(() => validateManifest(escaping, root), /Unrecognized/);
  assert.throws(() => validateManifest(resign({ ...manifest, entries: [{ ...homes(manifest), targets: ['.cache/v2-spike/homes/../../x'] }] }), root), /Unrecognized/);
  assert.equal((await applyStorage(manifest, root, { usage: idle, now })).ok, true);
  assert.ok(await exists(path.join(root, rg)));
  function homes(current) { return entry(current, '.cache/v2-spike/homes'); }
}));

test('the budget evicts the oldest eligible runs first, never cited, pinned or tiny ones', () => fixture(async ({ root, now, put, audit, entry }) => {
  const big = 'x'.repeat(2 * 1024 * 1024);
  for (const [name, completed] of [['oldest', '2026-01-01'], ['older', '2026-01-02'], ['newer', '2026-01-03'], ['pinned', '2026-01-01'], ['cited', '2026-01-01'], ['tiny', '2026-01-01']]) {
    await put(`.cache/perf/${name}/result.json`, name === 'tiny' ? '{}' : big);
    await put(`.cache/perf/${name}/run.json`, JSON.stringify({ schemaVersion: 1, status: 'passed', pinned: name === 'pinned', completedAt: `${completed}T00:00:00Z` }));
  }
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs/a.md'), 'proof .cache/perf/cited/result.json');
  const none = await audit({ maxBytes: 1024 ** 3 });
  assert.equal(none.entries.filter(item => item.budget).length, 0);
  const manifest = await audit({ maxBytes: 7 * 1024 * 1024 });
  const evicted = manifest.entries.filter(item => item.budget).map(item => item.path);
  assert.deepEqual(evicted, ['.cache/perf/oldest', '.cache/perf/older']);
  for (const name of ['pinned', 'cited', 'tiny']) assert.ok(!evicted.includes(`.cache/perf/${name}`));
  assert.equal(entry(manifest, '.cache/perf/pinned').eligible, false);
  assert.equal((await applyStorage(manifest, root, { usage: idle, now })).ok, true);
  assert.equal(await exists(path.join(root, '.cache/perf/oldest')), false);
  assert.ok(await exists(path.join(root, '.cache/perf/cited/result.json')));
}));

test('apply refuses a unit that changed after the preview, and plain clean never deletes', () => fixture(async ({ root, now, put, audit, entry }) => {
  await put('.cache/qa/run1/node_modules/a.js');
  await put('.cache/qa/run1/result.json', '{}');
  const manifest = await audit();
  await put('.cache/qa/run1/node_modules/b.js', 'late write');
  const refused = await applyStorage(manifest, root, { usage: idle, now });
  assert.equal(refused.ok, false);
  assert.ok(await exists(path.join(root, '.cache/qa/run1/node_modules/a.js')));
  const active = await auditStorage(root, { usage: async () => ({ known: true, paths: [{ pid: 1, path: path.join(root, '.cache/qa/run1/node_modules/a.js') }] }), now: Date.now() + 30 * day });
  assert.equal(entry(active, '.cache/qa/run1').eligible, false);
  assert.ok(entry(active, '.cache/qa/run1').reasons.includes('In use by a process'));
  assert.equal(await storageMain(['clean', '--quiet'], root), 0);
  assert.ok(await exists(path.join(root, '.cache/qa/run1/node_modules/a.js')), 'preview deletes nothing');
}));

test('the report lists every top-level family with owner, class and size, and the budget warning only warns', () => fixture(async ({ put, audit }) => {
  await put('.cache/qa/run1/result.json', '{}');
  await put('.cache/eslint/cache.json', '{}');
  await put('.cache/unknown-dir/a.txt');
  await put('.cache/loose.log');
  const manifest = await audit();
  const names = manifest.families.map(family => family.name).sort();
  assert.deepEqual(names, ['eslint', 'loose.log', 'qa', 'unknown-dir']);
  assert.ok(manifest.families.every(family => family.owner && family.class && Number.isFinite(family.bytes)));
  const text = renderReport(manifest);
  assert.match(text, /qa\s+run-evidence/);
  assert.match(text, /eslint\s+tool-cache/);
  assert.match(text, /1 loose root files/);
  const over = cacheBudgetWarning('/x', { maxBytes: 10, measure: () => 100, disk: () => ({ freeBytes: 1 }) });
  assert.match(over, /over the .* budget/);
  assert.match(over, /free disk/);
  assert.equal(cacheBudgetWarning('/x', { measure: () => 1, disk: () => ({ freeBytes: 2 ** 40 }) }), null);
  assert.equal(cacheBudgetWarning('/x', { measure: () => { throw new Error('boom'); } }), null);
}));

test('a QA package touched within 24 hours is never selected, even when superseded', async () => {
  await mkdir(path.join(repository, '.cache/storage-tests'), { recursive: true });
  const root = await mkdtemp(path.join(repository, '.cache/storage-tests/prune-'));
  try {
    await run('git', ['init', '-q'], { cwd: root });
    await writeFile(path.join(root, '.gitignore'), '.cache/\n');
    for (const [index, name] of ['aold', 'bmiddle', 'cnewest'].entries()) {
      const scope = `.cache/qa/packaged-electron-${name}`, app = `${scope}/app/mac-arm64/DevRyan QA.app`;
      await mkdir(path.join(root, app, 'Contents/Resources'), { recursive: true });
      await writeFile(path.join(root, app, 'Contents/Resources/app.asar'), 'fixture archive');
      await writeFile(path.join(root, scope, 'package-evidence.json'), JSON.stringify({ schemaVersion: 1, output: path.join(root, scope), appPath: path.join(root, app),
        archiveSha256: hash('fixture archive'), nativeSmoke: { sqlite: 'passed', pty: 'passed' } }));
      await writeFile(path.join(root, scope, 'storage-retention.json'), JSON.stringify({ schemaVersion: 1, createdAt: '2026-01-01T00:00:00Z',
        completedAt: `2026-01-0${index + 1}T00:00:00Z`, pinned: false, payloadState: 'ready' }));
    }
    const fresh = await auditStorage(root, { usage: idle });
    assert.equal(fresh.entries.filter(item => item.eligible).length, 0);
    assert.ok(fresh.entries[0].reasons.includes('Modified within the last 24 hours'));
    const old = await auditStorage(root, { usage: idle, now: Date.now() + 30 * day });
    assert.equal(old.entries.filter(item => item.eligible).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('packaged outputs keep their newest two per kind and shared caches are report-only', () => fixture(async ({ put, audit, entry }) => {
  for (let i = 1; i <= 4; i++) {
    await put(`.cache/qa/stage-f-v2-prepared-${i}/app/X.app/Contents/a`);
    await put(`.cache/qa/stage-f-v2-prepared-${i}/run.json`, JSON.stringify({ schemaVersion: 1, status: 'passed', pinned: false, completedAt: `2026-01-0${i}T00:00:00Z` }));
  }
  await put('.cache/shared/bun-install-cache/pkg/a.js');
  const manifest = await audit();
  const kept = manifest.entries.filter(item => item.path.includes('stage-f') && !item.eligible).map(item => item.path).sort();
  assert.deepEqual(kept, ['.cache/qa/stage-f-v2-prepared-3', '.cache/qa/stage-f-v2-prepared-4']);
  assert.equal(entry(manifest, '.cache/qa/stage-f-v2-prepared-1').kind, 'strip');
  assert.equal(manifest.entries.some(item => item.path.startsWith('.cache/shared')), false);
  assert.equal(manifest.families.find(family => family.name === 'shared').class, 'report-only');
}));
