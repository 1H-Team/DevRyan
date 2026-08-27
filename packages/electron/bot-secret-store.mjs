import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const BOT_DEPLOYMENT_KEY_ID = 'deployment-v1';

const DEPLOYMENT_KEY_BYTES = 32;
const BASE64_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

export class BotSecretStoreError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BotSecretStoreError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new BotSecretStoreError(message, code);
};

const validateSafeStorage = (safeStorage) => {
  if (!safeStorage
    || typeof safeStorage.isEncryptionAvailable !== 'function'
    || typeof safeStorage.encryptString !== 'function'
    || typeof safeStorage.decryptString !== 'function') {
    fail('Electron safeStorage is unavailable', 'bot_os_encryption_unavailable');
  }
  let available = false;
  try {
    available = safeStorage.isEncryptionAvailable() === true;
  } catch {
    available = false;
  }
  if (!available) {
    fail('Operating-system encryption is unavailable', 'bot_os_encryption_unavailable');
  }
};

const decodeDeploymentKey = (encoded) => {
  if (typeof encoded !== 'string' || !BASE64_KEY_PATTERN.test(encoded)) {
    fail('Sealed Bot deployment key is invalid', 'bot_deployment_key_invalid');
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.byteLength !== DEPLOYMENT_KEY_BYTES || key.toString('base64') !== encoded) {
    key.fill(0);
    fail('Sealed Bot deployment key is invalid', 'bot_deployment_key_invalid');
  }
  return key;
};

const unsealKey = (sealed, safeStorage) => {
  try {
    return decodeDeploymentKey(safeStorage.decryptString(Buffer.from(sealed)));
  } catch (error) {
    if (error instanceof BotSecretStoreError) throw error;
    fail('Unable to unseal the Bot deployment key', 'bot_deployment_key_unseal_failed');
  }
};

const fsyncDirectory = async (directory, fsPromises) => {
  let handle;
  try {
    handle = await fsPromises.open(directory, 'r');
    await handle.sync();
  } catch {
    // Some filesystems do not permit directory fsync.
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const createSealedKeyFile = async ({
  keyPath,
  sealed,
  fsPromises,
}) => {
  const directory = path.dirname(keyPath);
  await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsPromises.chmod(directory, 0o700);
  const temporaryPath = `${keyPath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fsPromises.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(sealed);
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      // link() is an atomic create-without-replace operation. Two concurrent
      // first runs therefore converge on one key instead of overwriting it.
      await fsPromises.link(temporaryPath, keyPath);
      await fsPromises.chmod(keyPath, 0o600);
      await fsyncDirectory(directory, fsPromises);
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await fsPromises.unlink(temporaryPath).catch(() => undefined);
  }
};

const replaceSealedKeyFile = async ({ keyPath, sealed, fsPromises }) => {
  const directory = path.dirname(keyPath);
  await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsPromises.chmod(directory, 0o700);
  const temporaryPath = `${keyPath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fsPromises.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(sealed);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsPromises.rename(temporaryPath, keyPath);
    await fsPromises.chmod(keyPath, 0o600);
    await fsyncDirectory(directory, fsPromises);
  } finally {
    await handle?.close().catch(() => undefined);
    await fsPromises.unlink(temporaryPath).catch(() => undefined);
  }
};

const readExistingKey = async (keyPath, safeStorage, fsPromises) => {
  const sealed = await fsPromises.readFile(keyPath);
  const key = unsealKey(sealed, safeStorage);
  await fsPromises.chmod(keyPath, 0o600);
  return key;
};

export async function replaceBotEncryptionKeyAndRepair({ secretStore, replacement, repair } = {}) {
  if (!secretStore || typeof secretStore.getBotEncryptionKey !== 'function'
    || typeof secretStore.replaceBotEncryptionKey !== 'function'
    || typeof repair !== 'function') {
    fail('Bot deployment key repair operation is invalid', 'bot_secret_store_invalid');
  }
  const previous = secretStore.getBotEncryptionKey();
  let changed = false;
  try {
    const result = await secretStore.replaceBotEncryptionKey(replacement);
    changed = result?.changed === true;
    if (changed) await repair();
    return Object.freeze({ changed });
  } catch (error) {
    if (changed) {
      try {
        await secretStore.replaceBotEncryptionKey(previous);
        await repair();
      } catch {
        fail(
          'Bot deployment key rollback failed; runtime repair is required',
          'bot_deployment_key_rollback_failed',
        );
      }
    }
    throw error;
  } finally {
    previous.fill(0);
  }
}

export async function createBotSecretStore({
  dataDirectory,
  safeStorage,
  fsPromises = fs,
  randomBytes = crypto.randomBytes,
} = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)) {
    fail('Bot secret store requires an absolute data directory', 'bot_secret_store_invalid');
  }
  validateSafeStorage(safeStorage);

  const keyPath = path.join(dataDirectory, 'bots', 'keys', 'deployment-key.v1');
  let key;
  try {
    key = await readExistingKey(keyPath, safeStorage, fsPromises);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const generated = Buffer.from(randomBytes(DEPLOYMENT_KEY_BYTES));
    if (generated.byteLength !== DEPLOYMENT_KEY_BYTES) {
      generated.fill(0);
      fail('Bot deployment key generator returned an invalid value', 'bot_deployment_key_invalid');
    }
    let sealed;
    try {
      sealed = Buffer.from(safeStorage.encryptString(generated.toString('base64')));
    } catch {
      generated.fill(0);
      fail('Unable to seal the Bot deployment key', 'bot_deployment_key_seal_failed');
    }
    if (sealed.byteLength === 0) {
      generated.fill(0);
      fail('Unable to seal the Bot deployment key', 'bot_deployment_key_seal_failed');
    }
    let created;
    try {
      created = await createSealedKeyFile({
        keyPath,
        sealed,
        fsPromises,
      });
    } catch (error) {
      generated.fill(0);
      sealed.fill(0);
      throw error;
    }
    sealed.fill(0);
    if (created) {
      key = generated;
    } else {
      generated.fill(0);
      key = await readExistingKey(keyPath, safeStorage, fsPromises);
    }
  }

  let disposed = false;
  let mutation = Promise.resolve();
  return Object.freeze({
    keyId: BOT_DEPLOYMENT_KEY_ID,
    getBotEncryptionKey() {
      if (disposed) {
        fail('Bot secret store has been disposed', 'bot_secret_store_disposed');
      }
      return Buffer.from(key);
    },
    replaceBotEncryptionKey(replacement) {
      const operation = async () => {
        if (disposed) {
          fail('Bot secret store has been disposed', 'bot_secret_store_disposed');
        }
        if (!(Buffer.isBuffer(replacement) || replacement instanceof Uint8Array)
          || replacement.byteLength !== DEPLOYMENT_KEY_BYTES) {
          fail('Replacement Bot deployment key is invalid', 'bot_deployment_key_invalid');
        }
        const nextKey = Buffer.from(replacement);
        if (crypto.timingSafeEqual(nextKey, key)) {
          nextKey.fill(0);
          return Object.freeze({ changed: false });
        }
        let sealed;
        try {
          sealed = Buffer.from(safeStorage.encryptString(nextKey.toString('base64')));
          if (sealed.byteLength < 1) {
            fail('Unable to seal the Bot deployment key', 'bot_deployment_key_seal_failed');
          }
          await replaceSealedKeyFile({ keyPath, sealed, fsPromises });
          const previous = key;
          key = nextKey;
          previous.fill(0);
          return Object.freeze({ changed: true });
        } catch (error) {
          nextKey.fill(0);
          if (error instanceof BotSecretStoreError) throw error;
          fail('Unable to replace the Bot deployment key', 'bot_deployment_key_seal_failed');
        } finally {
          sealed?.fill(0);
        }
      };
      const next = mutation.then(operation, operation);
      mutation = next.catch(() => undefined);
      return next;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      key.fill(0);
    },
    paths: Object.freeze({ keyPath }),
  });
}
