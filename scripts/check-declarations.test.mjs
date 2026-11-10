import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASELINE, findDeclarationMismatches, main } from './check-declarations.mjs';

const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function fixture(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-declarations-'));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return { root, files: Object.keys(files) };
}

const baseline = (mismatches, { unchecked = [], transformExports = [] } = {}) => ({ schemaVersion: 1, description: 'fixture', mismatches, unchecked, transformExports });
const entry = (declaration, name) => ({ declaration, name, reason: 'fixture' });
const tree = {
  'packages/runtime/package.json': { name: '@devryan/runtime', main: './index.js', types: './index.d.ts',
    exports: { '.': { types: './index.d.ts', default: './index.js' }, './node/archive.js': { types: './lib/archive.d.ts', default: './lib/archive.js' } } },
  'packages/runtime/index.js': "export * from './lib/tools.js';\nexport { archive as default } from './lib/archive.js';\nexport const { first, second: [second] } = { first: 1, second: [2] };\n",
  'packages/runtime/index.d.ts': "export * from './lib/tools.js';\nexport { archive as default } from './lib/archive.js';\nexport const first: number;\nexport const second: number;\nexport interface Options { a: string }\nexport type Mode = 'a';\nexport type { Shape } from './lib/tools.js';\n",
  'packages/runtime/lib/tools.js': 'export function tool() {}\nexport class Box {}\nexport const extra = 1;\n',
  'packages/runtime/lib/tools.d.ts': 'export function tool(): void;\nexport class Box {}\nexport interface Shape { s: 1 }\n',
  'packages/runtime/lib/archive.js': 'export const archive = () => 1;\n',
  'packages/runtime/lib/archive.d.ts': 'export const archive: () => number;\n',
  'scripts/helper.mjs': 'export const helper = 1;\n',
  'scripts/helper.d.mts': 'export const helper: number;\n',
  'packages/web/runtime/reviewed-inputs/vendor/index.js': 'export {};\n',
  'packages/web/runtime/reviewed-inputs/vendor/index.d.ts': 'export const missing: number;\n',
};
const run = (root, files, argv = []) => {
  const lines = [];
  const log = console.log, error = console.error;
  console.log = console.error = line => lines.push(line);
  try { return { status: main(argv, { root, files }), output: lines.join('\n') }; } finally { console.log = log; console.error = error; }
};

test('matching declarations pass through re-exports, defaults, destructuring and type-only exports; undeclared exports are information', () => {
  const { root, files } = fixture(tree);
  const result = findDeclarationMismatches({ root, files });
  assert.equal(result.pairs, 4);
  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(result.unchecked, []);
  assert.deepEqual(result.undeclared.map(item => [item.declaration, item.name]).sort(),
    [['packages/runtime/index.d.ts', 'extra'], ['packages/runtime/lib/tools.d.ts', 'extra']]);
});

test('a declared export the implementation lacks fails, directly and through a package index re-export', () => {
  const { root, files } = fixture({ ...tree, [BASELINE]: baseline([]),
    'scripts/helper.d.mts': 'export const helper: number;\nexport const PHANTOM: string;\n',
    'packages/runtime/lib/tools.d.ts': 'export function tool(): void;\nexport class Box {}\nexport function ghost(): void;\n' });
  const { mismatches } = findDeclarationMismatches({ root, files });
  assert.deepEqual(mismatches.map(item => [item.declaration, item.name]).sort(), [
    ['packages/runtime/index.d.ts', 'ghost'], ['packages/runtime/lib/tools.d.ts', 'ghost'], ['scripts/helper.d.mts', 'PHANTOM'],
  ]);
  const { status, output } = run(root, files);
  assert.equal(status, 1);
  assert.match(output, /declared but not implemented: scripts\/helper\.d\.mts exports PHANTOM, which scripts\/helper\.mjs does not export/);
  assert.match(output, /3 unlisted, 0 stale/);
});

test('an undeclared implementation export does not fail', () => {
  const { root, files } = fixture({ ...tree, [BASELINE]: baseline([]), 'scripts/helper.mjs': 'export const helper = 1;\nexport const internal = 2;\n' });
  const { status, output } = run(root, files);
  assert.equal(status, 0, output);
  assert.match(output, /0 mismatches \(0 baselined\), 0 transform exports, 0 unchecked pairs, 3 undeclared exports/);
});

test('a baselined mismatch passes, a stale entry fails, and --prune removes only stale entries', () => {
  const { root, files } = fixture({ ...tree, 'scripts/helper.d.mts': 'export const helper: number;\nexport const PHANTOM: string;\n',
    [BASELINE]: baseline([entry('scripts/helper.d.mts', 'PHANTOM')]) });
  assert.equal(run(root, files).status, 0);
  writeFileSync(path.join(root, BASELINE), `${JSON.stringify(baseline([entry('scripts/helper.d.mts', 'PHANTOM'), entry('scripts/helper.d.mts', 'fixed'), entry('scripts/gone.d.mts', 'x')]))}\n`);
  const stale = run(root, files);
  assert.equal(stale.status, 1);
  assert.match(stale.output, /stale entry: scripts\/helper\.d\.mts fixed no longer mismatches/);
  assert.match(stale.output, /0 unlisted, 2 stale/);
  // --prune never adds the unlisted mismatch a new declaration brings.
  writeFileSync(path.join(root, 'scripts/helper.d.mts'), 'export const helper: number;\nexport const PHANTOM: string;\nexport const NEW: string;\n');
  const pruned = run(root, files, ['--prune']);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, BASELINE), 'utf8')).mismatches, [entry('scripts/helper.d.mts', 'PHANTOM')]);
  assert.match(pruned.output, /Pruned 2 stale entries/);
  assert.equal(pruned.status, 1);
  assert.match(pruned.output, /exports NEW/);
});

test('a malformed baseline is refused, naming the file', () => {
  const { root, files } = fixture({ ...tree, [BASELINE]: baseline([{ declaration: 'scripts/helper.d.mts', name: 'x' }]) });
  assert.throws(() => main([], { root, files }), /Invalid entry in scripts\/declaration-parity\.json/);
  writeFileSync(path.join(root, BASELINE), `${JSON.stringify(baseline([entry('a.d.ts', 'x'), entry('a.d.ts', 'x')]))}\n`);
  assert.throws(() => main([], { root, files }), /Duplicate entry in scripts\/declaration-parity\.json/);
  writeFileSync(path.join(root, BASELINE), '{"schemaVersion":1,"description":"x","mismatches":[]}\n');
  assert.throws(() => main([], { root, files }), /scripts\/declaration-parity\.json is invalid/);
  writeFileSync(path.join(root, BASELINE), '{"schemaVersion":1,');
  assert.throws(() => main([], { root, files }), /scripts\/declaration-parity\.json cannot be read/);
  writeFileSync(path.join(root, BASELINE), `${JSON.stringify(baseline([], { unchecked: [{ declaration: 'scripts/a.d.mts' }] }))}\n`);
  assert.throws(() => main([], { root, files }), /Invalid unchecked entry in scripts\/declaration-parity\.json/);
});

test('a pair that cannot be compared fails unless the baseline lists it with a reason', () => {
  const { root, files } = fixture({ ...tree, [BASELINE]: baseline([]),
    'scripts/a.mjs': "export * from 'some-pkg';\nexport const a = 1;\n",
    'scripts/a.d.mts': 'export const a: number;\nexport const ghost: number;\n',
    'scripts/b.cjs': 'module.exports = { b: 1 };\n',
    'scripts/b.d.cts': 'export const ghost: number;\n' });
  const { unchecked } = findDeclarationMismatches({ root, files });
  assert.deepEqual(unchecked.map(item => [item.declaration, item.reason]), [
    ['scripts/a.d.mts', 'implementation re-exports some-pkg'], ['scripts/b.d.cts', 'CommonJS implementation'],
  ]);
  const failed = run(root, files);
  assert.equal(failed.status, 1);
  assert.match(failed.output, /unchecked: scripts\/a\.d\.mts cannot be compared with scripts\/a\.mjs \(implementation re-exports some-pkg\)/);
  assert.match(failed.output, /unchecked: scripts\/b\.d\.cts cannot be compared with scripts\/b\.cjs \(CommonJS implementation\)/);
  assert.match(failed.output, /2 unlisted, 0 stale/);
  const listed = [{ declaration: 'scripts/a.d.mts', reason: 'fixture' }, { declaration: 'scripts/b.d.cts', reason: 'fixture' }];
  writeFileSync(path.join(root, BASELINE), `${JSON.stringify(baseline([], { unchecked: listed }))}\n`);
  const passed = run(root, files);
  assert.equal(passed.status, 0, passed.output);
  assert.match(passed.output, /2 unchecked pairs/);
  // Once the pair can be compared, the entry is stale; --prune removes it.
  const comparable = files.filter(file => !file.startsWith('scripts/b.'));
  writeFileSync(path.join(root, 'scripts/a.mjs'), 'export const a = 1;\nexport const ghost = 2;\n');
  assert.match(run(root, comparable).output, /stale entry: unchecked scripts\/a\.d\.mts is checked now/);
  assert.equal(run(root, comparable, ['--prune']).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, BASELINE), 'utf8')).unchecked, []);
});

test('transform exports are exempt only while the named transform exports them and the mismatch remains', () => {
  const transform = 'packages/runtime/lib/plugin-transform.js';
  const exemption = names => ({ declaration: 'scripts/helper.d.mts', transform, names, reason: 'fixture' });
  const { root, files } = fixture({ ...tree,
    'scripts/helper.d.mts': 'export const helper: number;\nexport const nativeOnly: string;\nexport const nativeOwner: string;\n',
    [transform]: "export function rewrite(source) {\n  return source + `\\nexport const nativeOnly='x';\\nexport {nativeOwner};\\n`;\n}\n",
    [BASELINE]: baseline([], { transformExports: [exemption(['nativeOnly', 'nativeOwner'])] }) });
  const passed = run(root, files);
  assert.equal(passed.status, 0, passed.output);
  assert.match(passed.output, /0 mismatches \(0 baselined\), 2 transform exports/);
  // The transform stops adding a name: the exemption fails.
  writeFileSync(path.join(root, transform), "export function rewrite(source) {\n  return source + `\\nexport const nativeOnly='x';\\n`;\n}\n");
  const dropped = run(root, files);
  assert.equal(dropped.status, 1);
  assert.match(dropped.output, /transform exemption: packages\/runtime\/lib\/plugin-transform\.js no longer exports nativeOwner/);
  // The shipped implementation exports an exempted name: the exemption is stale.
  writeFileSync(path.join(root, transform), "export function rewrite(source) {\n  return source + `\\nexport const nativeOnly='x';\\nexport {nativeOwner};\\n`;\n}\n");
  writeFileSync(path.join(root, 'scripts/helper.mjs'), "export const helper = 1;\nexport const nativeOnly = 'x';\n");
  const stale = run(root, files);
  assert.equal(stale.status, 1);
  assert.match(stale.output, /transform exemption: scripts\/helper\.d\.mts nativeOnly is no longer a mismatch/);
  // A missing transform fails, and --prune never edits exemptions.
  rmSync(path.join(root, transform));
  const missing = run(root, files.filter(file => file !== transform), ['--prune']);
  assert.equal(missing.status, 1);
  assert.match(missing.output, /plugin-transform\.js, named for scripts\/helper\.d\.mts, does not exist/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, BASELINE), 'utf8')).transformExports, [exemption(['nativeOnly', 'nativeOwner'])]);
});

test('the repository passes against its baseline', () => {
  const { status, output } = run(undefined, undefined);
  assert.equal(status, 0, output);
});
