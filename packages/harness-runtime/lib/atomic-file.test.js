import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  cleanupStaleAtomicFiles,
  readJsonGuarded,
  withCrossProcessFileLock,
  writeFileAtomic,
} from './atomic-file.js';

const temporaryDirectories = [];

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
