import { describe, expect, it } from 'vitest';

import {
  BOT_ENCRYPTION_ALGORITHM,
  BOT_ENCRYPTION_VERSION,
  BotEncryptionError,
  decryptBotJson,
  encryptBotJson,
} from './encryption.js';

const KEY_ID = 'deployment-v1';

describe('Production Bots AES-256-GCM envelopes', () => {
  it('round-trips structured JSON through the exact versioned envelope', () => {
    const key = Buffer.alloc(32, 0x12);
    const value = { token: 'private-token', nested: { enabled: true }, count: 3 };
    const envelope = encryptBotJson({ key, keyId: KEY_ID, value });

    expect(envelope).toEqual({
      version: BOT_ENCRYPTION_VERSION,
      algorithm: BOT_ENCRYPTION_ALGORITHM,
      keyId: KEY_ID,
      iv: expect.any(String),
      tag: expect.any(String),
      ciphertext: expect.any(String),
    });
    expect(Object.keys(envelope).sort()).toEqual([
      'algorithm',
      'ciphertext',
      'iv',
      'keyId',
      'tag',
      'version',
    ]);
    expect(JSON.stringify(envelope)).not.toContain('private-token');
    expect(decryptBotJson({ key, envelope, expectedKeyId: KEY_ID })).toEqual(value);
  });

  it('uses a unique 96-bit IV for every encryption', () => {
    const key = Buffer.alloc(32, 0x23);
    const first = encryptBotJson({ key, keyId: KEY_ID, value: { value: 'same' } });
    const second = encryptBotJson({ key, keyId: KEY_ID, value: { value: 'same' } });

    expect(Buffer.from(first.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(second.iv, 'base64')).toHaveLength(12);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('binds ciphertext to optional associated data', () => {
    const key = Buffer.alloc(32, 0x34);
    const envelope = encryptBotJson({
      key,
      keyId: KEY_ID,
      value: { accessToken: 'scoped' },
      associatedData: 'credential:one:1',
    });

    expect(decryptBotJson({
      key,
      envelope,
      expectedKeyId: KEY_ID,
      associatedData: 'credential:one:1',
    })).toEqual({ accessToken: 'scoped' });
    expect(() => decryptBotJson({
      key,
      envelope,
      expectedKeyId: KEY_ID,
      associatedData: 'credential:two:1',
    })).toThrow(BotEncryptionError);
  });

  it('rejects the wrong key without exposing OpenSSL internals', () => {
    const envelope = encryptBotJson({
      key: Buffer.alloc(32, 0x45),
      keyId: KEY_ID,
      value: { secret: 'must-not-leak' },
    });

    expect(() => decryptBotJson({
      key: Buffer.alloc(32, 0x46),
      envelope,
      expectedKeyId: KEY_ID,
    })).toThrow(expect.objectContaining({
      code: 'bot_encryption_failed',
      message: 'Unable to decrypt Bot data',
    }));
  });

  it('rejects key-ID mismatches and non-exact envelope shapes', () => {
    const key = Buffer.alloc(32, 0x56);
    const envelope = encryptBotJson({ key, keyId: KEY_ID, value: { ok: true } });

    expect(() => decryptBotJson({
      key,
      envelope,
      expectedKeyId: 'deployment-v2',
    })).toThrow(expect.objectContaining({ code: 'bot_encryption_key_mismatch' }));
    expect(() => decryptBotJson({
      key,
      envelope: { ...envelope, unexpected: true },
      expectedKeyId: KEY_ID,
    })).toThrow(expect.objectContaining({ code: 'bot_encryption_envelope_invalid' }));
  });

  it('requires exact 32-byte keys and JSON-compatible values', () => {
    expect(() => encryptBotJson({
      key: Buffer.alloc(31),
      keyId: KEY_ID,
      value: { ok: true },
    })).toThrow(expect.objectContaining({ code: 'bot_encryption_key_invalid' }));
    expect(() => encryptBotJson({
      key: Buffer.alloc(32),
      keyId: KEY_ID,
      value: undefined,
    })).toThrow(expect.objectContaining({ code: 'bot_encryption_plaintext_invalid' }));
  });
});
