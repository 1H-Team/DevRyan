import crypto from 'node:crypto';
import path from 'node:path';

import { DateTime, IANAZone } from 'luxon';

export const ANALYTICS_ACTIONS = Object.freeze({
  promptSent: 'prompt.sent',
  fileOpened: 'file.opened',
  clipboardCopied: 'clipboard.copied',
});

export const PROMPT_TEXT_LIMIT_BYTES = 16 * 1024;
export const CLIPBOARD_TEXT_LIMIT_BYTES = 64 * 1024;
export const ANALYTICS_EVENT_BATCH_LIMIT = 50;
export const ANALYTICS_PAGE_LIMIT = 50;

const INTERACTION_TYPES = new Set([
  ANALYTICS_ACTIONS.fileOpened,
  ANALYTICS_ACTIONS.clipboardCopied,
]);
const FILE_SURFACES = new Set(['git-changes', 'diff', 'files', 'search', 'context', 'editor']);
const COPY_SURFACES = new Set([
  'git-changes', 'diff', 'files', 'search', 'context', 'editor', 'chat', 'settings', 'unknown',
]);
const COPY_KINDS = new Set(['path', 'text', 'code', 'command', 'identifier', 'unknown']);
const DETAILED_ACTIONS = new Set([
  ANALYTICS_ACTIONS.promptSent,
  ANALYTICS_ACTIONS.fileOpened,
  ANALYTICS_ACTIONS.clipboardCopied,
]);
const NON_ACTIVITY_PREFIXES = ['tool.', 'assistant.', 'file.changed', 'file.diff'];
const SENSITIVE_FIELD_PATTERN = /(?:password|secret|token|credential|authorization|api[_-]?key|private[_-]?key|path|directory|url|uri|prompt|template|command|content|clipboard)/i;
const SAFE_STRING_FIELDS = new Set([
  'displayName', 'display_name', 'name', 'role', 'status', 'theme', 'colorScheme', 'language',
  'fontFamily', 'agent', 'variant', 'branchName', 'branch_name', 'defaultBranch', 'default_branch',
  'permission', 'read', 'edit',
]);
const BRANCH_COLLECTION_FIELDS = new Set(['branches', 'removedBranches', 'addedBranches']);
const SAFE_BOOLEAN_OBJECT_FIELDS = new Set([
  'capabilities', 'settingsPermissions', 'settingsPermissionOverrides', 'permissions',
]);
const INTERACTION_KEYS = Object.freeze({
  [ANALYTICS_ACTIONS.fileOpened]: new Set(['id', 'type', 'occurredAt', 'directory', 'sourceSurface', 'path']),
  [ANALYTICS_ACTIONS.clipboardCopied]: new Set([
    'id', 'type', 'occurredAt', 'directory', 'sourceSurface', 'path', 'copyKind', 'characterCount', 'copiedText',
  ]),
});

const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const truncateUtf8 = (value, limitBytes = PROMPT_TEXT_LIMIT_BYTES) => {
  const source = String(value || '');
  const sourceBytes = Buffer.byteLength(source, 'utf8');
  if (sourceBytes <= limitBytes) {
    return { text: source, originalLength: source.length, originalBytes: sourceBytes, truncated: false };
  }
  let low = 0;
  let high = source.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(source.slice(0, middle), 'utf8') <= limitBytes) low = middle;
    else high = middle - 1;
  }
  return {
    text: source.slice(0, low),
    originalLength: source.length,
    originalBytes: sourceBytes,
    truncated: true,
  };
};

export const stableAuditEventId = (namespace, value) => {
  const bytes = crypto.createHash('sha256').update(`${namespace}\0${String(value || '')}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const extractHumanPrompt = ({ body, sessionId, assignment, occurredAt = new Date().toISOString() } = {}) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const messageId = typeof body.messageID === 'string' && body.messageID.trim()
    ? body.messageID.trim()
    : null;
  if (!messageId || !sessionId) return null;

  const parts = Array.isArray(body.parts) ? body.parts : [];
  const textParts = parts
    .filter((part) => part?.type === 'text' && part.synthetic !== true && typeof part.text === 'string')
    .map((part) => part.text)
    .filter((text) => text.length > 0);
  const attachmentCount = parts.filter((part) => part && part.type !== 'text' && part.type !== 'agent').length;
  if (textParts.length === 0 && attachmentCount === 0) return null;
  const prompt = truncateUtf8(textParts.join('\n'));
  const providerId = typeof body.model?.providerID === 'string' ? body.model.providerID.slice(0, 160) : null;
  const modelId = typeof body.model?.modelID === 'string' ? body.model.modelID.slice(0, 240) : null;

  return {
    eventId: stableAuditEventId('prompt.sent', messageId),
    action: ANALYTICS_ACTIONS.promptSent,
    occurredAt,
    sessionId,
    projectId: assignment?.projectId || null,
    metadata: {
      messageId,
      promptText: prompt.text,
      promptOriginalLength: prompt.originalLength,
      promptOriginalBytes: prompt.originalBytes,
      promptTruncated: prompt.truncated,
      attachmentCount,
      agent: typeof body.agent === 'string' ? body.agent.slice(0, 160) : null,
      providerId,
      modelId,
      variant: typeof body.variant === 'string' ? body.variant.slice(0, 160) : null,
      projectName: typeof (assignment?.projectName || assignment?.label) === 'string'
        ? (assignment.projectName || assignment.label).slice(0, 200)
        : null,
      branchName: typeof assignment?.branchName === 'string' ? assignment.branchName.slice(0, 240) : null,
    },
  };
};

const invalidInteraction = (id, error) => ({ id: typeof id === 'string' ? id : null, accepted: false, error });

const normalizeRelativePath = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 2_048 || path.isAbsolute(value)) return undefined;
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.includes('\0')) return undefined;
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..' || segment === '')) return undefined;
  return normalized;
};

export const validateInteractionEvent = (event, {
  now = Date.now(),
  resolveAssignment,
  containsPath,
} = {}) => {
  const id = event?.id;
  if (!event || typeof event !== 'object' || Array.isArray(event)) return invalidInteraction(id, 'Event must be an object');
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return invalidInteraction(id, 'A UUID event id is required');
  if (!INTERACTION_TYPES.has(event.type)) return invalidInteraction(id, 'Unsupported interaction type');
  if (Object.keys(event).some((key) => !INTERACTION_KEYS[event.type].has(key))) {
    return invalidInteraction(id, 'Event includes an unsupported field');
  }
  if (Object.hasOwn(event, 'userId') || Object.hasOwn(event, 'targetUserId')) {
    return invalidInteraction(id, 'User identity is derived from the authenticated session');
  }
  if (['content', 'text', 'clipboardText', 'value'].some((key) => Object.hasOwn(event, key))) {
    return invalidInteraction(id, 'Interaction content is not accepted');
  }
  const occurred = Date.parse(event.occurredAt);
  if (!Number.isFinite(occurred) || occurred > now + 5 * 60_000 || occurred < now - 30 * 86_400_000) {
    return invalidInteraction(id, 'Event time is invalid or outside the accepted window');
  }
  if (typeof resolveAssignment !== 'function') return invalidInteraction(id, 'Project resolution is unavailable');
  const assignment = resolveAssignment(event.directory);
  if (!assignment) return invalidInteraction(id, 'Project is not assigned');
  const relativePath = normalizeRelativePath(event.path);
  if (relativePath === undefined) return invalidInteraction(id, 'File path must be project-relative');
  if (relativePath && typeof containsPath === 'function') {
    const candidate = path.resolve(assignment.repositoryPath, relativePath);
    if (!containsPath(assignment.repositoryPath, candidate)) {
      return invalidInteraction(id, 'File path is outside the assigned project');
    }
  }

  if (event.type === ANALYTICS_ACTIONS.fileOpened) {
    if (!FILE_SURFACES.has(event.sourceSurface)) return invalidInteraction(id, 'Invalid file-open surface');
    if (!relativePath) return invalidInteraction(id, 'A project-relative file path is required');
  } else {
    if (!COPY_SURFACES.has(event.sourceSurface)) return invalidInteraction(id, 'Invalid copy surface');
    if (!COPY_KINDS.has(event.copyKind)) return invalidInteraction(id, 'Invalid copy kind');
    if (!Number.isInteger(event.characterCount) || event.characterCount < 0 || event.characterCount > 10_000_000) {
      return invalidInteraction(id, 'Character count must be a bounded integer');
    }
    if (event.copiedText !== undefined && typeof event.copiedText !== 'string') {
      return invalidInteraction(id, 'Copied text must be a string');
    }
    if (typeof event.copiedText === 'string' && event.copiedText.length > event.characterCount) {
      return invalidInteraction(id, 'Copied text cannot exceed the reported character count');
    }
  }

  const copiedText = event.type === ANALYTICS_ACTIONS.clipboardCopied && typeof event.copiedText === 'string'
    ? truncateUtf8(event.copiedText, CLIPBOARD_TEXT_LIMIT_BYTES)
    : null;

  return {
    id,
    accepted: true,
    eventId: stableAuditEventId('analytics.interaction', id),
    action: event.type,
    occurredAt: new Date(occurred).toISOString(),
    assignment,
    ...(copiedText ? {
      clipboard: {
        text: copiedText.text,
        originalLength: event.characterCount,
        truncated: copiedText.truncated || copiedText.originalLength < event.characterCount,
      },
    } : {}),
    metadata: {
      clientEventId: id,
      sourceSurface: event.sourceSurface,
      ...(relativePath ? { filePath: relativePath } : {}),
      ...(event.type === ANALYTICS_ACTIONS.clipboardCopied ? {
        copyKind: event.copyKind,
        characterCount: event.characterCount,
      } : {}),
    },
  };
};

const safeBooleanObject = (value, depth = 0) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (depth > 2) return null;
  const normalized = {};
  for (const [key, item] of entries) {
    if (typeof item === 'boolean' || item === null) normalized[key] = item;
    else {
      const nested = safeBooleanObject(item, depth + 1);
      if (nested === null) return null;
      normalized[key] = nested;
    }
  }
  return normalized;
};

const collectionSummary = (value) => ({ count: Array.isArray(value) ? value.length : 0 });

export const buildSafeFieldDeltas = (before = {}, after = {}) => {
  const previous = before && typeof before === 'object' && !Array.isArray(before) ? before : {};
  const next = after && typeof after === 'object' && !Array.isArray(after) ? after : {};
  const changes = [];
  for (const field of [...new Set([...Object.keys(previous), ...Object.keys(next)])].sort()) {
    const beforeValue = previous[field];
    const afterValue = next[field];
    if (sameValue(beforeValue, afterValue)) continue;
    const base = { field };
    if (SENSITIVE_FIELD_PATTERN.test(field)) {
      changes.push({ ...base, changed: true });
      continue;
    }
    if (typeof beforeValue === 'boolean' || typeof afterValue === 'boolean'
      || typeof beforeValue === 'number' || typeof afterValue === 'number') {
      changes.push({ ...base, before: beforeValue ?? null, after: afterValue ?? null });
      continue;
    }
    if (SAFE_STRING_FIELDS.has(field)
      && [beforeValue, afterValue].every((value) => value === null || value === undefined || typeof value === 'string')) {
      changes.push({ ...base, before: beforeValue ?? null, after: afterValue ?? null });
      continue;
    }
    if (BRANCH_COLLECTION_FIELDS.has(field) && [beforeValue, afterValue].every((value) => value === undefined || Array.isArray(value))) {
      changes.push({ ...base, before: beforeValue || [], after: afterValue || [] });
      continue;
    }
    if (SAFE_BOOLEAN_OBJECT_FIELDS.has(field)) {
      const safeBefore = safeBooleanObject(beforeValue);
      const safeAfter = safeBooleanObject(afterValue);
      if (safeBefore !== null || safeAfter !== null) {
        changes.push({ ...base, before: safeBefore || {}, after: safeAfter || {} });
        continue;
      }
    }
    if (Array.isArray(beforeValue) || Array.isArray(afterValue)) {
      changes.push({ ...base, before: collectionSummary(beforeValue), after: collectionSummary(afterValue) });
      continue;
    }
    if ((beforeValue && typeof beforeValue === 'object') || (afterValue && typeof afterValue === 'object')) {
      const beforeKeys = beforeValue && typeof beforeValue === 'object' && !Array.isArray(beforeValue) ? Object.keys(beforeValue) : [];
      const afterKeys = afterValue && typeof afterValue === 'object' && !Array.isArray(afterValue) ? Object.keys(afterValue) : [];
      changes.push({ ...base, changed: true, changedKeys: [...new Set([...beforeKeys, ...afterKeys])].sort() });
      continue;
    }
    changes.push({ ...base, changed: true });
  }
  return changes;
};

export const isDetailedAnalyticsAction = (action) => DETAILED_ACTIONS.has(action);

export const sanitizeActivityForReviewer = (rows, { isAdmin }) => {
  if (isAdmin) return rows || [];
  return (rows || [])
    .filter((row) => !DETAILED_ACTIONS.has(row.action))
    .map((row) => ({ ...row, metadata: {} }));
};

export const isDirectActivityAction = (action) => (
  typeof action === 'string'
  && !NON_ACTIVITY_PREFIXES.some((prefix) => action === prefix || action.startsWith(prefix))
  && (DETAILED_ACTIONS.has(action) || /^(?:settings|user|project|invite|github\.account)\./.test(action))
);

export const isSettingsChangeAction = (action) => (
  typeof action === 'string'
  && /(?:updated|changed|assigned|unassigned|reset|created|revoked|suspended|archived)$/.test(action)
  && !DETAILED_ACTIONS.has(action)
);

export const isAnalyticsChangeAction = (action) => (
  isSettingsChangeAction(action) || action === 'session.deleted'
);

export const validateAnalyticsDay = (date, timeZone) => {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (typeof timeZone !== 'string' || !IANAZone.isValidZone(timeZone)) return null;
  const start = DateTime.fromISO(date, { zone: timeZone }).startOf('day');
  if (!start.isValid || start.toISODate() !== date) return null;
  return { start, end: start.plus({ days: 1 }) };
};

const rowDate = (row) => DateTime.fromISO(row.created_at, { setZone: true }).toUTC();

const makeHourBuckets = (start, end) => {
  const buckets = [];
  for (let cursor = start; cursor < end; cursor = cursor.plus({ hours: 1 })) {
    const next = DateTime.min(cursor.plus({ hours: 1 }), end);
    buckets.push({
      start: cursor.toUTC().toISO(),
      end: next.toUTC().toISO(),
      label: cursor.toFormat('HH:mm'),
      offset: cursor.toFormat('ZZ'),
      activeMinutes: 0,
      promptCount: 0,
    });
  }
  return buckets;
};

const overlapMinutes = (leftStart, leftEnd, rightStart, rightEnd) => {
  const start = Math.max(leftStart, rightStart);
  const end = Math.min(leftEnd, rightEnd);
  return end > start ? (end - start) / 60_000 : 0;
};

export const ANALYTICS_RANGE_MAX_DAYS = 92;

export const validateAnalyticsRange = (start, end, timeZone, { maxDays = ANALYTICS_RANGE_MAX_DAYS } = {}) => {
  if (typeof start !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return null;
  if (typeof end !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  if (typeof timeZone !== 'string' || !IANAZone.isValidZone(timeZone)) return null;
  const startDay = DateTime.fromISO(start, { zone: timeZone }).startOf('day');
  const endDay = DateTime.fromISO(end, { zone: timeZone }).startOf('day');
  if (!startDay.isValid || startDay.toISODate() !== start) return null;
  if (!endDay.isValid || endDay.toISODate() !== end) return null;
  if (endDay < startDay) return null;
  let days = 0;
  for (let cursor = startDay; cursor <= endDay; cursor = cursor.plus({ days: 1 })) {
    days += 1;
    if (days > maxDays) return null;
  }
  return { start: startDay, end: endDay.plus({ days: 1 }), days };
};

// Aggregates a single day window: activity sessions (30-min gap split, 5-min tail)
// and the five metric totals. Shared by the daily and range aggregators so the
// numbers stay identical between them.
const aggregateDayWindow = ({ rows = [], userId, start, end }) => {
  const startMs = start.toMillis();
  const endMs = end.toMillis();
  const dayRows = rows
    .filter((row) => {
      const value = rowDate(row).toMillis();
      return Number.isFinite(value) && value >= startMs && value < endMs;
    })
    .sort((left, right) => rowDate(left).toMillis() - rowDate(right).toMillis());
  const successfulRows = dayRows.filter((row) => row.success !== false);
  const ownDirectRows = successfulRows.filter((row) => row.actor_user_id === userId && isDirectActivityAction(row.action));
  const sessions = [];
  for (const row of ownDirectRows) {
    const occurredMs = rowDate(row).toMillis();
    const current = sessions.at(-1);
    if (!current || occurredMs - current.lastEventMs > 30 * 60_000) {
      sessions.push({ firstEventMs: occurredMs, lastEventMs: occurredMs, rows: [row] });
    } else {
      current.lastEventMs = occurredMs;
      current.rows.push(row);
    }
  }
  const activitySessions = sessions.map((session, index) => {
    const sessionStart = Math.max(startMs, session.firstEventMs);
    const sessionEnd = Math.min(endMs, session.lastEventMs + 5 * 60_000);
    const counts = {
      prompts: session.rows.filter((row) => row.action === ANALYTICS_ACTIONS.promptSent).length,
      filesOpened: session.rows.filter((row) => row.action === ANALYTICS_ACTIONS.fileOpened).length,
      copies: session.rows.filter((row) => row.action === ANALYTICS_ACTIONS.clipboardCopied).length,
      settingsChanges: session.rows.filter((row) => isSettingsChangeAction(row.action)).length,
    };
    return {
      id: `activity-${index + 1}`,
      start: new Date(sessionStart).toISOString(),
      end: new Date(sessionEnd).toISOString(),
      estimatedMinutes: Math.max(0, Math.round((sessionEnd - sessionStart) / 60_000)),
      actionCount: session.rows.length,
      counts,
    };
  });
  const totals = {
    estimatedActiveMinutes: activitySessions.reduce((sum, session) => sum + session.estimatedMinutes, 0),
    prompts: successfulRows.filter((row) => row.action === ANALYTICS_ACTIONS.promptSent).length,
    filesOpened: successfulRows.filter((row) => row.action === ANALYTICS_ACTIONS.fileOpened).length,
    copies: successfulRows.filter((row) => row.action === ANALYTICS_ACTIONS.clipboardCopied).length,
    settingsChanges: successfulRows.filter((row) => isSettingsChangeAction(row.action)).length,
  };
  return { totals, activitySessions, ownDirectRows };
};

export const aggregateDailyAnalytics = ({ rows = [], userId, date, timeZone }) => {
  const range = validateAnalyticsDay(date, timeZone);
  if (!range) throw Object.assign(new Error('A valid date and IANA time zone are required'), { statusCode: 400 });
  const { totals, activitySessions, ownDirectRows } = aggregateDayWindow({
    rows, userId, start: range.start, end: range.end,
  });
  const hours = makeHourBuckets(range.start, range.end);
  for (const row of ownDirectRows) {
    if (row.action !== ANALYTICS_ACTIONS.promptSent) continue;
    const occurredMs = rowDate(row).toMillis();
    const bucket = hours.find((hour) => occurredMs >= Date.parse(hour.start) && occurredMs < Date.parse(hour.end));
    if (bucket) bucket.promptCount += 1;
  }
  for (const session of activitySessions) {
    const sessionStart = Date.parse(session.start);
    const sessionEnd = Date.parse(session.end);
    for (const hour of hours) {
      hour.activeMinutes = Math.round((hour.activeMinutes + overlapMinutes(
        sessionStart,
        sessionEnd,
        Date.parse(hour.start),
        Date.parse(hour.end),
      )) * 10) / 10;
    }
  }
  return {
    date,
    timeZone,
    dayStart: range.start.toUTC().toISO(),
    dayEnd: range.end.toUTC().toISO(),
    totals,
    hours,
    activitySessions,
  };
};

const RANGE_METRIC_KEYS = Object.freeze([
  'estimatedActiveMinutes', 'prompts', 'filesOpened', 'copies', 'settingsChanges',
]);

export const aggregateRangeAnalytics = ({ rows = [], userId, start, end, timeZone }) => {
  const range = validateAnalyticsRange(start, end, timeZone);
  if (!range) {
    throw Object.assign(
      new Error(`A valid start date, end date, and IANA time zone are required (max ${ANALYTICS_RANGE_MAX_DAYS} days)`),
      { statusCode: 400 },
    );
  }
  const series = [];
  const totals = Object.fromEntries(RANGE_METRIC_KEYS.map((key) => [key, 0]));
  const activitySessions = [];
  for (let cursor = range.start; cursor < range.end; cursor = cursor.plus({ days: 1 })) {
    const dayStart = cursor;
    const dayEnd = cursor.plus({ days: 1 });
    const date = dayStart.toISODate();
    const day = aggregateDayWindow({ rows, userId, start: dayStart, end: dayEnd });
    series.push({ date, ...day.totals });
    for (const key of RANGE_METRIC_KEYS) totals[key] += day.totals[key];
    for (const session of day.activitySessions) activitySessions.push({ ...session, date });
  }
  activitySessions.sort((left, right) => Date.parse(right.start) - Date.parse(left.start));
  return {
    start,
    end,
    timeZone,
    days: range.days,
    rangeStart: range.start.toUTC().toISO(),
    rangeEnd: range.end.toUTC().toISO(),
    totals,
    series,
    activitySessions,
  };
};

export const encodeAnalyticsCursor = (row) => Buffer.from(JSON.stringify({
  createdAt: row.created_at,
  id: String(row.id),
})).toString('base64url');

export const decodeAnalyticsCursor = (value) => {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (typeof decoded.createdAt !== 'string' || !Number.isFinite(Date.parse(decoded.createdAt))) return null;
    if (typeof decoded.id !== 'string' || !/^\d+$/.test(decoded.id)) return null;
    return decoded;
  } catch {
    return null;
  }
};

export const analyticsRowBeforeCursor = (row, cursor) => {
  if (!cursor) return true;
  const rowTime = Date.parse(row.created_at);
  const cursorTime = Date.parse(cursor.createdAt);
  if (rowTime !== cursorTime) return rowTime < cursorTime;
  return BigInt(row.id) < BigInt(cursor.id);
};
