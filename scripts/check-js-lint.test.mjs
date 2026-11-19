import { execFileSync } from 'node:child_process';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASELINE, CONFIG, formatBaseline, main, packageOf, parseJsonc, readBaseline, ruleName } from './check-js-lint.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

// A repository with the real configurations (the JavaScript one extends the TypeScript one) and these files.
function fixture(files, findings = []) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-js-lint-'));
  roots.push(root);
  for (const config of ['.oxlintrc.json', CONFIG]) copyFileSync(path.join(repositoryRoot, config), path.join(root, config));
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  writeFileSync(path.join(root, BASELINE), formatBaseline({ description: 'fixture', findings }));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return { root, files: Object.keys(files) };
}

function run(root, files, argv = [], options = {}) {
  const lines = [];
  const log = console.log, error = console.error;
  console.log = console.error = line => lines.push(line);
  try { return { status: main(argv, { root, files, ...options }), output: lines.join('\n') }; } finally { console.log = log; console.error = error; }
}

const baselineOf = root => JSON.parse(readFileSync(path.join(root, BASELINE), 'utf8')).findings;
const clean = 'export const value = 1;\n';
const oneLet = 'let value = 1;\nexport { value };\n';
const twoLets = 'let value = 1;\nlet other = 2;\nexport { value, other };\n';
const entry = (file, rule, count) => ({ file, rule, count });

test('passes on the repository as it is, against its baseline', () => {
  const { status, output } = run(undefined, undefined);
  assert.equal(status, 0, output);
  assert.match(output, /JavaScript lint passed \(\d+ files, \d+ findings, \d+ baseline entries/);
  assert.ok(readBaseline().canonical, `${BASELINE} is canonical`);
});

test('a planted finding in a file the baseline does not list fails, naming the line and the entry it would need', () => {
  const { root, files } = fixture({ 'scripts/tool.mjs': clean, 'packages/web/server/new.js': oneLet });
  const { status, output } = run(root, files);
  assert.equal(status, 1);
  assert.match(output, /new finding: packages\/web\/server\/new\.js prefer-const: 1 found, 0 in scripts\/js-lint-baseline\.json/);
  assert.match(output, /packages\/web\/server\/new\.js:1:5 /);
  assert.match(output, /\{"file":"packages\/web\/server\/new\.js","rule":"prefer-const","count":1\}/);
  assert.match(output, /1 new, 0 stale/);
  // The baseline is never written by a check.
  assert.deepEqual(baselineOf(root), []);
});

test('a planted increase over the recorded count fails; the recorded count passes', () => {
  const { root, files } = fixture({ 'packages/electron/main.mjs': twoLets }, [entry('packages/electron/main.mjs', 'prefer-const', 1)]);
  const { status, output } = run(root, files);
  assert.equal(status, 1);
  assert.match(output, /new finding: packages\/electron\/main\.mjs prefer-const: 2 found, 1 in /);
  writeFileSync(path.join(root, 'packages/electron/main.mjs'), oneLet);
  const recorded = run(root, files);
  assert.equal(recorded.status, 0, recorded.output);
  assert.match(recorded.output, /packages\/electron: 1 files, 1 findings, 1 baseline entries/);
});

test('a stale entry fails until --prune lowers or removes it; --prune never adds an entry', () => {
  const { root, files } = fixture({ 'scripts/a.mjs': oneLet, 'scripts/b.mjs': clean, 'scripts/c.mjs': oneLet },
    [entry('scripts/a.mjs', 'prefer-const', 3), entry('scripts/b.mjs', 'prefer-const', 1), entry('scripts/gone.mjs', 'no-unused-vars', 2)]);
  const { status, output } = run(root, files);
  assert.equal(status, 1);
  assert.match(output, /stale entry: scripts\/a\.mjs prefer-const \(count 3\) now occurs 1 time; run node scripts\/check-js-lint\.mjs --prune/);
  assert.match(output, /stale entry: scripts\/b\.mjs prefer-const \(count 1\) no longer occurs/);
  assert.match(output, /stale entry: scripts\/gone\.mjs no-unused-vars \(count 2\) is deleted or no longer linted/);
  const pruned = run(root, files, ['--prune']);
  assert.match(pruned.output, /Pruned 3 stale entries/);
  assert.deepEqual(baselineOf(root), [entry('scripts/a.mjs', 'prefer-const', 1)]);
  // scripts/c.mjs's finding is still new: pruning added nothing for it.
  assert.equal(pruned.status, 1);
  assert.match(pruned.output, /new finding: scripts\/c\.mjs prefer-const/);
  writeFileSync(path.join(root, 'scripts/c.mjs'), clean);
  assert.equal(run(root, files).status, 0);
});

test('fast mode checks only the named files, and a deleted or excluded file finds its entries stale', () => {
  const { root, files } = fixture({ 'scripts/a.mjs': oneLet, 'scripts/b.mjs': oneLet, 'scripts/c.mjs': clean },
    [entry('scripts/a.mjs', 'prefer-const', 1), entry('scripts/gone.mjs', 'prefer-const', 1),
      entry('packages/web/server/lib/opencode/v2/routes.generated.js', 'prefer-const', 1)]);
  // b.mjs's unrecorded finding is outside the change set.
  const changed = run(root, files, ['--files', 'scripts/a.mjs', 'scripts/c.mjs']);
  assert.equal(changed.status, 0, changed.output);
  assert.match(changed.output, /2 files, 1 findings, 1 baseline entries \(2 requested\)/);
  const deleted = run(root, files, ['--files', 'scripts/gone.mjs', 'packages/web/server/lib/opencode/v2/routes.generated.js']);
  assert.equal(deleted.status, 1);
  assert.match(deleted.output, /stale entry: scripts\/gone\.mjs prefer-const \(count 1\) is deleted or no longer linted/);
  assert.match(deleted.output, /stale entry: packages\/web\/server\/lib\/opencode\/v2\/routes\.generated\.js prefer-const/);
  assert.match(run(root, files, ['--files', 'scripts/b.mjs']).output, /new finding: scripts\/b\.mjs prefer-const/);
  assert.throws(() => main(['--files'], { root, files }), /--files needs at least one file/);
  assert.throws(() => main(['--add'], { root, files }), /Usage/);
});

test('a file oxlint cannot parse fails and cannot be baselined', () => {
  const { root, files } = fixture({ 'packages/web/server/broken.test.js': "import { vi } from 'vitest';\nimport { vi } from 'vitest';\n" });
  const { status, output } = run(root, files);
  assert.equal(status, 1);
  assert.match(output, /cannot parse: packages\/web\/server\/broken\.test\.js:\d+:\d+ .*it cannot be baselined/);
  assert.match(output, /1 unparsable, 0 new, 0 stale/);
  writeFileSync(path.join(root, BASELINE), formatBaseline({ description: 'fixture', findings: [entry('packages/web/server/broken.test.js', 'parse-error', 1)] }));
  assert.throws(() => main([], { root, files }), /cannot list parse-error/);
});

test('the JavaScript rule decisions: the bug-finding rules stay errors, the four noise rules and the scoped ones do not report', () => {
  const quiet = {
    // no-empty allows an empty catch; no-control-regex and require-yield are off.
    'packages/web/server/a.js': "export function a(f) { try { f(); } catch {} return /\\x00/.test(''); }\nexport async function* idle() {}\n",
    // no-unused-expressions allows ternary and short-circuit statements.
    'packages/web/server/b.js': 'export function b(x, f, g) { x ? f() : g(); x && f(); }\n',
    'packages/electron/preload.cjs': "const { contextBridge } = require('electron');\nmodule.exports = { contextBridge };\n",
    'tests/fixture/main.jsx': 'export const options = {};\nexport function App() { return null; }\n',
    'scripts/client-conformance/vectors.mjs': 'export const vectors = [9007199254740993, [1, , 3], /  /];\n',
    // Vendored and generated code is never linted.
    'packages/web/runtime/reviewed-inputs/vendor/index.js': oneLet,
    'packages/web/server/lib/opencode/v2/routes.generated.js': oneLet,
  };
  const { root, files } = fixture(quiet);
  const passed = run(root, files);
  assert.equal(passed.status, 0, passed.output);
  assert.match(passed.output, /5 files, 0 findings/);
  const loud = {
    'packages/web/server/empty.js': 'export function e(x) { if (x) {} }\n',
    // The class of the inspector bug: \s in a template literal reaches the page as s.
    'packages/electron/escape.mjs': 'export const script = `x.split(/\\s+/)`;\n',
    'scripts/finally.mjs': 'export function f(g) { try { return g(); } finally { throw new Error("cleanup"); } }\n',
    'packages/web/server/keys.js': 'export const keys = { a: 1, a: 2 };\n',
    'packages/web/server/require.js': "const fs = require('node:fs');\nexport { fs };\n",
  };
  const failing = fixture(loud);
  const { status, output } = run(failing.root, failing.files);
  assert.equal(status, 1);
  for (const [file, rule] of [['packages/web/server/empty.js', 'no-empty'], ['packages/electron/escape.mjs', 'no-useless-escape'],
    ['scripts/finally.mjs', 'no-unsafe-finally'], ['packages/web/server/keys.js', 'no-dupe-keys'], ['packages/web/server/require.js', 'typescript/no-require-imports']]) {
    assert.match(output, new RegExp(`new finding: ${file.replaceAll('.', '\\.')} ${rule}:`), `${file} ${rule}`);
  }
});

test('the baseline and the output are ordered by code unit, not by locale', () => {
  const { root, files } = fixture({ 'scripts/b.mjs': oneLet, 'scripts/B.mjs': oneLet, 'scripts/_b.mjs': oneLet },
    [entry('scripts/b.mjs', 'prefer-const', 2), entry('scripts/_b.mjs', 'prefer-const', 2), entry('scripts/B.mjs', 'prefer-const', 2)]);
  const { output } = run(root, files);
  const order = [...output.matchAll(/stale entry: (\S+)/g)].map(match => match[1]);
  assert.deepEqual(order, ['scripts/B.mjs', 'scripts/_b.mjs', 'scripts/b.mjs']);
  run(root, files, ['--prune']);
  assert.deepEqual(baselineOf(root).map(item => item.file), ['scripts/B.mjs', 'scripts/_b.mjs', 'scripts/b.mjs']);
  assert.ok(readBaseline(root).canonical);
});

test('a baseline that is unsorted, malformed or duplicated is refused', () => {
  const { root, files } = fixture({ 'scripts/a.mjs': oneLet, 'scripts/b.mjs': oneLet });
  const unsorted = { schemaVersion: 1, description: 'x', findings: [entry('scripts/b.mjs', 'prefer-const', 1), entry('scripts/a.mjs', 'prefer-const', 1)] };
  writeFileSync(path.join(root, BASELINE), `${JSON.stringify(unsorted, null, 2)}\n`);
  const { status, output } = run(root, files);
  assert.equal(status, 1);
  assert.match(output, /is not in canonical form/);
  assert.equal(run(root, files, ['--prune']).status, 0);
  assert.ok(readBaseline(root).canonical);
  for (const findings of [[entry('scripts/a.mjs', 'prefer-const', 0)], [{ file: 'scripts/a.mjs', rule: 'prefer-const' }],
    [{ ...entry('scripts/a.mjs', 'prefer-const', 1), line: 1 }]]) {
    writeFileSync(path.join(root, BASELINE), `${JSON.stringify({ schemaVersion: 1, description: 'x', findings })}\n`);
    assert.throws(() => main([], { root, files }), /Invalid entry in scripts\/js-lint-baseline\.json/);
  }
  writeFileSync(path.join(root, BASELINE), `${JSON.stringify({ schemaVersion: 1, description: 'x', findings: [entry('scripts/a.mjs', 'prefer-const', 1), entry('scripts/a.mjs', 'prefer-const', 1)] })}\n`);
  assert.throws(() => main([], { root, files }), /Duplicate entry/);
  writeFileSync(path.join(root, BASELINE), '{"schemaVersion":2,"description":"x","findings":[]}\n');
  assert.throws(() => main([], { root, files }), /is invalid/);
});

test('helpers: rule names, packages and the commented configuration', () => {
  assert.equal(ruleName('eslint(no-empty)'), 'no-empty');
  assert.equal(ruleName('typescript-eslint(no-require-imports)'), 'typescript/no-require-imports');
  assert.equal(ruleName('eslint-plugin-react(only-export-components)'), 'react/only-export-components');
  assert.equal(ruleName(undefined), 'parse-error');
  assert.equal(packageOf('packages/web/server/index.js'), 'packages/web');
  assert.equal(packageOf('scripts/qa/run.mjs'), 'scripts');
  assert.equal(packageOf('postcss.config.js'), '(root)');
  assert.deepEqual(parseJsonc('{\n  // a "comment"\n  "a": "//x", /* b */ "b": ["/*y*/"]\n}'), { a: '//x', b: ['/*y*/'] });
  // Every JavaScript-only rule change carries its reason on the line above it.
  const lines = readFileSync(path.join(repositoryRoot, CONFIG), 'utf8').split('\n');
  for (const [index, line] of lines.entries()) {
    if (/^\s*"(?:[\w/-]+)": (?:"off"|\[)/.test(line) && !/^\s*"(?:extends|overrides|no-loss-of-precision|no-sparse-arrays|no-regex-spaces)"/.test(line)) {
      assert.match(lines[index - 1], /^\s*\/\/ /, `reason above ${line.trim()}`);
    }
  }
});

test('a file an .eslintignore lists is still linted: oxlint never skips a file the checker gave it', () => {
  const { root, files } = fixture({ 'scripts/hidden.mjs': oneLet, 'scripts/shown.mjs': clean, '.eslintignore': 'scripts/hidden.mjs\nscripts/**\n' });
  const full = run(root, files);
  assert.equal(full.status, 1);
  assert.match(full.output, /new finding: scripts\/hidden\.mjs prefer-const: 1 found/);
  assert.match(full.output, /2 files, 1 findings/);
  const fast = run(root, files, ['--files', 'scripts/hidden.mjs']);
  assert.equal(fast.status, 1);
  assert.match(fast.output, /new finding: scripts\/hidden\.mjs prefer-const/);
});

test('a linter that prints nothing, lints fewer files than given, or crashes fails the check', () => {
  const { root, files } = fixture({ 'scripts/a.mjs': oneLet, 'scripts/b.mjs': clean });
  const fake = (name, source) => { const file = path.join(root, name); writeFileSync(file, source); return file; };
  const silent = fake('silent.mjs', '');
  assert.throws(() => run(root, files, [], { oxlint: silent }), /oxlint failed \(exit 0\): no output/);
  const partial = fake('partial.mjs', "process.stdout.write(JSON.stringify({ diagnostics: [], number_of_files: 1 }));\n");
  assert.throws(() => run(root, files, [], { oxlint: partial }), /it linted 1 of the 2 files it was given/);
  const none = fake('none.mjs', "process.stdout.write(JSON.stringify({ diagnostics: [], number_of_files: 0 }));\n");
  assert.throws(() => run(root, files, ['--files', 'scripts/a.mjs'], { oxlint: none }), /it linted 0 of the 1 files/);
  const crash = fake('crash.mjs', "process.stdout.write(JSON.stringify({ diagnostics: [], number_of_files: 2 }));\nprocess.exit(2);\n");
  assert.throws(() => run(root, files, [], { oxlint: crash }), /oxlint failed \(exit 2\)/);
});

test('an excluded directory excludes only itself, and dependency paths are never linted', () => {
  const { root, files } = fixture({
    // A sibling whose name starts with an excluded directory's name is first-party code.
    'packages/web/runtime/reviewed-inputs-extra/index.js': oneLet,
    'packages/web/runtime/reviewed-inputs/vendor/index.js': oneLet,
    'node_modules/dependency/index.js': oneLet,
    'packages/web/node_modules/dependency/index.mjs': oneLet,
  });
  const { status, output } = run(root, files);
  assert.equal(status, 1);
  assert.match(output, /new finding: packages\/web\/runtime\/reviewed-inputs-extra\/index\.js prefer-const/);
  assert.match(output, /1 files, 1 findings/);
  assert.doesNotMatch(output, /node_modules|reviewed-inputs\/vendor/);
});

test('a full check lists untracked files as well as tracked ones', () => {
  const { root } = fixture({ 'scripts/tracked.mjs': clean, 'scripts/untracked.mjs': oneLet });
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', 'scripts/tracked.mjs'], { cwd: root });
  const { status, output } = run(root, undefined);
  assert.equal(status, 1);
  assert.match(output, /new finding: scripts\/untracked\.mjs prefer-const/);
  assert.match(output, /2 files, 1 findings/);
});
