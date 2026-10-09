import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AUDIT_PINNED_EVIDENCE,
  docRetentionErrorMessages,
  formatDocRetentionError,
  isCitingSource,
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

function run(t, files, options) {
  const root = fixture(t, files);
  return validateDocRetention(root, Object.keys(files), options).errors;
}

test('recognizes codemap file names and citing sources, and formats errors as path:line: message', () => {
  assert.ok(isCodemapFile('a/b/codemap.md') && isCodemapFile('CODEMAP.md'));
  assert.ok(!isCodemapFile('a/codemap.md.bak') && !isCodemapFile('a/DOCUMENTATION.md') && !isCodemapFile('a/my-codemap.md'));
  assert.ok(['CHANGELOG.md', 'docs/TESTING.md', 'DOCUMENTATION.md', 'packages/x/DOCUMENTATION.md'].every(isCitingSource));
  assert.ok(!['docs/nested/other.md', 'README.md', 'packages/x/README.md', 'packages/x/codemap.md', 'docs/a.txt'].some(isCitingSource));
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

test('audit entries need a README, and loose date-folder files are judged by their own citation', t => {
  const cite = { 'CHANGELOG.md': 'docs/audits/2026-10-09/with-readme docs/audits/2026-10-09/no-readme docs/audits/2026-10-08/note.md' };
  const errors = run(t, {
    ...cite,
    'docs/audits/2026-10-09/with-readme/README.md': '', 'docs/audits/2026-10-09/with-readme/shot.png': '',
    'docs/audits/2026-10-09/no-readme/shot.png': '', 'docs/audits/2026-10-08/note.md': '',
    'docs/audits/2026-10-08/orphan.md': '',
  });
  assert.deepEqual(errors.map((e) => [e.path, /not cited/.test(e.message) ? 'cite' : /needs a README/.test(e.message) ? 'readme' : e.message]), [
    ['docs/audits/2026-10-08/orphan.md', 'cite'],
    ['docs/audits/2026-10-09/no-readme', 'readme'],
  ]);
});

test('forbids raw log, recording and script files anywhere under docs/audits', t => {
  const files = {};
  for (const name of ['a.jsonl', 'b.log', 'c.webm', 'd.mp4', 'e.mjs', 'F.LOG']) files[`docs/audits/2026-09-01-legacy/deep/${name}`] = '';
  files['docs/audits/2026-09-01-legacy/ok.json'] = '{}';
  files['scripts/ok.mjs'] = '';
  const errors = run(t, files);
  assert.equal(errors.length, 6);
  assert.ok(errors.every((e) => /must not keep \./.test(e.message)));
});

test('caps audit files at 200 KB except the pinned live-acceptance evidence', t => {
  assert.equal(AUDIT_PINNED_EVIDENCE.size, 6);
  assert.ok([...AUDIT_PINNED_EVIDENCE].every((file) => file.startsWith('docs/audits/') && file.endsWith('/live-acceptance.json')));
  const big = 'x'.repeat(204801);
  const pinned = 'docs/audits/2026-09-20-context-deduplication/live-acceptance.json';
  const errors = run(t, {
    [pinned]: big, 'docs/audits/2026-09-20-context-deduplication/live-incomplete.json': big,
    'docs/audits/2026-09-20-context-deduplication/edge.json': 'x'.repeat(204800),
    'docs/audits/2026-09-24-duplicate-routes/xai-46/live-acceptance.json': big,
    'docs/audits/2026-09-24-duplicate-routes/xai-48/live-acceptance.json': big,
  });
  assert.deepEqual(errors.map((e) => e.path), [
    'docs/audits/2026-09-20-context-deduplication/live-incomplete.json', 'docs/audits/2026-09-24-duplicate-routes/xai-48/live-acceptance.json']);
  assert.match(errors[0].message, /204801 bytes \(max 204800\)/);
  assert.deepEqual(run(t, { [pinned]: big }, { pinned: new Set([pinned]) }), []);
});

test('cites new-layout audit entries only from CHANGELOG.md, docs/*.md and DOCUMENTATION.md', t => {
  const entry = (name) => ({ [`docs/audits/2026-10-09/${name}/README.md`]: '' });
  const files = {
    ...entry('by-path'), ...entry('by-link'), ...entry('by-doc'), ...entry('by-codemap'), ...entry('by-doc-link'),
    ...entry('uncited'), ...entry('short'), ...entry('short-longer'),
    'CHANGELOG.md': 'See docs/audits/2026-10-09/by-path/README.md.',
    'docs/PLAN.md': '[evidence](audits/2026-10-09/by-link/README.md#top)',
    'packages/x/DOCUMENTATION.md': 'Evidence: `docs/audits/2026-10-09/by-doc` and [more](../../docs/audits/2026-10-09/by-doc-link/)',
    // A codemap is no longer a citing source (it is itself an error), nor are nested docs or READMEs.
    'packages/y/codemap.md': '# y/\n[a](../../docs/audits/2026-10-09/by-codemap/)',
    'docs/nested/other.md': 'docs/audits/2026-10-09/uncited and docs/audits/2026-10-09/short-longer.',
    'packages/z/README.md': 'docs/audits/2026-10-09/uncited',
  };
  const errors = run(t, files);
  assert.deepEqual(errors.filter((e) => /not cited/.test(e.message)).map((e) => e.path), [
    'docs/audits/2026-10-09/by-codemap', 'docs/audits/2026-10-09/short', 'docs/audits/2026-10-09/short-longer', 'docs/audits/2026-10-09/uncited']);
  assert.deepEqual(errors.filter((e) => /codemap files were removed/.test(e.message)).map((e) => e.path), ['packages/y/codemap.md']);
});

test('treats legacy date-prefixed audit entries as grandfathered', t => {
  const errors = run(t, {
    'docs/audits/2026-09-01-legacy/README.md': '', 'docs/audits/2026-09-02-note.md': '', 'docs/audits/reusable-cleanup-checklist.md': '',
  });
  assert.deepEqual(errors, []);
});

test('sorts errors deterministically and lists git files for the CLI', t => {
  const files = { 'b/codemap.md': '', 'a/CODEMAP.md': '', 'docs/audits/2026-10-09/x/README.md': '' };
  assert.deepEqual(run(t, files).map((e) => e.path), ['a/CODEMAP.md', 'b/codemap.md', 'docs/audits/2026-10-09/x']);

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
