import { randomUUID } from 'node:crypto';

import { decryptBotJson, encryptBotJson } from './encryption.js';
import { sanitizeBotConversationalText } from './response-sanitizer.js';
import {
  assertExactObject,
  normalizePageLimit,
  validateBoundedString,
  validateUuid,
} from './validation.js';
import { createBotSharedFileAdmissions } from './shared-files.js';
import { publicBotActionAttempt } from './approval-service.js';
import { isBotRunRetryable } from './retry-policy.js';

const DEPLOYMENT_KEY_ID = 'deployment-v1';
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_ATTACHMENTS = 32;
const ASSISTANT_PHASES = Object.freeze(['pending', 'acknowledgment', 'result']);

export class BotChannelError extends Error {
  constructor(message, code = 'bot_channel_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotChannelError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotChannelError(message, code, statusCode);
};

const isUniqueViolation = (error) => (
  error?.code === '23505' || error?.payload?.code === '23505'
);

const normalizeText = (value, { allowEmpty = false } = {}) => {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    fail('Bot message text is required', 'bot_message_invalid', 400);
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_MESSAGE_BYTES) {
    fail('Bot message text is too large', 'bot_message_too_large', 413);
  }
  return value;
};

const normalizeAttachmentIds = (value) => {
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) {
    fail('Bot message attachments are invalid', 'bot_message_invalid', 400);
  }
  const normalized = value.map((id, index) => validateUuid(id, `attachmentIds[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    fail('Bot message attachments contain duplicates', 'bot_message_invalid', 400);
  }
  return normalized;
};

const publicChannel = (row, accessRole = 'owner') => Object.freeze({
  id: row.id,
  botId: row.bot_id,
  ownerUserId: row.owner_user_id,
  accessRole,
  canSend: accessRole === 'owner' || accessRole === 'collaborator',
  lifecycle: row.lifecycle,
  currentCheckpointNumber: Number(row.current_checkpoint_number || 0),
  lastMessageSequence: Math.max(0, Number(row.next_message_sequence || 1) - 1),
  lastMessageAt: row.last_message_at || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  archivedAt: row.archived_at || null,
});

const publicRun = (row) => Object.freeze({
  id: row.id,
  botId: row.bot_id,
  channelId: row.channel_id,
  revisionId: row.revision_id,
  modelSnapshot: row.model_snapshot || null,
  computerScopeKey: row.computer_scope_key,
  queueSequence: row.queue_sequence == null ? null : Number(row.queue_sequence),
  state: row.state,
  retryable: isBotRunRetryable(row),
  interruptionKind: row.interruption_kind || null,
  createdAt: row.created_at || null,
  updatedAt: row.updated_at || null,
  startedAt: row.started_at || null,
  finishedAt: row.finished_at || null,
});

const publicBot = (row) => Object.freeze({
  id: row.id,
  name: row.name,
  title: row.title || row.name,
  summary: row.summary || '',
  avatarUrl: row.avatar_object_id
    ? `/api/bots/${row.id}/avatar?v=${encodeURIComponent(row.updated_at)}`
    : null,
  avatarFallback: row.avatar_fallback || null,
  lifecycle: row.lifecycle,
  tenancy: row.tenancy,
  activeRevisionId: row.active_revision_id || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  retiredAt: row.retired_at || null,
});

const publicRevision = (row) => Object.freeze({
  id: row.id,
  botId: row.bot_id,
  revisionNumber: Number(row.revision_number),
  compiledHash: row.compiled_hash,
  createdAt: row.created_at,
  activatedAt: row.activated_at || null,
  retiredAt: row.retired_at || null,
});

const publicMembership = (row) => Object.freeze({
  botId: row.bot_id,
  userId: row.user_id,
  role: row.role,
  activatedAt: row.activated_at,
  revokedAt: row.revoked_at || null,
  updatedAt: row.updated_at,
});

export const publicBotChannelPreview = (message) => Object.freeze({
  channelId: message.channelId,
  messageId: message.id,
  role: message.role,
  sequence: message.sequence,
  text: message.body.text.replace(/\s+/gu, ' ').trim().slice(0, 512),
  attachmentCount: message.attachmentCount,
  createdAt: message.createdAt,
  finalizedAt: message.finalizedAt,
});

export const messageAssociatedData = (channelId, messageId) => (
  `devryan:bot-message:${validateUuid(channelId, 'channelId')}:${validateUuid(messageId, 'messageId')}`
);

export const memoryAssociatedData = (memoryId) => (
  `devryan:bot-memory:${validateUuid(memoryId, 'memoryId')}`
);

export const channelSummaryAssociatedData = (channelId, checkpointNumber) => (
  `devryan:bot-channel-summary:${validateUuid(channelId, 'channelId')}:${Number(checkpointNumber)}`
);

export function createBotChannels({
  store,
  authorization,
  encryption,
  uuid = randomUUID,
  now = () => new Date(),
} = {}) {
  if (!store || typeof store.get !== 'function'
    || !store.repositories?.bot_channels || !store.repositories?.bot_messages
    || !authorization || typeof authorization.requireActiveMembership !== 'function'
    || typeof authorization.requireChannelRead !== 'function'
    || typeof authorization.requireChannelSend !== 'function'
    || typeof uuid !== 'function' || typeof now !== 'function') {
    throw new TypeError('Bot channels are misconfigured');
  }

  const withKey = async (operation) => {
    let provided = null;
    let key = null;
    try {
      if (typeof encryption?.getKey !== 'function') {
        fail('Bot encryption key is unavailable', 'bot_os_encryption_unavailable', 503);
      }
      provided = await encryption.getKey();
      key = Buffer.from(provided || []);
      if (key.byteLength !== 32) {
        fail('Bot encryption key is unavailable', 'bot_os_encryption_unavailable', 503);
      }
      return await operation(key);
    } finally {
      key?.fill(0);
      if (Buffer.isBuffer(provided) || provided instanceof Uint8Array) provided.fill(0);
    }
  };

  const getChannel = async (channelId) => {
    const id = validateUuid(channelId, 'channelId');
    const row = await store.get('bot_channels', { id });
    if (!row || row.archived_at !== null || row.lifecycle !== 'active') {
      fail('Bot channel not found', 'bot_channel_not_found', 404);
    }
    return row;
  };

  const decryptMessage = (row, key) => {
    const body = decryptBotJson({
      key,
      envelope: row.body_envelope,
      expectedKeyId: DEPLOYMENT_KEY_ID,
      associatedData: messageAssociatedData(row.channel_id, row.id),
    });
    if (!body || body.version !== 1 || typeof body.text !== 'string'
      || !Array.isArray(body.attachmentIds)) {
      fail('Bot message envelope is invalid', 'bot_message_envelope_invalid', 500);
    }
    const text = row.role === 'assistant'
      ? sanitizeBotConversationalText(body.text)
      : body.text;
    return Object.freeze({
      id: row.id,
      channelId: row.channel_id,
      runId: row.run_id || null,
      actorUserId: row.actor_user_id || null,
      role: row.role,
      assistantPhase: row.assistant_phase || null,
      sequence: Number(row.sequence),
      body: Object.freeze({
        text,
        attachmentIds: Object.freeze([...body.attachmentIds]),
      }),
      attachmentCount: Number(row.attachment_count || 0),
      createdAt: row.created_at,
      finalizedAt: row.finalized_at || null,
    });
  };

  const encryptMessage = (key, { channelId, messageId, text, attachmentIds }) => encryptBotJson({
    key,
    keyId: DEPLOYMENT_KEY_ID,
    value: { version: 1, text, attachmentIds },
    associatedData: messageAssociatedData(channelId, messageId),
  });

  const preflightMessage = async ({ principal, channelId }) => {
    const normalizedChannelId = validateUuid(channelId, 'channelId');
    let decision;
    let revision = null;
    if (typeof store.loadBotSendContext === 'function'
      && typeof authorization.requireChannelSendContext === 'function') {
      const context = await store.loadBotSendContext({
        channelId: normalizedChannelId,
        userId: validateUuid(principal?.id, 'principal.id'),
      });
      decision = await authorization.requireChannelSendContext(
        principal,
        context,
        normalizedChannelId,
      );
      revision = context?.revision || null;
    } else {
      const channel = await getChannel(normalizedChannelId);
      decision = await authorization.requireChannelSend(
        principal,
        channel.bot_id,
        channel.id,
      );
    }
    const bot = decision.bot;
    if (decision.channel.lifecycle !== 'active' || decision.channel.archived_at !== null) {
      fail('Bot channel not found', 'bot_channel_not_found', 404);
    }
    if (bot.lifecycle === 'paused') fail('Bot is paused', 'bot_paused', 409);
    if (bot.lifecycle === 'retired') fail('Bot is retired', 'bot_retired', 410);
    if (bot.lifecycle !== 'active' || !bot.active_revision_id) {
      fail('Bot has no active revision', 'bot_not_active', 409);
    }
    if (revision && (revision.id !== bot.active_revision_id
      || revision.bot_id !== bot.id
      || revision.activated_at === null
      || revision.retired_at !== null)) {
      fail('Bot active revision is invalid', 'bot_revision_invalid', 409);
    }
    return Object.freeze({
      bot,
      channel: decision.channel,
      membership: decision.membership,
      acl: decision.acl,
      revision,
    });
  };

  const createAssistantCheckpoint = async ({
    run,
    messageId = uuid(),
    assistantPhase = 'pending',
  } = {}) => {
    const runId = validateUuid(run?.id, 'run.id');
    const channelId = validateUuid(run?.channel_id, 'run.channel_id');
    const normalizedMessageId = validateUuid(messageId, 'messageId');
    if (!ASSISTANT_PHASES.includes(assistantPhase)) {
      fail('Bot assistant checkpoint phase is invalid', 'bot_message_invalid', 500);
    }
    const sequencePayload = await store.allocateMessageSequence(channelId);
    const sequence = Number(
      typeof sequencePayload === 'number' ? sequencePayload : sequencePayload?.sequence,
    );
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      fail('Bot message sequence allocation failed', 'bot_message_sequence_invalid', 500);
    }
    const bodyEnvelope = await withKey(async (key) => encryptMessage(key, {
      channelId,
      messageId: normalizedMessageId,
      text: '',
      attachmentIds: [],
    }));
    return store.repositories.bot_messages.insert({
      id: normalizedMessageId,
      channel_id: channelId,
      run_id: runId,
      actor_user_id: null,
      role: 'assistant',
      assistant_phase: assistantPhase,
      sequence,
      body_envelope: bodyEnvelope,
      attachment_count: 0,
      finalized_at: null,
    });
  };

  const getAssistantCheckpoint = ({ run, assistantPhase }) => {
    const runId = validateUuid(run?.id, 'run.id');
    const channelId = validateUuid(run?.channel_id, 'run.channel_id');
    if (!ASSISTANT_PHASES.includes(assistantPhase)) {
      fail('Bot assistant checkpoint phase is invalid', 'bot_message_invalid', 500);
    }
    return store.repositories.bot_messages.get({
      run_id: runId,
      channel_id: channelId,
      role: 'assistant',
      assistant_phase: assistantPhase,
    });
  };

  const getOrCreateAssistantCheckpoint = async ({
    run,
    messageId = uuid(),
    assistantPhase = 'pending',
  } = {}) => {
    if (!ASSISTANT_PHASES.includes(assistantPhase)) {
      fail('Bot assistant checkpoint phase is invalid', 'bot_message_invalid', 500);
    }
    const find = () => getAssistantCheckpoint({ run, assistantPhase });
    let message = await find();
    if (message) return message;
    // Tool publications attach to the admitted response while it is pending.
    // Only final-answer reconciliation promotes that row to result, so a file
    // cannot create a competing result bubble or finalize unverified prose.
    if (assistantPhase === 'result') {
      const pending = await getAssistantCheckpoint({ run, assistantPhase: 'pending' });
      if (pending) return pending;
    }
    try {
      return await createAssistantCheckpoint({ run, messageId, assistantPhase });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      message = await find();
      if (!message) throw error;
      return message;
    }
  };

  return Object.freeze({
    async getOrCreateOwnerChannel({ principal, botId } = {}) {
      const normalizedBotId = validateUuid(botId, 'botId');
      const { bot, membership } = await authorization.requireActiveMembership(principal, normalizedBotId);
      const ownerUserId = validateUuid(principal?.id, 'principal.id');
      const find = () => store.repositories.bot_channels.get({
        bot_id: bot.id,
        owner_user_id: ownerUserId,
        lifecycle: 'active',
      });
      let row = await find();
      if (!row) {
        try {
          row = await store.repositories.bot_channels.insert({
            id: validateUuid(uuid(), 'channel.id'),
            bot_id: bot.id,
            owner_user_id: ownerUserId,
            lifecycle: 'active',
          });
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          row = await find();
          if (!row) throw error;
        }
      }
      return Object.freeze({ ...publicChannel(row, 'owner'), membershipRole: membership.role });
    },

    getChannel,
    preflightMessage,

    async authorizeChannelRead({ principal, channelId, breakGlassReason = null } = {}) {
      const channel = await getChannel(channelId);
      return authorization.requireChannelRead(
        principal,
        channel.bot_id,
        channel.id,
        breakGlassReason,
      );
    },

    async authorizeChannelSend({ principal, channelId } = {}) {
      return preflightMessage({ principal, channelId });
    },

    async listMessages({
      principal,
      channelId,
      cursor = null,
      limit,
      breakGlassReason = null,
    } = {}) {
      const channel = await getChannel(channelId);
      await authorization.requireChannelRead(
        principal,
        channel.bot_id,
        channel.id,
        breakGlassReason,
      );
      const page = await store.repositories.bot_messages.list({
        filters: { channel_id: channel.id },
        cursor,
        limit: normalizePageLimit(limit),
      });
      const messages = await withKey(async (key) => (
        page.items.map((row) => decryptMessage(row, key)).reverse()
      ));
      return Object.freeze({ messages: Object.freeze(messages), nextCursor: page.nextCursor || null });
    },

    async loadRecentMessages({
      channelId,
      limit = 80,
      excludeMessageId = null,
      throughSequence = null,
    } = {}) {
      const normalizedChannelId = validateUuid(channelId, 'channelId');
      const pageLimit = normalizePageLimit(limit, 80, 100);
      const rows = throughSequence === null
        ? (await store.repositories.bot_messages.list({
            filters: { channel_id: normalizedChannelId },
            limit: pageLimit,
          })).items
        : await store.listChannelMessagesThrough({
            channelId: normalizedChannelId,
            throughSequence,
            limit: pageLimit,
          });
      const excluded = excludeMessageId ? validateUuid(excludeMessageId, 'excludeMessageId') : null;
      return withKey(async (key) => rows
        .filter((row) => row.id !== excluded)
        .map((row) => decryptMessage(row, key))
        .reverse());
    },

    async loadRunUserMessage({ runId, channelId } = {}) {
      const normalizedRunId = validateUuid(runId, 'runId');
      const normalizedChannelId = validateUuid(channelId, 'channelId');
      const row = await store.repositories.bot_messages.get({
        run_id: normalizedRunId,
        channel_id: normalizedChannelId,
        role: 'user',
      });
      if (!row) fail('Bot run user message is missing', 'bot_message_not_found', 409);
      return withKey(async (key) => decryptMessage(row, key));
    },

    async loadRunAssistantResult({ runId, channelId } = {}) {
      const normalizedRunId = validateUuid(runId, 'runId');
      const normalizedChannelId = validateUuid(channelId, 'channelId');
      const row = await store.repositories.bot_messages.get({
        run_id: normalizedRunId,
        channel_id: normalizedChannelId,
        role: 'assistant',
        assistant_phase: 'result',
      });
      if (!row || row.finalized_at === null) {
        fail('Bot run assistant result is missing', 'bot_message_not_found', 409);
      }
      return withKey(async (key) => decryptMessage(row, key));
    },

    async decryptMemory(memory) {
      if (!memory?.id || !memory.encrypted_content) {
        fail('Bot memory is invalid', 'bot_memory_invalid', 500);
      }
      return withKey(async (key) => decryptBotJson({
        key,
        envelope: memory.encrypted_content,
        expectedKeyId: DEPLOYMENT_KEY_ID,
        associatedData: memoryAssociatedData(memory.id),
      }));
    },

    async decryptSummary(channel) {
      if (!channel?.summary_envelope) return null;
      return withKey(async (key) => decryptBotJson({
        key,
        envelope: channel.summary_envelope,
        expectedKeyId: DEPLOYMENT_KEY_ID,
        associatedData: channelSummaryAssociatedData(
          channel.id,
          channel.current_checkpoint_number,
        ),
      }));
    },

    async enqueueUserMessage(input = {}) {
      assertExactObject(input, {
        label: 'Bot user message admission',
        required: [
          'principal', 'preflight', 'messageId', 'acknowledgmentId', 'runId', 'revisionId', 'idempotencyKey',
          'text', 'attachmentIds', 'computerScopeKey', 'modelSnapshot', 'contextSnapshot',
        ],
      });
      const channelId = validateUuid(input.preflight?.channel?.id, 'channelId');
      const botId = validateUuid(input.preflight?.bot?.id, 'botId');
      if (input.preflight.channel.bot_id !== botId) {
        fail('Bot channel preflight is invalid', 'bot_channel_invalid', 500);
      }
      const messageId = validateUuid(input.messageId, 'messageId');
      const acknowledgmentId = validateUuid(input.acknowledgmentId, 'acknowledgmentId');
      const runId = validateUuid(input.runId, 'runId');
      const revisionId = validateUuid(input.revisionId, 'revisionId');
      const actorUserId = validateUuid(input.principal?.id, 'principal.id');
      const attachmentIds = normalizeAttachmentIds(input.attachmentIds);
      const text = normalizeText(input.text, { allowEmpty: attachmentIds.length > 0 });
      const attachmentObjects = await Promise.all(attachmentIds.map(async (attachmentId) => {
        const object = await store.repositories.bot_objects?.get?.({ id: attachmentId });
        if (!object || object.bot_id !== botId || object.channel_id !== channelId
          || object.visibility !== 'private' || object.deleted_at !== null) {
          fail('Bot message attachment is unavailable', 'bot_object_not_found', 404);
        }
        if (object.expires_at && Date.parse(object.expires_at) <= now().getTime()) {
          fail('Bot message attachment has expired; reattach the file', 'bot_object_expired', 410);
        }
        return object;
      }));
      const sharedFiles = createBotSharedFileAdmissions({
        channelId,
        messageId,
        objects: attachmentObjects,
        uuid,
      });
      const idempotencyKey = validateBoundedString(
        input.idempotencyKey,
        'idempotencyKey',
        { maximum: 512 },
      );
      const computerScopeKey = validateBoundedString(
        input.computerScopeKey,
        'computerScopeKey',
        { maximum: 512 },
      );
      const bodyEnvelope = await withKey(async (key) => encryptMessage(key, {
        channelId,
        messageId,
        text,
        attachmentIds,
      }));
      const acknowledgmentBodyEnvelope = await withKey(async (key) => encryptMessage(key, {
        channelId,
        messageId: acknowledgmentId,
        text: '',
        attachmentIds: [],
      }));
      const admittedAt = now().toISOString();
      const admitted = await store.enqueueMessageRun({
        messageId,
        acknowledgmentId,
        runId,
        botId,
        channelId,
        revisionId,
        idempotencyKey,
        modelSnapshot: structuredClone(input.modelSnapshot),
        contextSnapshot: structuredClone(input.contextSnapshot),
        computerScopeKey,
        actorUserId,
        bodyEnvelope,
        acknowledgmentBodyEnvelope,
        attachmentCount: attachmentIds.length,
        finalizedAt: admittedAt,
        sharedFiles,
      });
      if (!admitted?.message || !admitted?.run || !admitted?.acknowledgment) {
        fail('Bot message admission did not return its complete transcript', 'bot_repository_invalid', 500);
      }
      const message = admitted.message
        ? (admitted.created === true ? Object.freeze({
            id: admitted.message.id,
            channelId: admitted.message.channel_id,
            runId: admitted.message.run_id,
            actorUserId: admitted.message.actor_user_id,
            role: admitted.message.role,
            assistantPhase: admitted.message.assistant_phase || null,
            sequence: Number(admitted.message.sequence),
            body: Object.freeze({ text, attachmentIds: Object.freeze([...attachmentIds]) }),
            attachmentCount: Number(admitted.message.attachment_count || 0),
            createdAt: admitted.message.created_at,
            finalizedAt: admitted.message.finalized_at,
          }) : await withKey(async (key) => decryptMessage(admitted.message, key)))
        : null;
      const acknowledgment = admitted.acknowledgment
        ? (admitted.created === true ? Object.freeze({
            id: admitted.acknowledgment.id,
            channelId: admitted.acknowledgment.channel_id,
            runId: admitted.acknowledgment.run_id,
            actorUserId: null,
            role: 'assistant',
            assistantPhase: admitted.acknowledgment.assistant_phase || null,
            sequence: Number(admitted.acknowledgment.sequence),
            body: Object.freeze({ text: '', attachmentIds: Object.freeze([]) }),
            attachmentCount: 0,
            createdAt: admitted.acknowledgment.created_at,
            finalizedAt: admitted.acknowledgment.finalized_at || null,
          }) : await withKey(async (key) => decryptMessage(admitted.acknowledgment, key)))
        : null;
      return Object.freeze({
        created: admitted.created === true,
        message,
        acknowledgment,
        run: admitted.run ? publicRun(admitted.run) : null,
        rawRun: admitted.run || null,
      });
    },

    createAssistantCheckpoint,
    getAssistantCheckpoint,
    getOrCreateAssistantCheckpoint,

    async updateAssistantCheckpoint({
      message,
      text,
      finalizedAt = null,
      assistantPhase = null,
    } = {}) {
      if (!message || message.role !== 'assistant') {
        fail('Bot assistant checkpoint is invalid', 'bot_message_invalid', 500);
      }
      if (assistantPhase !== null
        && (!['acknowledgment', 'result'].includes(assistantPhase)
          || message.assistant_phase !== 'pending' || finalizedAt === null)) {
        fail('Bot assistant checkpoint phase promotion is invalid', 'bot_message_invalid', 500);
      }
      const normalizedText = sanitizeBotConversationalText(
        typeof text === 'string' ? text : '',
      );
      const bodyEnvelope = await withKey(async (key) => encryptMessage(key, {
        channelId: message.channel_id,
        messageId: message.id,
        text: normalizedText,
        attachmentIds: [],
      }));
      const updated = await store.updateMessageCheckpoint({
        messageId: message.id,
        bodyEnvelope,
        finalizedAt,
        assistantPhase,
      });
      return Object.freeze({
        id: updated.id,
        channelId: updated.channel_id,
        runId: updated.run_id || null,
        actorUserId: updated.actor_user_id || null,
        role: updated.role,
        assistantPhase: updated.assistant_phase || null,
        sequence: Number(updated.sequence),
        body: Object.freeze({ text: normalizedText, attachmentIds: Object.freeze([]) }),
        attachmentCount: Number(updated.attachment_count || 0),
        createdAt: updated.created_at,
        finalizedAt: updated.finalized_at || null,
      });
    },

    async snapshotForPrincipal(principal) {
      if (!principal?.id) fail('Authentication required', 'bot_authentication_required', 401);
      const channels = new Map();
      const bots = new Map();
      const revisions = new Map();
      const memberships = [];
      const runs = new Map();
      const previewCandidates = [];
      const membershipPage = await store.repositories.bot_memberships?.list?.({
        filters: { user_id: principal.id, revoked_at: null },
        limit: 100,
      });
      for (const membership of membershipPage?.items || []) {
        if (membership.revoked_at !== null
          || (membership.activated_at && Date.parse(membership.activated_at) > now().getTime())) continue;
        const bot = await store.repositories.bots?.get?.({ id: membership.bot_id });
        if (!bot || !bot.active_revision_id) continue;
        try {
          await authorization.requireActiveMembership(principal, bot.id);
        } catch {
          continue;
        }
        bots.set(bot.id, bot);
        memberships.push(membership);
        const revisionPage = await store.repositories.bot_revisions?.list?.({
          filters: { bot_id: bot.id },
          limit: 100,
        });
        for (const revision of revisionPage?.items || []) revisions.set(revision.id, revision);
      }
      const own = await store.repositories.bot_channels.list({
        filters: { owner_user_id: principal.id, lifecycle: 'active' },
        limit: 100,
      });
      for (const row of own.items) {
        try {
          await authorization.requireChannelRead(principal, row.bot_id, row.id, null);
          channels.set(row.id, { row, accessRole: 'owner' });
        } catch {
        }
      }
      const grants = await store.repositories.bot_channel_acl?.list?.({
        filters: { user_id: principal.id, revoked_at: null },
        limit: 100,
      });
      for (const grant of grants?.items || []) {
        const row = await store.get('bot_channels', { id: grant.channel_id });
        if (!row || row.lifecycle !== 'active' || row.archived_at !== null) continue;
        try {
          await authorization.requireChannelRead(principal, row.bot_id, row.id, null);
          if (!channels.has(row.id)) channels.set(row.id, { row, accessRole: grant.role });
        } catch {
        }
      }
      for (const { row: channel } of channels.values()) {
        const [runPage, messagePage] = await Promise.all([
          store.repositories.bot_runs?.list?.({
            filters: { channel_id: channel.id },
            limit: 100,
          }),
          store.repositories.bot_messages.list({
            filters: { channel_id: channel.id },
            limit: 8,
          }),
        ]);
        for (const run of runPage?.items || []) runs.set(run.id, run);
        previewCandidates.push(messagePage.items.filter((message) => (
          message.finalized_at !== null
          && (message.role === 'user' || message.role === 'assistant')
          && message.assistant_phase !== 'acknowledgment'
        )));
      }
      const channelPreviews = await withKey(async (key) => previewCandidates
        .map((rows) => rows
          .map((row) => decryptMessage(row, key))
          .find((message) => (
            message.body.text.trim().length > 0 || message.attachmentCount > 0
          )))
        .filter(Boolean)
        .map(publicBotChannelPreview)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)
          || right.sequence - left.sequence
          || left.messageId.localeCompare(right.messageId)));
      const accessibleRunIds = new Set(runs.keys());
      const recentActions = [];
      if (store.repositories.bot_action_attempts?.list) {
        for (const botRow of bots.values()) {
          const actionPage = await store.repositories.bot_action_attempts.list({
            filters: { bot_id: botRow.id },
            limit: 100,
          });
          for (const action of actionPage.items) {
            if (accessibleRunIds.has(action.run_id)) recentActions.push(action);
          }
        }
      }
      return Object.freeze({
        bots: Object.freeze([...bots.values()]
          .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
          .map(publicBot)),
        revisions: Object.freeze([...revisions.values()]
          .sort((left, right) => Number(left.revision_number) - Number(right.revision_number)
            || left.id.localeCompare(right.id))
          .map(publicRevision)),
        memberships: Object.freeze(memberships
          .sort((left, right) => left.bot_id.localeCompare(right.bot_id))
          .map(publicMembership)),
        channels: Object.freeze([...channels.values()]
          .sort((left, right) => left.row.created_at.localeCompare(right.row.created_at)
            || left.row.id.localeCompare(right.row.id))
          .map(({ row, accessRole }) => publicChannel(row, accessRole))),
        channelPreviews: Object.freeze(channelPreviews),
        runs: Object.freeze([...runs.values()]
          .sort((left, right) => Number(left.queue_sequence || 0) - Number(right.queue_sequence || 0)
            || left.id.localeCompare(right.id))
          .map(publicRun)),
        recentActions: Object.freeze(recentActions
          .sort((left, right) => right.created_at.localeCompare(left.created_at)
            || left.id.localeCompare(right.id))
          .map(publicBotActionAttempt)),
      });
    },

    async audienceForChannel(channelId) {
      if (typeof store.listChannelAudience === 'function') {
        return Object.freeze(await store.listChannelAudience(channelId));
      }
      const channel = await getChannel(channelId);
      const audience = new Set();
      const ownerMembership = await store.get('bot_memberships', {
        bot_id: channel.bot_id,
        user_id: channel.owner_user_id,
      });
      if (ownerMembership?.revoked_at === null
        && (!ownerMembership.activated_at
          || Date.parse(ownerMembership.activated_at) <= now().getTime())) {
        audience.add(channel.owner_user_id);
      }
      const grants = await store.repositories.bot_channel_acl?.list?.({
        filters: { channel_id: channel.id, revoked_at: null },
        limit: 100,
      });
      for (const grant of grants?.items || []) {
        const membership = await store.get('bot_memberships', {
          bot_id: channel.bot_id,
          user_id: grant.user_id,
        });
        if (membership && membership.revoked_at === null) audience.add(grant.user_id);
      }
      return Object.freeze([...audience]);
    },

    publicChannel,
    publicChannelPreview: publicBotChannelPreview,
    publicRun,
  });
}
