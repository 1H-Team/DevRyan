import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  readProviderAuthRecord,
  readScopedProviderAuthRecord,
  writeScopedProviderAuthRecord,
} from './auth.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

const makeDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-opencode-auth-'));
  temporaryDirectories.push(directory);
  return directory;
};

describe('scoped OpenCode provider auth', () => {
  it('returns only the requested host provider record as a defensive copy', async () => {
    const directory = await makeDirectory();
    const authFile = path.join(directory, 'auth.json');
    await fs.writeFile(authFile, JSON.stringify({
      openai: { type: 'oauth', access: 'selected-secret', refresh: 'selected-refresh' },
      anthropic: { type: 'api', key: 'unselected-secret' },
    }), { mode: 0o600 });

    const selected = readProviderAuthRecord('openai', { authFile });
    expect(selected).toEqual({ type: 'oauth', access: 'selected-secret', refresh: 'selected-refresh' });
    selected.access = 'mutated';
    expect(readProviderAuthRecord('openai', { authFile }).access).toBe('selected-secret');
    expect(readProviderAuthRecord('missing', { authFile })).toBeNull();
  });

  it('materializes one provider into a private directory and refuses extra records on ingest', async () => {
    const root = await makeDirectory();
    const scoped = path.join(root, 'run-auth');
    const written = await writeScopedProviderAuthRecord({
      directory: scoped,
      providerId: 'openai',
      record: { type: 'oauth', access: 'scoped-access', refresh: 'scoped-refresh' },
    });

    expect(written.authFile).toBe(path.join(scoped, 'auth.json'));
    expect((await fs.stat(scoped)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(written.authFile)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(written.authFile, 'utf8'))).toEqual({
      openai: { type: 'oauth', access: 'scoped-access', refresh: 'scoped-refresh' },
    });
    expect(await readScopedProviderAuthRecord({ directory: scoped, providerId: 'openai' }))
      .toEqual({ type: 'oauth', access: 'scoped-access', refresh: 'scoped-refresh' });

    await fs.writeFile(written.authFile, JSON.stringify({
      openai: { type: 'oauth', access: 'scoped-access' },
      anthropic: { type: 'api', key: 'must-not-be-ingested' },
    }), { mode: 0o600 });
    await expect(readScopedProviderAuthRecord({ directory: scoped, providerId: 'openai' }))
      .rejects.toThrow(/another provider/i);
  });

  it('rejects oversized, invalid, and traversal-shaped provider identities', async () => {
    const directory = await makeDirectory();
    const authFile = path.join(directory, 'auth.json');
    await fs.writeFile(authFile, JSON.stringify({ openai: { key: 'value' } }));
    expect(() => readProviderAuthRecord('../openai', { authFile })).toThrow(/invalid/i);
    await expect(writeScopedProviderAuthRecord({
      directory: path.join(directory, 'scoped'),
      providerId: 'openai',
      record: { value: 'x'.repeat(300 * 1024) },
    })).rejects.toThrow(/invalid/i);
  });
});
