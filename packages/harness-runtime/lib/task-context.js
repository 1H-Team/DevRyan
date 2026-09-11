import crypto from 'node:crypto';
import path from 'node:path';
import { createRecordStore } from './record-store.js';
import { withCrossProcessFileLock } from './atomic-file.js';
import { isManagedMaintenancePrompt } from './objective-identity.js';

const MAX_RECORD_BYTES = 64 * 1024;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const object = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const textParts = (record) => (record?.parts ?? []).filter((part) => part.type === 'text' && typeof part.text === 'string');
const isRealUser = (record) => record?.info?.role === 'user' && !isManagedMaintenancePrompt(record)
  && textParts(record).some((part) => part.synthetic !== true || part.text.startsWith('[openchamber-plan-action:v1] '));
const boundedText = (value, bytes) => {
  let result = String(value ?? '');
  if (Buffer.byteLength(result) <= bytes) return result;
  result = Buffer.from(result).subarray(0, bytes).toString('utf8');
  return result.endsWith('\uFFFD') ? result.slice(0, -1) : result;
};
const fault = (code) => Object.assign(new Error(code), { code, statusCode: 409 });
const planReference = (record) => {
  for (const part of textParts(record)) {
    if (part.synthetic !== true || !part.text.startsWith('[openchamber-plan-action:v1] ')) continue;
    try {
      const value = JSON.parse(part.text.slice('[openchamber-plan-action:v1] '.length));
      if (value.action === 'implement' && typeof value.sourceSessionId === 'string' && typeof value.sourceMessageId === 'string'
        && Number.isSafeInteger(value.planIndex) && value.planIndex >= 0) {
        return { sourceSessionId: value.sourceSessionId, sourceMessageId: value.sourceMessageId, planIndex: value.planIndex };
      }
    } catch { /* A malformed marker cannot manufacture a plan selection. */ }
  }
  return null;
};

export const validateTaskContextRecord = (record) => {
  if (!object(record) || record.schemaVersion !== 1 || !['task', 'project'].includes(record.kind)
    || typeof record.projectKey !== 'string' || !Number.isFinite(record.updatedAt)
    || Buffer.byteLength(JSON.stringify(record)) > MAX_RECORD_BYTES) throw new TypeError('Invalid bounded context record');
  if (record.kind === 'task' && (typeof record.sessionID !== 'string' || typeof record.anchor?.messageID !== 'string')) throw new TypeError('Invalid task context identity');
  if (record.kind === 'project' && (!Array.isArray(record.decisions) || record.decisions.length > 64
    || record.decisions.some((entry) => !object(entry) || typeof entry.id !== 'string' || typeof entry.statement !== 'string'
      || !object(entry.source) || typeof entry.source.sessionID !== 'string' || typeof entry.source.messageID !== 'string'
      || !['active', 'superseded'].includes(entry.state) || !Array.isArray(entry.paths)))) throw new TypeError('Invalid project decision record');
  return record;
};

// This is a replaceable view of canonical sessions, TODOs, plans and ledgers.
// Task checkpoints never authorize execution or change the recovery controller.
export const deriveTaskCheckpoint = ({ session, anchor, primary, tasks = [], envelopes = [], todos = [], decisions = [],
  projectKey, now = Date.now(), sanitizeText = (value) => value }) => {
  if (!session?.id || !isRealUser(anchor) || (anchor.info.sessionID && anchor.info.sessionID !== session.id)) throw fault('context_anchor_unavailable');
  const sourceText = textParts(anchor).map((part) => part.text).join('\n\n');
  const safeText = sanitizeText(sourceText);
  const objective = boundedText(safeText, 12 * 1024);
  const envelopeMap = new Map(envelopes.filter((entry) => entry.rootSessionId === session.id).map((entry) => [entry.taskId, entry]));
  const outstanding = tasks.filter((task) => task.rootSessionId === session.id && (['queued', 'starting', 'running'].includes(task.status)
    || envelopeMap.get(task.taskId)?.action === null));
  const children = outstanding.slice(0, 100).map((task) => {
    const envelope = envelopeMap.get(task.taskId);
    return { taskId: task.taskId, childSessionId: task.childSessionId, status: task.status,
      envelopeId: envelope?.envelopeId ?? null, action: envelope?.action ?? null,
      failureReason: task.failureReason ? boundedText(sanitizeText(task.failureReason), 512) : null,
      recovery: envelope?.autoResume ? { state: envelope.autoResume.state, nextAttemptAt: envelope.autoResume.nextAttemptAt } : null,
      checks: (task.requiredChecks ?? []).map((check) => {
        const receipt = task.requiredCheckReceipts?.find((entry) => entry.name === check.name);
        return { name: check.name, status: receipt?.status === 'failed' ? 'failed' : 'not-observed',
          lastObservation: receipt?.status ?? 'not-observed', callId: receipt?.callId ?? null,
          messageId: receipt?.messageId ?? null };
      }),
    };
  });
  const missingObjective = sourceText !== safeText || objective !== safeText;
  const checkpoint = { schemaVersion: 1, kind: 'task', sessionID: session.id, projectKey, updatedAt: now,
    anchor: { messageID: anchor.info.id, objective, complete: !missingObjective,
      reference: { sessionID: session.id, messageID: anchor.info.id } },
    selectedPlan: planReference(anchor),
    decisions: decisions.slice(0, 8),
    unresolvedWork: todos.filter((entry) => entry?.status !== 'completed' && entry?.status !== 'cancelled').slice(0, 20)
      .map((entry) => ({ id: entry.id ?? null, status: entry.status, content: boundedText(sanitizeText(entry.content ?? ''), 512) })),
    children, childCoverage: { returned: children.length, total: outstanding.length, complete: children.length === outstanding.length },
    recovery: primary && primary.anchorID === anchor.info.id ? { state: primary.state, reason: primary.reason ?? null,
      attemptCount: primary.attemptCount, todoContinuationCount: primary.todoContinuationCount ?? 0,
      cancellationGeneration: primary.cancellationGeneration, readOnly: primary.guardedIDs?.length > 0,
      activeUserID: primary.activeUserID ?? primary.recoveryID ?? primary.continuationID ?? primary.anchorID } : null,
    nextAction: missingObjective ? { kind: 'retrieve-objective', messageID: anchor.info.id }
      : children.length ? { kind: 'inspect-managed-barrier', rootSessionId: session.id }
        : { kind: 'continue-current-objective', messageID: anchor.info.id },
    authority: 'derived-view; canonical instructions, live task state and current check evidence prevail',
  };
  // Never silently truncate critical task state into a seemingly complete view.
  while (Buffer.byteLength(JSON.stringify(checkpoint)) > MAX_RECORD_BYTES && checkpoint.children.length) {
    checkpoint.children.pop(); checkpoint.childCoverage.returned--; checkpoint.childCoverage.complete = false;
  }
  if (!checkpoint.childCoverage.complete && !missingObjective) checkpoint.nextAction = { kind: 'inspect-managed-barrier', rootSessionId: session.id };
  return validateTaskContextRecord(checkpoint);
};

export const createTaskContextRuntime = (options) => {
  const now = options.now ?? Date.now;
  const sanitizeText = options.sanitizeText ?? ((value) => value);
  const store = options.store ?? createRecordStore({ directory: path.join(options.dataDirectory, 'harness', 'context'),
    validateRecord: validateTaskContextRecord, maxReadBytes: MAX_RECORD_BYTES + 4096, logger: options.logger });
  const pending = new Map();
  const operations = new Set();
  let lastPruneAt = null;
  let pruning = null;
  const pruneDerived = async (protectedKey) => {
    if (pruning) return pruning;
    if (lastPruneAt !== null && now() - lastPruneAt < 60_000) return;
    lastPruneAt = now();
    pruning = (async () => {
      const records = (await store.listRecords()).filter(({ record }) => record.kind === 'task')
        .sort((a, b) => a.record.updatedAt - b.record.updatedAt);
      let bytes = records.reduce((sum, { record }) => sum + Buffer.byteLength(JSON.stringify(record)), 0), count = records.length;
      for (const { key, record } of records) {
        if (key === protectedKey) continue;
        const reason = now() - record.updatedAt > 14 * 86400_000 ? 'derived_checkpoint_age_limit'
          : count > 512 ? 'derived_checkpoint_count_limit' : bytes > 16 * 1024 * 1024 ? 'derived_checkpoint_byte_limit' : null;
        if (!reason) continue;
        options.recordDiagnostic?.({ type: 'lifecycle', event: 'context_checkpoint_evicted', sessionID: record.sessionID,
          payload: { reason, bytes: Buffer.byteLength(JSON.stringify(record)), ageMs: now() - record.updatedAt } });
        await store.deleteRecord(key); count--; bytes -= Buffer.byteLength(JSON.stringify(record));
      }
    })().finally(() => { pruning = null; });
    return pruning;
  };
  const withLock = (key, run) => options.withLock ? options.withLock(key, run)
    : withCrossProcessFileLock(path.join(store.directory, `${key}.lock`), run);
  const scope = async (sessionID, directory) => {
    const value = await options.readScope({ sessionID, directory });
    if (!value || value.session?.id !== sessionID || value.session.directory !== directory || value.session.time?.archived
      || typeof value.projectIdentity !== 'string') throw fault('context_scope_unavailable');
    return { ...value, projectKey: hash(value.projectIdentity) };
  };
  const readDecisions = async (context, query = '') => {
    const record = await store.readRecord(`project_${context.projectKey}`);
    if (!record) return [];
    const words = new Set(String(query).toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
    const entries = await Promise.all(record.decisions.map(async (entry) => {
      const expired = Number.isFinite(entry.validUntil) && entry.validUntil <= now();
      const contentHash = entry.paths.length ? await options.fingerprintFiles(context.projectDirectory, entry.paths) : null;
      const validity = entry.state === 'superseded' ? 'superseded' : expired ? 'expired'
        : entry.paths.length && (!contentHash || contentHash !== entry.contentHash) ? 'stale' : 'active';
      const score = [...words].reduce((sum, word) => sum + (entry.statement.toLowerCase().includes(word) ? 1 : 0), 0);
      return { ...entry, validity, score };
    }));
    return entries.sort((a, b) => (a.validity === 'active' ? 0 : 1) - (b.validity === 'active' ? 0 : 1)
      || b.score - a.score || b.createdAt - a.createdAt).slice(0, 8).map(({ score: _score, ...entry }) => entry);
  };
  const checkpoint = async ({ sessionID, directory, query = '' }) => {
    const key = `${sessionID}:${directory}`;
    if (pending.has(key)) return pending.get(key);
    const operation = (async () => {
      const context = await scope(sessionID, directory);
      if (context.session.parentID) return { available: false, reason: 'child_uses_its_dispatch_brief' };
      const data = await options.readTaskState(context);
      const decisions = await readDecisions(context, query || textParts(data.anchor).map((part) => part.text).join(' ').slice(0, 2048));
      const result = deriveTaskCheckpoint({ ...data, session: context.session, projectKey: context.projectKey,
        now: now(), sanitizeText, decisions });
      const recordKey = `task_${hash(key)}`;
      await store.writeRecord(recordKey, result);
      await pruneDerived(recordKey);
      return { available: true, checkpoint: result };
    })().finally(() => pending.delete(key));
    pending.set(key, operation);
    return operation;
  };
  const rememberDecision = async (input) => {
    const context = await scope(input.sessionID, input.directory);
    if (context.session.parentID) throw fault('project_decision_requires_root');
    const statement = typeof input.statement === 'string' ? input.statement.trim() : '';
    if (!statement || Buffer.byteLength(statement) > 1024 || sanitizeText(statement) !== statement) throw fault('project_decision_invalid_statement');
    const paths = input.paths ?? [];
    if (!Array.isArray(paths) || paths.length > 16 || paths.some((entry) => typeof entry !== 'string' || !entry || entry.length > 512
      || path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..'))) throw fault('project_decision_invalid_paths');
    if (input.validUntil !== undefined && input.validUntil !== null && (!Number.isFinite(input.validUntil) || input.validUntil <= now())) throw fault('project_decision_invalid_expiry');
    const source = await options.readMessage({ sessionID: input.sessionID, directory: input.directory, messageID: input.sourceMessageID });
    if (!isRealUser(source) || source.info.id !== input.sourceMessageID || source.info.sessionID !== input.sessionID
      || !textParts(source).some((part) => part.synthetic !== true && part.text.includes(statement))) throw fault('project_decision_requires_canonical_user_quote');
    const contentHash = paths.length ? await options.fingerprintFiles(context.projectDirectory, paths) : null;
    if (paths.length && !contentHash) throw fault('project_decision_content_unavailable');
    const id = `dvr_decision_${hash(`${context.projectKey}:${input.sessionID}:${input.sourceMessageID}:${statement}`)}`;
    const key = `project_${context.projectKey}`;
    return withLock('project-decisions', async () => {
      const current = await store.readRecord(key) ?? { schemaVersion: 1, kind: 'project', projectKey: context.projectKey, updatedAt: now(), decisions: [] };
      const existing = current.decisions.find((entry) => entry.id === id);
      if (existing) return existing;
      if (input.supersedes && !current.decisions.some((entry) => entry.id === input.supersedes)) throw fault('project_decision_superseded_source_missing');
      if (current.decisions.length >= 64) throw fault('project_decision_capacity_requires_review');
      const decision = { id, statement, source: { sessionID: input.sessionID, messageID: input.sourceMessageID, kind: 'canonical-user-quote' },
        state: 'active', paths, contentHash, createdAt: now(), validUntil: input.validUntil ?? null, supersedes: input.supersedes ?? null };
      const decisions = current.decisions.map((entry) => entry.id === input.supersedes ? { ...entry, state: 'superseded', supersededBy: id } : entry);
      const next = { ...current, updatedAt: now(), decisions: [...decisions, decision] };
      if (Buffer.byteLength(JSON.stringify(next)) > MAX_RECORD_BYTES) throw fault('project_decision_capacity_requires_review');
      if (!current.decisions.length && (await store.listRecords()).filter(({ record }) => record.kind === 'project').length >= 256) throw fault('project_context_capacity_requires_review');
      await store.writeRecord(key, next);
      return decision;
    });
  };
  const track = (operation) => {
    operations.add(operation);
    void operation.finally(() => operations.delete(operation)).catch(() => {});
    return operation;
  };
  return { checkpoint: (input) => track(checkpoint(input)), rememberDecision: (input) => track(rememberDecision(input)),
    decisions: (input) => track(scope(input.sessionID, input.directory).then((context) => readDecisions(context, input.query))),
    async drain() { while (operations.size) await Promise.allSettled([...operations]); await store.drain(); } };
};
