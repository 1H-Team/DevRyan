import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { cloneFile, cloneTree, createRunRoot, keepArtifactsRequested, removeRunPayloads } from './run-root.mjs';

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

test('pass deletes heavy payloads and keeps evidence', () => {
  const parent = scratch(); const run = create(parent); seed(run.dir);
  run.finish('passed'); run.finish('failed');
  assert.equal(manifestOf(run).status, 'passed'); assert.ok(manifestOf(run).completedAt);
  for (const gone of ['runtime', 'home', 'profile', 'app/DevRyan QA.app', 'sub/node_modules', 'home2/runtime-bundles']) assert.equal(existsSync(path.join(run.dir, gone)), false, gone);
  for (const kept of ['evidence.json', 'logs/run.log', 'shots/a.png', 'native/copied-binary']) assert.ok(existsSync(path.join(run.dir, kept)), kept);
  rmSync(parent, { recursive: true });
});

test('failure keeps everything', () => {
  const parent = scratch(); const run = create(parent); seed(run.dir);
  run.finish('failed');
  assert.equal(manifestOf(run).status, 'failed');
  assert.ok(existsSync(path.join(run.dir, 'runtime/bin/tool')));
  rmSync(parent, { recursive: true });
});

test('interrupt cleans like a pass and records the status', () => {
  const parent = scratch(); const run = create(parent); seed(run.dir);
  run.finish('interrupted');
  assert.equal(manifestOf(run).status, 'interrupted');
  assert.equal(existsSync(path.join(run.dir, 'home')), false);
  rmSync(parent, { recursive: true });
});

test('keep flag, argv and env keep payloads on pass', () => {
  assert.equal(keepArtifactsRequested({ argv: [], env: {} }), false);
  assert.equal(keepArtifactsRequested({ argv: ['--keep-artifacts'], env: {} }), true);
  assert.equal(keepArtifactsRequested({ argv: [], env: { DEVRYAN_KEEP_ARTIFACTS: '1' } }), true);
  assert.equal(keepArtifactsRequested({ argv: [], env: { DEVRYAN_KEEP_ARTIFACTS: '0' } }), false);
  for (const options of [{ keepArtifacts: true }, { argv: ['--keep-artifacts'] }, { env: { DEVRYAN_KEEP_ARTIFACTS: '1' } }]) {
    const parent = scratch(); const run = create(parent, options); seed(run.dir);
    run.finish('passed');
    assert.ok(existsSync(path.join(run.dir, 'runtime/bin/tool')));
    rmSync(parent, { recursive: true });
  }
});

test('an existing fixture directory can be adopted', () => {
  const parent = scratch(); const adopted = path.join(parent, 'fixture'); mkdirSync(adopted); seed(adopted);
  const run = createRunRoot({ dir: adopted, owner: 'test', signals: false, env: {}, argv: [] });
  assert.equal(run.dir, adopted); run.finish('passed');
  assert.equal(manifestOf(run).status, 'passed'); assert.equal(existsSync(path.join(adopted, 'home')), false);
  rmSync(parent, { recursive: true });
});

test('keepOnPass keeps a delivered payload on pass but not on interrupt', () => {
  const parent = scratch(); const passed = create(parent, { keepOnPass: true }); seed(passed.dir);
  passed.finish('passed'); assert.ok(existsSync(path.join(passed.dir, 'runtime/bin/tool')));
  const interrupted = create(parent, { keepOnPass: true }); seed(interrupted.dir);
  interrupted.finish('interrupted'); assert.equal(existsSync(path.join(interrupted.dir, 'runtime')), false);
  rmSync(parent, { recursive: true });
});

test('extra payloads and external paths are removed; escapes are ignored', () => {
  const parent = scratch(); const outside = scratch(); writeFileSync(path.join(outside, 'keep.txt'), 'x');
  const external = scratch(); writeFileSync(path.join(external, 'big'), 'x');
  const run = create(parent, { extraPayloads: ['native', outside], external: [external] }); seed(run.dir);
  run.finish('passed');
  assert.equal(existsSync(path.join(run.dir, 'native')), false); assert.equal(existsSync(external), false);
  assert.ok(existsSync(path.join(outside, 'keep.txt')));
  rmSync(parent, { recursive: true }); rmSync(outside, { recursive: true });
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
  const run = createRunRoot({ parent: ${JSON.stringify(parent)}, owner: 'child', env: {}, argv: [] });
  mkdirSync(run.dir + '/home', { recursive: true }); writeFileSync(run.dir + '/home/big', 'x'); writeFileSync(run.dir + '/result.json', '{}');
  console.log(run.dir);
  ${mode === 'hang' ? 'setInterval(() => {}, 1000);' : mode === 'crash' ? 'throw new Error("boom");' : 'run.finish("passed");'}
`;
const runChild = (parent, mode, signal) => new Promise(resolve => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript(parent, mode)], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; if (signal && out.includes('\n')) child.kill(signal); });
  child.on('close', (code, sig) => resolve({ dir: out.trim(), code, sig }));
});

test('SIGINT and SIGTERM remove payloads and mark interrupted', async () => {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const parent = scratch(); const result = await runChild(parent, 'hang', signal);
    assert.equal(result.code, code);
    assert.equal(existsSync(path.join(result.dir, 'home')), false); assert.ok(existsSync(path.join(result.dir, 'result.json')));
    assert.equal(JSON.parse(readFileSync(path.join(result.dir, 'run.json'), 'utf8')).status, 'interrupted');
    rmSync(parent, { recursive: true });
  }
});

test('an unfinished crash is recorded as failed and keeps payloads', async () => {
  const parent = scratch(); const result = await runChild(parent, 'crash');
  assert.notEqual(result.code, 0);
  assert.ok(existsSync(path.join(result.dir, 'home/big')));
  assert.equal(JSON.parse(readFileSync(path.join(result.dir, 'run.json'), 'utf8')).status, 'failed');
  rmSync(parent, { recursive: true });
});
