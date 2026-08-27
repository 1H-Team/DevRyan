import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  BOT_OBJECT_BUCKET,
  BOT_PROFILE_AVATAR_MAX_BYTES,
  createBotBlobStore,
} from './blob-store.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';
const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const SOURCE_ID = 'd0000000-0000-4000-8000-000000000001';
const NOW = '2026-08-22T10:00:00.000Z';
const principal = { id: USER_ID, role: 'developer', scope: 'managed' };

const createHarness = () => {
  const rows = new Map(Object.keys({
    bot_objects: true,
    bot_library_sources: true,
    bot_library_versions: true,
  }).map((name) => [name, []]));
  rows.get('bot_library_sources').push({
    id: SOURCE_ID,
    bot_id: BOT_ID,
    descriptor: {},
    exclusions: {},
    provenance: {},
    current_published_version_id: null,
    created_by: USER_ID,
    created_at: NOW,
    updated_at: NOW,
    retired_at: null,
  });
  const objects = new Map();
  const storage = {
    upload: vi.fn(async (_bucket, name, bytes) => { objects.set(name, Buffer.from(bytes)); }),
    download: vi.fn(async (_bucket, name) => Buffer.from(objects.get(name) || [])),
    delete: vi.fn(async (_bucket, names) => { names.forEach((name) => objects.delete(name)); }),
  };
  const store = {
    available: true,
    storage,
    insert: vi.fn(async (table, input) => {
      const row = {
        ...structuredClone(input),
        created_at: input.created_at || NOW,
        updated_at: input.updated_at || NOW,
      };
      rows.get(table).push(row);
      return row;
    }),
    async get(table, filters) {
      return rows.get(table)?.find((row) => Object.entries(filters).every(([key, value]) => row[key] === value)) || null;
    },
    async list(table, { filters, limit }) {
      const items = (rows.get(table) || [])
        .filter((row) => Object.entries(filters).every(([key, value]) => row[key] === value))
        .sort((left, right) => Number(right.version_number || 0) - Number(left.version_number || 0))
        .slice(0, limit);
      return { items, nextCursor: null };
    },
    async updateIfRevision(table, filters, changes, expectedUpdatedAt) {
      const row = rows.get(table)?.find((candidate) => (
        Object.entries(filters).every(([key, value]) => candidate[key] === value)
        && candidate.updated_at === expectedUpdatedAt
      ));
      if (!row) throw Object.assign(new Error('conflict'), { code: 'bot_revision_conflict' });
      Object.assign(row, structuredClone(changes), { updated_at: '2026-08-22T10:01:00.000Z' });
      return structuredClone(row);
    },
    async deleteCreated(table, filters) {
      const index = rows.get(table).findIndex((row) => (
        Object.entries(filters).every(([key, value]) => row[key] === value)
      ));
      if (index >= 0) rows.get(table).splice(index, 1);
    },
  };
  const authorization = {
    requireChannelSend: vi.fn(async () => ({ allowed: true })),
    requireChannelRead: vi.fn(async () => ({ channel: { owner_user_id: USER_ID } })),
    requireActiveMembership: vi.fn(async () => ({ membership: { role: 'member' } })),
    requireManager: vi.fn(async () => ({ membership: { role: 'manager' } })),
  };
  const blobStore = createBotBlobStore({
    store,
    authorization,
    encryption: { getKey: () => Buffer.alloc(32, 0x71) },
  });
  return { authorization, blobStore, objects, rows, storage, store };
};

describe('Production Bots encrypted object store', () => {
  it('encrypts allowed content with a per-object key before private Storage upload', async () => {
    const harness = createHarness();
    const plaintext = Buffer.from('private transcript attachment');
    const row = await harness.blobStore.uploadPrivate({
      principal,
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      contentType: 'text/plain',
      bytes: plaintext,
      provenance: { source: 'channel_upload' },
    });

    expect(harness.authorization.requireChannelSend).toHaveBeenCalledWith(
      principal,
      BOT_ID,
      CHANNEL_ID,
    );
    expect(row).toMatchObject({
      bot_id: BOT_ID,
      channel_id: CHANNEL_ID,
      visibility: 'private',
      storage_bucket: BOT_OBJECT_BUCKET,
      ciphertext_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      ciphertext_size: plaintext.byteLength,
      object_key_envelope: {
        version: 1,
        algorithm: 'aes-256-gcm',
        aadVersion: 1,
      },
      wrapped_key: {
        version: 1,
        algorithm: 'aes-256-gcm',
        keyId: 'deployment-v1',
      },
    });
    const stored = harness.objects.get(row.storage_object_name);
    expect(stored).not.toEqual(plaintext);
    expect(stored.toString('utf8')).not.toContain('private transcript');
    expect(JSON.stringify(row)).not.toContain('private transcript');
  });

  it('accepts a signature-valid PNG as a private conversation attachment', async () => {
    const harness = createHarness();
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x00,
    ]);
    const row = await harness.blobStore.uploadPrivate({
      principal,
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      contentType: 'image/png',
      bytes: png,
      provenance: { source: 'channel_upload', name: 'screenshot.png' },
    });

    expect(row).toMatchObject({
      bot_id: BOT_ID,
      channel_id: CHANNEL_ID,
      visibility: 'private',
      content_type: 'image/png',
    });
    await expect(harness.blobStore.download({
      principal,
      botId: BOT_ID,
      objectId: row.id,
    })).resolves.toMatchObject({ bytes: png });
  });

  it('verifies MIME magic before writing and ciphertext integrity before decrypting', async () => {
    const harness = createHarness();
    await expect(harness.blobStore.uploadPrivate({
      principal,
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      contentType: 'application/pdf',
      bytes: Buffer.from('not a PDF'),
      provenance: {},
    })).rejects.toMatchObject({ code: 'bot_object_mime_mismatch', statusCode: 415 });
    expect(harness.storage.upload).not.toHaveBeenCalled();

    const row = await harness.blobStore.uploadPrivate({
      principal,
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      contentType: 'text/plain',
      bytes: Buffer.from('verified text'),
      provenance: {},
    });
    await expect(harness.blobStore.download({
      principal,
      botId: BOT_ID,
      objectId: row.id,
    })).resolves.toMatchObject({ bytes: Buffer.from('verified text') });

    harness.objects.set(row.storage_object_name, crypto.randomBytes(row.ciphertext_size));
    await expect(harness.blobStore.download({
      principal,
      botId: BOT_ID,
      objectId: row.id,
    })).rejects.toMatchObject({ code: 'bot_object_integrity_failed', statusCode: 502 });
  });

  it('stores only bounded PNG, JPEG, or WebP avatars in the profile visibility class', async () => {
    const harness = createHarness();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const row = await harness.blobStore.uploadProfileAvatar({
      principal,
      botId: BOT_ID,
      contentType: 'image/png',
      bytes: png,
      provenance: { purpose: 'bot-profile-avatar' },
    });

    expect(harness.authorization.requireManager).toHaveBeenCalledWith(principal, BOT_ID);
    expect(harness.authorization.requireChannelSend).not.toHaveBeenCalled();
    expect(row).toMatchObject({
      bot_id: BOT_ID,
      channel_id: null,
      visibility: 'profile',
      content_type: 'image/png',
    });
    await expect(harness.blobStore.download({
      principal,
      botId: BOT_ID,
      objectId: row.id,
    })).resolves.toMatchObject({ bytes: png });

    await expect(harness.blobStore.uploadProfileAvatar({
      principal,
      botId: BOT_ID,
      contentType: 'image/jpeg',
      bytes: png,
      provenance: {},
    })).rejects.toMatchObject({ code: 'bot_object_mime_mismatch', statusCode: 415 });

    const oversized = Buffer.alloc(BOT_PROFILE_AVATAR_MAX_BYTES + 1);
    png.copy(oversized);
    await expect(harness.blobStore.uploadProfileAvatar({
      principal,
      botId: BOT_ID,
      contentType: 'image/png',
      bytes: oversized,
      provenance: {},
    })).rejects.toMatchObject({ code: 'bot_object_too_large', statusCode: 413 });

    row.visibility = 'library';
    await expect(harness.blobStore.download({
      principal,
      botId: BOT_ID,
      objectId: row.id,
    })).rejects.toMatchObject({ code: 'bot_object_integrity_failed', statusCode: 502 });
  });

  it('fails closed on expired encrypted evidence before reading Storage', async () => {
    const harness = createHarness();
    const row = await harness.blobStore.uploadPrivate({
      principal,
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      contentType: 'text/plain',
      bytes: Buffer.from('expiring evidence'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      provenance: { actionEvidence: { actionAttemptId: SOURCE_ID } },
    });
    expect(row.expires_at).toEqual(expect.any(String));
    row.expires_at = new Date(Date.now() - 1_000).toISOString();

    await expect(harness.blobStore.download({
      principal,
      botId: BOT_ID,
      objectId: row.id,
    })).rejects.toMatchObject({ code: 'bot_object_expired', statusCode: 410 });
    expect(harness.storage.download).not.toHaveBeenCalled();
  });

  it('publishes by creating a new immutable Library object and version', async () => {
    const harness = createHarness();
    const privateObject = await harness.blobStore.uploadPrivate({
      principal,
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      contentType: 'text/markdown',
      bytes: Buffer.from('# Reviewed handbook'),
      provenance: {},
    });
    const result = await harness.blobStore.publishToLibrary({
      principal,
      botId: BOT_ID,
      objectId: privateObject.id,
      sourceId: SOURCE_ID,
      provenance: { reviewId: 'review-1' },
    });

    expect(harness.authorization.requireManager).toHaveBeenCalledWith(principal, BOT_ID);
    expect(harness.authorization.requireChannelRead).toHaveBeenCalled();
    expect(result.object).toMatchObject({
      bot_id: BOT_ID,
      channel_id: null,
      visibility: 'library',
    });
    expect(result.object.id).not.toBe(privateObject.id);
    expect(result.version).toMatchObject({
      source_id: SOURCE_ID,
      version_number: 1,
      object_ids: [result.object.id],
      published_by: USER_ID,
    });
    expect(result.version.manifest_envelope).not.toHaveProperty('objectIds');
    expect(harness.rows.get('bot_library_sources')[0].current_published_version_id)
      .toBe(result.version.id);
    expect(harness.rows.get('bot_objects').find((row) => row.id === privateObject.id).visibility)
      .toBe('private');
  });

  it('reports a resumable partial deletion when private Storage cleanup fails', async () => {
    const harness = createHarness();
    const row = await harness.blobStore.uploadPrivate({
      principal,
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      contentType: 'text/plain',
      bytes: Buffer.from('delete me'),
      provenance: {},
    });
    harness.storage.delete.mockRejectedValueOnce(Object.assign(new Error('offline'), {
      code: 'storage_offline',
    }));

    await expect(harness.blobStore.deleteObject({
      principal,
      botId: BOT_ID,
      objectId: row.id,
    })).resolves.toMatchObject({
      storageDeleted: false,
      cleanupRequired: true,
      errorCode: 'storage_offline',
      object: { deleted_at: expect.any(String) },
    });
  });
});
