import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { parseStrictJson } from '@openchamber/bots-runtime';

import { decryptBotJson, encryptBotJson } from './encryption.js';

const SIGNER_VERSION = 1;
const SIGNER_KEY_ID = 'deployment-v1';
const SIGNER_AAD = 'devryan-bot-spec-signer:v1';
const SIGNER_FIELDS = Object.freeze([
  'keyId',
  'privateKeyEnvelope',
  'publicKey',
  'version',
]);
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class BotSpecSignerError extends Error {
  constructor(message, code = 'bot_spec_signer_invalid', statusCode = 500) {
    super(message);
    this.name = 'BotSpecSignerError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotSpecSignerError(message, code, statusCode);
};

const decodeBase64 = (value, label) => {
  if (typeof value !== 'string' || !BASE64_PATTERN.test(value)) {
    fail(`Bot specification ${label} is invalid`, 'bot_spec_signer_corrupt');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    decoded.fill(0);
    fail(`Bot specification ${label} is invalid`, 'bot_spec_signer_corrupt');
  }
  return decoded;
};

const keyIdentifier = (publicKeyBytes) => (
  `ed25519:${crypto.createHash('sha256').update(publicKeyBytes).digest('hex')}`
);

const withEncryptionKey = async (encryption, operation) => {
  let provided = null;
  let key = null;
  try {
    if (typeof encryption?.getKey !== 'function') {
      fail('Bot specification signing key is unavailable', 'bot_os_encryption_unavailable', 503);
    }
    provided = await encryption.getKey();
    key = Buffer.from(provided || []);
    if (key.byteLength !== 32) {
      fail('Bot specification signing key is unavailable', 'bot_os_encryption_unavailable', 503);
    }
    return await operation(key);
  } finally {
    key?.fill(0);
    if (Buffer.isBuffer(provided) || provided instanceof Uint8Array) provided.fill(0);
  }
};

export function createBotSpecSigner({
  dataDirectory,
  encryption,
  fsPromises = fs,
  randomBytes = crypto.randomBytes,
  generateKeyPairSync = crypto.generateKeyPairSync,
} = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)
    || typeof encryption?.getKey !== 'function'
    || typeof fsPromises?.readFile !== 'function'
    || typeof fsPromises?.writeFile !== 'function'
    || typeof randomBytes !== 'function'
    || typeof generateKeyPairSync !== 'function') {
    throw new TypeError('Bot specification signer is misconfigured');
  }

  const signerDirectory = path.join(dataDirectory, 'bots', 'signing');
  const signerPath = path.join(signerDirectory, 'revision-ed25519.json');
  let loaded = null;
  let loadPromise = null;

  const decodeState = async (raw) => {
    let state;
    try {
      state = parseStrictJson(raw, { maximumBytes: 32 * 1024, maximumDepth: 12 });
    } catch {
      fail('Bot specification signing key is unreadable', 'bot_spec_signer_corrupt');
    }
    if (!state || typeof state !== 'object' || Array.isArray(state)
      || Object.keys(state).sort().join('\0') !== SIGNER_FIELDS.join('\0')
      || state.version !== SIGNER_VERSION) {
      fail('Bot specification signing key is unreadable', 'bot_spec_signer_corrupt');
    }
    const publicKeyBytes = decodeBase64(state.publicKey, 'public key');
    let privateKeyBytes = null;
    try {
      const privateValue = await withEncryptionKey(encryption, (key) => decryptBotJson({
        key,
        envelope: state.privateKeyEnvelope,
        expectedKeyId: SIGNER_KEY_ID,
        associatedData: SIGNER_AAD,
      }));
      privateKeyBytes = decodeBase64(privateValue?.pkcs8, 'private key');
      const publicKey = crypto.createPublicKey({ key: publicKeyBytes, format: 'der', type: 'spki' });
      const privateKey = crypto.createPrivateKey({ key: privateKeyBytes, format: 'der', type: 'pkcs8' });
      if (publicKey.asymmetricKeyType !== 'ed25519' || privateKey.asymmetricKeyType !== 'ed25519'
        || state.keyId !== keyIdentifier(publicKeyBytes)) {
        fail('Bot specification signing key is unreadable', 'bot_spec_signer_corrupt');
      }
      const challenge = Buffer.from('devryan-bot-spec-signer-check', 'utf8');
      const signature = crypto.sign(null, challenge, privateKey);
      if (!crypto.verify(null, challenge, publicKey, signature)) {
        signature.fill(0);
        fail('Bot specification signing key failed verification', 'bot_spec_signer_corrupt');
      }
      signature.fill(0);
      return Object.freeze({
        keyId: state.keyId,
        publicKey: state.publicKey,
        publicKeyObject: publicKey,
        privateKeyObject: privateKey,
      });
    } catch (error) {
      if (error instanceof BotSpecSignerError) throw error;
      fail('Bot specification signing key is unreadable', 'bot_spec_signer_corrupt');
    } finally {
      publicKeyBytes.fill(0);
      privateKeyBytes?.fill(0);
    }
  };

  const createState = async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyBytes = publicKey.export({ format: 'der', type: 'spki' });
    const privateKeyBytes = privateKey.export({ format: 'der', type: 'pkcs8' });
    try {
      const publicKeyBase64 = publicKeyBytes.toString('base64');
      const keyId = keyIdentifier(publicKeyBytes);
      const privateKeyEnvelope = await withEncryptionKey(encryption, (key) => encryptBotJson({
        key,
        keyId: SIGNER_KEY_ID,
        value: { pkcs8: privateKeyBytes.toString('base64') },
        associatedData: SIGNER_AAD,
      }));
      const state = {
        version: SIGNER_VERSION,
        keyId,
        publicKey: publicKeyBase64,
        privateKeyEnvelope,
      };
      await fsPromises.mkdir(signerDirectory, { recursive: true, mode: 0o700 });
      await fsPromises.chmod(signerDirectory, 0o700);
      const nonce = Buffer.from(randomBytes(12)).toString('hex');
      const temporaryPath = path.join(signerDirectory, `.revision-ed25519-${process.pid}-${nonce}.tmp`);
      try {
        await fsPromises.writeFile(temporaryPath, `${JSON.stringify(state)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        });
        await fsPromises.chmod(temporaryPath, 0o600);
        await fsPromises.rename(temporaryPath, signerPath);
        await fsPromises.chmod(signerPath, 0o600);
      } catch (error) {
        await fsPromises.rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
      return decodeState(`${JSON.stringify(state)}\n`);
    } finally {
      publicKeyBytes.fill(0);
      privateKeyBytes.fill(0);
    }
  };

  const load = async () => {
    if (loaded) return loaded;
    loadPromise ||= (async () => {
      try {
        loaded = await decodeState(await fsPromises.readFile(signerPath, 'utf8'));
      } catch (error) {
        if (error instanceof BotSpecSignerError) throw error;
        if (error?.code !== 'ENOENT') {
          fail('Bot specification signing key is unreadable', 'bot_spec_signer_corrupt');
        }
        try {
          loaded = await createState();
        } catch (createError) {
          if (createError?.code === 'EEXIST') {
            loaded = await decodeState(await fsPromises.readFile(signerPath, 'utf8'));
          } else {
            throw createError;
          }
        }
      }
      return loaded;
    })().finally(() => { loadPromise = null; });
    return loadPromise;
  };

  return Object.freeze({
    signerPath,
    async identity() {
      const signer = await load();
      return Object.freeze({ keyId: signer.keyId, publicKey: signer.publicKey });
    },
    async sign(bytes) {
      if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)) {
        fail('Bot specification signing input is invalid', 'bot_spec_signer_invalid', 400);
      }
      const signer = await load();
      return Object.freeze({
        keyId: signer.keyId,
        publicKey: signer.publicKey,
        signature: crypto.sign(null, Buffer.from(bytes), signer.privateKeyObject).toString('base64'),
      });
    },
  });
}
