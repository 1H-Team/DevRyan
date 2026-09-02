import { canonicalizeBotJson } from '@openchamber/bots-runtime';

import { botQuestionContextText } from './bot-question.js';
import { genericExecutionFromLegacyRun } from './reasoning-adapter.js';
import { validateUuid } from './validation.js';

const MAX_CONTEXT_BYTES = 768 * 1024;
const MAX_RECENT_MESSAGES = 80;
const MAX_MEMORIES_PER_SCOPE = 50;
const MAX_MEMORY_CANDIDATE_ROWS = 100;
const MAX_MEMORY_CONTEXT_BYTES = 96 * 1024;
const MAX_MEMORY_QUERY_BYTES = 8 * 1024;
const MEMORY_QUERY_USER_TURNS = 2;
const DEFAULT_MEMORY_RETRIEVAL_LIMIT = 12;
const MAX_MEMORY_RETRIEVAL_LIMIT = 50;
const MAX_PINNED_MEMORIES = 8;
const CONTEXT_RATIO_LIMIT = 0.6;
const CONTINUATION_TURN_LIMIT = 40;

// Durable facts about the people in the conversation are always in context;
// everything else competes on relevance to the current request, then recency.
export const PINNED_MEMORY_KEY_PREFIXES = Object.freeze([
  'user.', 'owner.', 'preference.', 'identity.', 'profile.',
]);

// The register guide. It applies to every Bot on every turn without a
// republish: the Soul says who the Bot is, this says how a person texts.
export const BOT_CONVERSATIONAL_RESPONSE_INSTRUCTION = [
  '<devryan_bot_response_style>',
  'Talk like a person in a chat thread, not like an assistant filling out a form. This is a natural conversation, not an agent work log.',
  'Match the user\'s length and energy: a short message gets a short reply, one thought per message, contractions are fine.',
  'Keep the Bot\'s configured personality in every line. No “Certainly”, no “Great question”, no restating the request, no closing offers like “let me know if you need anything else”.',
  'If a request needs no tool, reply directly with the useful answer.',
  'If it needs a tool or external action, first write exactly one short line in your own voice that fits this request (like “on it, give me a sec” or “let me check the calendar”), then call the tool. The interface shows that you are working after that line.',
  'Do not narrate progress between tools. Do not use progress or status headings such as “Acknowledging”, “Checking”, “Confirming”, or “Analyzing”. After all tool work is finished, send one useful, natural response focused on the user\'s result.',
  'Keep internal execution language private. Do not mention planning, workspaces, artifacts, tools, schemas, commands, capabilities, or other implementation details unless the user explicitly asks about them or a user-relevant limitation requires a plain-language explanation.',
  'If something failed or you do not know, say so plainly and explain it honestly in plain conversational language. Apologize at most once.',
  'Use headings or lists only when the user asks for them or when they materially clarify a complex answer.',
  'The context carries turn.localTime, turn.timeZone, turn.member (the person you are talking to), and turn.sinceLastMessage. Use them naturally: greet by name sometimes, never every message, and never recite the timestamp.',
  'When a request is genuinely ambiguous and the answer would change what you do, ask one short question with the devryan_ask tool (two to four tappable options, one question at a time), then end your turn and wait. Never use it for trivia or to confirm something you can safely assume.',
  '</devryan_bot_response_style>',
].join('\n');

// The payload shape lives in the devryan_bot tool description; this is only
// the reminder that the connector exists.
export const BOT_COMPUTER_CONNECTOR_INSTRUCTION = [
  '<devryan_bot_computer>',
  'This Active Bot has a persistent browser connector through the devryan_bot tool (operation "computer.command"; the tool description carries the payload shape and the navigate/snapshot-first flow). Do not claim that a browser connector is missing.',
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

const describeGap = (milliseconds) => {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} ago`;
  const weeks = Math.round(days / 7);
  return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
};

// What a person knows without being told: the clock, who they are talking
// to, and how long it has been. Prompt-only; none of it enters the snapshot.
const turnContext = async ({ store, actorUserId, recentMessages, at }) => {
  let timeZone = 'UTC';
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    timeZone = 'UTC';
  }
  let localTime;
  try {
    localTime = at.toLocaleString('en-US', {
      timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch {
    localTime = at.toISOString();
  }
  let member = null;
  if (actorUserId && typeof store.listUserProfiles === 'function') {
    try {
      const profiles = await store.listUserProfiles([actorUserId]);
      const row = profiles?.get?.(actorUserId);
      member = typeof row?.display_name === 'string' && row.display_name.trim()
        ? safeText(row.display_name.trim(), 256)
        : null;
    } catch {
      member = null;
    }
  }
  const lastAt = Date.parse(recentMessages.at(-1)?.createdAt || '');
  return Object.freeze({
    localTime,
    timeZone,
    member,
    sinceLastMessage: Number.isFinite(lastAt) ? describeGap(at.getTime() - lastAt) : null,
  });
};

const isPinnedMemoryKey = (logicalKey) => typeof logicalKey === 'string'
  && PINNED_MEMORY_KEY_PREFIXES.some((prefix) => logicalKey.startsWith(prefix));

const clampMemoryRetrievalLimit = (value) => {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return DEFAULT_MEMORY_RETRIEVAL_LIMIT;
  return Math.max(1, Math.min(MAX_MEMORY_RETRIEVAL_LIMIT, parsed));
};

// The retrieval query is the current request plus the last user turns, so a
// short follow-up ("and the other one?") still finds the facts it refers to.
const memoryQueryText = (queryText, recentMessages) => {
  const turns = recentMessages
    .filter((message) => message?.role === 'user' && typeof message.body?.text === 'string'
      && message.body.text.trim())
    .slice(-MEMORY_QUERY_USER_TURNS)
    .map((message) => message.body.text.trim());
  const current = typeof queryText === 'string' ? queryText.trim() : '';
  return safeText([current, ...turns].filter(Boolean).join('\n'), MAX_MEMORY_QUERY_BYTES);
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
  memoryRetrieval = null,
  memoryRetrievalLimit = DEFAULT_MEMORY_RETRIEVAL_LIMIT,
  capabilities = Object.freeze({ runtimeCatalog: async () => ({ mcpServers: [] }) }),
  now = () => new Date(),
} = {}) {
  if (!store?.repositories?.bot_runs || typeof store.getPreviousChannelRun !== 'function'
    || !store.repositories?.bot_memories
    || !channels || typeof channels.loadRecentMessages !== 'function'
    || typeof channels.decryptMemory !== 'function'
    || typeof retrieval?.search !== 'function'
    || (memoryRetrieval !== null && typeof memoryRetrieval?.search !== 'function')
    || typeof capabilities?.runtimeCatalog !== 'function') {
    throw new TypeError('Bot context assembler is misconfigured');
  }
  const retrievalLimit = clampMemoryRetrievalLimit(memoryRetrievalLimit);

  const memoryCache = new Map();
  let memoryCacheBytes = 0;
  const cachedMemory = async (row) => {
    // Still read current live rows each turn. Only expensive decryption is
    // reused, and only for an exact immutable version and optimistic timestamp.
    const key = row.active_version_id && row.updated_at
      ? `${row.bot_id}:${row.id}:${row.active_version_id}:${row.updated_at}`
      : null;
    const cached = key ? memoryCache.get(key) : null;
    if (cached) {
      memoryCache.delete(key);
      memoryCache.set(key, cached);
      return cached.text;
    }
    const text = safeText(memoryText(await channels.decryptMemory(row)), 64 * 1024);
    if (key) {
      const bytes = Buffer.byteLength(text, 'utf8');
      // Another concurrent channel may have decrypted this exact version.
      memoryCacheBytes -= memoryCache.get(key)?.bytes || 0;
      memoryCache.set(key, { text, bytes });
      memoryCacheBytes += bytes;
      while (memoryCache.size > 100 || memoryCacheBytes > 4 * 1024 * 1024) {
        const oldest = memoryCache.keys().next().value;
        memoryCacheBytes -= memoryCache.get(oldest).bytes;
        memoryCache.delete(oldest);
      }
    }
    return text;
  };

  const memoryEntry = async (row) => ({
    id: row.id,
    logicalKey: row.logical_key,
    text: await cachedMemory(row),
  });

  // Keep the selection order (pinned, relevant, recent) and drop from the end
  // once the memory block would exceed its byte budget.
  const boundedMemoryEntries = async (rows) => {
    const entries = await Promise.all(rows.map(memoryEntry));
    const kept = [];
    let bytes = 0;
    for (const entry of entries) {
      const entryBytes = Buffer.byteLength(entry.text, 'utf8');
      if (kept.length > 0 && bytes + entryBytes > MAX_MEMORY_CONTEXT_BYTES) break;
      kept.push(entry);
      bytes += entryBytes;
    }
    return kept;
  };

  const liveMemoryRow = (row) => Boolean(row) && typeof row === 'object' && !row.tombstoned_at;

  // A Bot has one memory, shared by every member. Without a retrieval index the
  // newest facts go in; with one, the people-facts are pinned and the rest of
  // the budget is filled by relevance to the request, then by recency, so a
  // small memory is fully present and a large one stays focused.
  const selectMemories = async ({ botId, queryText, recentMessages }) => {
    const page = await store.repositories.bot_memories.list({
      filters: { bot_id: botId, tombstoned_at: null },
      limit: memoryRetrieval ? MAX_MEMORY_CANDIDATE_ROWS : MAX_MEMORIES_PER_SCOPE,
    });
    const rows = page.items.filter(liveMemoryRow);
    const recentSelection = async () => ({
      memories: await boundedMemoryEntries(rows.slice(0, MAX_MEMORIES_PER_SCOPE)),
      retrieval: Object.freeze({
        mode: 'recent', pinned: 0, relevant: 0, recent: Math.min(rows.length, MAX_MEMORIES_PER_SCOPE),
        candidates: rows.length,
      }),
    });
    if (!memoryRetrieval) return recentSelection();

    const query = memoryQueryText(queryText, recentMessages);
    let hits = null;
    if (query.trim()) {
      try {
        const result = await memoryRetrieval.search({
          botId,
          query,
          limit: retrievalLimit + MAX_PINNED_MEMORIES,
        });
        hits = Array.isArray(result) ? result : null;
      } catch {
        hits = null;
      }
    }
    if (hits === null) return recentSelection();

    const byId = new Map(rows.map((row) => [row.id, row]));
    const pinned = rows.filter((row) => isPinnedMemoryKey(row.logical_key)).slice(0, MAX_PINNED_MEMORIES);
    const selectedIds = new Set(pinned.map((row) => row.id));
    const relevant = [];
    for (const hit of hits) {
      if (relevant.length >= retrievalLimit) break;
      const memoryId = typeof hit?.memoryId === 'string' ? hit.memoryId : null;
      if (!memoryId || selectedIds.has(memoryId)) continue;
      let row = byId.get(memoryId) || null;
      if (!row) {
        // A relevant fact older than the newest page is still worth reading.
        row = await store.repositories.bot_memories.get({ id: memoryId, bot_id: botId })
          .catch(() => null);
        if (!liveMemoryRow(row)) continue;
      }
      selectedIds.add(memoryId);
      relevant.push(row);
    }
    const recent = [];
    for (const row of rows) {
      if (relevant.length + recent.length >= retrievalLimit) break;
      if (selectedIds.has(row.id)) continue;
      selectedIds.add(row.id);
      recent.push(row);
    }
    const memories = await boundedMemoryEntries([...pinned, ...relevant, ...recent]);
    const keptIds = new Set(memories.map((memory) => memory.id));
    const count = (selection) => selection.filter((row) => keptIds.has(row.id)).length;
    return {
      memories,
      retrieval: Object.freeze({
        mode: 'relevance',
        pinned: count(pinned),
        relevant: count(relevant),
        recent: count(recent),
        candidates: rows.length,
      }),
    };
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
      actorUserId = null,
    } = {}) {
      const botId = validateUuid(bot?.id, 'bot.id');
      const channelId = validateUuid(channel?.id, 'channel.id');
      const revisionId = validateUuid(revision?.id, 'revision.id');
      if (run?.channel_id !== channelId) fail('Bot run channel does not match context');
      const previousRunPromise = store.getPreviousChannelRun({
        channelId,
        beforeQueueSequence: run?.queue_sequence,
      });
      const recentMessagesPromise = channels.loadRecentMessages({
        channelId,
        limit: MAX_RECENT_MESSAGES,
        excludeMessageId: currentMessageId,
        throughSequence: currentMessageSequence,
      });
      const [recentMessages, checkpoint, memorySelection, capabilityCatalog, previousRun, turn] = await Promise.all([
        recentMessagesPromise,
        channel.summary !== undefined
          ? channel.summary
          : channels.decryptSummary?.(channel),
        recentMessagesPromise.then((messages) => selectMemories({
          botId,
          queryText,
          recentMessages: Array.isArray(messages) ? messages : [],
        })),
        capabilities.runtimeCatalog({ revisionId }),
        previousRunPromise,
        recentMessagesPromise.then((messages) => turnContext({
          store,
          actorUserId,
          recentMessages: Array.isArray(messages) ? messages : [],
          at: now(),
        })),
      ]);
      const memories = memorySelection.memories;
      const continuation = decideBotContinuation({ revisionId, previousRun });
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
        turn,
        checkpoint: checkpoint || null,
        messages: recentMessages.filter((message) => (
          message.assistantPhase !== 'acknowledgment'
        )).map((message) => ({
          id: message.id,
          role: message.role,
          sequence: message.sequence,
          text: safeText(message.body?.question
            ? [message.body.text, botQuestionContextText(message.body.question)].filter(Boolean).join('\n')
            : message.body?.text, 128 * 1024),
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
        memoryRetrieval: memorySelection.retrieval,
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
