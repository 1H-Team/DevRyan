#!/usr/bin/env node
// Declaration parity for hand-written declarations beside JavaScript: every value
// a first-party `x.d.ts` (`x.d.mts`, `x.d.cts`) exports must be exported by its
// twin `x.js` (`x.mjs`, `x.cjs`), and so must every value a package manifest's
// `exports` pairs with a JavaScript `default`/`import`/`require` target. Type-only
// exports (interfaces, type aliases, `export type`) need no implementation.
// Relative `export *` and `export { a } from` are followed on both sides.
// Exports the implementation has and the declaration omits are information only.
//
// scripts/declaration-parity.json holds two shrink-only lists, known `mismatches`
// and `unchecked` pairs (a CommonJS implementation, or one that re-exports a
// package, cannot be compared): an unlisted finding fails, and an entry that no
// longer matches fails until it is removed. Its `transformExports` are permanent:
// names a build transform adds to a copy of the implementation only. Each must
// still be a mismatch and still be exported in the named transform's source.
//
//   node scripts/check-declarations.mjs           check
//   node scripts/check-declarations.mjs --prune   also remove stale entries (never adds any)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE = 'scripts/declaration-parity.json';
// Third-party code vendored into the repository, and the frozen legacy Tauri package.
const IGNORED = [/\/node_modules\//, /^packages\/web\/runtime\/reviewed-inputs\//, /^packages\/desktop\//];
const DECLARATION = /\.d\.([cm]?)ts$/;
const IMPLEMENTATION = /\.[cm]?js$/;

let typescript;
function ts() {
  typescript ??= createRequire(path.join(repositoryRoot, 'package.json'))('@typescript/typescript6');
  return typescript;
}

const isFile = absolute => existsSync(absolute) && statSync(absolute).isFile();
const twinOf = declaration => declaration.replace(DECLARATION, (_, kind) => `.${kind}js`);

/** The declaration file a relative specifier in a declaration names. */
function resolveDeclaration(root, importer, specifier) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  const stem = base.replace(/\.[cm]?[jt]sx?$/, '');
  const kind = /\.([cm])[jt]s$/.exec(base)?.[1] ?? '';
  for (const candidate of [`${stem}.d.${kind}ts`, `${stem}.d.ts`, `${stem}.${kind}ts`, `${stem}.ts`, `${base}/index.d.ts`]) {
    if (isFile(path.join(root, candidate))) return candidate;
  }
  return null;
}

/** The implementation file a relative specifier in an implementation names. */
function resolveImplementation(root, importer, specifier) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, `${base}/index.js`]) if (isFile(path.join(root, candidate))) return candidate;
  return null;
}

function parse(root, file) {
  const t = ts();
  return t.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'), t.ScriptTarget.Latest, true);
}

function bindingNames(name, out = []) {
  const t = ts();
  if (t.isIdentifier(name)) out.push(name.text);
  else for (const element of name.elements) if (!t.isOmittedExpression(element)) bindingNames(element.name, out);
  return out;
}

const hasModifier = (node, kind) => (ts().canHaveModifiers(node) ? ts().getModifiers(node) ?? [] : []).some(modifier => modifier.kind === kind);
const moduleName = node => node.moduleSpecifier && ts().isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null;

/**
 * Names a declaration file exports, each 'value' or 'type'. `opaque` lists the
 * non-relative `export *` targets whose names cannot be read.
 */
export function declaredExports(root, file, seen = new Set()) {
  const t = ts();
  const names = new Map(), opaque = [];
  if (seen.has(file)) return { names, opaque };
  seen.add(file);
  const source = parse(root, file);
  // Local declarations and imports, for `export { a }` without a module.
  const locals = new Map();
  const imports = new Map();
  const declare = (name, kind) => { if (locals.get(name) !== 'value') locals.set(name, kind); };
  for (const statement of source.statements) {
    if (t.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) for (const name of bindingNames(declaration.name)) declare(name, 'value');
    else if (t.isFunctionDeclaration(statement) || t.isClassDeclaration(statement) || t.isEnumDeclaration(statement)) { if (statement.name) declare(statement.name.text, 'value'); }
    else if (t.isInterfaceDeclaration(statement) || t.isTypeAliasDeclaration(statement)) declare(statement.name.text, 'type');
    else if (t.isModuleDeclaration(statement) && t.isIdentifier(statement.name)) declare(statement.name.text, t.getModuleInstanceState?.(statement) === 0 ? 'type' : 'value');
    else if (t.isImportDeclaration(statement) && statement.importClause) {
      const clause = statement.importClause, from = moduleName(statement);
      if (clause.name) imports.set(clause.name.text, { from, name: 'default', type: clause.isTypeOnly });
      const bindings = clause.namedBindings;
      if (bindings && t.isNamespaceImport(bindings)) imports.set(bindings.name.text, { from, name: '*', type: clause.isTypeOnly });
      else if (bindings) for (const element of bindings.elements) imports.set(element.name.text, { from, name: (element.propertyName ?? element.name).text, type: clause.isTypeOnly || element.isTypeOnly });
    }
  }
  const kindFrom = (from, name) => {
    if (name === '*') return 'value';
    const target = from ? resolveDeclaration(root, file, from) : null;
    return target ? declaredExports(root, target, seen).names.get(name) ?? 'value' : 'value';
  };
  const localKind = name => {
    if (locals.has(name)) return locals.get(name);
    const imported = imports.get(name);
    if (imported) return imported.type ? 'type' : kindFrom(imported.from, imported.name);
    return 'value';
  };
  for (const statement of source.statements) {
    if (hasModifier(statement, t.SyntaxKind.ExportKeyword)) {
      const isDefault = hasModifier(statement, t.SyntaxKind.DefaultKeyword);
      if (t.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) for (const name of bindingNames(declaration.name)) names.set(name, 'value');
      else if (isDefault) names.set('default', t.isInterfaceDeclaration(statement) || t.isTypeAliasDeclaration(statement) ? 'type' : 'value');
      else if (statement.name && t.isIdentifier(statement.name)) names.set(statement.name.text, locals.get(statement.name.text) ?? 'value');
    } else if (t.isExportAssignment(statement)) {
      names.set('default', t.isIdentifier(statement.expression) ? localKind(statement.expression.text) : 'value');
    } else if (t.isExportDeclaration(statement)) {
      const from = moduleName(statement);
      const clause = statement.exportClause;
      if (!clause) {
        const target = from ? resolveDeclaration(root, file, from) : null;
        if (!target) { opaque.push(from); continue; }
        const nested = declaredExports(root, target, seen);
        for (const [name, kind] of nested.names) if (name !== 'default') names.set(name, statement.isTypeOnly ? 'type' : kind);
        opaque.push(...nested.opaque);
      } else if (t.isNamespaceExport(clause)) names.set(clause.name.text, statement.isTypeOnly ? 'type' : 'value');
      else for (const element of clause.elements) {
        const local = (element.propertyName ?? element.name).text;
        const kind = statement.isTypeOnly || element.isTypeOnly ? 'type' : from ? kindFrom(from, local) : localKind(local);
        names.set(element.name.text, kind);
      }
    }
  }
  seen.delete(file);
  return { names, opaque };
}

/** Names an ES module implementation exports, following relative `export *`. */
export function implementedExports(root, file, seen = new Set()) {
  const t = ts();
  const names = new Set(), opaque = [];
  if (seen.has(file)) return { names, opaque, commonjs: false };
  seen.add(file);
  const source = parse(root, file);
  let esm = false;
  for (const statement of source.statements) {
    if (hasModifier(statement, t.SyntaxKind.ExportKeyword)) {
      esm = true;
      if (hasModifier(statement, t.SyntaxKind.DefaultKeyword)) names.add('default');
      else if (t.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) for (const name of bindingNames(declaration.name)) names.add(name);
      else if (statement.name && t.isIdentifier(statement.name)) names.add(statement.name.text);
    } else if (t.isExportAssignment(statement)) { esm = true; names.add('default'); }
    else if (t.isExportDeclaration(statement)) {
      esm = true;
      const clause = statement.exportClause, from = moduleName(statement);
      if (!clause) {
        const target = from ? resolveImplementation(root, file, from) : null;
        if (!target) { opaque.push(from); continue; }
        const nested = implementedExports(root, target, seen);
        for (const name of nested.names) if (name !== 'default') names.add(name);
        opaque.push(...nested.opaque);
      } else if (t.isNamespaceExport(clause)) names.add(clause.name.text);
      else for (const element of clause.elements) names.add(element.name.text);
    }
  }
  seen.delete(file);
  const commonjs = !esm && /\bmodule\.exports\b|\bexports\.[A-Za-z_$]/.test(source.text);
  return { names, opaque, commonjs };
}

const isIgnored = file => IGNORED.some(pattern => pattern.test(file));

/** First-party declaration/implementation pairs: twins, and manifest `exports` conditions. */
export function declarationPairs(root, files) {
  const pairs = new Map();
  const tracked = new Set(files);
  for (const file of files) {
    if (!DECLARATION.test(file) || isIgnored(file)) continue;
    const twin = twinOf(file);
    if (tracked.has(twin) || isFile(path.join(root, twin))) pairs.set(`${file}\0${twin}`, { declaration: file, implementation: twin });
  }
  for (const manifestPath of files.filter(file => /^packages\/[^/]+\/package\.json$/.test(file))) {
    const base = path.posix.dirname(manifestPath);
    const manifest = JSON.parse(readFileSync(path.join(root, manifestPath), 'utf8'));
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      const implementation = [value.default, value.import, value.require].find(target => typeof target === 'string' && IMPLEMENTATION.test(target));
      if (typeof value.types === 'string' && implementation) {
        const declaration = path.posix.join(base, value.types), code = path.posix.join(base, implementation);
        if (!isIgnored(declaration)) pairs.set(`${declaration}\0${code}`, { declaration, implementation: code });
      }
      for (const nested of Object.values(value)) visit(nested);
    };
    visit(manifest.exports);
    if (typeof manifest.types === 'string' && typeof manifest.main === 'string' && IMPLEMENTATION.test(manifest.main)) {
      const declaration = path.posix.join(base, manifest.types), code = path.posix.join(base, manifest.main);
      pairs.set(`${declaration}\0${code}`, { declaration, implementation: code });
    }
  }
  return [...pairs.values()].filter(pair => isFile(path.join(root, pair.declaration)) && isFile(path.join(root, pair.implementation)))
    .sort((a, b) => a.declaration.localeCompare(b.declaration) || a.implementation.localeCompare(b.implementation));
}

/** Declared values the implementation lacks, undeclared implementation exports, and pairs that cannot be checked. */
export function findDeclarationMismatches({ root = repositoryRoot, files = trackedFiles(root) } = {}) {
  const mismatches = [], undeclared = [], unchecked = [];
  const pairs = declarationPairs(root, files);
  for (const { declaration, implementation } of pairs) {
    const declared = declaredExports(root, declaration);
    const implemented = implementedExports(root, implementation);
    if (implemented.commonjs) { unchecked.push({ declaration, implementation, reason: 'CommonJS implementation' }); continue; }
    if (implemented.opaque.length) { unchecked.push({ declaration, implementation, reason: `implementation re-exports ${implemented.opaque.join(', ')}` }); continue; }
    for (const [name, kind] of declared.names) if (kind === 'value' && !implemented.names.has(name)) mismatches.push({ declaration, implementation, name });
    if (declared.opaque.length === 0) for (const name of implemented.names) if (!declared.names.has(name)) undeclared.push({ declaration, implementation, name });
  }
  return { pairs: pairs.length, mismatches, undeclared, unchecked };
}

function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter(file => file && existsSync(path.join(root, file)));
}

function readJson(root, file) {
  try { return JSON.parse(readFileSync(path.join(root, file), 'utf8')); } catch (error) {
    throw new Error(`${file} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const exactKeys = (entry, keys) => Object.keys(entry ?? {}).sort().join(',') === keys;
const strings = values => values.every(value => typeof value === 'string' && value.length > 0);

/**
 * The baseline: shrink-only `mismatches` and `unchecked` pairs, and permanent
 * `transformExports` (names a build transform adds to a copy of the implementation).
 */
export function readBaseline(root = repositoryRoot) {
  const document = readJson(root, BASELINE);
  if (document?.schemaVersion !== 1 || typeof document.description !== 'string' || !Array.isArray(document.mismatches)
    || !Array.isArray(document.unchecked) || !Array.isArray(document.transformExports)) throw new Error(`${BASELINE} is invalid: it needs schemaVersion 1, description, mismatches, unchecked and transformExports`);
  const seen = new Set();
  const once = (key, label) => { if (seen.has(key)) throw new Error(`Duplicate entry in ${BASELINE}: ${label}`); seen.add(key); };
  for (const entry of document.mismatches) {
    if (!exactKeys(entry, 'declaration,name,reason') || !strings([entry.declaration, entry.name, entry.reason])) throw new Error(`Invalid entry in ${BASELINE}: ${JSON.stringify(entry)}`);
    once(`m\0${entry.declaration}\0${entry.name}`, `${entry.declaration} ${entry.name}`);
  }
  for (const entry of document.unchecked) {
    if (!exactKeys(entry, 'declaration,reason') || !strings([entry.declaration, entry.reason])) throw new Error(`Invalid unchecked entry in ${BASELINE}: ${JSON.stringify(entry)}`);
    once(`u\0${entry.declaration}`, `unchecked ${entry.declaration}`);
  }
  for (const entry of document.transformExports) {
    if (!exactKeys(entry, 'declaration,names,reason,transform') || !strings([entry.declaration, entry.transform, entry.reason])
      || !Array.isArray(entry.names) || entry.names.length === 0 || !strings(entry.names)) throw new Error(`Invalid transformExports entry in ${BASELINE}: ${JSON.stringify(entry)}`);
    for (const name of entry.names) {
      once(`m\0${entry.declaration}\0${name}`, `${entry.declaration} ${name}`);
    }
  }
  return document;
}

/** Mismatches the baseline omits, and baseline entries that no longer match a mismatch. */
export function compareBaseline(mismatches, listed) {
  const key = entry => `${entry.declaration}\0${entry.name}`;
  const found = new Set(mismatches.map(key)), allowed = new Set(listed.map(key));
  return { unlisted: mismatches.filter(entry => !allowed.has(key(entry))), stale: listed.filter(entry => !found.has(key(entry))) };
}

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** True when `source` exports `name`: `export const|let|function|class name` or `export { ..., name, ... }`. */
export function transformExportsName(source, name) {
  const word = escapeRegExp(name);
  return new RegExp(`export\\s+(?:const|let|var|function|class)\\s+${word}\\b|export\\s*\\{[^}]*(?<![\\w$])${word}(?![\\w$])[^}]*\\}`).test(source);
}

/**
 * Problems with the permanent transform exemptions: a missing transform, a name
 * the transform no longer exports, or a name that is no longer a mismatch.
 */
export function checkTransformExports(root, exemptions, mismatches) {
  const problems = [];
  const found = new Set(mismatches.map(entry => `${entry.declaration}\0${entry.name}`));
  for (const entry of exemptions) {
    const transform = path.join(root, entry.transform);
    const source = isFile(transform) ? readFileSync(transform, 'utf8') : null;
    if (source === null) { problems.push(`transform exemption: ${entry.transform}, named for ${entry.declaration}, does not exist`); continue; }
    for (const name of entry.names) {
      if (!transformExportsName(source, name)) problems.push(`transform exemption: ${entry.transform} no longer exports ${name}, so ${entry.declaration} declares it for nothing; fix the declaration or the exemption in ${BASELINE}`);
      else if (!found.has(`${entry.declaration}\0${name}`)) problems.push(`transform exemption: ${entry.declaration} ${name} is no longer a mismatch (the implementation exports it, or the declaration dropped it); remove the name from ${BASELINE}`);
    }
  }
  return problems;
}

/** `files` overrides the tracked-file list (tests). */
export function main(argv = process.argv.slice(2), { root = repositoryRoot, files, verbose = argv.includes('--verbose') } = {}) {
  const flags = argv.filter(arg => arg !== '--verbose');
  const prune = flags[0] === '--prune';
  if (flags.length > (prune ? 1 : 0)) throw new Error('Usage: node scripts/check-declarations.mjs [--prune] [--verbose]');
  const started = performance.now();
  const document = readBaseline(root);
  const { pairs, mismatches, undeclared, unchecked } = findDeclarationMismatches({ root, ...(files ? { files } : {}) });
  const exempted = new Set(document.transformExports.flatMap(entry => entry.names.map(name => `${entry.declaration}\0${name}`)));
  const debt = mismatches.filter(entry => !exempted.has(`${entry.declaration}\0${entry.name}`));
  const { unlisted, stale } = compareBaseline(debt, document.mismatches);
  const uncheckedFound = new Set(unchecked.map(entry => entry.declaration)), uncheckedListed = new Set(document.unchecked.map(entry => entry.declaration));
  const uncheckedUnlisted = unchecked.filter(entry => !uncheckedListed.has(entry.declaration));
  const uncheckedStale = document.unchecked.filter(entry => !uncheckedFound.has(entry.declaration));
  const transformProblems = checkTransformExports(root, document.transformExports, mismatches);
  if (prune && (stale.length || uncheckedStale.length)) {
    const next = { ...document, mismatches: document.mismatches.filter(entry => !stale.includes(entry)), unchecked: document.unchecked.filter(entry => !uncheckedStale.includes(entry)) };
    writeFileSync(path.join(root, BASELINE), `${JSON.stringify(next, null, 2)}\n`);
    const removed = [...stale.map(entry => `${entry.declaration} ${entry.name}`), ...uncheckedStale.map(entry => `unchecked ${entry.declaration}`)];
    console.log(`Pruned ${removed.length} stale entr${removed.length === 1 ? 'y' : 'ies'} from ${BASELINE}: ${removed.join(', ')}`);
  }
  const remainingStale = prune ? [] : [...stale.map(entry => `${entry.declaration} ${entry.name} no longer mismatches`), ...uncheckedStale.map(entry => `unchecked ${entry.declaration} is checked now (or gone)`)];
  if (verbose) for (const entry of undeclared) console.log(`undeclared: ${entry.implementation} exports ${entry.name}; ${entry.declaration} omits it`);
  for (const entry of uncheckedUnlisted) console.error(`unchecked: ${entry.declaration} cannot be compared with ${entry.implementation} (${entry.reason}); make the implementation an ES module with relative re-exports, or list the declaration under "unchecked" in ${BASELINE} with a reason`);
  for (const entry of unlisted) console.error(`declared but not implemented: ${entry.declaration} exports ${entry.name}, which ${entry.implementation} does not export; implement it or remove the declaration (the list in ${BASELINE} only shrinks)`);
  for (const line of remainingStale) console.error(`stale entry: ${line}; remove it from ${BASELINE} (node scripts/check-declarations.mjs --prune)`);
  for (const line of transformProblems) console.error(line);
  const elapsed = `${Math.round(performance.now() - started)} ms`;
  const counts = `${pairs} declaration pairs, ${debt.length} mismatches (${document.mismatches.length - (prune ? stale.length : 0)} baselined), ${exempted.size} transform exports, ${unchecked.length} unchecked pairs, ${undeclared.length} undeclared exports (information${verbose ? '' : '; --verbose lists them'})`;
  const failures = unlisted.length + uncheckedUnlisted.length + remainingStale.length + transformProblems.length;
  if (failures) {
    console.error(`Declaration parity failed: ${unlisted.length + uncheckedUnlisted.length} unlisted, ${remainingStale.length} stale, ${transformProblems.length} transform exemption problems (${counts}; ${elapsed}).`);
    return 1;
  }
  console.log(`Declaration parity passed (${counts}; ${elapsed}).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
