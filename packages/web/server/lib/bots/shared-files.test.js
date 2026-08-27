import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  createBotSharedFileAdmissions,
  createBotSharedFileService,
  sanitizeBotSharedFilename,
} from './shared-files.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';
const MESSAGE_ID = 'd0000000-0000-4000-8000-000000000001';
const FILE_ID = 'e0000000-0000-4000-8000-000000000001';
const OBJECT_ID = 'f0000000-0000-4000-8000-000000000001';
const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const RUN_ID = '10000000-0000-4000-8000-000000000001';

const createHarness = ({ claimConflict = false, importFailure = false, runAvailable = true } = {}) => {
  let revision = 0;
  let pendingClaimConflict = claimConflict;
  const importedBytes = [];
  const rows = new Map([[FILE_ID, {
    id: FILE_ID,
    bot_id: BOT_ID,
    channel_id: CHANNEL_ID,
    message_id: MESSAGE_ID,
    object_id: OBJECT_ID,
    sender_user_id: USER_ID,
    direction: 'user',
    safe_filename: 'fixture.txt',
    content_type: 'text/plain',
    plaintext_sha256: null,
    plaintext_size: null,
    computer_path: `/workspace/Shared/${CHANNEL_ID}/${MESSAGE_ID}/fixture.txt`,
    copy_state: 'pending',
    copy_attempts: 0,
    error_code: null,
    created_at: '2026-08-25T12:00:00.000Z',
    updated_at: '2026-08-25T12:00:00.000Z',
  }]]);
  const repository = {
    get: vi.fn(async ({ id }) => structuredClone(rows.get(id) || null)),
    list: vi.fn(async ({ filters }) => ({
      items: [...rows.values()].filter((row) => Object.entries(filters || {}).every(
        ([key, value]) => row[key] === value,
      )).map((row) => structuredClone(row)),
      nextCursor: null,
    })),
    updateIfRevision: vi.fn(async ({ id }, changes, expectedUpdatedAt) => {
      const current = rows.get(id);
      expect(current.updated_at).toBe(expectedUpdatedAt);
      revision += 1;
      if (pendingClaimConflict && changes.copy_state === 'copying') {
        pendingClaimConflict = false;
        rows.set(id, {
          ...current,
          copy_state: 'copying',
          copy_attempts: Number(current.copy_attempts || 0) + 1,
          updated_at: `2026-08-25T12:00:0${revision}.000Z`,
        });
        throw Object.assign(new Error('concurrent Shared claim'), { code: 'bot_revision_conflict' });
      }
      const next = {
        ...current,
        ...structuredClone(changes),
        updated_at: `2026-08-25T12:00:0${revision}.000Z`,
      };
      rows.set(id, next);
      return structuredClone(next);
    }),
    insert: vi.fn(async (input) => {
      const row = {
        ...structuredClone(input),
        created_at: '2026-08-25T12:01:00.000Z',
        updated_at: '2026-08-25T12:01:00.000Z',
      };
      rows.set(row.id, row);
      return structuredClone(row);
    }),
  };
  const bytes = Buffer.from('known fixture');
  const objectBytes = new Map([[OBJECT_ID, Buffer.from(bytes)]]);
  const dockerProvider = {
    importSharedFile: vi.fn(async (input) => {
      importedBytes.push(Buffer.from(input.bytes));
      if (importFailure) throw Object.assign(new Error('offline'), { code: 'bot_runtime_unavailable' });
      return {
        written: true,
        path: `/workspace/Shared/${input.channelId}/${input.messageId}/${input.filename}`,
        bytes: input.bytes.byteLength,
        sha256: crypto.createHash('sha256').update(input.bytes).digest('hex'),
      };
    }),
  };
  const authorization = {
    requireChannelRead: vi.fn(async () => ({})),
    requireChannelSend: vi.fn(async () => ({})),
  };
  const onMessageReady = vi.fn(async () => {});
  const recordDiagnostic = vi.fn();
  const service = createBotSharedFileService({
    store: {
      repositories: {
        bot_shared_files: repository,
        bots: { get: vi.fn(async () => ({ id: BOT_ID, lifecycle: 'active', active_revision_id: 'revision' })) },
        bot_messages: { get: vi.fn(async () => ({ id: MESSAGE_ID, run_id: RUN_ID })) },
        bot_runs: { get: vi.fn(async () => (runAvailable
          ? {
            id: RUN_ID,
            bot_id: BOT_ID,
            channel_id: CHANNEL_ID,
            state: 'queued',
            computer_scope_key: `bot:${BOT_ID}`,
          }
          : null)) },
      },
    },
    authorization,
    blobStore: {
      downloadAuthorized: vi.fn(async ({ objectId }) => ({
        object: { id: objectId, channel_id: CHANNEL_ID },
        bytes: Buffer.from(objectBytes.get(objectId) || bytes),
      })),
      uploadPrivate: vi.fn(async ({ bytes: publishedBytes, contentType, provenance }) => {
        const id = 'f0000000-0000-4000-8000-000000000099';
        objectBytes.set(id, Buffer.from(publishedBytes));
        return { id, channel_id: CHANNEL_ID, content_type: contentType, provenance };
      }),
      deleteObject: vi.fn(async () => ({ cleanupRequired: false })),
    },
    dockerProvider,
    computerRuntimeManager: { ensureBot: vi.fn(async () => ({})) },
    eventStream: { publish: vi.fn(async () => ({ delivered: 1 })) },
    channels: { audienceForChannel: vi.fn(async () => [USER_ID]) },
    onMessageReady,
    recordDiagnostic,
    logger: { warn: vi.fn() },
  });
  return {
    authorization,
    dockerProvider,
    importedBytes,
    onMessageReady,
    recordDiagnostic,
    repository,
    rows,
    service,
  };
};

describe('Bot Shared files', () => {
  it('sanitizes traversal and resolves filename collisions deterministically', () => {
    expect(sanitizeBotSharedFilename('../../Quarterly Report?.pdf', OBJECT_ID))
      .toBe('Quarterly_Report_.pdf');
    const admissions = createBotSharedFileAdmissions({
      channelId: CHANNEL_ID,
      messageId: MESSAGE_ID,
      objects: [
        { id: OBJECT_ID, provenance: { name: '../report.txt' } },
        { id: 'f0000000-0000-4000-8000-000000000002', provenance: { name: 'report.txt' } },
      ],
      uuid: (() => {
        let index = 0;
        return () => `e0000000-0000-4000-8000-00000000000${++index}`;
      })(),
    });
    expect(admissions.map((entry) => entry.filename)).toEqual(['report.txt', 'report-2.txt']);
    expect(admissions[1].computerPath).toBe(
      `/workspace/Shared/${CHANNEL_ID}/${MESSAGE_ID}/report-2.txt`,
    );
  });

  it('copies exact bytes, verifies them, publishes status, and drains the blocked scope', async () => {
    const harness = createHarness();
    await expect(harness.service.prepareMessage({ messageId: MESSAGE_ID }))
      .resolves.toMatchObject({ ready: true });
    expect(harness.dockerProvider.importSharedFile).toHaveBeenCalledWith(expect.objectContaining({
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      messageId: MESSAGE_ID,
      filename: 'fixture.txt',
      bytes: expect.any(Buffer),
    }));
    expect(harness.rows.get(FILE_ID)).toMatchObject({
      copy_state: 'ready',
      plaintext_size: 13,
      plaintext_sha256: crypto.createHash('sha256').update('known fixture').digest('hex'),
      error_code: null,
    });
    expect(harness.onMessageReady).toHaveBeenCalledWith(`bot:${BOT_ID}`);
  });

  it('keeps failed preparation visible and retries idempotently without a new mapping', async () => {
    const harness = createHarness({ importFailure: true });
    await harness.service.prepareMessage({ messageId: MESSAGE_ID });
    expect(harness.rows.get(FILE_ID)).toMatchObject({
      copy_state: 'failed',
      error_code: 'bot_runtime_unavailable',
    });
    harness.dockerProvider.importSharedFile.mockImplementation(async (input) => ({
      written: true,
      path: `/workspace/Shared/${input.channelId}/${input.messageId}/${input.filename}`,
      bytes: input.bytes.byteLength,
      sha256: crypto.createHash('sha256').update(input.bytes).digest('hex'),
    }));
    await expect(harness.service.retry({
      principal: { id: USER_ID },
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      sharedFileId: FILE_ID,
    })).resolves.toMatchObject({ id: FILE_ID, copyState: 'ready' });
    expect(harness.rows).toHaveLength(1);
    expect(harness.authorization.requireChannelSend).toHaveBeenCalledWith(
      { id: USER_ID }, BOT_ID, CHANNEL_ID,
    );
  });

  it('does not mark a Shared copy failed when another runtime owns the optimistic claim', async () => {
    const harness = createHarness({ claimConflict: true });
    await expect(harness.service.prepareMessage({ messageId: MESSAGE_ID }))
      .resolves.toMatchObject({ ready: false });
    expect(harness.rows.get(FILE_ID)).toMatchObject({
      copy_state: 'copying',
      error_code: null,
    });
    expect(harness.dockerProvider.importSharedFile).not.toHaveBeenCalled();
  });

  it('registers only an explicit Bot publication under the assistant message path', async () => {
    const harness = createHarness();
    const published = await harness.service.publishBotFile({
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      runId: RUN_ID,
      principalId: USER_ID,
      filename: '../fixture.txt',
      contentType: 'text/plain',
      bytes: Buffer.from('published by bot'),
    });

    expect(published).toMatchObject({
      direction: 'bot',
      senderUserId: null,
      filename: 'fixture-2.txt',
      copyState: 'pending',
      computerPath: `/workspace/Shared/${CHANNEL_ID}/${MESSAGE_ID}/fixture-2.txt`,
    });
    expect(harness.repository.insert).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(harness.dockerProvider.importSharedFile).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'fixture-2.txt' }),
    ));
    expect(harness.rows.get(published.id)).toMatchObject({ copy_state: 'ready' });
    expect(harness.importedBytes.at(-1)).toEqual(Buffer.from('published by bot'));
    expect(harness.recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      mark: 'bot.turn.shared_mapping_created',
      payload: expect.objectContaining({ runId: RUN_ID }),
    }));
  });

  it('keeps the encrypted Bot publication available when its asynchronous Shared copy fails', async () => {
    const harness = createHarness({ importFailure: true });
    const published = await harness.service.publishBotFile({
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      runId: RUN_ID,
      principalId: USER_ID,
      filename: 'generated.png',
      contentType: 'image/png',
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      sourceKey: 'generated:docker-fixture',
    });

    expect(published).toMatchObject({
      objectId: 'f0000000-0000-4000-8000-000000000099',
      direction: 'bot',
      contentType: 'image/png',
      copyState: 'pending',
    });
    await vi.waitFor(() => expect(harness.rows.get(published.id)).toMatchObject({
      object_id: published.objectId,
      copy_state: 'failed',
      error_code: 'bot_runtime_unavailable',
    }));
    expect(harness.repository.insert).toHaveBeenCalledTimes(1);
  });

  it('rejects publication unless the exact run belongs to the Bot and channel', async () => {
    const harness = createHarness({ runAvailable: false });
    await expect(harness.service.publishBotFile({
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      runId: RUN_ID,
      principalId: USER_ID,
      filename: 'fixture.txt',
      contentType: 'text/plain',
      bytes: Buffer.from('not admitted'),
    })).rejects.toMatchObject({
      code: 'bot_shared_file_message_unavailable',
      statusCode: 409,
    });
    expect(harness.repository.insert).not.toHaveBeenCalled();
  });
});
