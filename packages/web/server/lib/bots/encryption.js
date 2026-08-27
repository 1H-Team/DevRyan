import crypto from 'node:crypto';

export const BOT_ENCRYPTION_VERSION = 1;
export const BOT_ENCRYPTION_ALGORITHM = 'aes-256-gcm';

const ENVELOPE_FIELDS = Object.freeze([
  'algorithm',
  'ciphertext',
  'iv',
  'keyId',
  'tag',
  'version',
]);
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class BotEncryptionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BotEncryptionError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new BotEncryptionError(message, code);
};

const normalizeKey = (key) => {
  if (!(Buffer.isBuffer(key) || key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) {
    fail('Bot encryption key must contain exactly 32 bytes', 'bot_encryption_key_invalid');
  }
  return Buffer.from(key);
};

const normalizeKeyId = (keyId) => {
  const normalized = typeof keyId === 'string' ? keyId.trim() : '';
  if (!KEY_ID_PATTERN.test(normalized)) {
    fail('Bot encryption key ID is invalid', 'bot_encryption_key_id_invalid');
  }
  return normalized;
};

const normalizeAssociatedData = (associatedData) => {
  if (associatedData === undefined || associatedData === null) return null;
  if (typeof associatedData === 'string') return Buffer.from(associatedData, 'utf8');
  if (Buffer.isBuffer(associatedData) || associatedData instanceof Uint8Array) {
    return Buffer.from(associatedData);
  }
  fail('Bot encryption associated data is invalid', 'bot_encryption_aad_invalid');
};

const decodeBase64 = (value, expectedBytes = null) => {
  if (typeof value !== 'string' || !BASE64_PATTERN.test(value)) {
    fail('Bot encryption envelope is invalid', 'bot_encryption_envelope_invalid');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    fail('Bot encryption envelope is invalid', 'bot_encryption_envelope_invalid');
  }
  if (expectedBytes !== null && decoded.byteLength !== expectedBytes) {
    fail('Bot encryption envelope is invalid', 'bot_encryption_envelope_invalid');
  }
  return decoded;
};

const validateEnvelope = (envelope) => {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    fail('Bot encryption envelope is invalid', 'bot_encryption_envelope_invalid');
  }
  if (Object.keys(envelope).sort().join('\0') !== ENVELOPE_FIELDS.join('\0')) {
    fail('Bot encryption envelope is invalid', 'bot_encryption_envelope_invalid');
  }
  if (envelope.version !== BOT_ENCRYPTION_VERSION
    || envelope.algorithm !== BOT_ENCRYPTION_ALGORITHM) {
    fail('Bot encryption envelope version is unsupported', 'bot_encryption_envelope_unsupported');
  }

  return {
    keyId: normalizeKeyId(envelope.keyId),
    iv: decodeBase64(envelope.iv, IV_BYTES),
    tag: decodeBase64(envelope.tag, TAG_BYTES),
    ciphertext: decodeBase64(envelope.ciphertext),
  };
};

const encodeJson = (value) => {
  if (value === undefined) {
    fail('Bot encryption plaintext must be JSON-compatible', 'bot_encryption_plaintext_invalid');
  }
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string') {
      fail('Bot encryption plaintext must be JSON-compatible', 'bot_encryption_plaintext_invalid');
    }
    return Buffer.from(encoded, 'utf8');
  } catch (error) {
    if (error instanceof BotEncryptionError) throw error;
    fail('Bot encryption plaintext must be JSON-compatible', 'bot_encryption_plaintext_invalid');
  }
};

export const encryptBotJson = ({
  key,
  keyId,
  value,
  associatedData,
  randomBytes = crypto.randomBytes,
} = {}) => {
  const normalizedKey = normalizeKey(key);
  const normalizedKeyId = normalizeKeyId(keyId);
  const aad = normalizeAssociatedData(associatedData);
  const plaintext = encodeJson(value);
  const iv = Buffer.from(randomBytes(IV_BYTES));
  if (iv.byteLength !== IV_BYTES) {
    fail('Bot encryption IV generator returned an invalid value', 'bot_encryption_iv_invalid');
  }

  const cipher = crypto.createCipheriv(BOT_ENCRYPTION_ALGORITHM, normalizedKey, iv);
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: BOT_ENCRYPTION_VERSION,
    algorithm: BOT_ENCRYPTION_ALGORITHM,
    keyId: normalizedKeyId,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
};

export const decryptBotJson = ({
  key,
  envelope,
  expectedKeyId,
  associatedData,
} = {}) => {
  const normalizedKey = normalizeKey(key);
  const decoded = validateEnvelope(envelope);
  const normalizedExpectedKeyId = expectedKeyId === undefined
    ? decoded.keyId
    : normalizeKeyId(expectedKeyId);
  if (decoded.keyId !== normalizedExpectedKeyId) {
    fail('Bot encryption key ID does not match', 'bot_encryption_key_mismatch');
  }
  const aad = normalizeAssociatedData(associatedData);

  let plaintext;
  try {
    const decipher = crypto.createDecipheriv(BOT_ENCRYPTION_ALGORITHM, normalizedKey, decoded.iv);
    decipher.setAuthTag(decoded.tag);
    if (aad) decipher.setAAD(aad);
    plaintext = Buffer.concat([decipher.update(decoded.ciphertext), decipher.final()]);
  } catch {
    fail('Unable to decrypt Bot data', 'bot_encryption_failed');
  }

  try {
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    fail('Decrypted Bot data is not valid JSON', 'bot_encryption_plaintext_invalid');
  }
};
