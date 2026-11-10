#!/usr/bin/env node
// Script-test selection for fast `validate`: given the changed files, the
// scripts-suite test files that must run. A test runs when its closure holds a
// changed file. The closure follows, from every code file:
// - imports, read by TypeScript's pre-processor (static imports, re-exports,
//   require(), literal import()) and resolved with the resolvers of
//   scripts/check-import-boundaries.mjs, relative paths outside packages/ too;
// - every quoted relative or workspace path (module URLs, worker and fixture
//   paths), a superset of the import specifiers;
// - names: a script, test, fixture or tool source that writes a repository
//   file's name in any form (a spawned script, a Bun.build entry, a read
//   fixture) may load or read it, so it reaches every file of that name.
//   Shipped package code loads files only through the two kinds above.
// Selection only errs toward running more: a change it cannot account for runs
// the whole suite (see selectScriptTests). CI and `validate:full` always run
// every script test; only fast mode uses this module.
//
//   node scripts/test-select.mjs <file>...   print the selection for these changes
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { importSpecifiers, isTestImporter, loadPackages, resolveFile, resolveSpecifier } from './check-import-boundaries.mjs';
import { testFilePattern } from './test-runner-utils.mjs';
import { discoverScriptTestFiles } from './test-scripts.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The selector, its resolver and the suite machinery: a change to any of them
 * can change which tests run or how every test runs, so it runs the whole suite.
 */
export const WHOLE_SUITE_INPUTS = Object.freeze([
  'scripts/test-select.mjs',
  'scripts/check-import-boundaries.mjs',
  'scripts/validate.mjs',
  'scripts/test-scripts.mjs',
  'scripts/test-runner-utils.mjs',
  'scripts/test-full.mjs',
  'scripts/test-ci-lanes.mjs',
  'scripts/test-pool.mjs',
  'scripts/test-suite-contract.test.mjs',
]);
// Reviewed inputs are hashed and read as whole trees by manifest code; which
// tests read a given file is not proven, so any change runs the whole suite.
const WHOLE_SUITE_PREFIXES = Object.freeze(['packages/web/runtime/reviewed-inputs/']);
// The suite contract inventories every test file in the repository (discovery,
// runner lists, conditional skips), so a change to any test file selects it.
export const SUITE_CONTRACT = 'scripts/test-suite-contract.test.mjs';

const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const DECLARATION = /\.d\.[cm]?ts$/;
const isCode = file => CODE.test(file) && !DECLARATION.test(file);
// A file name as a source writes it: a whole run of name characters holding a
// dot (`release.yml`, `.gitignore`, `.oxlintrc.json`).
const DOTTED_NAME = /(?<![A-Za-z0-9_@.+-])(?:\.[A-Za-z0-9_@+-]+(?:\.[A-Za-z0-9_@+-]+)*|[A-Za-z0-9_@+-]+(?:\.[A-Za-z0-9_@+-]+)+)/g;
// A quoted relative or workspace path: every import specifier and module URL
// that can reach a repository file is one.
const QUOTED_PATH = /(['"`])((?:\.{1,2}\/|@(?:devryan|openchamber)\/)[^'"`\n]*)\1/g;
const NAME_CHARACTER = /[A-Za-z0-9_@.+-]/;
/** True when `source` holds `name` as a whole name, not inside a longer one. */
function names(source, name) {
  for (let index = source.indexOf(name); index !== -1; index = source.indexOf(name, index + 1)) {
    if (!NAME_CHARACTER.test(source[index - 1] ?? ' ') && !NAME_CHARACTER.test(source[index + name.length] ?? ' ')) return true;
  }
  return false;
}
// Vendored code (installed or reviewed packages) never loads repository files:
// it is a leaf, and its names are not read.
const isVendored = file => file.includes('node_modules/') || WHOLE_SUITE_PREFIXES.some(prefix => file.startsWith(prefix));

function repositoryFiles(root) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(Boolean);
}

function resolveImport(root, packages, importer, raw) {
  const specifier = raw.split('?')[0];
  let target = null;
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    target = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
    if (target.startsWith('../')) return null;
  } else if (/^@(?:devryan|openchamber)\//.test(specifier)) {
    target = resolveSpecifier({ root, packages, importer, specifier })?.target ?? null;
  }
  if (!target) return null; // builtin or third-party package: a leaf
  const resolved = resolveFile(root, target);
  if (resolved !== target || isFile(root, resolved)) return resolved;
  // TypeScript sources import their siblings by the emitted extension.
  const typed = target.replace(/\.([cm]?)js$/, '.$1ts');
  return typed !== target && isFile(root, typed) ? typed : target;
}

/**
 * Whether a source's file names count as edges. Shipped package code runs
 * without the repository around it and without its tests: it loads files only
 * through import specifiers and module URLs, which are quoted relative or
 * workspace paths. Tests, test fixtures, package-local tooling
 * (packages/<name>/scripts/) and everything outside packages/ may name any file.
 */
function namesFiles(file) {
  const owner = /^packages\/[^/]+\//.exec(file)?.[0];
  return !owner || isTestImporter(file) || file.startsWith(`${owner}scripts/`);
}

function isFile(root, file) {
  const absolute = path.join(root, file);
  return existsSync(absolute) && statSync(absolute).isFile();
}

/**
 * The scripts-suite graph from every test file through imports and names:
 * `importers` maps a file to the files reaching it directly, `sources` holds
 * every source whose names can reach any file, `universe` the files names
 * resolve to.
 */
export function buildScriptTestGraph({ root = repositoryRoot, tests = discoverScriptTestFiles(root), files = repositoryFiles(root),
  readSource = file => readFileSync(path.join(root, file), 'utf8') } = {}) {
  const packages = loadPackages(root);
  const byBasename = new Map();
  for (const file of files) {
    if (file.includes('node_modules/')) continue;
    const name = path.posix.basename(file);
    if (!byBasename.has(name)) byBasename.set(name, []);
    byBasename.get(name).push(file);
  }
  const undotted = [...byBasename.keys()].filter(name => !name.includes('.'));
  const importers = new Map(); // file -> files that import or name it
  const sources = new Map();
  const resolutions = new Map();
  const addEdge = (from, to) => {
    if (from === to) return;
    if (!importers.has(to)) importers.set(to, new Set());
    importers.get(to).add(from);
  };
  const visited = new Set(tests);
  const queue = [...tests];
  while (queue.length > 0) {
    const file = queue.pop();
    if (!isCode(file) || isVendored(file)) continue;
    let source;
    try { source = readSource(file); } catch { continue; } // deleted: nothing it reaches
    const reached = new Set();
    const directory = path.posix.dirname(file);
    const resolve = specifier => {
      // Relative resolution depends only on the importer's directory.
      const key = specifier.startsWith('.') ? `${directory}\0${specifier}` : specifier;
      if (!resolutions.has(key)) resolutions.set(key, resolveImport(root, packages, file, specifier));
      const target = resolutions.get(key);
      if (target) reached.add(target);
    };
    // Every quoted relative or workspace path: a superset of the import
    // specifiers and module URLs (workers, assets) that reach repository files.
    for (const match of source.matchAll(QUOTED_PATH)) if (!match[2].includes('${')) resolve(match[2]);
    if (namesFiles(file)) {
      importSpecifiers(source).forEach(resolve);
      sources.set(file, source);
      const named = [...(source.match(DOTTED_NAME) ?? []), ...undotted.filter(name => names(source, name))];
      for (const name of named) for (const target of byBasename.get(name) ?? []) reached.add(target);
    }
    for (const target of reached) {
      addEdge(file, target);
      if (!visited.has(target)) { visited.add(target); queue.push(target); }
    }
  }
  return { tests: new Set(tests), importers, sources, files: visited, universe: new Set(files) };
}

/** Tests whose closure holds any of `targets`. */
function testsReaching(graph, targets) {
  const selected = new Set();
  const seen = new Set(targets);
  const queue = [...targets];
  while (queue.length > 0) {
    const file = queue.pop();
    if (graph.tests.has(file)) selected.add(file);
    for (const importer of graph.importers.get(file) ?? []) {
      if (!seen.has(importer)) { seen.add(importer); queue.push(importer); }
    }
  }
  return selected;
}

// An unresolved import keeps its written path, which may omit the extension or
// the index file: a deleted `x.mjs` is still the target of `import './x'`.
function graphKeys(file) {
  const keys = [file];
  const stem = file.replace(/\.[^./]+$/, '');
  if (stem !== file) keys.push(stem);
  const directory = /^(.*)\/index\.[^./]+$/.exec(file)?.[1];
  if (directory) keys.push(directory);
  return keys;
}

// The outermost directory a source must spell to reach a file by a path it
// builds: a top-level dot directory itself (.github, .opencode), else the first
// directory below the top level. A source that spells only a deeper directory
// takes the rest of the path from a source it imports or is handed by, which
// spells it and is reached by the same tests. A file directly under scripts/
// has none: nearly every source names `scripts`, so such a file relies on its
// own name.
function directoryNames(file) {
  const segments = file.split('/').slice(0, -1);
  return file.startsWith('.') ? segments.slice(0, 1) : segments.slice(1, 2);
}

/** Sources whose names count (see namesFiles) that name any of `wanted`. */
function filesNaming(graph, wanted) {
  graph.naming ??= new Map(); // name -> sources naming it, memoized per graph
  const result = new Set();
  for (const name of wanted) {
    if (!graph.naming.has(name)) graph.naming.set(name, [...graph.sources].filter(([, source]) => names(source, name)).map(([file]) => file));
    for (const file of graph.naming.get(name)) result.add(file);
  }
  return [...result];
}

/**
 * Script tests that read the contents of every tracked Markdown file (the
 * release-docs rule: no doc instructs deleting, editing or re-uploading a
 * published release). Markdown is docs-only to the plan, so it never enters
 * the graph: any `.md`/`.mdx` change runs these. test-select.test.mjs checks
 * that every script-suite source listing repository Markdown is one of these
 * or reviewed as not reading their contents.
 */
export const MARKDOWN_READERS = Object.freeze(['scripts/release-docs.test.mjs', 'scripts/toolchain-pins.test.mjs']);
// The Markdown they read: every tracked file but the changelog (history),
// dependencies and reviewed inputs (scripts/release-docs.test.mjs `docs`).
const isReadMarkdown = file => /\.mdx?$/.test(file) && file !== 'CHANGELOG.md' && !file.includes('node_modules/') && !WHOLE_SUITE_PREFIXES.some(prefix => file.startsWith(prefix));

/** `selection` (null when the scripts suite is not in the plan) with the Markdown readers when `files` holds Markdown they read. */
function addMarkdownReaders(selection, files) {
  const markdown = files.filter(isReadMarkdown);
  if (markdown.length === 0 || selection?.all) return selection;
  const reasons = new Map(selection?.reasons ?? []);
  for (const file of markdown) reasons.set(file, `${MARKDOWN_READERS.length} reading every tracked Markdown file`);
  return { all: false, tests: [...new Set([...(selection?.tests ?? []), ...MARKDOWN_READERS])].sort(), reasons, total: selection?.total };
}

/**
 * `selection` (null when the scripts suite is not in the plan) with the Markdown
 * readers when `files` holds Markdown they read, and the suite contract when it
 * holds a test file of any package.
 */
export function withMarkdownReaders(selection, files) {
  return withSuiteContract(addMarkdownReaders(selection, files), files);
}

const isRepositoryTestPath = file => testFilePattern.test(file) && !isVendored(file);
function withSuiteContract(selection, files) {
  const changed = files.filter(isRepositoryTestPath);
  if (changed.length === 0 || selection?.all || selection?.tests.includes(SUITE_CONTRACT)) return selection;
  const reasons = new Map(selection?.reasons ?? []);
  for (const file of changed) if (!reasons.has(file)) reasons.set(file, 'a test file: the suite contract inventories it');
  return { all: false, tests: [...new Set([...(selection?.tests ?? []), SUITE_CONTRACT])].sort(), reasons, total: selection?.total };
}

// The suite inventory (discovery, and the Node/Bun and native-graph split) and
// where it discovers test files.
const INVENTORY = 'scripts/test-scripts.mjs';
const isSuiteTestPath = file => testFilePattern.test(file)
  && ['scripts/', '.opencode/plugins/', '.opencode/agents/', ...WHOLE_SUITE_PREFIXES].some(prefix => file.startsWith(prefix));

const graphs = new Map();
/** The graph of this checkout, built once per process. */
export function scriptTestGraph(root = repositoryRoot) {
  if (!graphs.has(root)) graphs.set(root, buildScriptTestGraph({ root }));
  return graphs.get(root);
}

/**
 * The script tests to run for `files`, every changed file of the plan. Only
 * `triggers`, the files that put the scripts suite in the plan, can widen the
 * run to the whole suite; other changed files only add the tests reaching them.
 *
 * Returns `{ all: true, reason }` for the whole suite, else
 * `{ all: false, tests, reasons, total }`: `reasons` maps each trigger to what
 * it selected, `total` counts the suite's test files.
 *
 * A trigger selects:
 * - the whole suite when it is a WHOLE_SUITE_INPUTS file or a reviewed input;
 * - for a suite test file, added, changed or deleted: also the inventory's tests;
 * - for a code file, present or deleted: the tests whose closure holds it, and
 *   under a top-level dot directory also those naming one of its directories;
 * - for a declaration file (erased at run time): the tests naming it and those
 *   reaching its implementation;
 * - for any other file (workflow, JSON, shell, fixture, Markdown): the tests
 *   naming it or one of its directories, and the whole suite when none does.
 * A file absent from the graph (deleted) is reached by the sources naming it.
 */
export function selectScriptTests({ files, triggers = files, root = repositoryRoot, graph }) {
  for (const file of triggers) {
    if (WHOLE_SUITE_INPUTS.includes(file)) return { all: true, reason: `${file} drives test selection or the suite` };
    const prefix = WHOLE_SUITE_PREFIXES.find(entry => file.startsWith(entry));
    if (prefix) return { all: true, reason: `${file}: tests read ${prefix} as a whole` };
  }
  graph ??= scriptTestGraph(root);
  const total = graph.tests.size;
  const selected = new Set();
  const reasons = new Map();
  const triggerSet = new Set(triggers);
  for (const file of files) {
    const targets = graphKeys(file);
    if (!graph.universe.has(file)) targets.push(...filesNaming(graph, [path.posix.basename(file)]));
    const reached = testsReaching(graph, targets);
    if (triggerSet.has(file)) {
      // Adding, removing or retyping a suite file changes the inventory.
      if (isSuiteTestPath(file)) for (const test of testsReaching(graph, [INVENTORY])) reached.add(test);
      if (isCode(file)) {
        if (file.startsWith('.')) for (const test of testsReaching(graph, filesNaming(graph, directoryNames(file)))) reached.add(test);
        reasons.set(file, reached.size ? `${reached.size} reaching it` : 'no script test imports or names it');
      } else if (DECLARATION.test(file)) {
        const implementation = file.replace(/\.d\.([cm]?)ts$/, '.$1js');
        for (const test of testsReaching(graph, graphKeys(implementation).concat(implementation.replace(/js$/, 'ts')))) reached.add(test);
        reasons.set(file, reached.size ? `${reached.size} naming it or reaching its implementation` : 'no script test names it or its implementation');
      } else {
        for (const test of testsReaching(graph, filesNaming(graph, directoryNames(file)))) reached.add(test);
        if (reached.size === 0) return { all: true, reason: `${file}: no script test names it or its directory` };
        reasons.set(file, `${reached.size} naming it or its directory`);
      }
    }
    for (const test of reached) selected.add(test);
  }
  return withSuiteContract({ all: false, tests: [...selected].sort(), reasons, total }, files);
}

export function main(argv = process.argv.slice(2)) {
  const started = performance.now();
  const selection = selectScriptTests({ files: argv });
  const elapsed = `${Math.round(performance.now() - started)} ms`;
  if (selection.all) console.log(`All script tests: ${selection.reason} (${elapsed}).`);
  else {
    for (const [file, reason] of selection.reasons) console.log(`${file}: ${reason}`);
    for (const test of selection.tests) console.log(`  ${test}`);
    console.log(`${selection.tests.length} script tests selected (${elapsed}).`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
