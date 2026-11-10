#!/usr/bin/env node
// Unreached browser source: every tracked code file under packages/ui/src and
// packages/web/src must be reached from a web build entry (BROWSER_ENTRIES and
// the service worker) or from a test, through the browser-graph resolver
// (scripts/check-browser-graph.mjs). Tests are every tracked test file in the
// repository; a test under a privileged prefix (a server test) contributes its
// own imports, and the walk stops at privileged files as the browser graph does.
//
// The files unreached today are listed in scripts/unreached-files.json, each with
// a kind and a reason: `awaiting-removal` (dead code a later phase deletes) or
// `hand-run` (a tool run by hand, kept on purpose). The list only shrinks: an
// unreached file it omits fails, and a listed file that is now reached or deleted
// fails until its entry is removed.
// Known limits: a file reached only through `import type` counts as reached, and
// helpers under a `test/` directory are treated as tests, so they are not checked.
// Server packages are out of scope: their string-built dynamic imports make a
// file-level check noisy.
//
//   node scripts/check-unreached-files.mjs           check
//   node scripts/check-unreached-files.mjs --prune   also remove stale entries (never adds any)
//   --verbose                                         also list the files only tests reach
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BROWSER_ENTRIES, walkBrowserGraph } from './check-browser-graph.mjs';
import { isTestImporter } from './check-import-boundaries.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ALLOWLIST = 'scripts/unreached-files.json';
// The Vite PWA plugin builds the service worker from its own entry (packages/web/vite.config.ts).
export const UNREACHED_ENTRIES = Object.freeze([...BROWSER_ENTRIES, 'packages/web/src/sw.ts']);
export const SCOPES = Object.freeze(['packages/ui/src/', 'packages/web/src/']);
const CODE = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/;
const DECLARATION = /\.d\.[cm]?ts$/;

function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter(file => file && !file.includes('/node_modules/') && existsSync(path.join(root, file)));
}

// Allowlist entry kinds: dead code a later phase removes, or a hand-run tool kept on purpose.
export const KINDS = Object.freeze(['awaiting-removal', 'hand-run']);

export function readAllowlist(root = repositoryRoot) {
  let document;
  try { document = JSON.parse(readFileSync(path.join(root, ALLOWLIST), 'utf8')); } catch (error) {
    throw new Error(`${ALLOWLIST} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (document?.schemaVersion !== 1 || typeof document.description !== 'string' || !Array.isArray(document.files)) throw new Error(`${ALLOWLIST} is invalid: it needs schemaVersion 1, description and files`);
  const seen = new Set();
  for (const entry of document.files) {
    if (Object.keys(entry ?? {}).sort().join(',') !== 'file,kind,reason' || typeof entry.file !== 'string' || !KINDS.includes(entry.kind)
      || typeof entry.reason !== 'string' || !entry.reason) throw new Error(`Invalid entry in ${ALLOWLIST} (needs file, kind ${KINDS.join('|')} and reason): ${JSON.stringify(entry)}`);
    if (seen.has(entry.file)) throw new Error(`Duplicate entry in ${ALLOWLIST}: ${entry.file}`);
    seen.add(entry.file);
  }
  return document;
}

/** Source files in scope, which of them no entry and no test reaches, and which only tests reach. */
export function findUnreachedFiles({ root = repositoryRoot, files = trackedFiles(root), entries = UNREACHED_ENTRIES } = {}) {
  const sources = files.filter(file => SCOPES.some(scope => file.startsWith(scope)) && CODE.test(file) && !DECLARATION.test(file) && !isTestImporter(file));
  const tests = files.filter(file => CODE.test(file) && !DECLARATION.test(file) && isTestImporter(file));
  const specifiers = new Map();
  const product = walkBrowserGraph({ root, entries: entries.filter(file => existsSync(path.join(root, file))), specifiers }).visited;
  const tested = walkBrowserGraph({ root, entries: tests, privilegedEntries: true, specifiers }).visited;
  return {
    sources: sources.length,
    unreached: sources.filter(file => !product.has(file) && !tested.has(file)).sort(),
    testOnly: sources.filter(file => !product.has(file) && tested.has(file)).sort(),
  };
}

/** Unreached files the allowlist omits, and listed entries whose file is reached or gone. */
export function compareAllowlist(unreached, listed) {
  const found = new Set(unreached), allowed = new Set(listed.map(entry => entry.file));
  return { unlisted: unreached.filter(file => !allowed.has(file)), stale: listed.filter(entry => !found.has(entry.file)) };
}

/** `files` overrides the tracked-file list (tests). */
export function main(argv = process.argv.slice(2), { root = repositoryRoot, files } = {}) {
  const verbose = argv.includes('--verbose');
  const flags = argv.filter(arg => arg !== '--verbose');
  const prune = flags[0] === '--prune';
  if (flags.length > (prune ? 1 : 0)) throw new Error('Usage: node scripts/check-unreached-files.mjs [--prune] [--verbose]');
  const started = performance.now();
  const document = readAllowlist(root);
  const { sources, unreached, testOnly } = findUnreachedFiles({ root, ...(files ? { files } : {}) });
  const { unlisted, stale } = compareAllowlist(unreached, document.files);
  if (prune && stale.length) {
    const kept = document.files.filter(entry => !stale.includes(entry));
    writeFileSync(path.join(root, ALLOWLIST), `${JSON.stringify({ ...document, files: kept }, null, 2)}\n`);
    console.log(`Pruned ${stale.length} stale entr${stale.length === 1 ? 'y' : 'ies'} from ${ALLOWLIST}: ${stale.map(entry => entry.file).join(', ')}`);
  }
  const remainingStale = prune ? [] : stale;
  if (verbose) for (const file of testOnly) console.log(`reached by tests only: ${file}`);
  for (const file of unlisted) console.error(`unreached: ${file} is reached by no web entry and no test; import it or delete it. Dead code is never listed in ${ALLOWLIST}; only a hand-run tool kept on purpose is, as kind "hand-run" with a reason`);
  for (const entry of remainingStale) {
    const state = existsSync(path.join(root, entry.file)) ? 'is now reached (or no longer a source file in scope)' : 'is deleted';
    console.error(`stale entry: ${entry.file} (${entry.kind}) ${state}; remove its entry from ${ALLOWLIST} (node scripts/check-unreached-files.mjs --prune)`);
  }
  const elapsed = `${Math.round(performance.now() - started)} ms`;
  const listed = document.files.filter(entry => !(prune && stale.includes(entry)));
  const kinds = KINDS.map(kind => `${listed.filter(entry => entry.kind === kind).length} ${kind}`).join(', ');
  const counts = `${sources} source files, ${unreached.length} unreached (${listed.length} allowlisted: ${kinds}), ${testOnly.length} reached by tests only${verbose ? '' : ' (--verbose lists them)'}`;
  if (unlisted.length || remainingStale.length) {
    console.error(`Unreached files failed: ${unlisted.length} unlisted, ${remainingStale.length} stale (${counts}; ${elapsed}).`);
    return 1;
  }
  console.log(`Unreached files passed (${counts}; ${elapsed}).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
