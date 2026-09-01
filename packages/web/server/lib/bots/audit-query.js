import { PRODUCTION_BOTS_MIGRATION } from '../multi-user/auth-compat.js';
import { validateBotAuditMetadata } from './audit-retention.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const CURSOR_VERSION = 1;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_SEARCH_LENGTH = 200;
const RESULTS = new Set(['issues', 'failure', 'partial', 'unknown', 'denied', 'success', 'all']);
const ISSUE_RESULTS = Object.freeze(['failure', 'partial', 'unknown']);
const LIST_QUERY_KEYS = new Set(['result', 'bot', 'actor', 'q', 'from', 'to', 'limit', 'cursor']);
const ROW_SELECT = 'id,event_id,bot_id,actor_user_id,target_type,target_id,action,result,metadata,created_at,resolved_at,resolved_by_event_id';
const CLEAR_RANGE_DAYS = new Map([['24h', 1], ['7d', 7], ['14d', 14], ['all', null]]);

const rethrowStorageError = (error) => {
  if (['42P01', '42883', 'PGRST202', 'PGRST205'].includes(error?.payload?.code || error?.code)) {
    fail('Bot Audit requires database migration 20260901160000_bot_runtime_scope_and_audit_repair.sql',
      'bot_audit_clear_migration_required', 503);
  }
  throw error;
};

export class BotAuditQueryError extends Error {
  constructor(message, code = 'bot_audit_query_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotAuditQueryError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotAuditQueryError(message, code, statusCode);
};

const isUuid = (value) => typeof value === 'string' && UUID_PATTERN.test(value);
const isPlainObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const queryString = (value, label) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') fail(`${label} must be a string`);
  return value;
};

const normalizeUuid = (value, label) => {
  const normalized = queryString(value, label);
  if (normalized === null) return null;
  if (!isUuid(normalized)) fail(`${label} must be a UUID`);
  return normalized.toLowerCase();
};

const normalizeTimestamp = (value, label) => {
  const normalized = queryString(value, label);
  if (normalized === null) return null;
  if (!ISO_TIMESTAMP_PATTERN.test(normalized) || !Number.isFinite(Date.parse(normalized))) {
    fail(`${label} must be an ISO timestamp`);
  }
  return new Date(normalized).toISOString();
};

const normalizeLimit = (value) => {
  if (value === undefined || value === null || value === '') return DEFAULT_LIMIT;
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    fail(`limit must be between 1 and ${MAX_LIMIT}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    fail(`limit must be between 1 and ${MAX_LIMIT}`);
  }
  return parsed;
};

const escapeLikePattern = (value) => value.replace(/[(),*\\"]/g, ' ').trim();

const normalizeSearch = (value) => {
  const normalized = queryString(value, 'q');
  if (normalized === null) return null;
  const trimmed = normalized.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_SEARCH_LENGTH) fail(`q must be ${MAX_SEARCH_LENGTH} characters or fewer`);
  return escapeLikePattern(trimmed) || null;
};

const assertListQuery = (query) => {
  if (!isPlainObject(query)) fail('query must contain simple parameters');
  for (const key of Object.keys(query)) {
    if (!LIST_QUERY_KEYS.has(key)) fail(`${key} is not a supported Bot audit filter`);
  }
  return query;
};

const encodeCursor = (row) => Buffer.from(JSON.stringify({
  v: CURSOR_VERSION,
  kind: 'bot_audit',
  createdAt: row.created_at,
  id: String(row.id),
}), 'utf8').toString('base64url');

const decodeCursor = (value) => {
  const normalized = queryString(value, 'cursor');
  if (normalized === null) return null;
  if (normalized.length > 2_048) fail('cursor is invalid');
  try {
    const parsed = JSON.parse(Buffer.from(normalized, 'base64url').toString('utf8'));
    if (!isPlainObject(parsed)
      || parsed.v !== CURSOR_VERSION
      || parsed.kind !== 'bot_audit'
      || typeof parsed.createdAt !== 'string'
      || !ISO_TIMESTAMP_PATTERN.test(parsed.createdAt)
      || !Number.isFinite(Date.parse(parsed.createdAt))
      || typeof parsed.id !== 'string'
      || !/^[0-9]+$/.test(parsed.id)) {
      fail('cursor is invalid');
    }
    return parsed;
  } catch (error) {
    if (error instanceof BotAuditQueryError) throw error;
    fail('cursor is invalid');
  }
};

const cursorFilter = (cursor) => (
  `(created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id}))`
);

const searchFilter = (pattern) => (
  `(action.ilike.*${pattern}*,target_type.ilike.*${pattern}*,target_id.ilike.*${pattern}*,metadata->>code.ilike.*${pattern}*,metadata->>failureCode.ilike.*${pattern}*,metadata->>interruptionCode.ilike.*${pattern}*)`
);

const logicFilter = ({ cursor, search, from, to }) => {
  const orGroups = [];
  if (cursor) orGroups.push(cursorFilter(cursor));
  if (search) orGroups.push(searchFilter(search));
  const bounds = [];
  if (from) bounds.push(`gte.${from}`);
  if (to) bounds.push(`lte.${to}`);
  if (orGroups.length + bounds.length > 1) {
    return {
      and: `(${[
        ...orGroups.map((group) => `or${group}`),
        ...bounds.map((bound) => `created_at.${bound}`),
      ].join(',')})`,
    };
  }
  if (orGroups.length === 1) return { or: orGroups[0] };
  if (bounds.length === 1) return { created_at: bounds[0] };
  return {};
};

const containsHostPath = (value) => {
  if (typeof value === 'string') {
    return value.startsWith('/Users/')
      || value.startsWith('/home/')
      || /^[A-Za-z]:[\\/]/.test(value)
      || value.startsWith('\\\\');
  }
  if (Array.isArray(value)) return value.some(containsHostPath);
  if (isPlainObject(value)) return Object.values(value).some(containsHostPath);
  return false;
};

const safeMetadata = (metadata) => {
  try {
    const validated = validateBotAuditMetadata(metadata);
    if (containsHostPath(validated)) throw new Error('host path in Bot audit metadata');
    return { metadata: validated, metadataRedacted: false };
  } catch {
    return {
      metadata: { code: 'bot_audit_metadata_redacted', redacted: true },
      metadataRedacted: true,
    };
  }
};

const metadataBotId = (metadata) => (
  isPlainObject(metadata) && isUuid(metadata.botId) ? metadata.botId.toLowerCase() : null
);

const diagnosticCode = (metadata) => {
  for (const key of ['code', 'failureCode', 'interruptionCode']) {
    const value = metadata?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 160);
  }
  return null;
};

const actionLabel = (action) => {
  const normalized = String(action || 'bot.event')
    .replace(/^bot[._]/, '')
    .replace(/[._-]+/g, ' ')
    .trim();
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : 'Bot event';
};

const summarize = (row, code) => {
  const label = actionLabel(row.action);
  if (code === 'bot_opencode_provider_authentication') {
    return `${label} · ${code} · Reconnect the selected account in Providers and Bot Settings. The failed request is not replayed.`;
  }
  return code ? `${label} · ${code}` : label;
};

const actorFallback = (actorId) => ({
  id: actorId || null,
  displayName: actorId ? 'Former managed user' : 'System or former user',
  email: '',
  role: null,
  former: true,
});

const botFallback = (botId) => ({
  id: botId || null,
  name: 'Deleted Bot',
  title: null,
  lifecycle: null,
  deleted: true,
});

const formatRow = (row, { botById, actorById, detail = false }) => {
  const safe = safeMetadata(row.metadata);
  const resolvedBotId = isUuid(row.bot_id) ? row.bot_id.toLowerCase() : metadataBotId(safe.metadata);
  const resolvedActorId = isUuid(row.actor_user_id) ? row.actor_user_id.toLowerCase() : null;
  const code = diagnosticCode(safe.metadata);
  return {
    eventId: row.event_id,
    action: row.action,
    result: row.result,
    timestamp: row.created_at,
    summary: summarize(row, code),
    diagnosticCode: code,
    bot: resolvedBotId ? (botById.get(resolvedBotId) || botFallback(resolvedBotId)) : botFallback(null),
    actor: resolvedActorId ? (actorById.get(resolvedActorId) || actorFallback(resolvedActorId)) : actorFallback(null),
    target: {
      type: row.target_type,
      id: row.target_id || null,
    },
    resolvedAt: row.resolved_at || null,
    resolvedByEventId: row.resolved_by_event_id || null,
    ...(detail ? {
      metadata: safe.metadata,
      metadataRedacted: safe.metadataRedacted,
    } : {}),
  };
};

const requireAdmin = (principal) => {
  if (principal?.scope !== 'managed' || principal?.role !== 'admin') {
    fail('Administrator access required', 'bot_audit_admin_required', 403);
  }
};

export function createBotAuditQuery({
  supabase,
  assertSchemaVersion,
  logger = console,
  now = Date.now,
} = {}) {
  const ensureAvailable = async (principal) => {
    requireAdmin(principal);
    if (!supabase || typeof supabase.rest !== 'function') {
      fail('Bot audit storage is unavailable', 'bots_supabase_unavailable', 503);
    }
    if (typeof assertSchemaVersion !== 'function') {
      fail('Bot audit schema check is unavailable', 'bot_schema_migration_required', 503);
    }
    await assertSchemaVersion(PRODUCTION_BOTS_MIGRATION);
  };

  const hydrate = async (rows) => {
    const botIds = [...new Set(rows.flatMap((row) => {
      const safe = safeMetadata(row.metadata).metadata;
      return [row.bot_id, metadataBotId(safe)].filter(isUuid).map((id) => id.toLowerCase());
    }))];
    const actorIds = [...new Set(rows.map((row) => row.actor_user_id).filter(isUuid).map((id) => id.toLowerCase()))];
    const [bots, actors] = await Promise.all([
      botIds.length > 0
        ? supabase.rest('bots', {
            query: { id: `in.(${botIds.join(',')})`, order: 'name.asc,id.asc' },
            select: 'id,name,title,lifecycle',
          })
        : Promise.resolve([]),
      actorIds.length > 0
        ? supabase.rest('user_profiles', {
            query: { id: `in.(${actorIds.join(',')})` },
            select: 'id,display_name,email,role',
          })
        : Promise.resolve([]),
    ]);
    return {
      botById: new Map((bots || []).map((bot) => [bot.id, {
        id: bot.id,
        name: bot.name,
        title: bot.title || null,
        lifecycle: bot.lifecycle,
        deleted: false,
      }])),
      actorById: new Map((actors || []).map((actor) => [actor.id, {
        id: actor.id,
        displayName: actor.display_name,
        email: actor.email,
        role: actor.role,
        former: false,
      }])),
    };
  };

  const list = async (principal, query = {}) => {
    await ensureAvailable(principal);
    const validatedQuery = assertListQuery(query);
    const result = queryString(validatedQuery.result, 'result') || 'issues';
    if (!RESULTS.has(result)) fail('result is invalid');
    const bot = normalizeUuid(validatedQuery.bot, 'bot');
    const actor = normalizeUuid(validatedQuery.actor, 'actor');
    const search = normalizeSearch(validatedQuery.q);
    const from = normalizeTimestamp(validatedQuery.from, 'from');
    const to = normalizeTimestamp(validatedQuery.to, 'to');
    if (from && to && from > to) fail('from must not be later than to');
    const limit = normalizeLimit(validatedQuery.limit);
    const cursor = decodeCursor(validatedQuery.cursor);
    const resultFilter = result === 'issues'
      ? `in.(${ISSUE_RESULTS.join(',')})`
      : result === 'all' ? null : `eq.${result}`;

    try {
      const rows = await supabase.rest('bot_audit_review_events', {
        query: {
          ...(resultFilter ? { result: resultFilter } : {}),
          ...(result === 'issues' ? { resolved_at: 'is.null' } : {}),
          ...(bot ? { bot_id: `eq.${bot}` } : {}),
          ...(actor ? { actor_user_id: `eq.${actor}` } : {}),
          ...logicFilter({ cursor, search, from, to }),
          order: 'created_at.desc,id.desc',
          limit: limit + 1,
        },
        select: ROW_SELECT,
      });
      const page = (rows || []).slice(0, limit);
      const hydration = await hydrate(page);
      const tail = page.at(-1);
      return {
        logs: page.map((row) => formatRow(row, hydration)),
        nextCursor: (rows || []).length > limit && tail ? encodeCursor(tail) : null,
      };
    } catch (error) {
      logger.warn?.('[Bots] Audit listing failed:', error?.message || error);
      rethrowStorageError(error);
    }
  };

  const options = async (principal) => {
    await ensureAvailable(principal);
    try {
      const bots = await supabase.rest('bots', {
        query: { order: 'name.asc,id.asc' },
        select: 'id,name,title,lifecycle',
      });
      return {
        bots: (bots || []).map((bot) => ({
          id: bot.id,
          name: bot.name,
          title: bot.title || null,
          lifecycle: bot.lifecycle,
        })),
      };
    } catch (error) {
      logger.warn?.('[Bots] Audit options failed:', error?.message || error);
      throw error;
    }
  };

  const detail = async (principal, eventId) => {
    await ensureAvailable(principal);
    if (!isUuid(eventId)) fail('Bot audit event id must be a UUID');
    try {
      const row = await supabase.rest('bot_audit_events_with_resolution', {
        query: { event_id: `eq.${eventId.toLowerCase()}`, limit: 1 },
        select: ROW_SELECT,
        maybeSingle: true,
      });
      if (!row) fail('Bot audit event not found', 'bot_audit_not_found', 404);
      const hydration = await hydrate([row]);
      return { log: formatRow(row, { ...hydration, detail: true }) };
    } catch (error) {
      if (error instanceof BotAuditQueryError) throw error;
      logger.warn?.('[Bots] Audit detail failed:', error?.message || error);
      throw error;
    }
  };

  const clear = async (principal, query = {}) => {
    await ensureAvailable(principal);
    if (!isPlainObject(query) || Object.keys(query).some((key) => key !== 'range')
      || !CLEAR_RANGE_DAYS.has(query.range)) {
      fail('range must be one of: 24h, 7d, 14d, all');
    }
    const until = now();
    const days = CLEAR_RANGE_DAYS.get(query.range);
    try {
      const result = await supabase.rpc('devryan_clear_bot_audit', {
        p_actor_id: principal.id,
        p_since: days === null ? null : new Date(until - days * 86_400_000).toISOString(),
        p_until: new Date(until).toISOString(),
      });
      if (!Number.isSafeInteger(result?.clearedCount) || result.clearedCount < 0) {
        fail('Bot audit clear returned an invalid count', 'bot_audit_clear_invalid_response', 502);
      }
      return { clearedCount: result.clearedCount };
    } catch (error) {
      rethrowStorageError(error);
    }
  };

  return Object.freeze({ list, options, detail, clear });
}
