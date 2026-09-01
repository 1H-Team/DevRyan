import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const EMPTY_VAULT = Object.freeze({ version: 1, credentials: {} });

const atomicWrite = async (filePath, content, mode = 0o600) => {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(tempPath, content, { mode });
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, mode);
};

const readOrCreateKey = async (keyPath) => {
  try {
    const encoded = (await fs.readFile(keyPath, 'utf8')).trim();
    const key = Buffer.from(encoded, 'base64');
    if (key.byteLength !== 32) throw new Error('invalid key length');
    return key;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const key = crypto.randomBytes(32);
    await atomicWrite(keyPath, `${key.toString('base64')}\n`);
    return key;
  }
};

const encrypt = (key, value) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
};

const decrypt = (key, envelope) => {
  if (!envelope || envelope.version !== 1) throw new Error('Unsupported branch preview vault format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8'));
};

const normalizeReference = (value) => {
  const reference = typeof value === 'string' ? value.trim() : '';
  if (!reference || reference.length > 256 || reference.includes('\u0000')) {
    throw new Error('Branch preview vault reference is invalid');
  }
  return reference;
};

export async function createBranchPreviewVault({ dataDirectory }) {
  const keyPath = path.join(dataDirectory, 'branch-preview-vault.key');
  const vaultPath = path.join(dataDirectory, 'branch-preview-vault.json');
  const key = await readOrCreateKey(keyPath);
  let state = { ...EMPTY_VAULT, credentials: {} };
  let mutation = Promise.resolve();

  try {
    const raw = JSON.parse(await fs.readFile(vaultPath, 'utf8'));
    const decoded = decrypt(key, raw);
    if (decoded?.version === 1 && decoded.credentials && typeof decoded.credentials === 'object') {
      state = decoded;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const persist = () => atomicWrite(vaultPath, `${JSON.stringify(encrypt(key, state))}\n`);
  const mutate = (operation) => {
    const next = mutation.then(operation, operation);
    mutation = next.catch(() => {});
    return next;
  };

  return Object.freeze({
    get(referenceInput) {
      const reference = normalizeReference(referenceInput);
      const value = state.credentials[reference];
      return value ? structuredClone(value) : null;
    },
    set(referenceInput, value) {
      const reference = normalizeReference(referenceInput);
      return mutate(async () => {
        state = {
          ...state,
          credentials: { ...state.credentials, [reference]: structuredClone(value) },
        };
        await persist();
      });
    },
    delete(referenceInput) {
      const reference = normalizeReference(referenceInput);
      return mutate(async () => {
        if (!Object.prototype.hasOwnProperty.call(state.credentials, reference)) return;
        const credentials = { ...state.credentials };
        delete credentials[reference];
        state = { ...state, credentials };
        await persist();
      });
    },
    paths: Object.freeze({ keyPath, vaultPath }),
  });
}
