import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const compiler = require.resolve('typescript/lib/tsc.js');

test('diagnostic command rejects missing, unknown, and extra arguments', () => {
  for (const args of [[], ['desktop'], ['ui', '--json']]) {
    const result = spawnSync(process.execPath, ['scripts/typecheck-diagnostics.mjs', ...args], {
      cwd: root, encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
    assert.equal(result.stdout, '');
  }
});

test('package incremental checks retain errors and invalidate cached results after edits', () => {
  const parent = path.join(root, '.cache', 'typecheck');
  mkdirSync(parent, { recursive: true });
  const fixture = mkdtempSync(path.join(parent, 'test-'));
  try {
    const caches = new Set();
    for (const target of ['ui', 'web']) {
      const configPath = path.join(root, 'packages', target, 'tsconfig.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      const configuredCache = path.resolve(path.dirname(configPath), config.compilerOptions.tsBuildInfoFile);
      assert.equal(path.dirname(configuredCache), parent);
      caches.add(configuredCache);
      const cachePath = path.join(fixture, path.basename(configuredCache));
      const sourcePath = path.join(fixture, `${target}.ts`);
      const fixtureConfig = path.join(fixture, `${target}.json`);
      writeFileSync(fixtureConfig, JSON.stringify({
        extends: configPath,
        compilerOptions: { tsBuildInfoFile: cachePath, types: [] },
        files: [sourcePath], include: [],
      }));
      const check = () => spawnSync(process.execPath, [compiler, '-p', fixtureConfig, '--pretty', 'false'], {
        cwd: root, encoding: 'utf8', timeout: 30_000,
      });
      writeFileSync(sourcePath, 'export const value: string = "valid";\n');
      let result = check();
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(readFileSync(cachePath, 'utf8').length > 0);
      writeFileSync(sourcePath, 'export const value: string = 123;\n');
      for (let attempt = 0; attempt < 2; attempt++) {
        result = check();
        assert.notEqual(result.status, 0);
        assert.match(result.stdout, /TS2322/);
      }
      writeFileSync(sourcePath, 'export const value: string = "fixed";\n');
      result = check();
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
    assert.equal(caches.size, 2, 'UI and web must not share compiler state');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('diagnostics measure the compiler, preserve type errors, and clean their disposable cache', () => {
  const parent = path.join(root, '.cache', 'typecheck');
  mkdirSync(parent, { recursive: true });
  const fixture = mkdtempSync(path.join(parent, 'diagnostic-test-'));
  try {
    mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
    const project = path.join(fixture, 'packages', 'ui');
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(fixture, 'scripts', 'typecheck-diagnostics.mjs'),
      readFileSync(path.join(root, 'scripts', 'typecheck-diagnostics.mjs')));
    writeFileSync(path.join(project, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, types: [], skipLibCheck: true },
      files: ['fixture.ts'],
    }));
    writeFileSync(path.join(project, 'fixture.ts'), 'const value: string = 123;\n');
    const result = spawnSync(process.execPath, ['scripts/typecheck-diagnostics.mjs', 'ui'], {
      cwd: fixture, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, NODE_OPTIONS: '--title=private-diagnostic-marker' },
    });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /TS2322/);
    assert.match(result.stdout, /Memory used:/);
    assert.doesNotMatch(result.stdout + result.stderr, /private-diagnostic-marker/);
    const summaries = result.stdout.trim().split('\n').filter((line) => line.startsWith('{')).map(JSON.parse);
    assert.equal(summaries[0].incrementalCache, 'fresh');
    assert.ok(summaries[0].heapLimitMiB > 0);
    assert.equal(summaries[1].exitCode, 2);
    assert.ok(summaries[1].maxRssMiB > 0);
    assert.deepEqual(readdirSync(path.join(fixture, '.cache', 'typecheck')), []);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
