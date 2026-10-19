import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveDevRyanDataRoot } from '@openchamber/shared-runtime/node/data-root.js';
import { DATA_ROOT_MIGRATION_MARKER, migrateLegacyDataRoot } from './data-root-migration.js';

const homes = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => fs.rm(home, { recursive: true, force: true }))); });

async function fixture() {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-data-root-')));
  homes.push(home);
  const config = path.join(home, '.config');
  await fs.mkdir(config);
  return { home, root: path.join(config, 'devryan'), legacy: path.join(config, 'openchamber') };
}
const env = home => ({ HOME: home, XDG_STATE_HOME: path.join(home, '.local', 'state') });
const write = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
const read = file => fs.readFile(file, 'utf8');
const marker = async root => JSON.parse(await read(path.join(root, DATA_ROOT_MIGRATION_MARKER)));
const run = (home, options = {}) => migrateLegacyDataRoot({ env: env(home), home, platform: 'darwin', ...options });

describe('data root migration', () => {
  test('a fresh install uses ~/.config/devryan and creates no link', async () => {
    const { home, root, legacy } = await fixture();
    expect(await run(home)).toEqual({ outcome: 'none', root });
    expect(resolveDevRyanDataRoot({ env: {}, home })).toBe(root);
    await fs.mkdir(root);
    expect((await run(home)).outcome).toBe('current');
    await expect(fs.lstat(legacy)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('moves the folder in one rename and leaves a relative compatibility link', async () => {
    const { home, root, legacy } = await fixture();
    await write(path.join(legacy, 'settings.json'), '{"a":1}');
    await write(path.join(legacy, 'harness', 'journal', 'x.jsonl'), 'line\n');
    const inode = (await fs.stat(path.join(legacy, 'settings.json'))).ino;
    expect(resolveDevRyanDataRoot({ env: {}, home })).toBe(legacy);
    expect(await run(home)).toEqual({ outcome: 'migrated', root });
    expect((await fs.stat(path.join(root, 'settings.json'))).ino).toBe(inode);
    expect(await fs.readlink(legacy)).toBe('devryan');
    expect(await read(path.join(legacy, 'harness', 'journal', 'x.jsonl'))).toBe('line\n');
    expect(await marker(root)).toMatchObject({ schema: 1, state: 'complete', from: legacy });
    expect(resolveDevRyanDataRoot({ env: {}, home })).toBe(root);
    expect(resolveDevRyanDataRoot({ env: { OPENCHAMBER_DATA_DIR: legacy }, home })).toBe(root);
    expect(await run(home)).toEqual({ outcome: 'current', root });
  });

  test('a crash after the rename is finished by the next start', async () => {
    const { home, root, legacy } = await fixture();
    await write(path.join(legacy, 'settings.json'), '{}');
    const crashing = { ...fs, symlink: async () => { throw Object.assign(new Error('crash'), { code: 'EIO' }); } };
    await expect(run(home, { fs: crashing })).rejects.toThrow('crash');
    await expect(fs.lstat(legacy)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await marker(root)).toMatchObject({ state: 'renamed' });
    expect(resolveDevRyanDataRoot({ env: {}, home })).toBe(root);
    expect(await run(home)).toEqual({ outcome: 'linked', root });
    expect(await fs.readlink(legacy)).toBe('devryan');
    expect(await marker(root)).toMatchObject({ state: 'complete' });
  });

  test('when both exist, legacy entries merge and conflicts are kept aside', async () => {
    const { home, root, legacy } = await fixture();
    await write(path.join(root, 'settings.json'), 'new');
    await write(path.join(legacy, 'settings.json'), 'old');
    await write(path.join(legacy, 'github-auth.json'), 'auth');
    expect(resolveDevRyanDataRoot({ env: {}, home })).toBe(legacy);
    const result = await run(home, { now: () => new Date('2026-10-19T12:00:00.000Z') });
    expect(result).toMatchObject({ outcome: 'merged', root, conflicts: ['settings.json'] });
    expect(await read(path.join(root, 'settings.json'))).toBe('new');
    expect(await read(path.join(root, 'github-auth.json'))).toBe('auth');
    expect(await read(path.join(result.conflictDirectory, 'settings.json'))).toBe('old');
    expect(path.basename(result.conflictDirectory)).toBe('legacy-openchamber-2026-10-19T12-00-00.000Z');
    expect(await fs.readlink(legacy)).toBe('devryan');
  });

  test('a failed merge is rolled back and the legacy folder stays in use', async () => {
    const { home, root, legacy } = await fixture();
    await fs.mkdir(root);
    for (const name of ['a', 'b', 'c']) await write(path.join(legacy, name), name);
    let renames = 0;
    const failing = { ...fs, rename: async (from, to) => {
      if (from.startsWith(legacy) && ++renames === 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return fs.rename(from, to);
    } };
    expect(await run(home, { fs: failing })).toEqual({ outcome: 'kept_in_place', root: legacy, code: 'EBUSY' });
    expect((await fs.readdir(legacy)).sort()).toEqual(['a', 'b', 'c']);
    expect(await fs.readdir(root)).toEqual([]);
    expect(resolveDevRyanDataRoot({ env: {}, home })).toBe(legacy);
  });

  test('a mount point that cannot be renamed keeps the legacy root in place', async () => {
    const { home, legacy } = await fixture();
    await write(path.join(legacy, 'settings.json'), '{}');
    const mounted = { ...fs, rename: async () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); } };
    expect(await run(home, { fs: mounted })).toEqual({ outcome: 'kept_in_place', root: legacy, code: 'EXDEV' });
    expect((await fs.lstat(legacy)).isDirectory()).toBe(true);
    expect(await read(path.join(legacy, 'settings.json'))).toBe('{}');
    expect(resolveDevRyanDataRoot({ env: {}, home })).toBe(legacy);
  });

  test('an explicit root and Windows are never migrated', async () => {
    const { home, root, legacy } = await fixture();
    await write(path.join(legacy, 'settings.json'), '{}');
    expect(await run(home, { env: { ...env(home), DEVRYAN_DATA_DIR: path.join(home, 'qa') } })).toEqual({ outcome: 'explicit' });
    expect(await run(home, { env: { ...env(home), OPENCHAMBER_DATA_DIR: path.join(home, 'qa') } })).toEqual({ outcome: 'explicit' });
    expect(await run(home, { platform: 'win32' })).toEqual({ outcome: 'unsupported_platform' });
    expect((await fs.lstat(legacy)).isDirectory()).toBe(true);
    await expect(fs.lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('an older process that recreates the folder before the link is merged at once', async () => {
    const { home, root, legacy } = await fixture();
    await write(path.join(legacy, 'settings.json'), 'moved');
    let raced = false;
    const racing = { ...fs, symlink: async (target, at, type) => {
      if (!raced) { raced = true; await write(path.join(legacy, 'ui-passkeys.json'), 'late'); }
      return fs.symlink(target, at, type);
    } };
    expect(await run(home, { fs: racing })).toEqual({ outcome: 'migrated', root });
    expect(await read(path.join(root, 'ui-passkeys.json'))).toBe('late');
    expect(await read(path.join(root, 'settings.json'))).toBe('moved');
    expect(await fs.readlink(legacy)).toBe('devryan');
  });

  test('a concurrent start that holds the lock defers this one', async () => {
    const { home, legacy } = await fixture();
    await write(path.join(legacy, 'settings.json'), '{}');
    await write(path.join(home, '.local', 'state', 'devryan', 'migrations', 'data-root.lock'), JSON.stringify({ ownerToken: 'x', pid: process.pid, createdAt: Date.now() }));
    expect(await run(home, { lockOptions: { timeoutMs: 50, retryMs: 10 } })).toEqual({ outcome: 'deferred' });
    expect((await fs.lstat(legacy)).isDirectory()).toBe(true);
  });

  test('a user link to another folder moves as a link', async () => {
    const { home, root, legacy } = await fixture();
    const elsewhere = path.join(home, 'volume', 'openchamber');
    await write(path.join(elsewhere, 'settings.json'), 'kept');
    await fs.symlink(elsewhere, legacy);
    expect(resolveDevRyanDataRoot({ env: {}, home })).toBe(legacy);
    expect((await run(home)).outcome).toBe('migrated');
    expect(await fs.readlink(root)).toBe(elsewhere);
    expect(await fs.readlink(legacy)).toBe('devryan');
    expect(await read(path.join(legacy, 'settings.json'))).toBe('kept');
    expect(resolveDevRyanDataRoot({ env: {}, home })).toBe(root);
  });
});
