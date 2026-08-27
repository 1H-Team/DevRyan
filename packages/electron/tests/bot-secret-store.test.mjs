import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  BOT_DEPLOYMENT_KEY_ID,
  BotSecretStoreError,
  createBotSecretStore,
  replaceBotEncryptionKeyAndRepair,
} from '../bot-secret-store.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

const createTemporaryDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-bot-secret-store-'));
  temporaryDirectories.push(directory);
  return directory;
};

const createFakeSafeStorage = ({ available = true } = {}) => {
  const calls = [];
  const transform = (input) => Buffer.from(input).map((byte) => byte ^ 0xa5);
  return {
    calls,
    api: {
      isEncryptionAvailable() {
        calls.push(['available']);
        return available;
      },
      encryptString(value) {
        calls.push(['encrypt', value]);
        return transform(Buffer.from(value, 'utf8'));
      },
      decryptString(value) {
        calls.push(['decrypt']);
        return transform(value).toString('utf8');
      },
    },
  };
};

describe('Electron Bot deployment-key store', () => {
  test('creates one random key sealed by safeStorage with private permissions', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const safeStorage = createFakeSafeStorage();
    const generatedKey = Buffer.alloc(32, 0x37);
    const store = await createBotSecretStore({
      dataDirectory,
      safeStorage: safeStorage.api,
      randomBytes: (size) => {
        expect(size).toBe(32);
        return Buffer.from(generatedKey);
      },
    });

    expect(store.keyId).toBe(BOT_DEPLOYMENT_KEY_ID);
    expect(store.getBotEncryptionKey()).toEqual(generatedKey);
    expect(store.paths.keyPath).toBe(path.join(
      dataDirectory,
      'bots',
      'keys',
      'deployment-key.v1',
    ));
    expect(safeStorage.calls).toContainEqual(['encrypt', generatedKey.toString('base64')]);

    const sealed = await fs.readFile(store.paths.keyPath);
    expect(sealed).not.toEqual(generatedKey);
    expect(sealed.toString('utf8')).not.toContain(generatedKey.toString('base64'));
    expect((await fs.stat(store.paths.keyPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(store.paths.keyPath))).mode & 0o777).toBe(0o700);
  });

  test('unseals the existing key without generating or rewriting it', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const safeStorage = createFakeSafeStorage();
    const first = await createBotSecretStore({ dataDirectory, safeStorage: safeStorage.api });
    const before = await fs.readFile(first.paths.keyPath);

    const second = await createBotSecretStore({
      dataDirectory,
      safeStorage: safeStorage.api,
      randomBytes: () => {
        throw new Error('existing stores must not generate another key');
      },
    });

    expect(second.getBotEncryptionKey()).toEqual(first.getBotEncryptionKey());
    expect(await fs.readFile(second.paths.keyPath)).toEqual(before);
    expect(safeStorage.calls.filter(([name]) => name === 'encrypt')).toHaveLength(1);
    expect(safeStorage.calls.filter(([name]) => name === 'decrypt')).toHaveLength(1);
  });

  test('returns defensive key copies and clears its owned key on disposal', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const safeStorage = createFakeSafeStorage();
    const store = await createBotSecretStore({ dataDirectory, safeStorage: safeStorage.api });
    const expected = store.getBotEncryptionKey();
    const callerCopy = store.getBotEncryptionKey();
    callerCopy.fill(0);

    expect(store.getBotEncryptionKey()).toEqual(expected);
    store.dispose();
    expect(() => store.getBotEncryptionKey()).toThrow(BotSecretStoreError);
    expect(() => store.getBotEncryptionKey()).toThrow(/disposed/i);
  });

  test('fails closed when Electron OS encryption is unavailable', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const safeStorage = createFakeSafeStorage({ available: false });

    await expect(createBotSecretStore({
      dataDirectory,
      safeStorage: safeStorage.api,
    })).rejects.toMatchObject({ code: 'bot_os_encryption_unavailable' });
    await expect(fs.stat(path.join(dataDirectory, 'bots', 'keys', 'deployment-key.v1')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('rejects corrupt sealed key material without replacing it', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const keyPath = path.join(dataDirectory, 'bots', 'keys', 'deployment-key.v1');
    await fs.mkdir(path.dirname(keyPath), { recursive: true });
    const safeStorage = createFakeSafeStorage();
    const malformedPlaintext = Buffer.from('not-a-32-byte-key', 'utf8').toString('base64');
    await fs.writeFile(keyPath, safeStorage.api.encryptString(malformedPlaintext), { mode: 0o600 });
    const beforeHash = crypto.createHash('sha256').update(await fs.readFile(keyPath)).digest('hex');

    await expect(createBotSecretStore({
      dataDirectory,
      safeStorage: safeStorage.api,
    })).rejects.toMatchObject({ code: 'bot_deployment_key_invalid' });
    const afterHash = crypto.createHash('sha256').update(await fs.readFile(keyPath)).digest('hex');
    expect(afterHash).toBe(beforeHash);
  });

  test('atomically replaces a recovery key and preserves it across reloads', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const safeStorage = createFakeSafeStorage();
    const store = await createBotSecretStore({ dataDirectory, safeStorage: safeStorage.api });
    const replacement = Buffer.alloc(32, 0x6d);

    await expect(store.replaceBotEncryptionKey(replacement)).resolves.toEqual({ changed: true });
    expect(store.getBotEncryptionKey()).toEqual(replacement);
    expect((await fs.stat(store.paths.keyPath)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(path.dirname(store.paths.keyPath))).toEqual(['deployment-key.v1']);

    const reloaded = await createBotSecretStore({ dataDirectory, safeStorage: safeStorage.api });
    expect(reloaded.getBotEncryptionKey()).toEqual(replacement);
    await expect(store.replaceBotEncryptionKey(replacement)).resolves.toEqual({ changed: false });
  });

  test('restores the prior sealed key when runtime repair rejects a recovery key', async () => {
    const dataDirectory = await createTemporaryDirectory();
    const safeStorage = createFakeSafeStorage();
    const store = await createBotSecretStore({ dataDirectory, safeStorage: safeStorage.api });
    const previous = store.getBotEncryptionKey();
    const replacement = Buffer.alloc(32, 0x4f);
    const repairs = [];

    await expect(replaceBotEncryptionKeyAndRepair({
      secretStore: store,
      replacement,
      repair: async () => {
        repairs.push(store.getBotEncryptionKey());
        if (repairs.length === 1) throw new Error('runtime could not restart');
      },
    })).rejects.toThrow('runtime could not restart');

    expect(repairs).toHaveLength(2);
    expect(repairs[0]).toEqual(replacement);
    expect(repairs[1]).toEqual(previous);
    expect(store.getBotEncryptionKey()).toEqual(previous);
    const reloaded = await createBotSecretStore({ dataDirectory, safeStorage: safeStorage.api });
    expect(reloaded.getBotEncryptionKey()).toEqual(previous);
    for (const key of repairs) key.fill(0);
    previous.fill(0);
  });
});
