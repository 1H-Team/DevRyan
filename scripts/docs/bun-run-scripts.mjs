// Docs drift check `bun-run`: every `bun run <name>` in a document, prose or
// code block, must name a script of the manifest it runs against: the root
// package.json, or the package given by `--cwd <dir>` or `--filter <name|path>`.
// A `<name>` that is a file path (`bun run scripts/x.mjs`) must exist there.
// Placeholders (`<name>`, `${x}`, globs) are not commands and are skipped.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const VALUE_OPTIONS = new Set(['--cwd', '--filter', '-F', '--elide-lines', '--shell']);
const PLACEHOLDER = /[<>{}$*[\]]|\.\.\./;

/**
 * Parses the `bun run` invocations of a document into `{ command, name, cwd, filter }`,
 * `command` being the normalized invocation (`bun run --cwd packages/web test`).
 */
export function bunRunCommands(source) {
  const commands = [];
  for (const match of source.matchAll(/\bbun((?:[ \t]+-[^\s`'"]+(?:[ \t]+[^\s`'"-][^\s`'"]*)?)*)[ \t]+run\b((?:[ \t]+[^\s`|&;()]+)*)/g)) {
    const words = [...match[1].trim().split(/\s+/).filter(Boolean), ...match[2].trim().split(/\s+/).filter(Boolean)];
    let cwd = null, filter = null, name = null;
    const options = [];
    for (let i = 0; i < words.length; i++) {
      let word = words[i];
      if (word.startsWith('-')) {
        if (word === '--') break;
        const [flag, inline] = word.split('=', 2);
        let value = inline;
        if (value === undefined && VALUE_OPTIONS.has(flag)) value = words[++i];
        if (value !== undefined) value = value.replace(/^['"]|['"]$/g, '');
        if (flag === '--cwd') cwd = value ?? null;
        if (flag === '--filter' || flag === '-F') filter = value ?? null;
        options.push(value === undefined ? flag : `${flag} ${value}`);
        continue;
      }
      name = word.replace(/['"]/g, '').replace(/[.,:;!?]+$/, '');
      break;
    }
    if (!name || PLACEHOLDER.test(name) || [cwd, filter].some((value) => value && PLACEHOLDER.test(value) && value !== '*')) continue;
    commands.push({ command: ['bun run', ...options, name].join(' '), name, cwd, filter });
  }
  return commands;
}

function readManifest(dir) {
  try { return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; }
}

/** Root manifest plus each `packages/*` manifest, as `{ dir, name, scripts }`. */
export function workspaceManifests(root) {
  const manifests = [];
  const add = (relative) => {
    const manifest = readManifest(path.join(root, relative));
    if (manifest) manifests.push({ dir: relative, name: manifest.name ?? null, scripts: new Set(Object.keys(manifest.scripts ?? {})) });
  };
  add('.');
  const packages = path.join(root, 'packages');
  if (existsSync(packages)) {
    for (const entry of readdirSync(packages, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) add(`packages/${entry.name}`);
    }
  }
  return manifests;
}

function filterTargets(manifests, filter) {
  const packages = manifests.filter((manifest) => manifest.dir !== '.');
  if (filter === '*') return packages;
  const byPath = path.posix.normalize(filter.replace(/^\.\//, ''));
  return packages.filter((manifest) => manifest.name === filter || manifest.dir === byPath);
}

/** Violations `{ check: 'bun-run', doc, token }`, `token` being the normalized command. */
export function validateBunRunScripts(root, files, { manifests = workspaceManifests(root) } = {}) {
  const violations = [];
  for (const doc of files) {
    const source = readFileSync(path.join(root, doc), 'utf8');
    for (const { command, name, cwd, filter } of bunRunCommands(source)) {
      let targets;
      if (cwd) {
        const dir = path.posix.normalize(cwd.replace(/\/$/, ''));
        const manifest = manifests.find((entry) => entry.dir === dir) ?? (() => {
          const read = readManifest(path.join(root, dir));
          return read ? { dir, scripts: new Set(Object.keys(read.scripts ?? {})) } : { dir, scripts: new Set() };
        })();
        targets = [manifest];
      } else if (filter) {
        targets = filterTargets(manifests, filter);
      } else {
        targets = manifests.filter((manifest) => manifest.dir === '.');
      }
      const isFile = name.includes('/') || /\.(?:[cm]?[jt]sx?|sh)$/.test(name);
      const found = targets.some(({ dir, scripts }) => (isFile ? existsSync(path.join(root, dir, name)) : scripts.has(name)));
      if (!found) violations.push({ check: 'bun-run', doc, token: command });
    }
  }
  return violations;
}
