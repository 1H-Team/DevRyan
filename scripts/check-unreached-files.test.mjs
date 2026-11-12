import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALLOWLIST, findUnreachedFiles, main } from './check-unreached-files.mjs';

const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function fixture(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-unreached-files-'));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return { root, files: Object.keys(files) };
}

const allowlist = files => ({ schemaVersion: 1, description: 'fixture', files: files.map(file => typeof file === 'string' ? { file, kind: 'awaiting-removal', reason: 'fixture' } : file) });
const tree = {
  'packages/web/package.json': { name: '@devryan/web', main: './server/index.js' },
  'packages/ui/package.json': { name: '@devryan/ui', main: 'src/main.tsx' },
  'packages/web/src/main.tsx': "import '@/app';\nconst lazy = () => import('./lazy');\n",
  'packages/web/src/lazy.ts': 'export {};\n',
  'packages/web/src/sw.ts': "import './sw-helper';\n",
  'packages/web/src/sw-helper.ts': 'export {};\n',
  'packages/web/src/types.d.ts': 'declare const x: number;\n',
  'packages/ui/src/app.tsx': 'export default 1;\n',
  'packages/ui/src/fixture.tsx': 'export default 1;\n',
  'packages/ui/src/app.test.tsx': "import './fixture';\n",
  'packages/web/server/ui.test.js': "import '../../ui/src/server-only.ts';\n",
  'packages/ui/src/server-only.ts': 'export {};\n',
  'packages/ui/src/orphan.ts': 'export {};\n',
};
const run = (root, files, argv = []) => {
  const lines = [];
  const log = console.log, error = console.error;
  console.log = console.error = line => lines.push(line);
  try { return { status: main(argv, { root, files }), output: lines.join('\n') }; } finally { console.log = log; console.error = error; }
};

test('finds sources no entry and no test reaches, and those only tests reach', () => {
  const { root, files } = fixture(tree);
  const result = findUnreachedFiles({ root, files, entries: ['packages/web/src/main.tsx', 'packages/web/src/sw.ts'] });
  // Declarations and tests are not sources; a server test still contributes its own imports.
  assert.equal(result.sources, 8);
  assert.deepEqual(result.unreached, ['packages/ui/src/orphan.ts']);
  assert.deepEqual(result.testOnly, ['packages/ui/src/fixture.tsx', 'packages/ui/src/server-only.ts']);
});

test('an unreached file the allowlist omits fails', () => {
  const { root, files } = fixture({ ...tree, [ALLOWLIST]: allowlist([]) });
  const { status, output } = run(root, files);
  assert.equal(status, 1);
  assert.match(output, /unreached: packages\/ui\/src\/orphan\.ts/);
  assert.match(output, /1 unlisted, 0 stale/);
});

test('an allowlisted unreached file passes and reports the test-only count; --verbose names those files', () => {
  const { root, files } = fixture({ ...tree, 'packages/ui/src/probe.ts': 'export {};\n',
    [ALLOWLIST]: allowlist(['packages/ui/src/orphan.ts', { file: 'packages/ui/src/probe.ts', kind: 'hand-run', reason: 'run by hand' }]) });
  const { status, output } = run(root, files);
  assert.equal(status, 0);
  assert.match(output, /2 unreached \(2 allowlisted: 1 awaiting-removal, 1 hand-run\), 2 reached by tests only \(--verbose lists them\)/);
  assert.doesNotMatch(output, /reached by tests only: /);
  const verbose = run(root, files, ['--verbose']);
  assert.equal(verbose.status, 0);
  assert.match(verbose.output, /reached by tests only: packages\/ui\/src\/fixture\.tsx\nreached by tests only: packages\/ui\/src\/server-only\.ts/);
});

test('a listed file that is now reached or deleted fails as stale', () => {
  const { root, files } = fixture({ ...tree, [ALLOWLIST]: allowlist(['packages/ui/src/app.tsx', 'packages/ui/src/fixture.tsx', 'packages/ui/src/gone.ts', 'packages/ui/src/orphan.ts']) });
  const { status, output } = run(root, files);
  assert.equal(status, 1);
  assert.match(output, /stale entry: packages\/ui\/src\/app\.tsx \(awaiting-removal\) is now reached/);
  assert.match(output, /stale entry: packages\/ui\/src\/fixture\.tsx \(awaiting-removal\) is now reached/);
  assert.match(output, /stale entry: packages\/ui\/src\/gone\.ts \(awaiting-removal\) is deleted/);
  assert.match(output, /0 unlisted, 3 stale/);
});

test('--prune removes only stale entries and never adds an unreached file', () => {
  const { root, files } = fixture({ ...tree, 'packages/ui/src/second-orphan.ts': 'export {};\n',
    [ALLOWLIST]: allowlist(['packages/ui/src/app.tsx', 'packages/ui/src/gone.ts', 'packages/ui/src/orphan.ts']) });
  const { status, output } = run(root, files, ['--prune']);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, ALLOWLIST), 'utf8')).files, allowlist(['packages/ui/src/orphan.ts']).files);
  assert.match(output, /Pruned 2 stale entries/);
  // The unlisted orphan still fails after pruning.
  assert.equal(status, 1);
  assert.match(output, /unreached: packages\/ui\/src\/second-orphan\.ts/);
  const clean = run(root, files.filter(file => file !== 'packages/ui/src/second-orphan.ts'), ['--prune']);
  assert.equal(clean.status, 0);
  assert.doesNotMatch(clean.output, /Pruned/);
});

test('a malformed or duplicated allowlist is refused, naming the file', () => {
  const { root, files } = fixture({ ...tree, [ALLOWLIST]: allowlist(['packages/ui/src/orphan.ts', 'packages/ui/src/orphan.ts']) });
  assert.throws(() => main([], { root, files }), /Duplicate entry in scripts\/unreached-files\.json/);
  writeFileSync(path.join(root, ALLOWLIST), '{"schemaVersion":2,"description":"x","files":[]}\n');
  assert.throws(() => main([], { root, files }), /scripts\/unreached-files\.json is invalid/);
  writeFileSync(path.join(root, ALLOWLIST), '{"schemaVersion":1,"description":"x","files":[');
  assert.throws(() => main([], { root, files }), /scripts\/unreached-files\.json cannot be read/);
  // Every entry needs a known kind and a reason.
  for (const entry of [{ file: 'packages/ui/src/orphan.ts' }, { file: 'packages/ui/src/orphan.ts', kind: 'kept', reason: 'x' }, { file: 'packages/ui/src/orphan.ts', kind: 'hand-run', reason: '' }]) {
    writeFileSync(path.join(root, ALLOWLIST), `${JSON.stringify({ schemaVersion: 1, description: 'x', files: [entry] })}\n`);
    assert.throws(() => main([], { root, files }), /Invalid entry in scripts\/unreached-files\.json/);
  }
  assert.throws(() => main(['--add'], { root, files }), /Usage/);
});

test('the repository passes against its allowlist', () => {
  const { status, output } = run(undefined, undefined);
  assert.equal(status, 0, output);
});
