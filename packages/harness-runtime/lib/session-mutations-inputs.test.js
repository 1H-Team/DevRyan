import { afterEach, expect, spyOn, test as bunTest } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from './session-changes-git.js';
import { createSessionMutationRuntime } from './session-mutations.js';
import { openChangeStore, changeKey } from './session-changes-store.js';
import { sessionExecutionProfile } from './session-execution.js';

// Gitignored directories are dependency inputs: linked read-only into views,
// never ingested, never published, and fenced from history replay.
const roots = [];
const test = (name, body) => bunTest(name, body, 120_000);
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-inputs-')); roots.push(root);
  const directory = path.join(root, 'project'), storage = path.join(root, 'private');
  await fs.mkdir(directory); await git(directory, ['init', '--quiet']);
  const diagnostics = [];
  const runtime = createSessionMutationRuntime({ directory: storage, onDiagnostic: (record) => diagnostics.push(record) });
  const put = async (name, text) => {
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await fs.writeFile(path.join(directory, name), text);
  };
  const begin = (sessionID, userMessageID, callID) => runtime.begin({ directory, sessionID, userMessageID,
    messageID: `${userMessageID}-assistant`, callID });
  const finish = async (lease) => {
    await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'),
      JSON.stringify({ terminated: true, confined: true, cancelled: false, exitCode: 0 }));
    await runtime.claimLease({ directory, token: lease.token, kind: 'process' });
    return runtime.finish({ directory, token: lease.token });
  };
  const commit = async (...files) => {
    await git(directory, ['add', '-f', ...files]);
    await git(directory, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  };
  const ledgerPaths = async () => {
    const ledger = path.join(storage, changeKey(await fs.realpath(directory)));
    const db = await openChangeStore(ledger, path.join(ledger, 'git'));
    const paths = [];
    for await (const { value } of db.entries('files')) if (value.published && !value.published.deleted) paths.push(value.published.path);
    return paths.sort();
  };
  return { runtime, root, directory, storage, diagnostics, put, begin, finish, commit, ledgerPaths,
    read: (name) => fs.readFile(path.join(directory, name), 'utf8') };
}
const kind = async (file) => {
  const stat = await fs.lstat(file).catch(() => null);
  return !stat ? 'missing' : stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : 'file';
};

test('classification follows Git: ignored directories become inputs, ignored files and tracked content stay', async () => {
  const f = await fixture();
  await f.put('.gitignore', '*.tmp\nmixed/\nneg/*\n!neg/keep\nart/\n.env\nignored-link\n');
  await f.put('src/app.js', 'app');
  await f.put('allfiles/x.tmp', 'only ignored files, but the directory itself is not ignored');
  await f.put('mixed/tracked.txt', 'tracked'); await f.put('mixed/generated.txt', 'generated'); await f.put('mixed/sub/g', 'deep');
  await f.put('neg/keep/k', 'kept by negation'); await f.put('neg/drop/d', 'dropped');
  await f.put('art/sub/f', 'artifact');
  await f.put('deep/a/.gitignore', 'b/\n'); await f.put('deep/a/b/f', 'nested rule');
  await f.put('.env', 'SECRET=local');
  await f.put('f2/art', 'a file named like a directory-only pattern');
  await fs.symlink('art', path.join(f.directory, 'ignored-link'));
  await f.commit('.gitignore', 'mixed/tracked.txt', 'deep/a/.gitignore', 'src/app.js');

  const lease = await f.begin('s', 'p', 'c');
  expect(lease.inputs).toEqual(['art', 'deep/a/b', 'mixed/sub', 'neg/drop']);
  const view = (name) => path.join(lease.viewDirectory, name);
  for (const input of lease.inputs) expect(await kind(view(input))).toBe('link');
  for (const file of ['allfiles/x.tmp', 'mixed/tracked.txt', 'mixed/generated.txt', 'neg/keep/k', '.env', 'f2/art', 'src/app.js']) {
    expect(await kind(view(file))).toBe('file');
  }
  expect(await kind(view('ignored-link'))).toBe('link');
  expect(await fs.readFile(view('.env'), 'utf8')).toBe('SECRET=local');
  expect(await fs.readFile(view('art/sub/f'), 'utf8')).toBe('artifact');
  const ledger = await f.ledgerPaths();
  expect(ledger).toContain('.env'); expect(ledger).toContain('allfiles/x.tmp'); expect(ledger).toContain('ignored-link');
  expect(ledger.filter((file) => ['art/', 'deep/a/b/', 'mixed/sub/', 'neg/drop/'].some((input) => file.startsWith(input)))).toEqual([]);
  await f.finish(lease);
});

test('records ingested before a directory became ignored are not observed, published, or replayed by Revert', async () => {
  const f = await fixture();
  await f.put('gen/out.txt', 'v0'); await f.put('keep.txt', 'k0');
  const first = await f.begin('a', 'pa', 'ca');
  await fs.writeFile(path.join(first.viewDirectory, 'gen/out.txt'), 'agent');
  await fs.writeFile(path.join(first.viewDirectory, 'keep.txt'), 'agent-keep');
  await f.finish(first);
  expect(await f.read('gen/out.txt')).toBe('agent');

  // The directory becomes ignored, then the user edits it outside any call.
  await f.put('.gitignore', 'gen/\n');
  await f.put('gen/out.txt', 'user edit');
  const second = await f.begin('b', 'pb', 'cb');
  expect(second.inputs).toEqual(['gen']);
  expect(await kind(path.join(second.viewDirectory, 'gen'))).toBe('link');
  await fs.writeFile(path.join(second.viewDirectory, 'other.txt'), 'by b');
  expect((await f.finish(second)).files).toEqual([{ path: 'other.txt', status: 'added' }]);

  const tx = await f.runtime.prepareRevert({ directory: f.directory, sessionID: 'a', messageID: 'pa' });
  const result = await f.runtime.settleRevert({ directory: f.directory, transactionID: tx.id, commit: true });
  expect(result.conflicts).toEqual([{ path: 'gen/out.txt', code: 'ignored_input' }]);
  expect(result.outcome).toBe('partial');
  expect(await f.read('gen/out.txt')).toBe('user edit');
  expect(await f.read('keep.txt')).toBe('k0');
});

test('an input the call replaced in its view is never published and is reported', async () => {
  const f = await fixture();
  await f.put('.gitignore', 'cache/\n'); await f.put('cache/seed', 'seed'); await f.put('a.txt', 'a');
  const lease = await f.begin('s', 'p', 'c');
  expect(lease.inputs).toEqual(['cache']);
  await fs.rm(path.join(lease.viewDirectory, 'cache'));
  await fs.mkdir(path.join(lease.viewDirectory, 'cache'));
  await fs.writeFile(path.join(lease.viewDirectory, 'cache', 'out'), 'build output');
  await fs.writeFile(path.join(lease.viewDirectory, 'a.txt'), 'changed');
  const result = await f.finish(lease);
  expect(result.files).toEqual([{ path: 'a.txt', status: 'modified' }]);
  expect(result.ignoredInputs).toEqual(['cache']);
  expect(await kind(path.join(f.directory, 'cache', 'out'))).toBe('missing');
  expect(await f.read('cache/seed')).toBe('seed');
});

const moduleFixture = async () => {
  const f = await fixture();
  await f.put('.gitignore', 'node_modules/\n'); await f.put('a.txt', 'a');
  await f.put('node_modules/pkg/index.js', 'dependency'); await f.put('node_modules/.bin/tool', 'tool');
  await f.put('node_modules/.vite/deps/old.js', 'project cache');
  return f;
};

const overlayOf = async (f) => {
  const ledger = path.join(f.storage, changeKey(await fs.realpath(f.directory)));
  return { ledger, overlays: path.join(ledger, 'module-overlays'), caches: path.join(ledger, 'context-cache', 'module-caches') };
};

bunTest.skipIf(process.platform === 'win32')('a view node_modules links to a host overlay whose tool caches live in the execution cache', async () => {
  const f = await moduleFixture();
  const lease = await f.begin('s', 'p', 'c');
  expect(lease.inputs).toEqual(['node_modules']);
  const modules = path.join(lease.viewDirectory, 'node_modules');
  expect(await kind(modules)).toBe('link');
  const { ledger, caches } = await overlayOf(f);
  const overlay = await fs.readlink(modules);
  expect(path.relative(path.join(ledger, 'module-overlays'), overlay)).toMatch(/^[0-9a-f]{16}$/);
  expect(await fs.readFile(path.join(modules, 'pkg', 'index.js'), 'utf8')).toBe('dependency');
  expect(await fs.realpath(path.join(modules, 'pkg'))).toBe(await fs.realpath(path.join(f.directory, 'node_modules', 'pkg')));
  expect(await fs.realpath(path.join(modules, '.bin'))).toBe(await fs.realpath(path.join(f.directory, 'node_modules', '.bin')));
  for (const cache of ['.vite', '.vite-temp', '.cache']) {
    expect(await fs.realpath(path.join(modules, cache))).toBe(await fs.realpath(path.join(caches, path.basename(overlay), cache)));
  }
  expect(await fs.readdir(path.join(modules, '.vite'))).toEqual([]);
  await fs.writeFile(path.join(modules, '.vite', 'x'), 'shared cache');
  const result = await f.finish(lease);
  expect(result.files).toEqual([]);
  expect(result.ignoredInputs).toBeFalsy();
  expect(await fs.readdir(path.join(f.directory, 'node_modules', '.vite'))).toEqual(['deps']);
  // The overlay follows installs and removals between calls; caches persist.
  await f.put('node_modules/added/index.js', 'added'); await fs.rm(path.join(f.directory, 'node_modules', 'pkg'), { recursive: true });
  const next = await f.begin('s', 'p2', 'c2');
  const nextModules = path.join(next.viewDirectory, 'node_modules');
  expect(await fs.readFile(path.join(nextModules, 'added', 'index.js'), 'utf8')).toBe('added');
  expect(await kind(path.join(nextModules, 'pkg'))).toBe('missing');
  expect(await fs.readFile(path.join(nextModules, '.vite', 'x'), 'utf8')).toBe('shared cache');
  await f.finish(next);
});

bunTest.skipIf(process.platform !== 'darwin')('confined tool caches are writable while dependencies and the overlay stay read-only', async () => {
  const f = await moduleFixture();
  const lease = await f.begin('s', 'p', 'c');
  const viewDirectory = await fs.realpath(lease.viewDirectory);
  const scratchDirectory = path.join(path.dirname(viewDirectory), 'scratch'); await fs.mkdir(scratchDirectory, { recursive: true });
  const auxiliaryDirectory = await fs.realpath(lease.auxiliaryDirectory);
  const profile = sessionExecutionProfile({ viewDirectory, scratchDirectory, auxiliaryDirectory });
  const run = (script) => spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', script], { cwd: viewDirectory, encoding: 'utf8' });
  const cacheWrite = run('mkdir -p node_modules/.vite/deps && echo x > node_modules/.vite/deps/new.js && echo y > node_modules/.vite-temp/config.mjs && rm node_modules/.vite/deps/new.js');
  expect(cacheWrite.stderr).toBe('');
  expect(cacheWrite.status).toBe(0);
  expect(run('echo changed > node_modules/pkg/index.js').status).not.toBe(0);
  expect(run('echo planted > node_modules/planted').status).not.toBe(0);
  expect(run('rm node_modules/pkg').status).not.toBe(0);
  expect(await f.read('node_modules/pkg/index.js')).toBe('dependency');
  expect(await fs.readdir(path.join(f.directory, 'node_modules', '.vite', 'deps'))).toEqual(['old.js']);
  expect(await kind(path.join(f.directory, 'node_modules', '.vite-temp'))).toBe('missing');
  expect((await f.finish(lease)).ignoredInputs).toBeFalsy();
});

bunTest.skipIf(process.platform === 'win32')('the overlay kill switch restores the direct dependency link', async () => {
  const f = await moduleFixture();
  process.env.DEVRYAN_MODULE_CACHE_OVERLAY = '0';
  try {
    const lease = await f.begin('s', 'p', 'c');
    expect(await fs.readlink(path.join(lease.viewDirectory, 'node_modules'))).toBe(path.join(lease.projectDirectory, 'node_modules'));
    await f.finish(lease);
  } finally { delete process.env.DEVRYAN_MODULE_CACHE_OVERLAY; }
  expect(await kind((await overlayOf(f)).overlays)).toBe('missing');
});

test('a lease prepared before inputs were persisted keeps the name-only rule', async () => {
  const f = await fixture();
  await f.put('node_modules/pkg/index.js', 'dependency'); await f.put('a.txt', 'a');
  const lease = await f.begin('s', 'p', 'c');
  const ledger = path.join(f.storage, changeKey(await fs.realpath(f.directory)));
  const db = await openChangeStore(ledger, path.join(ledger, 'git'));
  const leaseKey = `leases/${changeKey(lease.token)}.json`, stored = await db.get(leaseKey);
  delete stored.inputs; db.set(leaseKey, stored); await db.commit();
  await fs.writeFile(path.join(lease.viewDirectory, 'a.txt'), 'changed');
  expect((await f.finish(lease)).files).toEqual([{ path: 'a.txt', status: 'modified' }]);
  expect(await f.read('node_modules/pkg/index.js')).toBe('dependency');
});

bunTest.skipIf(process.platform !== 'darwin')('the confinement profile denies writes through an input link and allows view writes', async () => {
  const f = await fixture();
  await f.put('.gitignore', 'cache/\n.env\n'); await f.put('cache/seed', 'seed'); await f.put('.env', 'SECRET=1');
  const lease = await f.begin('s', 'p', 'c');
  const viewDirectory = await fs.realpath(lease.viewDirectory);
  const scratchDirectory = path.join(path.dirname(viewDirectory), 'scratch'); await fs.mkdir(scratchDirectory, { recursive: true });
  const profile = sessionExecutionProfile({ viewDirectory, scratchDirectory });
  const run = (script) => spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', script], { cwd: viewDirectory, encoding: 'utf8' });
  expect(run('echo denied > cache/new').status).not.toBe(0);
  expect(run('echo denied > cache/seed').status).not.toBe(0);
  expect(await kind(path.join(f.directory, 'cache', 'new'))).toBe('missing');
  expect(await f.read('cache/seed')).toBe('seed');
  const readable = run('cat .env && cat cache/seed && echo ok > view-write');
  expect(readable.status).toBe(0);
  expect(readable.stdout).toBe('SECRET=1seed');
  expect(await fs.readFile(path.join(viewDirectory, 'view-write'), 'utf8')).toBe('ok\n');
});

test('a real call never settles for a dirty warm pass that started after its reservation', async () => {
  const f = await fixture();
  await f.put('hot', 'original'); await f.put('stable', 'stable');
  const target = await fs.realpath(path.join(f.directory, 'hot'));
  const lease = await f.runtime.reserve({ directory: f.directory, sessionID: 's', userMessageID: 'p', messageID: 'p-assistant', callID: 'c' });
  // Change the file after the warm pass inspected it, at its install re-check,
  // so the warm pass skips it as dirty and does not re-pass; the reserved call
  // starts preparing right then, while that warm pass is still in flight.
  const original = fs.lstat.bind(fs); let inspected = false, preparing = null;
  const changing = spyOn(fs, 'lstat').mockImplementation(async (file, options) => {
    if (file === target && !preparing) {
      if (new Error().stack.includes('inspectMutationFile')) inspected = true;
      else if (inspected) { await fs.writeFile(target, 'changed during warm'); preparing = f.runtime.prepare(lease); }
    }
    return original(file, options);
  });
  let warmed;
  try { warmed = await f.runtime.warm({ directory: f.directory }); }
  finally { changing.mockRestore(); }
  expect(preparing).not.toBeNull();
  expect(warmed).toMatchObject({ built: true });
  expect(await f.runtime.warm({ directory: f.directory })).toEqual({ skipped: 'already-built' });
  const ready = await preparing;
  expect(await fs.readFile(path.join(ready.viewDirectory, 'hot'), 'utf8')).toBe('changed during warm');
});

test('warm enforces the eligible file budget, the byte budget, and skips without a listing', async () => {
  const counted = await fixture();
  await counted.put('.gitignore', '*.log\n');
  for (let index = 0; index < 3; index += 1) await counted.put(`src/${index}.js`, 'x');
  for (let index = 0; index < 6; index += 1) await counted.put(`logs/${index}.log`, 'ignored standalone file');
  // The cheap listing sees 4 files; the eligible set (ignored files included) is 10.
  expect(await counted.runtime.warm({ directory: counted.directory, maxFiles: 5 })).toEqual({ skipped: 'too-large' });
  expect(await counted.runtime.warm({ directory: counted.directory })).toEqual({ skipped: 'already-built' });

  const heavy = await fixture();
  for (let index = 0; index < 4; index += 1) await heavy.put(`blob${index}.txt`, 'y'.repeat(4096));
  expect(await heavy.runtime.warm({ directory: heavy.directory, maxBytes: 1024 })).toEqual({ skipped: 'too-large' });

  const broken = await fixture();
  await broken.put('a.txt', 'a');
  await fs.writeFile(path.join(broken.directory, '.git', 'index'), 'not an index');
  expect(await broken.runtime.warm({ directory: broken.directory })).toEqual({ skipped: 'listing-unavailable' });
});

test('a real call falls back to the complete walk when classification fails, and reports it', async () => {
  const f = await fixture();
  await f.put('.gitignore', 'cache/\n'); await f.put('cache/seed', 'seed'); await f.put('a.txt', 'a');
  await fs.writeFile(path.join(f.directory, '.git', 'index'), 'not an index');
  const lease = await f.begin('s', 'p', 'c');
  expect(lease.inputs).toEqual([]);
  expect(await kind(path.join(lease.viewDirectory, 'cache', 'seed'))).toBe('file');
  expect(f.diagnostics).toContainEqual({ phase: 'ledger_inputs', state: 'failed', code: 'capture_git_failed' });
});

test('replacing an input directory with a file (and back) between calls follows the working tree', async () => {
  const f = await fixture();
  await f.put('.gitignore', 'out\n'); await f.put('out/a', 'dir');
  const first = await f.begin('s', 'p1', 'c1');
  expect(first.inputs).toEqual(['out']);
  await f.finish(first);
  await fs.rm(path.join(f.directory, 'out'), { recursive: true }); await f.put('out', 'now an ignored file');
  const second = await f.begin('s', 'p2', 'c2');
  expect(second.inputs).toEqual([]);
  expect(await fs.readFile(path.join(second.viewDirectory, 'out'), 'utf8')).toBe('now an ignored file');
  await f.finish(second);
  await fs.rm(path.join(f.directory, 'out')); await f.put('out/b', 'dir again');
  const third = await f.begin('s', 'p3', 'c3');
  expect(third.inputs).toEqual(['out']);
  expect(await kind(path.join(third.viewDirectory, 'out'))).toBe('link');
  expect(await f.ledgerPaths()).not.toContain('out/b');
});
