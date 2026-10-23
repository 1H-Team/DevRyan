// Vitest setup file, run before every test file.
//
// Server modules resolve DEVRYAN_DATA_DIR when they load and fall back to
// ~/.config/devryan, and the OpenCode config helpers fall back to
// ~/.config/opencode. A test that imported one before choosing its own folder
// read the developer's real data and could rewrite it. Every test file now
// starts with its own empty data folder (suites that need a specific folder
// still set their own), and a guard fails the file if anything in the test
// process creates, writes, moves or removes a path inside the real DevRyan,
// pre-rename OpenChamber or OpenCode config folders.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, inject } from 'vitest';

import { keepArtifactsRequested } from '../../../scripts/qa/run-root.mjs';

const GUARD = Symbol.for('devryan.test.realDataGuard');

const installRealDataGuard = () => {
  const config = path.join(os.homedir(), '.config');
  const roots = [...new Set(['devryan', 'openchamber', 'opencode'].flatMap((name) => {
    const root = path.join(config, name);
    try { return [root, fs.realpathSync(root)]; } catch { return [root]; }
  }))];
  const state = { roots, violations: [] };

  const toPath = (value) => {
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    if (value instanceof URL) return value.protocol === 'file:' ? fileURLToPath(value) : null;
    return null;
  };
  const check = (operation, value) => {
    const raw = toPath(value);
    if (raw === null) return;
    const resolved = path.resolve(raw);
    if (!state.roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) return;
    const error = Object.assign(
      new Error(`Test isolation: ${operation} touched the real config folder: ${resolved}`),
      { code: 'EDEVRYANTESTISOLATION' },
    );
    state.violations.push(error.message);
    throw error;
  };
  const writeFlags = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;
  const opensForWrite = (flags) => (
    typeof flags === 'string' ? /[wa+]/.test(flags) : typeof flags === 'number' && (flags & writeFlags) !== 0
  );

  const wrap = (target, name, guardArguments) => {
    const original = target[name];
    if (typeof original !== 'function') return;
    target[name] = function guardedFileSystemCall(...args) {
      guardArguments(args, name);
      return original.apply(this, args);
    };
  };
  const first = (args, name) => check(name, args[0]);
  const second = (args, name) => check(name, args[1]);
  const both = (args, name) => { check(name, args[0]); check(name, args[1]); };
  const open = (args, name) => { if (opensForWrite(args[1])) check(name, args[0]); };
  const guards = {
    writeFile: first, appendFile: first, mkdir: first, mkdtemp: first, rm: first, rmdir: first, unlink: first,
    truncate: first, chmod: first, lchmod: first, chown: first, lchown: first, utimes: first, lutimes: first,
    rename: both, copyFile: second, cp: second, symlink: second, link: second, open,
  };
  for (const [name, guard] of Object.entries(guards)) {
    wrap(fs, name, guard);
    wrap(fs, `${name}Sync`, guard);
    wrap(fs.promises, name, guard);
  }
  wrap(fs, 'createWriteStream', first);
  syncBuiltinESMExports();
  return state;
};

globalThis[GUARD] ??= installRealDataGuard();
const guard = globalThis[GUARD];
// Builtins are shared by every file a worker runs; count only this file's.
const violationsBefore = guard.violations.length;

const fileRoot = fs.mkdtempSync(path.join(inject('devryanTestRunRoot'), 'file-'));
const dataDirectory = path.join(fileRoot, 'data');
fs.mkdirSync(dataDirectory);
for (const name of ['DEVRYAN_DATA_DIR', 'OPENCHAMBER_DATA_DIR']) process.env[name] = dataDirectory;

afterAll(() => {
  if (!keepArtifactsRequested()) fs.rmSync(fileRoot, { recursive: true, force: true });
  const violations = guard.violations.slice(violationsBefore);
  if (violations.length > 0) {
    throw new Error(`This test file touched the real DevRyan or OpenCode config folder:\n${[...new Set(violations)].join('\n')}`);
  }
});
