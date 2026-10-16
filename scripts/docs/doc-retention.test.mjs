import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  docRetentionErrorMessages,
  formatDocRetentionError,
  isCodemapFile,
  lintNoCodemaps,
  listRepositoryFiles,
  validateDocRetention,
} from './doc-retention.mjs';

function fixture(t, files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-doc-retention-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), contents);
  }
  return root;
}

function run(t, files) {
  const root = fixture(t, files);
  return validateDocRetention(root, Object.keys(files)).errors;
}

test('recognizes codemap file names and formats errors as path:line: message', () => {
  assert.ok(isCodemapFile('a/b/codemap.md') && isCodemapFile('CODEMAP.md'));
  assert.ok(!isCodemapFile('a/codemap.md.bak') && !isCodemapFile('a/DOCUMENTATION.md') && !isCodemapFile('a/my-codemap.md'));
  assert.equal(formatDocRetentionError({ path: 'a/codemap.md', line: 3, message: 'bad' }), 'a/codemap.md:3: bad');
});

test('rejects codemap files anywhere, pointing to DOCUMENTATION.md', t => {
  const errors = run(t, { 'packages/ui/src/codemap.md': '', 'CODEMAP.md': '', 'a/b/DOCUMENTATION.md': '', 'a/notes/codemap.md.bak': '' });
  assert.deepEqual(errors.map((e) => [e.path, e.line]), [['CODEMAP.md', 1], ['packages/ui/src/codemap.md', 1]]);
  assert.match(errors[0].message, /codemap files were removed/);
  assert.match(errors[0].message, /nearest DOCUMENTATION\.md/);
});

test('exempts vendored reviewed-inputs and node_modules codemaps', t => {
  const files = {
    'packages/web/runtime/reviewed-inputs/slim/codemap.md': '',
    'packages/web/runtime/reviewed-inputs/slim/skills/CODEMAP.md': '',
    'node_modules/x/codemap.md': '', 'packages/ui/node_modules/y/CODEMAP.md': '',
  };
  assert.deepEqual(run(t, files), []);
  assert.deepEqual(lintNoCodemaps(Object.keys(files)), []);
  assert.deepEqual(lintNoCodemaps(['packages/web/runtime/reviewed-inputs-other/codemap.md']).map((e) => e.path), ['packages/web/runtime/reviewed-inputs-other/codemap.md']);
});

test('sorts errors deterministically and lists git files for the CLI', t => {
  const files = { 'b/codemap.md': '', 'a/CODEMAP.md': '' };
  assert.deepEqual(run(t, files).map((e) => e.path), ['a/CODEMAP.md', 'b/codemap.md']);

  const root = fixture(t, { 'tracked.md': '', 'ignored.md': '', '.gitignore': 'ignored.md\n', 'docs/untracked.md': '' });
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', 'tracked.md', '.gitignore'], { cwd: root });
  assert.deepEqual(listRepositoryFiles(root).sort(), ['.gitignore', 'docs/untracked.md', 'tracked.md']);
  assert.deepEqual(docRetentionErrorMessages(root), []);
  mkdirSync(path.join(root, 'pkg'));
  writeFileSync(path.join(root, 'pkg/codemap.md'), '');
  assert.equal(docRetentionErrorMessages(root).length, 1);
});

test('the CLI exits nonzero exactly when the repository has doc-retention errors', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const expected = docRetentionErrorMessages(root);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/docs/doc-retention.mjs')], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, expected.length > 0 ? 1 : 0);
  if (expected.length > 0) assert.ok(result.stderr.includes(expected[0]));
});
