import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importSpecifiers, isTestImporter, loadPackages, resolveSpecifier } from './check-import-boundaries.mjs';
import { MARKDOWN_READERS, SUITE_CONTRACT, TREE_READERS, WHOLE_SUITE_INPUTS, buildScriptTestGraph, selectScriptTests, withMarkdownReaders } from './test-select.mjs';
import { discoverScriptTestFiles } from './test-scripts.mjs';

const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

/** A fixture checkout: `files` maps paths to sources; `listed` adds tracked paths absent from disk (deleted). */
function fixture(files, { listed = [] } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-test-select-'));
  roots.push(root);
  mkdirSync(path.join(root, 'packages'), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  const graph = buildScriptTestGraph({ root, files: [...Object.keys(files), ...listed] });
  return (changed, triggers = changed) => selectScriptTests({ files: changed, triggers, root, graph });
}

const base = {
  'scripts/sel-leaf.mjs': 'export const leaf = 1;\n',
  'scripts/sel-leaf.test.mjs': "import { leaf } from './sel-leaf.mjs';\n",
  'scripts/sel-lib/sel-helper.mjs': 'export const helper = 1;\n',
  'scripts/sel-a.mjs': "export { helper as a } from './sel-lib/sel-helper.mjs';\n",
  'scripts/sel-b.mjs': "const { helper } = require('./sel-lib/sel-helper.mjs');\nmodule.exports = helper;\n",
  'scripts/sel-a.test.mjs': "import { a } from './sel-a.mjs';\n",
  'scripts/sel-b.test.mjs': "import b from './sel-b.mjs';\n",
  'scripts/sel-unrelated.test.mjs': "import assert from 'node:assert';\n",
};

describe('script test selection', () => {
  test('a leaf script selects only the tests importing it', () => {
    const select = fixture(base);
    assert.deepEqual(select(['scripts/sel-leaf.mjs']).tests, ['scripts/sel-leaf.test.mjs']);
    // A test file change also selects the suite contract, which inventories every test file.
    assert.deepEqual(select(['scripts/sel-leaf.test.mjs']).tests, ['scripts/sel-leaf.test.mjs', 'scripts/test-suite-contract.test.mjs']);
  });

  test('a test file of any package selects the suite contract, even when the scripts suite is not in the plan', () => {
    const select = fixture(base);
    assert.deepEqual(select(['packages/harness-runtime/lib/sel-guard.test.js'], []).tests, [SUITE_CONTRACT]);
    assert.deepEqual(select(['packages/harness-runtime/lib/sel-guard.js'], []).tests, []);
    assert.deepEqual(withMarkdownReaders(null, ['packages/shared-runtime/sel-guard.test.js']).tests, [SUITE_CONTRACT]);
    assert.equal(withMarkdownReaders(null, ['packages/shared-runtime/sel-guard.js']), null);
    assert.deepEqual(withMarkdownReaders(null, ['packages/web/node_modules/dep/index.test.js']), null);
  });

  test('a shared helper selects every test whose closure holds it, through re-exports and require()', () => {
    const select = fixture(base);
    const selection = select(['scripts/sel-lib/sel-helper.mjs']);
    assert.equal(selection.all, false);
    assert.deepEqual(selection.tests, ['scripts/sel-a.test.mjs', 'scripts/sel-b.test.mjs']);
    assert.equal(selection.total, 4);
  });

  test('a script a test runs or bundles by path is in that test closure, with its own imports', () => {
    const select = fixture({
      ...base,
      'scripts/sel-tool.mjs': "import { leaf } from './sel-leaf.mjs';\n",
      'scripts/sel-tool.test.mjs': "spawnSync(process.execPath, [path.join(root, 'scripts', 'sel-tool.mjs')]);\n",
      'scripts/sel-entry.test.ts': "await Bun.build({ entrypoints: [new URL('./sel-lib/sel-entry.ts', import.meta.url).pathname] });\n",
      'scripts/sel-lib/sel-entry.ts': "export * from './sel-helper.mjs';\n",
    });
    assert.deepEqual(select(['scripts/sel-tool.mjs']).tests, ['scripts/sel-tool.test.mjs']);
    assert.deepEqual(select(['scripts/sel-leaf.mjs']).tests, ['scripts/sel-leaf.test.mjs', 'scripts/sel-tool.test.mjs']);
    assert.deepEqual(select(['scripts/sel-lib/sel-helper.mjs']).tests, ['scripts/sel-a.test.mjs', 'scripts/sel-b.test.mjs', 'scripts/sel-entry.test.ts']);
  });

  test('a TypeScript import by the emitted extension and a workspace import reach their files', () => {
    const select = fixture({
      'packages/sel-runtime/package.json': JSON.stringify({ name: '@devryan/sel-runtime', main: './index.js' }),
      'packages/sel-runtime/index.js': "export { tool } from '../../scripts/sel-native/sel-tool.ts';\n",
      'scripts/sel-native/sel-tool.ts': 'export const tool = 1;\n',
      'scripts/sel-native/sel-host.ts': "export { tool } from './sel-tool.js';\n",
      'scripts/sel-native/sel-host.test.ts': "import { tool } from './sel-host.js';\n",
      'scripts/sel-runtime.test.mjs': "import { tool } from '@devryan/sel-runtime';\n",
    });
    assert.deepEqual(select(['scripts/sel-native/sel-tool.ts']).tests, ['scripts/sel-native/sel-host.test.ts', 'scripts/sel-runtime.test.mjs']);
  });

  test('shipped package code reaches other files only through quoted paths, not prose names', () => {
    const select = fixture({
      'packages/sel-web/sel-server/sel-help.js': "export const help = 'Run bun scripts/sel-tool.mjs list';\n",
      'packages/sel-web/sel-server/sel-worker.js': 'export const worker = 1;\n',
      'packages/sel-web/sel-server/sel-host.js': "export const url = new URL('./sel-worker.js', import.meta.url);\nexport { help } from './sel-help.js';\n",
      'scripts/sel-tool.mjs': 'export const tool = 1;\n',
      'scripts/sel-server.test.mjs': "import { url } from '../packages/sel-web/sel-server/sel-host.js';\n",
    });
    assert.deepEqual(select(['scripts/sel-tool.mjs']).tests, []);
    assert.deepEqual(select(['packages/sel-web/sel-server/sel-worker.js'], []).tests, ['scripts/sel-server.test.mjs']);
  });

  test('a file of unknown type selects the tests naming it, and the whole suite when none does', () => {
    const select = fixture({ ...base, 'scripts/sel-install.sh': '#!/bin/sh\n', 'scripts/sel-notes.swift': 'print(1)\n',
      'scripts/sel-install.test.mjs': "const script = readFileSync(new URL('./sel-install.sh', import.meta.url), 'utf8');\n" });
    assert.deepEqual(select(['scripts/sel-install.sh']).tests, ['scripts/sel-install.test.mjs']);
    const fallback = select(['scripts/sel-notes.swift']);
    assert.equal(fallback.all, true);
    assert.match(fallback.reason, /scripts\/sel-notes\.swift: no script test names it or its directory/);
    // One unaccounted file runs everything, whatever else changed.
    assert.equal(select(['scripts/sel-leaf.mjs', 'scripts/sel-notes.swift']).all, true);
  });

  test('a fixture read through its directory selects the tests naming that directory', () => {
    const select = fixture({ ...base,
      'scripts/sel-fixtures/sel-github-api/sel-latest.json': '{}\n',
      'scripts/sel-fixtures.test.mjs': "for (const name of readdirSync(path.join(here, 'sel-fixtures', 'sel-github-api'))) load(name);\n" });
    assert.deepEqual(select(['scripts/sel-fixtures/sel-github-api/sel-latest.json']).tests, ['scripts/sel-fixtures.test.mjs']);
  });

  test('a workflow change selects the tests naming .github, and the whole suite when none does', () => {
    const files = { ...base, '.github/workflows/sel-ci.yml': 'on: push\n', '.github/sel-CODEOWNERS': '* @owner\n' };
    assert.equal(fixture(files)(['.github/workflows/sel-ci.yml']).all, true);
    const select = fixture({ ...files,
      'scripts/sel-lib/sel-workflows.mjs': "export const ci = () => readFileSync(path.join(root, '.github/workflows/sel-ci.yml'), 'utf8');\n",
      'scripts/sel-workflow.test.mjs': "import { ci } from './sel-lib/sel-workflows.mjs';\n" });
    assert.deepEqual(select(['.github/workflows/sel-ci.yml']).tests, ['scripts/sel-workflow.test.mjs']);
    assert.deepEqual(select(['.github/sel-CODEOWNERS']).tests, ['scripts/sel-workflow.test.mjs']);
  });

  test('a declaration file selects the tests naming it and those reaching its implementation', () => {
    const select = fixture({ ...base, 'scripts/sel-leaf.d.mts': 'export declare const leaf: number;\n' });
    assert.deepEqual(select(['scripts/sel-leaf.d.mts']).tests, ['scripts/sel-leaf.test.mjs']);
  });

  test('the selector, its resolver, the suite machinery and reviewed inputs run the whole suite', () => {
    const select = fixture(base);
    for (const file of WHOLE_SUITE_INPUTS) {
      const selection = select([file, 'scripts/sel-leaf.mjs']);
      assert.equal(selection.all, true, file);
      assert.match(selection.reason, new RegExp(file.replaceAll('.', '\\.')));
    }
    assert.ok(WHOLE_SUITE_INPUTS.includes('scripts/test-select.mjs'));
    assert.equal(select(['packages/web/runtime/reviewed-inputs/model-catalog/provenance.json']).all, true);
  });

  test('a deleted file selects the tests still importing or naming it', () => {
    const select = fixture({
      'scripts/sel-stale.test.mjs': "import { old } from './sel-old';\n",
      'scripts/sel-named.test.mjs': "execFileSync('node', ['scripts/sel-old.mjs']);\n",
      'scripts/sel-other.test.mjs': "import assert from 'node:assert';\n",
    }, { listed: ['scripts/sel-old.mjs'] });
    assert.deepEqual(select(['scripts/sel-old.mjs']).tests, ['scripts/sel-named.test.mjs', 'scripts/sel-stale.test.mjs']);
    // Absent from the graph's file list too (deleted and never tracked): names still reach it.
    const untracked = fixture({ 'scripts/sel-named.test.mjs': "execFileSync('node', ['scripts/sel-gone.mjs']);\n" });
    assert.deepEqual(untracked(['scripts/sel-gone.mjs']).tests, ['scripts/sel-named.test.mjs']);
    // A deleted file nothing reaches selects nothing.
    assert.deepEqual(untracked(['scripts/sel-forgotten.mjs']).tests, []);
  });

  test('a rename selects the importers of both paths', () => {
    const select = fixture({
      'scripts/sel-renamed.mjs': 'export const value = 1;\n',
      'scripts/sel-updated.test.mjs': "import { value } from './sel-renamed.mjs';\n",
      'scripts/sel-stale.test.mjs': "import { value } from './sel-original.mjs';\n",
      'scripts/sel-other.test.mjs': "import assert from 'node:assert';\n",
    });
    assert.deepEqual(select(['scripts/sel-original.mjs', 'scripts/sel-renamed.mjs']).tests, ['scripts/sel-stale.test.mjs', 'scripts/sel-updated.test.mjs']);
  });

  test('a suite test file change also runs the tests of the suite inventory', () => {
    const select = fixture({ ...base,
      'scripts/test-scripts.mjs': 'export const discover = () => [];\n',
      'scripts/sel-inventory.test.mjs': "import { discover } from './test-scripts.mjs';\n" });
    assert.deepEqual(select(['scripts/sel-new.test.mjs']).tests, ['scripts/sel-inventory.test.mjs', 'scripts/test-suite-contract.test.mjs']);
    assert.deepEqual(select(['scripts/sel-leaf.test.mjs']).tests, ['scripts/sel-inventory.test.mjs', 'scripts/sel-leaf.test.mjs', 'scripts/test-suite-contract.test.mjs']);
  });

  test('a file under a tree a script test reads whole selects that test, triggering or not', () => {
    const [{ prefix, tests: [reader] }] = TREE_READERS;
    const select = fixture({ ...base, [reader]: "import assert from 'node:assert';\n", [`${prefix}src/sel-unnamed.rs`]: 'fn main() {}\n',
      [`${prefix}sel-unnamed.toml`]: '[package]\n' });
    for (const file of [`${prefix}src/sel-unnamed.rs`, `${prefix}sel-unnamed.toml`, `${prefix}src/sel-deleted.rs`]) {
      const selection = select(['scripts/sel-leaf.mjs', file], ['scripts/sel-leaf.mjs']);
      assert.deepEqual(selection.tests, [reader, 'scripts/sel-leaf.test.mjs'].sort(), file);
    }
    assert.deepEqual(select(['packages/sel-other/src/sel-unnamed.rs'], []).tests, []);
  });

  test('changed files that did not trigger the suite add the tests reaching them but never widen it', () => {
    const select = fixture({ ...base, 'packages/sel-web/sel-data.json': '{}\n',
      'scripts/sel-web.test.mjs': "import data from '../packages/sel-web/sel-data.json' with { type: 'json' };\n" });
    const selection = select(['scripts/sel-leaf.mjs', 'packages/sel-web/sel-data.json', 'packages/sel-ui/sel-notes.swift'], ['scripts/sel-leaf.mjs']);
    assert.equal(selection.all, false);
    assert.deepEqual(selection.tests, ['scripts/sel-leaf.test.mjs', 'scripts/sel-web.test.mjs']);
    assert.deepEqual([...selection.reasons.keys()], ['scripts/sel-leaf.mjs']);
  });
});

describe('script test selection on this repository', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(file => file && !file.includes('node_modules/'));
  const isTracked = new Set(tracked);
  const byName = Map.groupBy(tracked, file => path.posix.basename(file));
  const tests = discoverScriptTestFiles(root);
  const packages = loadPackages(root);
  const SUFFIXES = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts', '/index.ts', '/index.js', '/index.mjs'];
  const isFile = file => { try { return statSync(path.join(root, file)).isFile(); } catch { return false; } };
  // An independent reading of a source's edges: its imports (TypeScript's
  // pre-processor, resolved here without the selector's resolver) and, for
  // repository scripts and tests, the tracked files it names.
  const resolve = (importer, specifier) => {
    let target = null;
    if (/^\.\.?\//.test(specifier)) target = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier.split('?')[0]));
    else if (/^@(?:devryan|openchamber)\//.test(specifier)) target = resolveSpecifier({ root, packages, importer, specifier })?.target ?? null;
    if (!target || target.startsWith('../')) return null;
    for (const candidate of [...SUFFIXES.map(suffix => target + suffix), target.replace(/\.([cm]?)js$/, '.$1ts')]) if (isFile(candidate)) return candidate;
    return null;
  };
  // One read per file, shared by the selector's graph and this check's own edges.
  const sources = new Map();
  const read = file => {
    if (!sources.has(file)) sources.set(file, readFileSync(path.join(root, file), 'utf8'));
    return sources.get(file);
  };
  let graph;
  const repositoryGraph = () => (graph ??= buildScriptTestGraph({ root, readSource: read }));
  const edges = new Map();
  const edgesOf = file => {
    if (edges.has(file)) return edges.get(file);
    const result = new Set();
    edges.set(file, result);
    // Installed and reviewed packages: never a changed file the selector sees
    // (git ignores node_modules; reviewed inputs run the whole suite).
    if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(file) || /\.d\.[cm]?ts$/.test(file) || file.startsWith('packages/web/runtime/reviewed-inputs/')) return result;
    let source;
    try { source = read(file); } catch { return result; }
    for (const specifier of importSpecifiers(source)) { const target = resolve(file, specifier); if (target && !target.includes('node_modules/')) result.add(target); }
    if (!file.startsWith('packages/') || isTestImporter(file)) {
      for (const name of new Set(source.split(/[^A-Za-z0-9_@.+-]+/))) for (const target of byName.get(name) ?? []) if (target !== file) result.add(target);
    }
    return result;
  };

  test('every file in a script test closure selects that test when it is the only change', () => {
    // Every pair is checked (about 200k pairs over 2.5k files): the cost is reading and parsing the
    // closures once, which a sample would not reduce.
    const selections = new Map();
    const select = file => {
      if (!selections.has(file)) selections.set(file, selectScriptTests({ files: [file], root, graph: repositoryGraph() }));
      return selections.get(file);
    };
    const misses = [];
    let pairs = 0;
    for (const test of tests) {
      const closure = new Set([test]);
      const queue = [test];
      while (queue.length) for (const next of edgesOf(queue.pop())) if (!closure.has(next)) { closure.add(next); queue.push(next); }
      for (const file of closure) {
        if (!isTracked.has(file) && !isFile(file)) continue;
        pairs += 1;
        const selection = select(file);
        if (!selection.all && !selection.tests.includes(test)) misses.push(`${test} <- ${file}`);
      }
    }
    assert.ok(pairs > tests.length * 20, `${pairs} pairs`);
    assert.deepEqual(misses, []);
  });

  test('every script-suite source that lists repository Markdown is a Markdown reader or reviewed as not reading it', () => {
    // Sources that list the checkout's files with a Markdown filter. A new one
    // must join MARKDOWN_READERS (its tests then run for any Markdown change)
    // or this list with the reason its tests never read the checkout's Markdown.
    const reviewed = new Map([
      ['scripts/validate.mjs', 'classifies changed paths; reads no Markdown'],
      ['scripts/test-select.mjs', 'the selector; reads script sources, not Markdown'],
      ['scripts/test-select.test.mjs', 'this check; reads script sources, not Markdown'],
      ['scripts/docs/validate-docs.mjs', 'the docs:validate command; script tests run it only on fixture roots'],
      ['scripts/docs/doc-retention.mjs', 'reads file names, not contents'],
      ['scripts/perf/ledger-benchmark.mjs', 'lists its own fixture repositories'],
      ['scripts/perf/ledger-profile-worker.mjs', 'lists its own fixture repositories'],
    ]);
    const listing = [...repositoryGraph().sources].filter(([, source]) => /ls-files/.test(source) && /\*\.mdx?|\\\.mdx?|\.md'|\.md\$/.test(source)).map(([file]) => file).sort();
    for (const file of listing) assert.ok(MARKDOWN_READERS.includes(file) || reviewed.has(file), `${file} lists repository Markdown`);
    for (const file of [...MARKDOWN_READERS, ...reviewed.keys()]) assert.ok(listing.includes(file), `${file} no longer lists Markdown; update the list`);
  });
});
