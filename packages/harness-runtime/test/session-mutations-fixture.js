// Shared fixture for the session-mutations suites (one file per concern so
// Bun schedules them on separate workers). Each test gets a fresh repository,
// copied from a template rather than `git init`, and fresh private storage.
import { test as bunTest } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initGitRepository } from '../../../scripts/test-git-template.mjs';
import { createSessionMutationRuntime } from '../lib/session-mutations.js';
import { openChangeStore, changeKey } from '../lib/session-changes-store.js';

export const roots = [];
/** A test with the suite's 60 s budget. */
export const test = (name, body, timeout = 60_000) => bunTest(name, body, timeout);
/** Register in each test file: `afterEach(cleanupRoots)` (a shared module loads once per process). */
export const cleanupRoots = async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); };
// Small batches so tests cross install-batch boundaries with ~150 files (a few commits each), not thousands.
export const SMALL_BATCHES = Object.freeze({ install: 32, initialInstall: 64 });
export async function fixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-mutations-')); roots.push(root);
  const directory = path.join(root, 'project'), storage = path.join(root, 'private');
  await initGitRepository(directory);
  const runtime = createSessionMutationRuntime({ directory: storage, ...options });
  const begin = (sessionID, userMessageID, callID, extra = {}) => runtime.begin({ directory, sessionID, userMessageID,
    messageID: `${userMessageID}-assistant`, callID, ...extra });
  const finish = (lease) => runtime.finish({ directory, token: lease.token });
  const revert = async (sessionID, messageID) => {
    const tx = await runtime.prepareRevert({ directory, sessionID, messageID });
    return runtime.settleRevert({ directory, transactionID: tx.id, commit: true });
  };
  return { runtime, root, directory, storage, begin, finish, revert,
    read: (name) => fs.readFile(path.join(directory, name), 'utf8'),
    write: (name, text) => fs.writeFile(path.join(directory, name), text) };
}

export async function ledgerState(f) {
  const root = path.join(f.storage, changeKey(await fs.realpath(f.directory)));
  const db = await openChangeStore(root, path.join(root, 'git'));
  const state = {};
  for await (const { value } of db.entries('files')) {
    if (!value.published) continue;
    let revisions = 0; for await (const _ of db.list(`revisions/${value.id}`)) revisions += 1;
    const text = [];
    for await (const { value: page } of db.entries(`runs/${value.id}`)) {
      if (!Array.isArray(page)) { text.push((await fs.readFile(path.join(root, 'objects', page.baseline))).toString('latin1')); continue; }
      for (const run of page) text.push(Buffer.from(run.bytes, 'base64').toString('latin1'));
    }
    state[value.published.path] = { hash: value.published.hash, mode: value.published.mode, deleted: Boolean(value.published.deleted), revisions, text: text.join('') };
  }
  return state;
}
export async function manyFiles(f, count) {
  for (let index = 0; index < count; index += 1) {
    const directory = path.join(f.directory, `d${index % 17}`, `e${index % 5}`);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `f${index}.txt`), `line ${index}\n`.repeat(1 + (index % 4)));
  }
  await fs.writeFile(path.join(f.directory, 'bin.dat'), Buffer.from([0, 1, 2, 255]));
  await fs.writeFile(path.join(f.directory, 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
  await fs.symlink('d0/e0/f0.txt', path.join(f.directory, 'link'));
}
export const withEnv = async (values, action) => {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  try { return await action(); }
  finally { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
};

