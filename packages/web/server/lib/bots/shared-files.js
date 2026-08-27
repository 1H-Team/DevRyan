import crypto, { randomUUID } from 'node:crypto';

import { validateUuid } from './validation.js';

const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESERVED_FILENAMES = new Set(['.devryan', '.opencode']);

export class BotSharedFileError extends Error {
  constructor(message, code = 'bot_shared_file_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotSharedFileError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotSharedFileError(message, code, statusCode);
};

const fallbackFilename = (objectId) => `attachment-${objectId.slice(0, 8)}.bin`;

export const sanitizeBotSharedFilename = (value, objectId) => {
  const leaf = typeof value === 'string'
    ? value.split(/[\\/]/).at(-1)?.normalize('NFKD') || ''
    : '';
  let safe = leaf
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/_+/g, '_')
    .slice(0, 128)
    .replace(/[._-]+$/, '');
  if (!SAFE_FILENAME_PATTERN.test(safe) || RESERVED_FILENAMES.has(safe.toLowerCase())) {
    safe = fallbackFilename(validateUuid(objectId, 'objectId'));
  }
  return safe;
};

const withCollisionSuffix = (filename, suffix) => {
  if (suffix === 1) return filename;
  const lastDot = filename.lastIndexOf('.');
  const extension = lastDot > 0 ? filename.slice(lastDot) : '';
  const stem = lastDot > 0 ? filename.slice(0, lastDot) : filename;
  const marker = `-${suffix}`;
  return `${stem.slice(0, 128 - extension.length - marker.length)}${marker}${extension}`;
};

export const createBotSharedFileAdmissions = ({
  channelId,
  messageId,
  objects,
  usedFilenames = [],
  uuid = randomUUID,
} = {}) => {
  const normalizedChannelId = validateUuid(channelId, 'channelId');
  const normalizedMessageId = validateUuid(messageId, 'messageId');
  if (!Array.isArray(objects) || typeof uuid !== 'function') {
    fail('Bot Shared file admission is invalid');
  }
  if (!Array.isArray(usedFilenames) || usedFilenames.some((filename) => (
    typeof filename !== 'string' || !SAFE_FILENAME_PATTERN.test(filename)
  ))) {
    fail('Bot Shared filename inventory is invalid');
  }
  const used = new Set(usedFilenames.map((filename) => filename.toLowerCase()));
  return Object.freeze(objects.map((object) => {
    const objectId = validateUuid(object?.id, 'objectId');
    const base = sanitizeBotSharedFilename(object?.provenance?.name, objectId);
    let filename = base;
    let suffix = 1;
    while (used.has(filename.toLowerCase())) {
      suffix += 1;
      filename = withCollisionSuffix(base, suffix);
    }
    used.add(filename.toLowerCase());
    return Object.freeze({
      id: validateUuid(uuid(), 'sharedFileId'),
      objectId,
      filename,
      computerPath: `/workspace/Shared/${normalizedChannelId}/${normalizedMessageId}/${filename}`,
    });
  }));
};

export const publicBotSharedFile = (row) => Object.freeze({
  id: row.id,
  botId: row.bot_id,
  channelId: row.channel_id,
  messageId: row.message_id,
  objectId: row.object_id,
  senderUserId: row.sender_user_id || null,
  direction: row.direction,
  filename: row.safe_filename,
  contentType: row.content_type,
  sha256: row.plaintext_sha256 || null,
  size: row.plaintext_size == null ? null : Number(row.plaintext_size),
  computerPath: row.computer_path,
  copyState: row.copy_state,
  errorCode: row.error_code || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const stableErrorCode = (error) => {
  const value = typeof error?.code === 'string' ? error.code : 'bot_shared_file_copy_failed';
  const safe = value.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 120);
  return safe || 'bot_shared_file_copy_failed';
};

export function createBotSharedFileService({
  store,
  authorization,
  blobStore,
  dockerProvider,
  computerRuntimeManager,
  eventStream,
  channels,
  onMessageReady = async () => {},
  recordDiagnostic = () => {},
  logger = console,
} = {}) {
  const repository = store?.repositories?.bot_shared_files;
  if (!repository || !authorization || typeof authorization.requireChannelRead !== 'function'
    || typeof authorization.requireChannelSend !== 'function'
    || !blobStore || typeof blobStore.downloadAuthorized !== 'function'
    || typeof blobStore.uploadPrivate !== 'function' || typeof blobStore.deleteObject !== 'function'
    || !dockerProvider || typeof dockerProvider.importSharedFile !== 'function'
    || !computerRuntimeManager || typeof computerRuntimeManager.ensureBot !== 'function'
    || !eventStream || typeof eventStream.publish !== 'function'
    || !channels || typeof channels.audienceForChannel !== 'function'
    || typeof onMessageReady !== 'function' || typeof recordDiagnostic !== 'function') {
    throw new TypeError('Bot Shared file service is misconfigured');
  }
  const locks = new Map();

  const publish = async (row) => eventStream.publish({
    kind: 'shared_file.updated',
    botId: row.bot_id,
    channelId: row.channel_id,
    audienceUserIds: await channels.audienceForChannel(row.channel_id),
    payload: { sharedFile: publicBotSharedFile(row) },
  });

  const update = async (row, changes) => repository.updateIfRevision(
    { id: row.id },
    changes,
    row.updated_at,
  );

  const prepareOne = async (fileId) => {
    const normalizedId = validateUuid(fileId, 'sharedFileId');
    const previous = locks.get(normalizedId) || Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      let row = await repository.get({ id: normalizedId });
      if (!row || row.copy_state === 'ready') return row;
      try {
        try {
          row = await update(row, {
            copy_state: 'copying',
            copy_attempts: Number(row.copy_attempts || 0) + 1,
            error_code: null,
          });
        } catch (error) {
          const current = await repository.get({ id: normalizedId }).catch(() => null);
          if (current?.copy_state === 'ready' || current?.copy_state === 'copying') {
            return current;
          }
          throw error;
        }
        await publish(row);
        const [bot, downloaded] = await Promise.all([
          store.repositories.bots.get({ id: row.bot_id }),
          blobStore.downloadAuthorized({ botId: row.bot_id, objectId: row.object_id }),
        ]);
        if (!bot || downloaded.object.id !== row.object_id
          || downloaded.object.channel_id !== row.channel_id) {
          downloaded.bytes.fill(0);
          fail('Bot Shared source is unavailable', 'bot_object_not_found', 404);
        }
        try {
          await computerRuntimeManager.ensureBot(bot);
          const sha256 = crypto.createHash('sha256').update(downloaded.bytes).digest('hex');
          const result = await dockerProvider.importSharedFile({
            botId: row.bot_id,
            channelId: row.channel_id,
            messageId: row.message_id,
            filename: row.safe_filename,
            bytes: downloaded.bytes,
          });
          if (result.sha256 !== sha256 || result.bytes !== downloaded.bytes.byteLength) {
            fail('Bot Shared copy verification failed', 'bot_shared_file_integrity_failed', 502);
          }
          row = await update(row, {
            plaintext_sha256: sha256,
            plaintext_size: downloaded.bytes.byteLength,
            copy_state: 'ready',
            error_code: null,
          });
        } finally {
          downloaded.bytes.fill(0);
        }
      } catch (error) {
        const current = await repository.get({ id: normalizedId }).catch(() => row);
        if (current && current.copy_state !== 'ready') {
          row = await update(current, {
            copy_state: 'failed',
            error_code: stableErrorCode(error),
          }).catch(() => current);
        }
        logger?.warn?.('[BotsShared] file preparation failed', {
          code: stableErrorCode(error),
          sharedFileId: normalizedId,
        });
      }
      if (row) await publish(row).catch(() => undefined);
      return row;
    });
    locks.set(normalizedId, operation);
    return operation.finally(() => {
      if (locks.get(normalizedId) === operation) locks.delete(normalizedId);
    });
  };

  const notifyIfMessageReady = async (messageId) => {
    const page = await repository.list({ filters: { message_id: messageId }, limit: 100 });
    if (page.items.length === 0 || page.items.some((row) => row.copy_state !== 'ready')) return false;
    const message = await store.repositories.bot_messages.get({ id: messageId });
    const run = message?.run_id
      ? await store.repositories.bot_runs.get({ id: message.run_id })
      : null;
    if (run?.state === 'queued') await onMessageReady(run.computer_scope_key);
    return true;
  };

  const prepareMessage = async ({ messageId, fileIds = null } = {}) => {
    const normalizedMessageId = validateUuid(messageId, 'messageId');
    const page = await repository.list({ filters: { message_id: normalizedMessageId }, limit: 100 });
    const selected = fileIds === null
      ? page.items
      : page.items.filter((row) => fileIds.includes(row.id));
    await Promise.all(selected.map((row) => prepareOne(row.id)));
    const ready = await notifyIfMessageReady(normalizedMessageId);
    return Object.freeze({ ready, files: Object.freeze(selected.map((row) => row.id)) });
  };

  const listChannel = async ({ principal, botId, channelId } = {}) => {
    const normalizedBotId = validateUuid(botId, 'botId');
    const normalizedChannelId = validateUuid(channelId, 'channelId');
    await authorization.requireChannelRead(principal, normalizedBotId, normalizedChannelId);
    const items = [];
    let cursor = null;
    do {
      const page = await repository.list({
        filters: { bot_id: normalizedBotId, channel_id: normalizedChannelId },
        cursor,
        limit: 100,
      });
      items.push(...page.items.map(publicBotSharedFile));
      cursor = page.nextCursor;
    } while (cursor && items.length < 1_000);
    return Object.freeze({ sharedFiles: Object.freeze(items), nextCursor: cursor });
  };

  return Object.freeze({
    prepareMessage,
    listChannel,
    async publishBotFile({
      botId,
      channelId,
      runId,
      principalId,
      filename,
      contentType,
      bytes,
      sourceKey = null,
    } = {}) {
      const normalizedBotId = validateUuid(botId, 'botId');
      const normalizedChannelId = validateUuid(channelId, 'channelId');
      const normalizedRunId = validateUuid(runId, 'runId');
      const normalizedPrincipalId = validateUuid(principalId, 'principalId');
      if (!Buffer.isBuffer(bytes) || bytes.byteLength < 1 || bytes.byteLength > 10 * 1024 * 1024) {
        fail('Bot Shared publication bytes are invalid', 'bot_shared_file_too_large', 413);
      }
      if (sourceKey !== null && (typeof sourceKey !== 'string'
        || !/^[a-z0-9:_-]{1,256}$/.test(sourceKey))) {
        fail('Bot Shared publication source is invalid');
      }
      const [run, existingMessage] = await Promise.all([
        store.repositories.bot_runs.get({
          id: normalizedRunId,
          bot_id: normalizedBotId,
          channel_id: normalizedChannelId,
        }),
        store.repositories.bot_messages.get({
          run_id: normalizedRunId,
          channel_id: normalizedChannelId,
          role: 'assistant',
          assistant_phase: 'result',
        }),
      ]);
      const message = existingMessage || (run && typeof channels.getOrCreateAssistantCheckpoint === 'function'
        ? await channels.getOrCreateAssistantCheckpoint({
            run,
            assistantPhase: 'result',
          })
        : null);
      if (!run || !message || message.run_id !== normalizedRunId) {
        fail('Bot Shared publication message is unavailable', 'bot_shared_file_message_unavailable', 409);
      }
      if (sourceKey) {
        const existing = await repository.get({ bot_id: normalizedBotId, source_key: sourceKey });
        if (existing) return publicBotSharedFile(existing);
      }
      const principal = Object.freeze({ id: normalizedPrincipalId, role: 'developer', scope: 'managed' });
      const object = await blobStore.uploadPrivate({
        principal,
        botId: normalizedBotId,
        channelId: normalizedChannelId,
        contentType,
        bytes,
        provenance: {
          name: filename,
          source: sourceKey ? 'bot_generated_image' : 'bot_explicit_publication',
          runId: normalizedRunId,
        },
      });
      let row = null;
      try {
        const existing = await repository.list({ filters: { message_id: message.id }, limit: 100 });
        const [admission] = createBotSharedFileAdmissions({
          channelId: normalizedChannelId,
          messageId: message.id,
          objects: [object],
          usedFilenames: existing.items.map((item) => item.safe_filename),
        });
        row = await repository.insert({
          id: admission.id,
          bot_id: normalizedBotId,
          channel_id: normalizedChannelId,
          message_id: message.id,
          object_id: object.id,
          sender_user_id: null,
          direction: 'bot',
          safe_filename: admission.filename,
          content_type: object.content_type,
          plaintext_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
          plaintext_size: bytes.byteLength,
          computer_path: admission.computerPath,
          copy_state: 'pending',
          copy_attempts: 0,
          error_code: null,
          source_key: sourceKey,
        });
      } catch (error) {
        await blobStore.deleteObject({ principal, botId: normalizedBotId, objectId: object.id })
          .catch(() => undefined);
        if (sourceKey && error?.code === '23505') {
          const existing = await repository.get({ bot_id: normalizedBotId, source_key: sourceKey });
          if (existing) return publicBotSharedFile(existing);
        }
        throw error;
      }
      await publish(row);
      try {
        recordDiagnostic({
          type: 'timing',
          mark: 'bot.turn.shared_mapping_created',
          payload: { botId: normalizedBotId, channelId: normalizedChannelId, runId: normalizedRunId },
        });
      } catch {
        // Diagnostics must not affect a durable Shared mapping.
      }
      queueMicrotask(() => {
        void prepareMessage({ messageId: message.id, fileIds: [row.id] }).catch((error) => {
          logger?.warn?.('[BotsShared] asynchronous Shared copy failed', {
            code: stableErrorCode(error),
            sharedFileId: row.id,
          });
        });
      });
      return publicBotSharedFile(row);
    },
    async retry({ principal, botId, channelId, sharedFileId } = {}) {
      const normalizedBotId = validateUuid(botId, 'botId');
      const normalizedChannelId = validateUuid(channelId, 'channelId');
      await authorization.requireChannelSend(principal, normalizedBotId, normalizedChannelId);
      const row = await repository.get({ id: validateUuid(sharedFileId, 'sharedFileId') });
      if (!row || row.bot_id !== normalizedBotId || row.channel_id !== normalizedChannelId) {
        fail('Bot Shared file not found', 'bot_shared_file_not_found', 404);
      }
      await prepareMessage({ messageId: row.message_id, fileIds: [row.id] });
      return publicBotSharedFile(await repository.get({ id: row.id }));
    },
    async recover() {
      for (const state of ['pending', 'copying']) {
        let cursor = null;
        do {
          const page = await repository.list({ filters: { copy_state: state }, cursor, limit: 100 });
          await Promise.all(page.items.map((row) => prepareMessage({
            messageId: row.message_id,
            fileIds: [row.id],
          })));
          cursor = page.nextCursor;
        } while (cursor);
      }
    },
  });
}
