import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { cleanupStaleAtomicFiles, readJsonGuarded, writeFileAtomic } from './atomic-file.js';

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
});
