#!/usr/bin/env node
// Browser bundle guard: walks the import graph the web Vite build bundles, from
// its real entry points (and the portable shared-runtime test fixtures UI tests
// load), with the same aliases, and fails when it reaches a Node builtin,
// adm-zip, or a privileged implementation (web server, Electron, Bot services,
// the Node-only shared-runtime archive module). Third-party packages are leaves.
import { builtinModules, createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPackages, resolveSpecifier } from './check-import-boundaries.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BROWSER_ENTRIES = Object.freeze([
  'packages/web/src/main.tsx',
  'packages/web/src/mini-chat-main.tsx',
  'packages/web/src/browser-main.tsx',
  'packages/shared-runtime/startup-diagnostics.js',
  'packages/shared-runtime/testing/assistant-image-fixtures.js',
  'packages/shared-runtime/testing/jsonc-config-fixtures.js',
]);
export const PRIVILEGED_PREFIXES = Object.freeze([
  'packages/web/server/', 'packages/web/bin/', 'packages/electron/', 'packages/desktop/',
  'packages/bot-supervisor/', 'packages/bot-engine-proxy/', 'packages/bot-egress/', 'packages/bot-computer/', 'packages/bot-indexer/',
  'packages/shared-runtime/lib/safe-archive.js',
]);
const FORBIDDEN_PACKAGES = new Set(['adm-zip']);
const BUILTINS = new Set(builtinModules.flatMap(name => [name, name.split('/')[0]]));
// The web Vite aliases (packages/web/vite.config.ts), most specific first.
const ALIASES = [['@openchamber/ui/', 'packages/ui/src/'], ['@web/', 'packages/web/src/'], ['@/', 'packages/ui/src/']];
const CODE = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/;
const SUFFIXES = ['', '.ts', '.tsx', '.js', '.mjs', '.jsx', '/index.ts', '/index.tsx', '/index.js'];
const WORKER_URL = /new\s+URL\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url\s*\)/g;

let typescript;
function specifiersOf(source) {
  typescript ??= createRequire(path.join(repositoryRoot, 'package.json'))('typescript');
  const specifiers = typescript.preProcessFile(source, true, true).importedFiles.map(entry => entry.fileName);
  for (const match of source.matchAll(WORKER_URL)) specifiers.push(match[2]);
  return specifiers;
}

function existing(root, candidate) {
  for (const suffix of SUFFIXES) if (existsSync(path.join(root, candidate + suffix)) && CODE.test(candidate + suffix)) return candidate + suffix;
  return null;
}

const bareName = specifier => specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];

export function walkBrowserGraph({ root = repositoryRoot, entries = BROWSER_ENTRIES } = {}) {
  const packages = loadPackages(root);
  const visited = new Set(), violations = [];
  const queue = entries.map(file => ({ file, from: null }));
  while (queue.length > 0) {
    const { file, from } = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    if (PRIVILEGED_PREFIXES.some(prefix => file.startsWith(prefix))) {
      violations.push({ importer: from, target: file, reason: 'privileged implementation' });
      continue;
    }
    for (const raw of specifiersOf(readFileSync(path.join(root, file), 'utf8'))) {
      const specifier = raw.split('?')[0];
      if (specifier.startsWith('node:') || BUILTINS.has(specifier) || BUILTINS.has(bareName(specifier)) && !specifier.startsWith('.')) {
        violations.push({ importer: file, target: raw, reason: 'Node builtin' });
        continue;
      }
      if (FORBIDDEN_PACKAGES.has(bareName(specifier))) {
        violations.push({ importer: file, target: raw, reason: 'Node-only package' });
        continue;
      }
      let candidate = null;
      const alias = ALIASES.find(([prefix]) => specifier.startsWith(prefix));
      if (specifier.startsWith('./') || specifier.startsWith('../')) candidate = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      else if (alias) candidate = alias[1] + specifier.slice(alias[0].length);
      else if (specifier.startsWith('@openchamber/')) candidate = resolveSpecifier({ root, packages, importer: file, specifier })?.target ?? null;
      if (!candidate) continue; // third-party package: a bundle leaf
      const target = existing(root, candidate);
      if (target) queue.push({ file: target, from: file });
      else if (PRIVILEGED_PREFIXES.some(prefix => candidate.startsWith(prefix))) violations.push({ importer: file, target: candidate, reason: 'privileged implementation' });
    }
  }
  return { files: visited.size, violations };
}

export function main() {
  const { files, violations } = walkBrowserGraph();
  for (const violation of violations) console.error(`${violation.reason}: ${violation.importer} -> ${violation.target}`);
  if (violations.length > 0) {
    console.error(`Browser graph failed: ${violations.length} non-portable import(s) across ${files} files.`);
    return 1;
  }
  console.log(`Browser graph passed (${files} files from ${BROWSER_ENTRIES.length} entries).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
