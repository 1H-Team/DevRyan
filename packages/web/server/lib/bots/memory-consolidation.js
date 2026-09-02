import { botErrorLogFields } from './error-normalization.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_GROUPS = 10;

export class BotMemoryConsolidationError extends Error {
  constructor(message, code = 'bot_memory_consolidation_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotMemoryConsolidationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotMemoryConsolidationError(message, code, statusCode);
};

const normalizedText = (value) => (typeof value === 'string' ? value : '')
  .normalize('NFKC')
  .toLocaleLowerCase('en-US')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

const timestamp = (value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const preferredTarget = (rows) => [...rows].sort((left, right) => {
  const managerDifference = Number(right.activeCreatorKind === 'manager')
    - Number(left.activeCreatorKind === 'manager');
  if (managerDifference !== 0) return managerDifference;
  return timestamp(right.updatedAt) - timestamp(left.updatedAt) || left.id.localeCompare(right.id);
})[0];

export function planBotMemoryConsolidation(memories, { limit = DEFAULT_MAX_GROUPS } = {}) {
  if (!Array.isArray(memories) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    fail('Bot memory consolidation input is invalid');
  }
  const groups = new Map();
  for (const memory of memories) {
    if (!memory || typeof memory !== 'object' || typeof memory.id !== 'string'
      || typeof memory.scope !== 'string' || typeof memory.updatedAt !== 'string'
      || typeof memory.content?.text !== 'string' || memory.tombstonedAt) continue;
    const contentKey = normalizedText(memory.content.text);
    if (!contentKey) continue;
    const key = [memory.scope, memory.subjectUserId || '', contentKey].join('\0');
    const rows = groups.get(key) || [];
    rows.push(memory);
    groups.set(key, rows);
  }
  const plans = [];
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const target = preferredTarget(rows);
    plans.push(Object.freeze({
      targetId: target.id,
      sourceIds: Object.freeze(rows.filter((row) => row.id !== target.id)
        .map((row) => row.id).sort()),
      expectedUpdatedAt: target.updatedAt,
      content: Object.freeze({ text: target.content.text }),
      sensitivity: target.sensitivity,
      confidence: Math.max(...rows.map((row) => Number(row.confidence) || 0)),
    }));
  }
  return Object.freeze(plans
    .sort((left, right) => left.targetId.localeCompare(right.targetId))
    .slice(0, limit));
}

export function createBotMemoryConsolidation({
  loadMemories,
  mergeMemories,
  intervalMs = DEFAULT_INTERVAL_MS,
  maxGroups = DEFAULT_MAX_GROUPS,
  logger = console,
} = {}) {
  if (typeof loadMemories !== 'function' || typeof mergeMemories !== 'function'
    || !Number.isFinite(intervalMs) || intervalMs < 1_000
    || !Number.isInteger(maxGroups) || maxGroups < 1 || maxGroups > 100) {
    fail('Bot memory consolidation is misconfigured', 'bot_memory_consolidation_unavailable', 500);
  }
  let timer = null;
  let running = null;
  let stopped = false;

  const sweep = () => {
    if (stopped) return Promise.resolve(Object.freeze({ planned: 0, merged: 0, conflicts: 0 }));
    if (running) return running;
    running = (async () => {
      const memories = await loadMemories();
      const plans = planBotMemoryConsolidation(memories, { limit: maxGroups });
      let merged = 0;
      let conflicts = 0;
      for (const plan of plans) {
        try {
          const result = await mergeMemories(plan);
          if (result?.activated === false) conflicts += 1;
          else merged += 1;
        } catch (error) {
          if (error?.code === 'bot_revision_conflict' || error?.code === 'bot_memory_version_conflict') {
            conflicts += 1;
            continue;
          }
          throw error;
        }
      }
      return Object.freeze({ planned: plans.length, merged, conflicts });
    })().finally(() => {
      running = null;
    });
    return running;
  };

  return Object.freeze({
    sweep,
    start() {
      if (stopped || timer) return;
      timer = setInterval(() => {
        void sweep().catch((error) => logger?.warn?.('[BotsMemory] consolidation failed', {
          ...botErrorLogFields(error, 'bot_memory_consolidation_failed'),
        }));
      }, intervalMs);
      timer.unref?.();
    },
    async shutdown() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      await running?.catch(() => undefined);
    },
  });
}
