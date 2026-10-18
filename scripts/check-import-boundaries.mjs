#!/usr/bin/env node
// Cross-package import boundaries for packages/*. Reads static imports, re-exports,
// require() and literal dynamic import() through TypeScript's pre-processor, and
// resolves relative and @openchamber/* specifiers to repository files.
//
// Rules, for an importer and a target in different packages:
// - private-application-import: an application package (web, electron, the Bot
//   services) exposes only its package entry points (main, exports).
// - unexported-subpath: a package that declares `exports` exposes only those
//   targets, whether reached by package name or by relative path.
// Each temporary exception in scripts/import-boundaries.json is one exact
// importer/target pair with the plan stage that removes it. An exception that no
// longer matches an import fails the check, so the list only shrinks. No
// exception covers a package-name import of a subpath the target's `exports`
// omits: Node refuses that import at runtime (ERR_PACKAGE_PATH_NOT_EXPORTED).
//
//   node scripts/check-import-boundaries.mjs            all tracked packages
//   node scripts/check-import-boundaries.mjs --files a b only these importers
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APPLICATION_PACKAGES = Object.freeze(['web', 'electron', 'desktop', 'bot-supervisor', 'bot-engine-proxy', 'bot-egress', 'bot-computer', 'bot-indexer']);
// Frozen legacy Tauri: kept only for released-install compatibility, never edited.
const IGNORED_IMPORTERS = ['packages/desktop/'];
export const STAGES = Object.freeze(['A', 'B', 'C', 'D', '4a', '4b', '4c', '4d', '5', 'unscheduled']);
const CODE_FILE = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/;
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.mjs'];

const toPosix = value => value.split(path.sep).join('/');
const packageOf = file => /^packages\/([^/]+)\//.exec(file)?.[1] ?? null;

export function loadPackages(root = repositoryRoot) {
  const packages = new Map();
  for (const directory of readdirSync(path.join(root, 'packages'))) {
    const manifestPath = path.join(root, 'packages', directory, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const base = `packages/${directory}`;
    const normalize = target => toPosix(path.posix.join(base, target));
    const exportTargets = new Map();
    const collect = (key, value) => {
      if (typeof value === 'string') exportTargets.set(key, [...(exportTargets.get(key) ?? []), normalize(value)]);
      else if (value && typeof value === 'object') for (const nested of Object.values(value)) collect(key, nested);
    };
    if (manifest.exports && typeof manifest.exports === 'object' && Object.keys(manifest.exports).every(key => key.startsWith('.'))) {
      for (const [key, value] of Object.entries(manifest.exports)) collect(key, value);
    } else if (manifest.exports !== undefined) collect('.', manifest.exports);
    const entries = new Set([...exportTargets.values()].flat());
    for (const field of ['main', 'types']) if (typeof manifest[field] === 'string') entries.add(normalize(manifest[field]));
    packages.set(directory, { name: manifest.name, directory, base, hasExports: manifest.exports !== undefined, exportTargets, entries });
  }
  return packages;
}

function resolveFile(root, repositoryPath) {
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = repositoryPath + suffix;
    const absolute = path.join(root, candidate);
    if (existsSync(absolute) && statSync(absolute).isFile()) return candidate;
  }
  return repositoryPath;
}

/** The repository file an import specifier reaches, or null when it leaves packages/. */
export function resolveSpecifier({ root = repositoryRoot, packages, importer, specifier }) {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const target = toPosix(path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier)));
    return target.startsWith('packages/') ? { target: resolveFile(root, target), via: 'relative' } : null;
  }
  const match = /^(@openchamber\/[^/]+)(\/.+)?$/.exec(specifier);
  if (!match) return null;
  const entry = [...packages.values()].find(candidate => candidate.name === match[1]);
  if (!entry) return null;
  const subpath = match[2] ? `.${match[2]}` : '.';
  if (entry.hasExports) {
    const targets = entry.exportTargets.get(subpath);
    return { target: targets ? targets.find(target => !target.endsWith('.d.ts')) ?? targets[0] : `${entry.base}/${subpath.slice(2)}`, via: 'package', exported: Boolean(targets) };
  }
  if (subpath === '.') return { target: [...entry.entries][0] ?? entry.base, via: 'package' };
  return { target: resolveFile(root, `${entry.base}/${subpath.slice(2)}`), via: 'package' };
}

let typescript;
function importSpecifiers(source) {
  typescript ??= createRequire(path.join(repositoryRoot, 'package.json'))('typescript');
  return typescript.preProcessFile(source, true, true).importedFiles.map(entry => entry.fileName);
}

/** Every boundary violation among `files`, before exceptions are applied. */
export function findViolations({ root = repositoryRoot, files, packages = loadPackages(root), readSource = file => readFileSync(path.join(root, file), 'utf8') }) {
  const violations = [];
  for (const importer of files) {
    const from = packageOf(importer);
    if (!from || !CODE_FILE.test(importer) || IGNORED_IMPORTERS.some(prefix => importer.startsWith(prefix))) continue;
    for (const specifier of importSpecifiers(readSource(importer))) {
      const resolved = resolveSpecifier({ root, packages, importer, specifier });
      if (!resolved) continue;
      const to = packageOf(resolved.target);
      if (!to || to === from) continue;
      const target = packages.get(to);
      if (!target) continue;
      const exported = target.entries.has(resolved.target) || resolved.exported === true;
      // Node enforces a declared `exports` on package-name imports at runtime.
      const runtimeRefused = target.hasExports && resolved.via === 'package' && !exported;
      if (APPLICATION_PACKAGES.includes(to) && !exported) violations.push({ importer, target: resolved.target, specifier, rule: 'private-application-import', runtimeRefused });
      else if (target.hasExports && !exported) violations.push({ importer, target: resolved.target, specifier, rule: 'unexported-subpath', runtimeRefused });
    }
  }
  return violations;
}

export function readExceptions(root = repositoryRoot) {
  const document = JSON.parse(readFileSync(path.join(root, 'scripts/import-boundaries.json'), 'utf8'));
  if (document?.schemaVersion !== 1 || typeof document.description !== 'string' || !Array.isArray(document.exceptions)) throw new Error('import-boundaries.json is invalid');
  const seen = new Set();
  for (const exception of document.exceptions) {
    const keys = Object.keys(exception ?? {}).sort().join(',');
    if (keys !== 'importer,stage,target' || !STAGES.includes(exception.stage)) throw new Error(`Invalid import-boundary exception: ${JSON.stringify(exception)}`);
    const key = `${exception.importer}\0${exception.target}`;
    if (seen.has(key)) throw new Error(`Duplicate import-boundary exception: ${exception.importer} -> ${exception.target}`);
    seen.add(key);
  }
  return document.exceptions;
}

/**
 * Violations not covered by an exception, and unused exceptions. A full run judges
 * every exception; a changed-file run only those of the requested importers,
 * including importers that were deleted.
 */
export function applyExceptions(violations, exceptions, requestedFiles = null) {
  const used = new Set();
  const unexpected = violations.filter(violation => {
    if (violation.runtimeRefused) return true;
    const exception = exceptions.find(entry => entry.importer === violation.importer && entry.target === violation.target);
    if (exception) used.add(exception);
    return !exception;
  });
  const requested = requestedFiles ? new Set(requestedFiles) : null;
  const stale = exceptions.filter(entry => !used.has(entry) && (!requested || requested.has(entry.importer)));
  return { unexpected, stale };
}

function trackedPackageFiles(root) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'packages'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter(file => file && !file.includes('/node_modules/') && existsSync(path.join(root, file)));
}

export function checkImportBoundaries({ root = repositoryRoot, files } = {}) {
  const checked = (files ?? trackedPackageFiles(root)).filter(file => file.startsWith('packages/') && existsSync(path.join(root, file)));
  const violations = findViolations({ root, files: checked });
  return { checked: checked.length, ...applyExceptions(violations, readExceptions(root), files ?? null) };
}

export function main(argv = process.argv.slice(2)) {
  let files;
  if (argv[0] === '--files') files = argv.slice(1);
  else if (argv.length > 0) throw new Error('Usage: node scripts/check-import-boundaries.mjs [--files <path>...]');
  const { checked, unexpected, stale } = checkImportBoundaries({ files });
  for (const violation of unexpected) {
    const note = violation.runtimeRefused ? '; the package exports omit it, so Node refuses this import at runtime' : '';
    console.error(`${violation.rule}: ${violation.importer} -> ${violation.target} (${violation.specifier})${note}`);
  }
  for (const exception of stale) console.error(`stale exception: ${exception.importer} -> ${exception.target}; remove it from scripts/import-boundaries.json`);
  if (unexpected.length || stale.length) {
    console.error(`Import boundaries failed: ${unexpected.length} unlisted, ${stale.length} stale (${checked} files checked).`);
    return 1;
  }
  console.log(`Import boundaries passed (${checked} files checked).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
