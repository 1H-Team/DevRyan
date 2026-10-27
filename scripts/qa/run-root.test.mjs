import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { cloneFile, cloneTree, createRunRoot, isOwnedScratchPath, keepArtifactsRequested, removeRunPayloads, scratchParent } from './run-root.mjs';

const helper = fileURLToPath(new URL('./run-root.mjs', import.meta.url));
const scratch = () => mkdtempSync(path.join(os.tmpdir(), 'run-root-test-'));
const seed = dir => {
  for (const file of ['runtime/bin/tool', 'home/.config/x', 'profile/Cache/a', 'app/DevRyan QA.app/Contents/x', 'sub/node_modules/pkg/index.js',
    'home2/runtime-bundles/b', 'evidence.json', 'logs/run.log', 'shots/a.png', 'native/copied-binary']) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), 'x');
  }
};
const manifestOf = run => JSON.parse(readFileSync(run.manifestPath, 'utf8'));
const create = (parent, options = {}) => createRunRoot({ parent, owner: 'test', signals: false, env: {}, argv: [], ...options });

test('run.json starts running and carries the fixed contract', () => {
  const parent = scratch(); const run = create(parent, { prefix: 'p-' });
  assert.match(path.basename(run.dir), /^p-/);
  const manifest = manifestOf(run);
  assert.deepEqual(Object.keys(manifest), ['schemaVersion', 'owner', 'createdAt', 'completedAt', 'status', 'pinned']);
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.status, 'running');
  assert.equal(manifest.completedAt, null); assert.equal(manifest.pinned, false); assert.equal(manifest.owner, 'test');
  rmSync(parent, { recursive: true });
});

test('scratchParent lives in the OS temp dir and validates the family', () => {
  assert.equal(scratchParent('qa'), path.join(realpathSync(os.tmpdir()), 'devryan-qa'));
  for (const bad of ['', 'Q A', '../x', 'a/b', undefined]) assert.throws(() => scratchParent(bad), TypeError);
});

test('only canonical descendants of a live constructor-owned scratch run are admitted', () => {
  const run = create(scratchParent('qa'));
  const workspace = path.join(run.dir, 'runtime/workspace');
  const outsider = scratch();
  try {
    assert.equal(isOwnedScratchPath(workspace, { scope: run.scope, future: true }), true);
    assert.equal(isOwnedScratchPath(workspace), false);
    mkdirSync(workspace, { recursive: true });
    assert.equal(isOwnedScratchPath(workspace, { scope: run.scope }), true);
    assert.equal(isOwnedScratchPath(outsider, { scope: run.scope }), false);
    assert.equal(isOwnedScratchPath(path.join(run.dir, '../escape'), { scope: run.scope, future: true }), false);
    symlinkSync(outsider, path.join(run.dir, 'alias'));
    assert.equal(isOwnedScratchPath(path.join(run.dir, 'alias'), { scope: run.scope, future: true }), false);
    assert.equal(isOwnedScratchPath(path.join(run.dir, 'alias/new'), { scope: run.scope, future: true }), false);
    renameSync(run.dir, path.join(outsider, 'retired')); mkdirSync(run.dir);
    assert.equal(isOwnedScratchPath(run.dir, { scope: run.scope }), false);
    assert.throws(() => run.finish('passed'), /identity changed/);
  } finally { run.dispose(); rmSync(run.dir, { recursive: true, force: true }); rmSync(outsider, { recursive: true }); }
});

test('owned scratch runs clean pass, failure and interruption', () => {
  for (const status of ['passed', 'failed', 'interrupted']) {
    const run = create(scratchParent('qa'));
    const file = path.join(run.dir, 'payload'); writeFileSync(file, 'x');
    const original = process.stderr.write; process.stderr.write = () => true;
    try { assert.equal(run.finish(status), status); } finally { process.stderr.write = original; }
    assert.equal(existsSync(run.dir), false);
    assert.equal(isOwnedScratchPath(file, { scope: run.scope }), false);
  }
});

test('scratch scope cannot admit sibling runs or path traversal', () => {
  const first = create(scratchParent('qa')), second = create(scratchParent('qa'));
  try {
    assert.equal(isOwnedScratchPath(path.join(second.dir, 'runtime'), { scope: first.scope, future: true }), false);
    assert.throws(() => create(scratchParent('qa'), { name: '../escaped' }), TypeError);
    assert.throws(() => create(scratchParent('qa'), { prefix: '../escaped-' }), TypeError);
  } finally { first.finish('passed'); second.finish('passed'); }
});

test('pass removes the whole run directory', () => {
  const parent = scratch(); const run = create(parent); seed(run.dir);
  run.finish('passed'); run.finish('failed');
  assert.equal(run.status, 'passed');
  assert.equal(existsSync(run.dir), false);
  rmSync(parent, { recursive: true });
});

test('failure removes the whole run directory and prints a hint to stderr', () => {
  const parent = scratch(); const run = create(parent); seed(run.dir);
  const chunks = []; const original = process.stderr.write;
  process.stderr.write = chunk => { chunks.push(String(chunk)); return true; };
  try { run.finish('failed'); } finally { process.stderr.write = original; }
  assert.equal(run.status, 'failed');
  assert.equal(existsSync(run.dir), false);
  assert.equal(chunks.join(''), `[run-root] test failed; its files were removed. Re-run with --keep-artifacts to keep ${run.dir}.\n`);
  rmSync(parent, { recursive: true });
});

test('interrupt removes the whole run directory', () => {
  const parent = scratch(); const run = create(parent); seed(run.dir);
  run.finish('interrupted');
  assert.equal(run.status, 'interrupted');
  assert.equal(existsSync(run.dir), false);
  rmSync(parent, { recursive: true });
});

test('keep flag, argv and env keep the run directory on pass and failure', () => {
  assert.equal(keepArtifactsRequested({ argv: [], env: {} }), false);
  assert.equal(keepArtifactsRequested({ argv: ['--keep-artifacts'], env: {} }), true);
  assert.equal(keepArtifactsRequested({ argv: [], env: { DEVRYAN_KEEP_ARTIFACTS: '1' } }), true);
  assert.equal(keepArtifactsRequested({ argv: [], env: { DEVRYAN_KEEP_ARTIFACTS: '0' } }), false);
  for (const options of [{ keepArtifacts: true }, { argv: ['--keep-artifacts'] }, { env: { DEVRYAN_KEEP_ARTIFACTS: '1' } }]) {
    const parent = scratch(); const run = create(parent, options); seed(run.dir);
    run.finish('passed');
    assert.ok(existsSync(path.join(run.dir, 'runtime/bin/tool')));
    assert.equal(manifestOf(run).status, 'passed');
    const failed = create(parent, options); seed(failed.dir);
    const original = process.stderr.write; process.stderr.write = () => true;
    try { failed.finish('failed'); } finally { process.stderr.write = original; }
    assert.ok(existsSync(path.join(failed.dir, 'runtime/bin/tool')));
    assert.equal(manifestOf(failed).status, 'failed');
    rmSync(parent, { recursive: true });
  }
});

test('an existing fixture directory can be adopted', () => {
  const parent = scratch(); const adopted = path.join(parent, 'fixture'); mkdirSync(adopted); seed(adopted);
  const run = createRunRoot({ dir: adopted, owner: 'test', signals: false, env: {}, argv: [] });
  assert.equal(run.dir, adopted); assert.equal(manifestOf(run).status, 'running'); run.finish('passed');
  assert.equal(existsSync(adopted), false);
  rmSync(parent, { recursive: true });
});

test('keepOnPass keeps a delivered payload on pass only', () => {
  const parent = scratch(); const passed = create(parent, { keepOnPass: true }); seed(passed.dir);
  passed.finish('passed'); assert.ok(existsSync(path.join(passed.dir, 'runtime/bin/tool'))); assert.equal(manifestOf(passed).status, 'passed');
  const interrupted = create(parent, { keepOnPass: true }); seed(interrupted.dir);
  interrupted.finish('interrupted'); assert.equal(existsSync(interrupted.dir), false);
  const failed = create(parent, { keepOnPass: true }); seed(failed.dir);
  const original = process.stderr.write; process.stderr.write = () => true;
  try { failed.finish('failed'); } finally { process.stderr.write = original; }
  assert.equal(existsSync(failed.dir), false);
  rmSync(parent, { recursive: true });
});

test('external paths are removed with the run; paths outside stay', () => {
  const parent = scratch(); const outside = scratch(); writeFileSync(path.join(outside, 'keep.txt'), 'x');
  const external = scratch(); writeFileSync(path.join(external, 'big'), 'x');
  const owned = scratch();
  const run = create(parent, { extraPayloads: [outside], external: [external] }); run.own(owned); seed(run.dir);
  run.finish('passed');
  assert.equal(existsSync(run.dir), false); assert.equal(existsSync(external), false); assert.equal(existsSync(owned), false);
  assert.ok(existsSync(path.join(outside, 'keep.txt')));
  rmSync(parent, { recursive: true }); rmSync(outside, { recursive: true });
});

test('removeRunPayloads removes heavy subtrees and extras but not evidence', () => {
  const dir = scratch(); seed(dir);
  removeRunPayloads(dir, { extra: ['native'] });
  for (const gone of ['runtime', 'home', 'profile', 'app/DevRyan QA.app', 'sub/node_modules', 'home2/runtime-bundles', 'native']) assert.equal(existsSync(path.join(dir, gone)), false, gone);
  for (const kept of ['evidence.json', 'logs/run.log', 'shots/a.png']) assert.ok(existsSync(path.join(dir, kept)), kept);
  rmSync(dir, { recursive: true });
});

test('payload removal never follows symlinks', () => {
  const parent = scratch(); const target = scratch(); writeFileSync(path.join(target, 'precious'), 'x');
  const run = create(parent); symlinkSync(target, path.join(run.dir, 'home')); mkdirSync(path.join(run.dir, 'x'));
  symlinkSync(target, path.join(run.dir, 'x/node_modules'));
  assert.deepEqual(removeRunPayloads(run.dir), []);
  assert.ok(existsSync(path.join(target, 'precious')));
  rmSync(parent, { recursive: true }); rmSync(target, { recursive: true });
});

test('clone helpers copy files and trees', () => {
  const dir = scratch(); mkdirSync(path.join(dir, 'a/b'), { recursive: true }); writeFileSync(path.join(dir, 'a/b/f'), 'data');
  cloneFile(path.join(dir, 'a/b/f'), path.join(dir, 'f2')); cloneTree(path.join(dir, 'a'), path.join(dir, 'a2'));
  assert.equal(readFileSync(path.join(dir, 'f2'), 'utf8'), 'data'); assert.equal(readFileSync(path.join(dir, 'a2/b/f'), 'utf8'), 'data');
  assert.throws(() => cloneTree(path.join(dir, 'a'), path.join(dir, 'a2')));
  rmSync(dir, { recursive: true });
});

const childScript = (parent, mode) => `
  import { createRunRoot } from ${JSON.stringify(helper)};
  import { mkdirSync, writeFileSync } from 'node:fs';
  const run = createRunRoot({ parent: ${JSON.stringify(parent)}, owner: 'child', argv: [] });
  mkdirSync(run.dir + '/home', { recursive: true }); writeFileSync(run.dir + '/home/big', 'x'); writeFileSync(run.dir + '/result.json', '{}');
  console.log(run.dir);
  ${mode === 'hang' ? 'setInterval(() => {}, 1000);' : mode === 'crash' ? 'throw new Error("boom");' : 'run.finish("passed");'}
`;
const runChild = (parent, mode, signal, env = {}) => new Promise(resolve => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript(parent, mode)], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DEVRYAN_KEEP_ARTIFACTS: '0', ...env } });
  let out = ''; let err = '';
  child.stderr.on('data', chunk => { err += chunk; });
  child.stdout.on('data', chunk => { out += chunk; if (signal && out.includes('\n')) child.kill(signal); });
  child.on('close', (code, sig) => resolve({ dir: out.trim(), code, sig, stderr: err }));
});

test('SIGINT and SIGTERM remove the run directory', async () => {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const parent = scratch(); const result = await runChild(parent, 'hang', signal);
    assert.equal(result.code, code);
    assert.equal(existsSync(result.dir), false);
    rmSync(parent, { recursive: true });
  }
});

test('an unfinished crash is recorded as failed, hinted on stderr and removed', async () => {
  const parent = scratch(); const result = await runChild(parent, 'crash');
  assert.notEqual(result.code, 0);
  assert.equal(existsSync(result.dir), false);
  assert.match(result.stderr, /\[run-root\] child failed; its files were removed\. Re-run with --keep-artifacts to keep /);
  rmSync(parent, { recursive: true });
});

test('a crash with DEVRYAN_KEEP_ARTIFACTS=1 keeps the run directory as failed', async () => {
  const parent = scratch(); const result = await runChild(parent, 'crash', undefined, { DEVRYAN_KEEP_ARTIFACTS: '1' });
  assert.ok(existsSync(path.join(result.dir, 'home/big')));
  assert.equal(JSON.parse(readFileSync(path.join(result.dir, 'run.json'), 'utf8')).status, 'failed');
  rmSync(parent, { recursive: true });
});
