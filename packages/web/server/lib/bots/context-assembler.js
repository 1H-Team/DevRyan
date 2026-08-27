import { canonicalizeBotJson } from '@openchamber/bots-runtime';

import { genericExecutionFromLegacyRun } from './reasoning-adapter.js';
import { validateUuid } from './validation.js';

const MAX_CONTEXT_BYTES = 768 * 1024;
const MAX_RECENT_MESSAGES = 80;
const MAX_MEMORIES_PER_SCOPE = 50;
const CONTEXT_RATIO_LIMIT = 0.6;
const CONTINUATION_TURN_LIMIT = 40;

export const BOT_CONVERSATIONAL_RESPONSE_INSTRUCTION = [
  '<devryan_bot_response_style>',
  'Reply as a natural conversation, not as an agent work log.',
  'If the request requires a tool or external action, call it without first sending an acknowledgment or preamble.',
  'Do not narrate progress between tools. After all tool work is finished, send one useful, natural response focused on the user\'s result.',
  'Keep internal execution language private. Do not mention planning, workspaces, artifacts, tools, schemas, commands, capabilities, or other implementation details unless the user explicitly asks about them or a user-relevant limitation requires a plain-language explanation.',
  'For requests that need no tool, lead directly with the useful answer. Do not use progress or status headings such as “Checking”, “Confirming”, or “Analyzing”.',
  'If a limitation or action failure matters to the user, explain it honestly in plain conversational language.',
  'Keep the Bot\'s configured personality. Use headings or lists only when the user asks for them or when they materially clarify a complex answer.',
  '</devryan_bot_response_style>',
].join('\n');

export const BOT_COMPUTER_CONNECTOR_INSTRUCTION = [
  '<devryan_bot_computer>',
  'This Active Bot has a persistent browser connector through the devryan_bot tool. Do not claim that a browser connector is missing.',
  'For browser work call devryan_bot with operation "computer.command" and payload { idempotencyKey, command, args, target, limits }. Use a unique, stable idempotencyKey for each intended action.',
  'Start with navigate or snapshot, then use returned element refs for interactions. Browser interactions require target { origin, goal }; read-only commands may use an empty target.',
  '</devryan_bot_computer>',
].join('\n');

export class BotContextError extends Error {
  constructor(message, code = 'bot_context_invalid', statusCode = 500) {
    super(message);
    this.name = 'BotContextError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotContextError(message, code, statusCode);
};

const numericSnapshotValue = (snapshot, key, fallback = 0) => {
  const value = Number(snapshot?.[key]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export const decideBotContinuation = ({ revisionId, previousRun } = {}) => {
  const normalizedRevisionId = validateUuid(revisionId, 'revisionId');
  if (!previousRun) {
    return Object.freeze({ create: true, reason: 'first_run', completedUserTurns: 0 });
  }
  if (previousRun.state !== 'completed') {
    const reason = ['failed', 'cancelled', 'interrupted'].includes(previousRun.state)
      ? `previous_run_${previousRun.state}`
      : 'previous_run_incomplete';
    return Object.freeze({ create: true, reason, completedUserTurns: 0 });
  }
  if (previousRun.revision_id !== normalizedRevisionId) {
    return Object.freeze({ create: true, reason: 'revision_changed', completedUserTurns: 0 });
  }
  const providerContextRatio = numericSnapshotValue(
    previousRun.context_snapshot,
    'providerContextRatio',
  );
  const completedUserTurns = Math.trunc(numericSnapshotValue(
    previousRun.context_snapshot,
    'completedUserTurns',
  ));
  if (providerContextRatio >= CONTEXT_RATIO_LIMIT) {
    return Object.freeze({ create: true, reason: 'context_threshold', completedUserTurns: 0 });
  }
  if (completedUserTurns >= CONTINUATION_TURN_LIMIT) {
    return Object.freeze({ create: true, reason: 'turn_limit', completedUserTurns: 0 });
  }
  const execution = genericExecutionFromLegacyRun(previousRun);
  if (!execution.adapter || !execution.threadId) {
    return Object.freeze({ create: true, reason: 'execution_missing', completedUserTurns: 0 });
  }
  return Object.freeze({
    create: false,
    reason: 'continue',
    adapter: execution.adapter,
    execution: Object.freeze({
      threadId: execution.threadId,
      ...execution.execution,
    }),
    completedUserTurns,
  });
};

// Compatibility export for callers that only depend on the decision shape.
export const decideBotSegment = decideBotContinuation;

const safeText = (value, maximumBytes = 128 * 1024) => {
  const text = typeof value === 'string' ? value : '';
  if (Buffer.byteLength(text, 'utf8') <= maximumBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), 'utf8') <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
};

const memoryText = (value) => {
  if (typeof value === 'string') return value;
  if (typeof value?.text === 'string') return value.text;
  return canonicalizeBotJson(value);
};

const fitContext = (context) => {
  const fitted = structuredClone(context);
  const encodedBytes = () => Buffer.byteLength(canonicalizeBotJson(fitted), 'utf8');
  while (encodedBytes() > MAX_CONTEXT_BYTES) {
    if (fitted.library.length > 0) fitted.library.pop();
    else if (fitted.messages.length > 0) fitted.messages.shift();
    else if (fitted.memories.length > 0) fitted.memories.pop();
    else if (fitted.checkpoint) fitted.checkpoint = null;
    else fail('Bot context exceeds the runtime bound', 'bot_context_too_large', 413);
  }
  return fitted;
};

export function createBotContextAssembler({
  store,
  channels,
  retrieval = Object.freeze({ search: async () => [] }),
  capabilities = Object.freeze({ runtimeCatalog: async () => ({ mcpServers: [] }) }),
} = {}) {
  if (!store?.repositories?.bot_runs || typeof store.getPreviousChannelRun !== 'function'
    || !store.repositories?.bot_memories
    || !channels || typeof channels.loadRecentMessages !== 'function'
    || typeof channels.decryptMemory !== 'function'
    || typeof retrieval?.search !== 'function'
    || typeof capabilities?.runtimeCatalog !== 'function') {
    throw new TypeError('Bot context assembler is misconfigured');
  }

  // A Bot has one memory, shared by every member, so this is a single read.
  const listMemories = async ({ botId }) => {
    const page = await store.repositories.bot_memories.list({
      filters: { bot_id: botId, tombstoned_at: null },
      limit: MAX_MEMORIES_PER_SCOPE,
    });
    return Promise.all(page.items.map(async (row) => ({
      id: row.id,
      logicalKey: row.logical_key,
      text: safeText(memoryText(await channels.decryptMemory(row)), 64 * 1024),
    })));
  };

  return Object.freeze({
    async assemble({
      run,
      bot,
      channel,
      revision,
      queryText,
      currentMessageId = null,
      currentMessageSequence = null,
    } = {}) {
      const botId = validateUuid(bot?.id, 'bot.id');
      const channelId = validateUuid(channel?.id, 'channel.id');
      const revisionId = validateUuid(revision?.id, 'revision.id');
      if (run?.channel_id !== channelId) fail('Bot run channel does not match context');
      const previousRun = await store.getPreviousChannelRun({
        channelId,
        beforeQueueSequence: run?.queue_sequence,
      });
      const continuation = decideBotContinuation({ revisionId, previousRun });
      const [recentMessages, checkpoint, memories, capabilityCatalog] = await Promise.all([
        channels.loadRecentMessages({
          channelId,
          limit: MAX_RECENT_MESSAGES,
          excludeMessageId: currentMessageId,
          throughSequence: currentMessageSequence,
        }),
        channel.summary !== undefined
          ? channel.summary
          : channels.decryptSummary?.(channel),
        listMemories({ botId }),
        capabilities.runtimeCatalog({ revisionId }),
      ]);
      const libraryVersionIds = Array.isArray(run.context_snapshot?.libraryVersionIds)
        ? [...run.context_snapshot.libraryVersionIds]
        : Array.isArray(revision.contract?.libraryVersionIds)
          ? [...revision.contract.libraryVersionIds]
          : [];
      const library = await retrieval.search({
        botId,
        channelId,
        ownerUserId: channel.owner_user_id,
        libraryVersionIds,
        query: safeText(queryText, 64 * 1024),
        limit: 24,
      });
      const context = fitContext({
        version: 1,
        checkpoint: checkpoint || null,
        messages: recentMessages.map((message) => ({
          id: message.id,
          role: message.role,
          sequence: message.sequence,
          text: safeText(message.body?.text, 128 * 1024),
        })),
        memories,
        capabilities: capabilityCatalog,
        library: (Array.isArray(library) ? library : []).slice(0, 24).map((chunk) => ({
          sourceId: typeof chunk?.sourceId === 'string' ? chunk.sourceId : null,
          libraryVersionId: typeof chunk?.libraryVersionId === 'string'
            ? chunk.libraryVersionId
            : null,
          text: safeText(chunk?.text, 128 * 1024),
        })),
      });
      const contextSnapshot = Object.freeze({
        version: 1,
        revisionId,
        checkpointNumber: Number(channel.current_checkpoint_number || 0),
        latestMessageSequence: currentMessageSequence || recentMessages.at(-1)?.sequence || 0,
        memoryIds: Object.freeze(memories.map((memory) => memory.id)),
        libraryVersionIds: Object.freeze(libraryVersionIds),
        completedUserTurns: continuation.completedUserTurns,
        providerContextRatio: 0,
        continuationReason: continuation.reason,
      });
      return Object.freeze({
        continuation,
        contextSnapshot,
        parts: Object.freeze([
          Object.freeze({
            type: 'text',
            text: `<devryan_bot_context>${canonicalizeBotJson(context)}</devryan_bot_context>`,
          }),
          Object.freeze({
            type: 'text',
            synthetic: true,
            text: BOT_CONVERSATIONAL_RESPONSE_INSTRUCTION,
          }),
          Object.freeze({
            type: 'text',
            synthetic: true,
            text: BOT_COMPUTER_CONNECTOR_INSTRUCTION,
          }),
          Object.freeze({ type: 'text', text: safeText(queryText, MAX_CONTEXT_BYTES) }),
        ]),
      });
    },
  });
}

export const BOT_SEGMENT_CONTEXT_RATIO = CONTEXT_RATIO_LIMIT;
export const BOT_SEGMENT_TURN_LIMIT = CONTINUATION_TURN_LIMIT;
export const BOT_CONTINUATION_CONTEXT_RATIO = CONTEXT_RATIO_LIMIT;
export const BOT_CONTINUATION_TURN_LIMIT = CONTINUATION_TURN_LIMIT;
