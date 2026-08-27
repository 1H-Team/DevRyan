import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createBotEnvironmentSecretVault } from './environment-secret-vault.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const SECRET_ID = 'c0000000-0000-4000-8000-000000000001';
const CREATOR_ID = 'a0000000-0000-4000-8000-000000000001';
const KEY = Buffer.alloc(32, 0x45);
const directories = [];

afterEach(async () => Promise.all(directories.splice(0).map((directory) => (
  fs.rm(directory, { recursive: true, force: true })
))));

const temporaryDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-env-vault-'));
  directories.push(directory);
  return directory;
};

describe('Bot environment-secret vault', () => {
  it('stores only ciphertext and supports rotation rollback and Bot purge', async () => {
    const dataDirectory = await temporaryDirectory();
    const vault = await createBotEnvironmentSecretVault({
      dataDirectory,
      getBotEncryptionKey: () => Buffer.from(KEY),
      now: () => new Date('2026-08-26T12:00:00.000Z'),
    });
    const created = await vault.create({
      id: SECRET_ID,
      botId: BOT_ID,
      name: 'SERVICE_TOKEN',
      createdBy: CREATOR_ID,
      value: 'first-secret-value',
    });
    expect(created).not.toHaveProperty('value');
    const vaultPath = path.join(dataDirectory, 'bots', 'vault', 'environment-secrets.v1.json');
    expect(await fs.readFile(vaultPath, 'utf8')).not.toContain('first-secret-value');
    expect((await fs.stat(vaultPath)).mode & 0o777).toBe(0o600);

    const rotated = await vault.rotate(SECRET_ID, 'second-secret-value');
    expect((await vault.read(SECRET_ID)).value).toBe('second-secret-value');
    await vault.rollbackRotation(SECRET_ID, rotated.metadata.secretVersion, rotated.previous);
    expect((await vault.read(SECRET_ID)).value).toBe('first-secret-value');
    expect(vault.listMetadata()).toHaveLength(1);
    await expect(vault.deleteBot(BOT_ID)).resolves.toEqual({ deletedCount: 1 });
    await expect(vault.read(SECRET_ID)).rejects.toMatchObject({
      code: 'bot_environment_secret_not_found',
    });
  });

  it('exports and restores an opaque Bot-scoped recovery document', async () => {
    const sourceDirectory = await temporaryDirectory();
    const targetDirectory = await temporaryDirectory();
    const source = await createBotEnvironmentSecretVault({
      dataDirectory: sourceDirectory,
      getBotEncryptionKey: () => Buffer.from(KEY),
    });
    await source.create({
      id: SECRET_ID,
      botId: BOT_ID,
      name: 'SERVICE_TOKEN',
      createdBy: CREATOR_ID,
      value: 'recovery-secret-value',
    });
    const recovery = source.exportForBot(BOT_ID);
    expect(recovery.toString('utf8')).not.toContain('recovery-secret-value');

    const target = await createBotEnvironmentSecretVault({
      dataDirectory: targetDirectory,
      getBotEncryptionKey: () => Buffer.from(KEY),
    });
    await expect(target.inspectRestoreForBot(BOT_ID, recovery, {
      mode: 'empty',
      deploymentKey: KEY,
    })).resolves.toEqual({ secretIds: [SECRET_ID] });
    await expect(target.restoreForBot(BOT_ID, recovery, { mode: 'empty' }))
      .resolves.toEqual({ restoredCount: 1 });
    expect((await target.read(SECRET_ID)).value).toBe('recovery-secret-value');
    recovery.fill(0);
  });
});
