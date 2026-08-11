import os from 'node:os';

import { createDiagnosticSanitizer } from '@openchamber/harness-runtime';

import { stableAuditEventId } from './analytics.js';
import {
  DIAGNOSTIC_IMPACTS,
  inferLegacyDiagnostic,
  normalizeDiagnosticImpact,
  normalizeDiagnosticSource,
  normalizeFailureClass,
} from './error-diagnostics.js';
import { SupabaseRequestError } from './supabase-client.js';

export const BUG_REPORTS_MIGRATION = '20260809190612_bug_reports';
export const ERROR_DIAGNOSTICS_MIGRATION = '20260810130000_managed_error_diagnostics';
export const ERROR_LOG_CLEAR_MIGRATION = '20260810182541_clear_managed_error_diagnostics';
export const BUG_REPORT_STATUSES = Object.freeze(['submitted', 'in_progress', 'resolved']);
export const ERROR_LOG_KINDS = Object.freeze(['session', 'tool', 'managed_task']);
export const ERROR_LOG_CLEAR_RANGES = Object.freeze(['24h', '7d', '14d', 'all']);

const BUG_REPORT_STATUS_SET = new Set(BUG_REPORT_STATUSES);
const ERROR_LOG_KIND_SET = new Set(ERROR_LOG_KINDS);
const ERROR_LOG_IMPACT_SET = new Set(DIAGNOSTIC_IMPACTS);
const ERROR_LOG_CLEAR_RANGE_MS = Object.freeze({
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '14d': 14 * 24 * 60 * 60 * 1000,
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T/;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 50;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 20_000;
const CURSOR_VERSION = 1;

const ERROR_ACTION_BY_KIND = Object.freeze({
  session: 'session.error',
  tool: 'tool.failed',
  managed_task: 'managed_task.failed',
});

const ERROR_KIND_BY_ACTION = Object.freeze(
  Object.fromEntries(Object.entries(ERROR_ACTION_BY_KIND).map(([kind, action]) => [action, kind])),
);

const ERROR_CONTEXT_KEYS = Object.freeze([
  'kind',
  'branch',
  'rootSessionId',
  'childSessionId',
  'messageId',
  'toolId',
  'callId',
  'taskId',
  'priorTaskId',
  'providerId',
  'modelId',
  'agent',
  'errorName',
  'errorCode',
  'statusCode',
  'retryable',
  'failureText',
  'tool',
  'status',
  'paths',
  'attempt',
  'executionKind',
  'failureKind',
  'partial',
  'failureClass',
]);

const knownSecretsFromEnvironment = () =>
  Object.entries(process.env)
    .filter(
      ([key, value]) =>
        /(?:secret|token|password|api[_-]?key|authorization)/i.test(key) &&
        typeof value === 'string' &&
        value.length >= 6,
    )
    .map(([, value]) => value);

const jsonError = (res, status, error, extras = {}) => res.status(status).json({ error, ...extras });

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const hasOnlyKeys = (value, allowed) => isRecord(value) && Object.keys(value).every((key) => allowed.has(key));

const isUuid = (value) => typeof value === 'string' && UUID_PATTERN.test(value);

const normalizeRequiredText = (value, label, maximum) => {
  if (typeof value !== 'string') return { error: `${label} must be plain text` };
  const text = value.trim();
  if (!text) return { error: `${label} is required` };
  if (text.length > maximum)
    return {
      error: `${label} must be ${maximum.toLocaleString('en-US')} characters or fewer`,
    };
  return { value: text };
};

export const validateBugReportSubmission = (value) => {
  const allowed = new Set(['id', 'title', 'description']);
  if (!hasOnlyKeys(value, allowed))
    return {
      valid: false,
      error: 'Only id, title, and description are accepted',
    };
  if (!isUuid(value.id)) return { valid: false, error: 'id must be a UUID' };
  const title = normalizeRequiredText(value.title, 'Title', MAX_TITLE_LENGTH);
  if (title.error) return { valid: false, error: title.error };
  const description = normalizeRequiredText(value.description, 'Description', MAX_DESCRIPTION_LENGTH);
  if (description.error) return { valid: false, error: description.error };
  return {
    valid: true,
    submission: {
      id: value.id.toLowerCase(),
      title: title.value,
      description: description.value,
    },
  };
};

export const validateBugReportStatusUpdate = (value) => {
  const allowed = new Set(['status', 'expectedUpdatedAt']);
  if (!hasOnlyKeys(value, allowed))
    return {
      valid: false,
      error: 'Only status and expectedUpdatedAt are accepted',
    };
  if (!BUG_REPORT_STATUS_SET.has(value.status))
    return {
      valid: false,
      error: 'status must be submitted, in_progress, or resolved',
    };
  if (
    typeof value.expectedUpdatedAt !== 'string' ||
    !ISO_TIMESTAMP_PATTERN.test(value.expectedUpdatedAt) ||
    !Number.isFinite(Date.parse(value.expectedUpdatedAt))
  ) {
    return {
      valid: false,
      error: 'expectedUpdatedAt must be an ISO timestamp',
    };
  }
  return {
    valid: true,
    update: {
      status: value.status,
      expectedUpdatedAt: value.expectedUpdatedAt,
    },
  };
};

export const validateErrorLogClearRange = (rawRange, now = Date.now()) => {
  const range = rawRange === undefined ? 'all' : rawRange;
  if (typeof range !== 'string' || !ERROR_LOG_CLEAR_RANGES.includes(range)) {
    return { valid: false, error: 'range must be 24h, 7d, 14d, or all' };
  }
  return {
    valid: true,
    clear: {
      range,
      ...(range === 'all' ? {} : { since: now - ERROR_LOG_CLEAR_RANGE_MS[range] }),
    },
  };
};

const normalizePageLimit = (raw) => {
  if (raw === undefined || raw === null || raw === '') return { value: DEFAULT_PAGE_LIMIT };
  if (Array.isArray(raw) || !/^\d+$/.test(String(raw))) return { error: 'limit must be an integer between 1 and 50' };
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    return { error: 'limit must be an integer between 1 and 50' };
  }
  return { value };
};

const encodeCursor = (kind, payload) =>
  Buffer.from(
    JSON.stringify({
      v: CURSOR_VERSION,
      kind,
      ...payload,
    }),
    'utf8',
  ).toString('base64url');

const decodeCursor = (raw, kind, validate) => {
  if (raw === undefined || raw === null || raw === '') return { value: null };
  if (typeof raw !== 'string' || raw.length > 2_048) return { error: 'cursor is invalid' };
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!isRecord(value) || value.v !== CURSOR_VERSION || value.kind !== kind || !validate(value)) {
      return { error: 'cursor is invalid' };
    }
    return { value };
  } catch {
    return { error: 'cursor is invalid' };
  }
};

const decodeBugReportCursor = (raw) =>
  decodeCursor(
    raw,
    'bug_reports',
    (value) => typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)) && isUuid(value.id),
  );

const decodeErrorLogCursor = (raw) =>
  decodeCursor(
    raw,
    'error_logs',
    (value) =>
      typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)) && isUuid(value.eventId),
  );

const reportCursorFilter = (cursor) =>
  `(created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id}))`;

const errorCursorFilter = (cursor) =>
  `(created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},event_id.lt.${cursor.eventId}))`;

export const isBugReportsSchemaError = (error) => {
  if (!(error instanceof SupabaseRequestError)) return false;
  const code = String(error.payload?.code || '');
  const detail = `${error.message || ''} ${error.payload?.message || ''} ${error.payload?.details || ''}`;
  return (code === 'PGRST205' || code === '42P01') && /bug_reports/i.test(detail);
};

export const isErrorDiagnosticsSchemaError = (error) => {
  if (!(error instanceof SupabaseRequestError)) return false;
  const code = String(error.payload?.code || '');
  const detail = `${error.message || ''} ${error.payload?.message || ''} ${error.payload?.details || ''}`;
  return (code === 'PGRST204' || code === '42703')
    && /diagnostic_(?:impact|source)/i.test(detail);
};

export const isErrorLogClearSchemaError = (error) => {
  if (!(error instanceof SupabaseRequestError)) return false;
  const code = String(error.payload?.code || '');
  const detail = `${error.message || ''} ${error.payload?.message || ''} ${error.payload?.details || ''}`;
  return (code === 'PGRST202' || code === '42883') && /devryan_clear_error_logs/i.test(detail);
};

const sendDependencyError = (res, error, label) => {
  if (isBugReportsSchemaError(error)) {
    return jsonError(res, 503, 'Database migration required', {
      code: 'schema_migration_required',
      requiredMigration: BUG_REPORTS_MIGRATION,
      retryable: false,
    });
  }
  return jsonError(res, 503, `${label} is temporarily unavailable`, {
    code: 'dependency_unavailable',
    retryable: true,
  });
};

const sendErrorLogsDependencyError = (res, error) => {
  if (isErrorDiagnosticsSchemaError(error)) {
    return jsonError(res, 503, 'Database migration required', {
      code: 'schema_migration_required',
      requiredMigration: ERROR_DIAGNOSTICS_MIGRATION,
      retryable: false,
    });
  }
  return sendDependencyError(res, error, 'Error logs');
};

const sendErrorLogClearDependencyError = (res, error) => {
  if (isErrorLogClearSchemaError(error)) {
    return jsonError(res, 503, 'Database migration required', {
      code: 'schema_migration_required',
      requiredMigration: ERROR_LOG_CLEAR_MIGRATION,
      retryable: false,
    });
  }
  return sendDependencyError(res, error, 'Error log clearing');
};

const formatReporter = (row) => ({
  id: row.reporter_user_id || null,
  displayName: row.reporter_display_name,
  email: row.reporter_email,
  role: row.reporter_role,
});

const formatBugReport = (row, { detail = false } = {}) => ({
  id: row.id,
  title: row.title,
  ...(detail ? { description: row.description } : {}),
  status: row.status,
  reporter: formatReporter(row),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const pickErrorContext = (metadata, sanitizer) => {
  const source = isRecord(metadata) ? metadata : {};
  const context = {};
  for (const key of ERROR_CONTEXT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) context[key] = source[key];
  }
  return sanitizer.sanitizeExportValue(context);
};

const summarizeErrorContext = (kind, context) => {
  const failure = typeof context.failureText === 'string' ? context.failureText.trim() : '';
  if (failure) return failure.length > 240 ? `${failure.slice(0, 237)}…` : failure;
  if (kind === 'tool') return `${typeof context.tool === 'string' && context.tool ? context.tool : 'Tool'} failed`;
  if (kind === 'managed_task') return 'Managed task failed';
  return typeof context.errorName === 'string' && context.errorName ? context.errorName : 'Session failed';
};

const hydrateErrorRows = async (supabase, rows) => {
  const actorIds = [...new Set(rows.map((row) => row.actor_user_id).filter(isUuid))];
  const projectIds = [...new Set(rows.map((row) => row.project_id).filter(isUuid))];
  const eventIds = [...new Set(rows.map((row) => row.event_id).filter(isUuid))];
  const [actors, projects, resolutions] = await Promise.all([
    actorIds.length > 0
      ? supabase
          .rest('user_profiles', {
            query: {
              id: `in.(${actorIds.join(',')})`,
              select: 'id,display_name,email,role',
            },
          })
          .catch(() => [])
      : Promise.resolve([]),
    projectIds.length > 0
      ? supabase
          .rest('managed_projects', {
            query: { id: `in.(${projectIds.join(',')})`, select: 'id,label' },
          })
          .catch(() => [])
      : Promise.resolve([]),
    eventIds.length > 0
      ? supabase.rest('activity_logs', {
          query: {
            action: 'in.(diagnostic.recovered,diagnostic.unresolved)',
            target_type: 'eq.activity_event',
            target_id: `in.(${eventIds.join(',')})`,
            order: 'created_at.desc,event_id.desc',
          },
          select: 'event_id,action,target_id,metadata,created_at',
        })
      : Promise.resolve([]),
  ]);
  const actorById = new Map((actors || []).map((actor) => [actor.id, actor]));
  const projectById = new Map((projects || []).map((project) => [project.id, project]));
  const resolutionByEventId = new Map();
  for (const resolution of Array.isArray(resolutions) ? resolutions : []) {
    if (!isUuid(resolution.target_id)) continue;
    const outcome = resolution.action === 'diagnostic.unresolved'
      ? 'unresolved'
      : resolution.action === 'diagnostic.recovered'
        ? 'recovered'
        : null;
    if (!outcome) continue;
    const current = resolutionByEventId.get(resolution.target_id);
    if (!current || outcome === 'unresolved') resolutionByEventId.set(resolution.target_id, outcome);
  }
  return rows.map((row) => ({
    ...row,
    actor: actorById.get(row.actor_user_id) || null,
    project: projectById.get(row.project_id) || null,
    resolutionOutcome: resolutionByEventId.get(row.event_id) || null,
  }));
};

const formatErrorLog = (row, sanitizer, { detail = false } = {}) => {
  const kind = ERROR_KIND_BY_ACTION[row.action] || 'session';
  const context = pickErrorContext(row.metadata, sanitizer);
  const inferred = inferLegacyDiagnostic({ action: row.action, metadata: context });
  const impact = normalizeDiagnosticImpact(row.diagnostic_impact) || inferred.impact;
  const classificationSource = normalizeDiagnosticSource(row.diagnostic_source) || 'inferred';
  const failureClass = Object.prototype.hasOwnProperty.call(context, 'failureClass')
    ? normalizeFailureClass(context.failureClass)
    : inferred.failureClass;
  const outcome = impact === 'high' || impact === 'critical'
    ? 'unresolved'
    : row.resolutionOutcome || 'unknown';
  return {
    eventId: row.event_id,
    kind,
    action: row.action,
    createdAt: row.created_at,
    actor: row.actor_user_id
      ? {
          id: row.actor_user_id,
          displayName: row.actor?.display_name || 'Former managed user',
          email: row.actor?.email || '',
          role: row.actor_role || row.actor?.role || 'developer',
        }
      : null,
    project: row.project ? { id: row.project.id, label: row.project.label } : null,
    sessionId: row.session_id || null,
    impact,
    classificationSource,
    failureClass,
    outcome,
    summary: summarizeErrorContext(kind, context),
    ...(detail
      ? { context }
      : {
          errorName: typeof context.errorName === 'string' ? context.errorName : null,
          tool: typeof context.tool === 'string' ? context.tool : null,
          statusCode: typeof context.statusCode === 'number' ? context.statusCode : null,
        }),
  };
};

const isManagedAdmin = (principal) => principal?.scope === 'managed' && principal.role === 'admin';

export function createBugReportsApi({
  supabase,
  audit,
  dataDirectory,
  canEditBugReports = () => false,
  withAuditDeliveryBarrier,
  logger = console,
} = {}) {
  if (!supabase || typeof supabase.rest !== 'function' || typeof supabase.rpc !== 'function') {
    throw new TypeError('supabase client with REST and RPC support is required');
  }
  if (typeof audit !== 'function') throw new TypeError('audit function is required');
  if (typeof withAuditDeliveryBarrier !== 'function') {
    throw new TypeError('audit delivery barrier is required');
  }

  const sanitizer = createDiagnosticSanitizer({
    homeDir: os.homedir(),
    dataDir: dataDirectory,
    knownSecrets: knownSecretsFromEnvironment(),
  });

  const registerRoutes = (app) => {
    app.post('/api/bug-reports', async (req, res, next) => {
      if (req.principal?.scope !== 'managed') return next();
      if (!canEditBugReports(req.principal))
        return jsonError(res, 403, 'Edit access to Bug Reports is disabled by policy');
      const validated = validateBugReportSubmission(req.body);
      if (!validated.valid) return jsonError(res, 400, validated.error);

      const sanitized = sanitizer.sanitizeExportValue({
        title: validated.submission.title,
        description: validated.submission.description,
      });
      const title = String(sanitized.title || '')
        .slice(0, MAX_TITLE_LENGTH)
        .trim();
      const description = String(sanitized.description || '')
        .slice(0, MAX_DESCRIPTION_LENGTH)
        .trim();
      if (!title || !description) return jsonError(res, 400, 'Title and description are required after sanitization');

      const row = {
        id: validated.submission.id,
        reporter_user_id: req.principal.id,
        reporter_display_name: String(req.principal.displayName || req.principal.email || 'Managed user').slice(0, 300),
        reporter_email: String(req.principal.email || 'unknown@invalid.local').slice(0, 320),
        reporter_role: req.principal.role,
        title,
        description,
      };

      try {
        const inserted = await supabase.rest('bug_reports', {
          method: 'POST',
          query: { on_conflict: 'id' },
          body: row,
          select:
            'id,title,description,status,reporter_user_id,reporter_display_name,reporter_email,reporter_role,created_at,updated_at',
          prefer: 'resolution=ignore-duplicates,return=representation',
        });
        const created = Array.isArray(inserted) ? inserted[0] : inserted;
        const stored =
          created ||
          (await supabase.rest('bug_reports', {
            query: { id: `eq.${row.id}`, limit: 1 },
            select:
              'id,title,description,status,reporter_user_id,reporter_display_name,reporter_email,reporter_role,created_at,updated_at',
            maybeSingle: true,
          }));
        if (!stored) throw new Error('Idempotent bug report lookup failed');
        if (
          stored.reporter_user_id !== row.reporter_user_id ||
          stored.title !== row.title ||
          stored.description !== row.description
        ) {
          return jsonError(res, 409, 'This report id is already associated with different content', {
            code: 'idempotency_conflict',
          });
        }
        await audit(req.principal, 'bug_report.submitted', {
          eventId: stableAuditEventId('bug_report.submitted', row.id),
          targetType: 'bug_report',
          targetId: row.id,
          metadata: { status: stored.status },
        });
        return res.status(created ? 201 : 200).json({ report: formatBugReport(stored, { detail: true }) });
      } catch (error) {
        logger.warn?.('[MultiUser] Bug report submission failed:', error?.message || error);
        return sendDependencyError(res, error, 'Bug report submission');
      }
    });

    app.get('/api/bug-reports', async (req, res, next) => {
      if (req.principal?.scope !== 'managed') return next();
      if (!isManagedAdmin(req.principal)) return jsonError(res, 403, 'Administrator access required');
      const status = req.query?.status;
      if (status !== undefined && (typeof status !== 'string' || !BUG_REPORT_STATUS_SET.has(status))) {
        return jsonError(res, 400, 'status must be submitted, in_progress, or resolved');
      }
      const limit = normalizePageLimit(req.query?.limit);
      if (limit.error) return jsonError(res, 400, limit.error);
      const cursor = decodeBugReportCursor(req.query?.cursor);
      if (cursor.error) return jsonError(res, 400, cursor.error);

      try {
        const rows = await supabase.rest('bug_reports', {
          query: {
            ...(status ? { status: `eq.${status}` } : {}),
            ...(cursor.value ? { or: reportCursorFilter(cursor.value) } : {}),
            order: 'created_at.desc,id.desc',
            limit: limit.value + 1,
          },
          select:
            'id,title,status,reporter_user_id,reporter_display_name,reporter_email,reporter_role,created_at,updated_at',
        });
        const page = (rows || []).slice(0, limit.value);
        const tail = page.at(-1);
        return res.json({
          reports: page.map((row) => formatBugReport(row)),
          nextCursor:
            (rows || []).length > limit.value && tail
              ? encodeCursor('bug_reports', {
                  createdAt: tail.created_at,
                  id: tail.id,
                })
              : null,
        });
      } catch (error) {
        logger.warn?.('[MultiUser] Bug report listing failed:', error?.message || error);
        return sendDependencyError(res, error, 'Bug report review');
      }
    });

    app.get('/api/bug-reports/:id', async (req, res, next) => {
      if (req.principal?.scope !== 'managed') return next();
      if (!isManagedAdmin(req.principal)) return jsonError(res, 403, 'Administrator access required');
      if (!isUuid(req.params?.id)) return jsonError(res, 400, 'Bug report id must be a UUID');
      try {
        const row = await supabase.rest('bug_reports', {
          query: { id: `eq.${req.params.id}`, limit: 1 },
          select:
            'id,title,description,status,reporter_user_id,reporter_display_name,reporter_email,reporter_role,created_at,updated_at',
          maybeSingle: true,
        });
        if (!row) return jsonError(res, 404, 'Bug report not found');
        return res.json({ report: formatBugReport(row, { detail: true }) });
      } catch (error) {
        logger.warn?.('[MultiUser] Bug report detail failed:', error?.message || error);
        return sendDependencyError(res, error, 'Bug report review');
      }
    });

    app.patch('/api/bug-reports/:id', async (req, res, next) => {
      if (req.principal?.scope !== 'managed') return next();
      if (!isManagedAdmin(req.principal)) return jsonError(res, 403, 'Administrator access required');
      if (!isUuid(req.params?.id)) return jsonError(res, 400, 'Bug report id must be a UUID');
      const validated = validateBugReportStatusUpdate(req.body);
      if (!validated.valid) return jsonError(res, 400, validated.error);

      try {
        const current = await supabase.rest('bug_reports', {
          query: { id: `eq.${req.params.id}`, limit: 1 },
          select: 'id,status,updated_at',
          maybeSingle: true,
        });
        if (!current) return jsonError(res, 404, 'Bug report not found');
        if (current.updated_at !== validated.update.expectedUpdatedAt) {
          return jsonError(res, 409, 'Bug report status changed in another session', {
            code: 'stale_update',
            current: {
              status: current.status,
              updatedAt: current.updated_at,
            },
          });
        }
        if (current.status === validated.update.status) {
          const unchanged = await supabase.rest('bug_reports', {
            query: { id: `eq.${req.params.id}`, limit: 1 },
            select:
              'id,title,description,status,reporter_user_id,reporter_display_name,reporter_email,reporter_role,created_at,updated_at',
            maybeSingle: true,
          });
          return res.json({
            report: formatBugReport(unchanged, { detail: true }),
          });
        }
        const updated = await supabase.rest('bug_reports', {
          method: 'PATCH',
          query: {
            id: `eq.${req.params.id}`,
            updated_at: `eq.${validated.update.expectedUpdatedAt}`,
          },
          body: { status: validated.update.status },
          select:
            'id,title,description,status,reporter_user_id,reporter_display_name,reporter_email,reporter_role,created_at,updated_at',
          prefer: 'return=representation',
          maybeSingle: true,
        });
        if (!updated) {
          return jsonError(res, 409, 'Bug report status changed in another session', { code: 'stale_update' });
        }
        await audit(req.principal, 'bug_report.status_changed', {
          eventId: stableAuditEventId(
            'bug_report.status_changed',
            `${updated.id}:${validated.update.expectedUpdatedAt}:${updated.status}`,
          ),
          targetType: 'bug_report',
          targetId: updated.id,
          metadata: { fromStatus: current.status, toStatus: updated.status },
        });
        return res.json({ report: formatBugReport(updated, { detail: true }) });
      } catch (error) {
        logger.warn?.('[MultiUser] Bug report status update failed:', error?.message || error);
        return sendDependencyError(res, error, 'Bug report status update');
      }
    });

    app.get('/api/error-logs', async (req, res, next) => {
      if (req.principal?.scope !== 'managed') return next();
      if (!isManagedAdmin(req.principal)) return jsonError(res, 403, 'Administrator access required');
      const kind = req.query?.kind;
      if (kind !== undefined && (typeof kind !== 'string' || !ERROR_LOG_KIND_SET.has(kind))) {
        return jsonError(res, 400, 'kind must be session, tool, or managed_task');
      }
      const impact = req.query?.impact;
      if (impact !== undefined && (typeof impact !== 'string' || !ERROR_LOG_IMPACT_SET.has(impact))) {
        return jsonError(res, 400, 'impact must be low, medium, high, or critical');
      }
      const limit = normalizePageLimit(req.query?.limit);
      if (limit.error) return jsonError(res, 400, limit.error);
      const cursor = decodeErrorLogCursor(req.query?.cursor);
      if (cursor.error) return jsonError(res, 400, cursor.error);

      try {
        const rows = await supabase.rest('activity_logs', {
          query: {
            action: kind ? `eq.${ERROR_ACTION_BY_KIND[kind]}` : `in.(${Object.values(ERROR_ACTION_BY_KIND).join(',')})`,
            ...(impact ? { diagnostic_impact: `eq.${impact}` } : {}),
            ...(cursor.value ? { or: errorCursorFilter(cursor.value) } : {}),
            order: 'created_at.desc,event_id.desc',
            limit: limit.value + 1,
          },
          select: 'id,event_id,actor_user_id,actor_role,action,project_id,session_id,success,diagnostic_impact,diagnostic_source,metadata,created_at',
        });
        const page = (rows || []).slice(0, limit.value);
        const hydrated = await hydrateErrorRows(supabase, page);
        const tail = page.at(-1);
        return res.json({
          logs: hydrated.map((row) => formatErrorLog(row, sanitizer)),
          nextCursor:
            (rows || []).length > limit.value && tail
              ? encodeCursor('error_logs', {
                  createdAt: tail.created_at,
                  eventId: tail.event_id,
                })
              : null,
        });
      } catch (error) {
        logger.warn?.('[MultiUser] Error log listing failed:', error?.message || error);
        return sendErrorLogsDependencyError(res, error);
      }
    });

    app.delete('/api/error-logs', async (req, res, next) => {
      if (req.principal?.scope !== 'managed') return next();
      if (!isManagedAdmin(req.principal)) return jsonError(res, 403, 'Administrator access required');
      const validated = validateErrorLogClearRange(req.query?.range);
      if (!validated.valid) return jsonError(res, 400, validated.error);

      try {
        await audit(req.principal, 'error_logs.clear_requested', {
          metadata: { range: validated.clear.range },
        });
        const result = await withAuditDeliveryBarrier(async () => {
          const cutoff = new Date().toISOString();
          return supabase.rpc('devryan_clear_error_logs', {
            p_since: validated.clear.since === undefined
              ? null
              : new Date(validated.clear.since).toISOString(),
            p_until: cutoff,
          });
        });
        const counts = Array.isArray(result) ? result[0] : result;
        return res.json({
          clearedCount: Number.isSafeInteger(counts?.clearedCount) && counts.clearedCount >= 0
            ? counts.clearedCount
            : 0,
          linkedResolutionCount:
            Number.isSafeInteger(counts?.linkedResolutionCount) && counts.linkedResolutionCount >= 0
              ? counts.linkedResolutionCount
              : 0,
          range: validated.clear.range,
        });
      } catch (error) {
        logger.warn?.('[MultiUser] Error log clearing failed:', error?.message || error);
        return sendErrorLogClearDependencyError(res, error);
      }
    });

    app.get('/api/error-logs/:eventId', async (req, res, next) => {
      if (req.principal?.scope !== 'managed') return next();
      if (!isManagedAdmin(req.principal)) return jsonError(res, 403, 'Administrator access required');
      if (!isUuid(req.params?.eventId)) return jsonError(res, 400, 'Error event id must be a UUID');
      try {
        const row = await supabase.rest('activity_logs', {
          query: {
            event_id: `eq.${req.params.eventId}`,
            action: `in.(${Object.values(ERROR_ACTION_BY_KIND).join(',')})`,
            limit: 1,
          },
          select: 'id,event_id,actor_user_id,actor_role,action,project_id,session_id,success,diagnostic_impact,diagnostic_source,metadata,created_at',
          maybeSingle: true,
        });
        if (!row) return jsonError(res, 404, 'Error log not found');
        const [hydrated] = await hydrateErrorRows(supabase, [row]);
        return res.json({
          log: formatErrorLog(hydrated, sanitizer, { detail: true }),
        });
      } catch (error) {
        logger.warn?.('[MultiUser] Error log detail failed:', error?.message || error);
        return sendErrorLogsDependencyError(res, error);
      }
    });
  };

  return { registerRoutes };
}
