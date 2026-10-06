import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  cleanupStaleAtomicFiles,
  readJsonGuarded,
  withCrossProcessFileLock,
  writeFileAtomic,
} from './atomic-file.js';

const temporaryDirectories = [];

test('Windows persistence uses constructor owners, identity-bound quarantine and guarded deletion', () => {
  const atomicModule = new URL('./atomic-file.js', import.meta.url).href;
  const storeModule = new URL('./record-store.js', import.meta.url).href;
  // Isolate the platform fixture: no Windows receipt or platform pass is
  // inferred, and every accidental Node filesystem fallback fails this test.
  const source = `
    import assert from 'node:assert/strict';
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { readJsonGuarded, writeFileAtomic } = await import(${JSON.stringify(atomicModule)});
    const { createRecordStore } = await import(${JSON.stringify(storeModule)});
    const fs = new Proxy({}, { get: () => () => { throw new Error('Node filesystem fallback'); } });
    const file = 'fixture.json';
    await assert.rejects(writeFileAtomic(file, '{}', { fs }), { code: 'private_windows_publication_authority_unavailable' });
    await assert.rejects(readJsonGuarded(file, { fs }), { code: 'private_windows_read_authority_unavailable' });
    const record = { identity: { fileId: 'fixture' }, bytes: Buffer.from('{broken') };
    let preserved = true, quarantined = 0, notified = 0;
    const owner = { read: async () => record, ensureDirectory: async () => {},
      write: async (target, bytes) => { assert.equal(target, file); assert.deepEqual(bytes, Buffer.from('{}')); return { receipt: true }; },
      quarantine: async (target, expected) => { assert.equal(target, file); assert.equal(expected, record); preserved = false; quarantined++; return 'held-backup'; } };
    await assert.rejects(readJsonGuarded(file, { fs, windowsOwner: { read: owner.read } }), { code: 'private_windows_quarantine_authority_unavailable' });
    assert.equal(preserved, true);
    assert.equal(await readJsonGuarded(file, { fs, windowsOwner: owner, onQuarantine: value => { assert.equal(value.quarantinedPath, 'held-backup'); notified++; } }), null);
    assert.equal(quarantined, 1); assert.equal(notified, 1);
    assert.deepEqual(await writeFileAtomic(file, '{}', { fs, windowsOwner: owner }), { receipt: true });
    owner.read = async () => { throw Object.assign(new Error('private'), { code: 'private_windows_file_unverified' }); };
    await assert.rejects(readJsonGuarded(file, { fs, windowsOwner: owner }), { code: 'private_windows_file_unverified' });
    assert.equal(quarantined, 1);
    owner.read = async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
    assert.equal(await readJsonGuarded(file, { fs, windowsOwner: owner }), null);
    let deleted = 0; owner.delete = async target => { assert.ok(target.endsWith('item.json')); deleted++; };
    const store = createRecordStore({ directory: 'fixture-records', fs, windowsOwner: owner });
    await store.deleteRecord('item'); await store.drain(); assert.equal(deleted, 1);
  `;
  expect(() => execFileSync('node', ['--input-type=module', '-e', source], { stdio: 'pipe' })).not.toThrow();
});

const temporaryDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-harness-atomic-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe('atomic file primitives', () => {
  test('fsyncs a private atomic replacement and leaves no temporary file', async () => {
    const directory = await temporaryDirectory();
    const filePath = path.join(directory, 'records', 'one.json');

    await writeFileAtomic(filePath, '{"ok":true}\n');

    expect(await fs.readFile(filePath, 'utf8')).toBe('{"ok":true}\n');
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(path.dirname(filePath))).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  test('cleans stale temporary files without touching fresh ones', async () => {
    const directory = await temporaryDirectory();
    const filePath = path.join(directory, 'record.json');
    const stale = `${filePath}.tmp-old`;
    const fresh = `${filePath}.tmp-new`;
    await fs.writeFile(stale, 'old');
    await fs.writeFile(fresh, 'new');
    await fs.utimes(stale, new Date(0), new Date(0));

    expect(await cleanupStaleAtomicFiles(filePath, {
      now: () => 10_000,
      staleAfterMs: 1_000,
    })).toBe(1);
    await expect(fs.stat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(fresh, 'utf8')).resolves.toBe('new');
  });

  test('refuses unconfirmed replacement durability and preserves the published bytes', async () => {
    const directory = await temporaryDirectory(), filePath = path.join(directory, 'record.json');
    let closed = false;
    const failure = Object.assign(new Error('fixture directory sync failed'), { code: 'EIO' });
    const fsApi = { ...fs, open: async (file, ...arguments_) => file === directory ? {
      sync: async () => { throw failure; }, close: async () => { closed = true; },
    } : fs.open(file, ...arguments_) };
    await expect(writeFileAtomic(filePath, '{"new":true}\n', { fs: fsApi })).rejects.toBe(failure);
    expect(closed).toBe(true);
    expect(await fs.readFile(filePath, 'utf8')).toBe('{"new":true}\n');
    expect(await fs.readdir(directory)).toEqual(['record.json']);
  });

  test('quarantines partial JSON and continues with an empty read', async () => {
    const directory = await temporaryDirectory();
    const filePath = path.join(directory, 'record.json');
    await fs.writeFile(filePath, '{"partial":');

    expect(await readJsonGuarded(filePath, { now: () => 123 })).toBeNull();
    const quarantine = await fs.readdir(path.join(directory, 'quarantine'));
    expect(quarantine).toHaveLength(1);
    expect(quarantine[0]).toContain('record.123.');
  });

  test('creates and releases a private exclusive lock', async () => {
    const directory = await temporaryDirectory();
    const lockPath = path.join(directory, 'project.lock');
    await withCrossProcessFileLock(lockPath, async () => {
      const owner = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      expect(owner).toMatchObject({ ownerToken: 'owner-a', pid: process.pid });
      expect((await fs.stat(lockPath)).mode & 0o777).toBe(0o600);
    }, { randomToken: () => 'owner-a' });
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('recovers a dead owner immediately but never steals from a live owner', async () => {
    const directory = await temporaryDirectory();
    const lockPath = path.join(directory, 'project.lock');
    await fs.writeFile(lockPath, JSON.stringify({ ownerToken: 'dead', pid: 999_999, createdAt: 0 }));
    await expect(withCrossProcessFileLock(lockPath, () => 'acquired', {
      isProcessAlive: () => false,
      randomToken: () => 'new-owner',
    })).resolves.toBe('acquired');

    await fs.writeFile(lockPath, JSON.stringify({ ownerToken: 'live', pid: process.pid, createdAt: 0 }));
    let currentTime = 0;
    await expect(withCrossProcessFileLock(lockPath, () => 'never', {
      timeoutMs: 10,
      retryMs: 5,
      now: () => currentTime,
      wait: async (milliseconds) => { currentTime += milliseconds; },
      isProcessAlive: () => true,
    })).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
    expect(JSON.parse(await fs.readFile(lockPath, 'utf8')).ownerToken).toBe('live');
  });

  test('waits on fresh malformed locks and recovers stale malformed locks', async () => {
    const directory = await temporaryDirectory();
    const lockPath = path.join(directory, 'project.lock');
    await fs.writeFile(lockPath, 'partial');
    let currentTime = (await fs.stat(lockPath)).mtimeMs;
    await expect(withCrossProcessFileLock(lockPath, () => 'never', {
      timeoutMs: 5,
      retryMs: 5,
      malformedStaleMs: 100,
      now: () => currentTime,
      wait: async (milliseconds) => { currentTime += milliseconds; },
    })).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
    expect(await fs.readFile(lockPath, 'utf8')).toBe('partial');

    currentTime += 1_000;
    await expect(withCrossProcessFileLock(lockPath, () => 'recovered', {
      malformedStaleMs: 100,
      now: () => currentTime,
      randomToken: () => 'replacement',
    })).resolves.toBe('recovered');
  });

  test('does not unlink a replacement owned by a different token during release', async () => {
    const directory = await temporaryDirectory();
    const lockPath = path.join(directory, 'project.lock');
    await withCrossProcessFileLock(lockPath, async () => {
      await fs.writeFile(lockPath, JSON.stringify({ ownerToken: 'replacement', pid: process.pid, createdAt: 1 }));
    }, { randomToken: () => 'original' });
    expect(JSON.parse(await fs.readFile(lockPath, 'utf8')).ownerToken).toBe('replacement');
  });
});
