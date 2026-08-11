import path from 'node:path';

import { stableAuditEventId } from './analytics.js';
import { classifyDiagnosticFailure } from './error-diagnostics.js';

export const ERROR_CONTEXT_TEXT_LIMIT_BYTES = 8 * 1024;

const TOOL_ACTIONS = Object.freeze({
  pending: 'tool.requested',
  running: 'tool.started',
  completed: 'tool.completed',
  error: 'tool.failed',
});

const FILE_EVENT_TYPES = new Set(['file.edited', 'file.changed', 'file.watcher.updated']);
const PATH_KEYS = new Set(['path', 'file', 'filepath', 'files', 'oldpath', 'newpath']);

const isContained = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const relativeProjectPath = (assignment, value, activeDirectory = null) => {
  if (!assignment || typeof value !== 'string' || !value.trim() || value.length > 8_192) return null;
  const candidate = value.trim();
  if (activeDirectory && path.isAbsolute(candidate) && isContained(activeDirectory, candidate)) {
    return (path.relative(activeDirectory, candidate).split(path.sep).join('/') || '.').slice(0, 1_024);
  }
  if (candidate === assignment.publicDirectory) return '.';
  if (candidate.startsWith(`${assignment.publicDirectory}/`)) {
    const relative = path.posix.normalize(candidate.slice(assignment.publicDirectory.length + 1));
    return relative === '..' || relative.startsWith('../') ? null : relative.slice(0, 1_024);
  }
  if (path.isAbsolute(candidate)) {
    if (!isContained(assignment.repositoryPath, candidate)) return null;
    return (path.relative(assignment.repositoryPath, candidate).split(path.sep).join('/') || '.').slice(0, 1_024);
  }
  const relative = path.posix.normalize(candidate.split(path.sep).join('/'));
  return relative === '..' || relative.startsWith('../') ? null : relative.slice(0, 1_024);
};

const collectPaths = (
  assignment,
  value,
  parentKey = '',
  result = new Set(),
  depth = 0,
  activeDirectory = null,
) => {
  if (!assignment || depth > 8 || result.size >= 100 || value === null || value === undefined) return result;
  if (typeof value === 'string') {
    if (PATH_KEYS.has(parentKey.toLowerCase())) {
      const relative = relativeProjectPath(assignment, value, activeDirectory);
      if (relative) result.add(relative);
    }
    return result;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPaths(assignment, entry, parentKey, result, depth + 1, activeDirectory);
    }
    return result;
  }
  if (typeof value !== 'object') return result;
  for (const [key, entry] of Object.entries(value)) {
    collectPaths(assignment, entry, key, result, depth + 1, activeDirectory);
  }
  return result;
};

const sessionIdFromPayload = (payload) => {
  const candidates = [
    payload?.properties?.sessionID,
    payload?.properties?.sessionId,
    payload?.properties?.part?.sessionID,
    payload?.properties?.part?.sessionId,
    payload?.properties?.info?.sessionID,
    payload?.properties?.info?.sessionId,
  ];
  return candidates.find((value) => typeof value === 'string' && value.trim())?.trim() || '';
};

const managedTaskFromPayload = (payload) => {
  if (payload?.type !== 'openchamber:managed-task') return null;
  const properties = payload.properties;
  if (!properties || properties.owner !== 'devryan') return null;
  const task = properties.task;
  if (!task || task.owner !== 'devryan') return null;
  return task;
};

const isFinalManagedTaskFailure = (payload) => {
  const task = managedTaskFromPayload(payload);
  if (task?.status !== 'failed' && task?.status !== 'interrupted') return false;
  if (task.agentRetryAvailable !== true) return true;
  const action = payload.properties?.resultEnvelope?.action;
  return action === 'continue' || action === 'abandon';
};

const truncateUtf8 = (value, limitBytes = ERROR_CONTEXT_TEXT_LIMIT_BYTES) => {
  const source = String(value || '');
  if (Buffer.byteLength(source, 'utf8') <= limitBytes) return source;
  let low = 0;
  let high = source.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(source.slice(0, middle), 'utf8') <= limitBytes) low = middle;
    else high = middle - 1;
  }
  return source.slice(0, low);
};

const safeString = (value, maximum = 512) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, maximum) : null;

const safeNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const safeFailureText = (value, sanitizeFailureText) => {
  const text = safeString(value, 100_000);
  if (!text) return null;
  const sanitized = typeof sanitizeFailureText === 'function' ? sanitizeFailureText(text) : text;
  return truncateUtf8(sanitized);
};

const rootAndChildContext = (sessionId, context) => {
  const rootSessionId = safeString(context?.rootSessionId) || sessionId;
  return {
    rootSessionId,
    ...(rootSessionId !== sessionId ? { childSessionId: sessionId } : {}),
  };
};

const errorMetadata = ({ error, sessionId, ownership, context, sanitizeFailureText }) => {
  const data =
    error && typeof error === 'object' && !Array.isArray(error) && error.data && typeof error.data === 'object'
      ? error.data
      : {};
  const messageContext = context?.message && typeof context.message === 'object' ? context.message : {};
  const errorName = safeString(error?.name) || 'UnknownError';
  const failureText = safeFailureText(data.message || error?.message || errorName, sanitizeFailureText);
  const providerId = safeString(data.providerID || data.providerId || messageContext.providerId);
  const modelId = safeString(messageContext.modelId);
  const agent = safeString(messageContext.agent);
  const messageId = safeString(messageContext.messageId);
  const errorCode = safeString(data.code, 160) || safeNumber(data.code);
  const statusCode = safeNumber(data.statusCode ?? data.status);
  return {
    kind: 'session',
    branch: ownership.branch_name,
    ...rootAndChildContext(sessionId, context),
    ...(messageId ? { messageId } : {}),
    ...(providerId ? { providerId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(agent ? { agent } : {}),
    errorName,
    ...(errorCode !== null ? { errorCode } : {}),
    ...(statusCode !== null ? { statusCode } : {}),
    ...(typeof data.isRetryable === 'boolean' ? { retryable: data.isRetryable } : {}),
    ...(failureText ? { failureText } : {}),
  };
};

export const isProjectableOpenCodeActivity = (payload) => {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.type === 'message.part.updated') {
    const part = payload.properties?.part;
    const status = typeof part?.state?.status === 'string' ? part.state.status.toLowerCase() : '';
    return part?.type === 'tool' && Boolean(TOOL_ACTIONS[status]);
  }
  if (payload.type === 'session.diff' || FILE_EVENT_TYPES.has(payload.type)) return true;
  if (payload.type === 'session.error') {
    return payload.properties?.error?.name !== 'MessageAbortedError';
  }
  return isFinalManagedTaskFailure(payload);
};

export const projectOpenCodeActivity = ({
  payload,
  ownership,
  assignment = null,
  context = null,
  sanitizeFailureText = null,
} = {}) => {
  if (!payload || !ownership) return null;

  const managedTask = managedTaskFromPayload(payload);
  const sessionId = managedTask ? safeString(managedTask.rootSessionId) : sessionIdFromPayload(payload);
  if (!sessionId || sessionId !== ownership.session_id) return null;

  if (payload.type === 'message.part.updated') {
    const part = payload.properties?.part;
    if (!part || part.type !== 'tool') return null;
    const status = typeof part.state?.status === 'string' ? part.state.status.toLowerCase() : '';
    const action = TOOL_ACTIONS[status];
    const partId = safeString(part.id);
    const tool = safeString(part.tool, 160);
    if (!action || !partId || !tool) return null;
    const paths = [...collectPaths(assignment, part.state?.input, '', new Set(), 0, context?.activeDirectory)];
    const failureText = status === 'error' ? safeFailureText(part.state?.error, sanitizeFailureText) : null;
    const messageId = safeString(part.messageID || payload.properties?.messageID);
    const callId = safeString(part.callID);
    const messageContext = context?.message && typeof context.message === 'object' ? context.message : {};
    const providerId = safeString(messageContext.providerId);
    const modelId = safeString(messageContext.modelId);
    const agent = safeString(messageContext.agent);
    const eventId = status === 'error' ? stableAuditEventId('tool.failed', `${sessionId}:${partId}`) : null;
    const metadata = {
      ...(status === 'error' ? { kind: 'tool' } : {}),
      tool,
      status,
      branch: ownership.branch_name,
      ...(messageId ? { messageId } : {}),
      ...(callId ? { callId } : {}),
      ...(status === 'error' ? { toolId: partId, ...rootAndChildContext(sessionId, context) } : {}),
      ...(providerId ? { providerId } : {}),
      ...(modelId ? { modelId } : {}),
      ...(agent ? { agent } : {}),
      ...(failureText ? { failureText } : {}),
      ...(paths.length > 0 ? { paths } : {}),
    };
    const classification = status === 'error'
      ? classifyDiagnosticFailure({ action, metadata })
      : null;
    if (classification) metadata.failureClass = classification.failureClass;
    return {
      dedupeKey: eventId || `tool:${sessionId}:${partId}:${status}`,
      action,
      details: {
        ...(eventId ? { eventId } : {}),
        targetType: 'tool',
        targetId: partId,
        projectId: ownership.project_id,
        sessionId,
        success: status !== 'error',
        ...(classification ? {
          diagnosticImpact: classification.impact,
          diagnosticSource: classification.source,
        } : {}),
        metadata,
      },
    };
  }

  if (payload.type === 'session.error') {
    const error = payload.properties?.error;
    if (error?.name === 'MessageAbortedError') return null;
    const metadata = errorMetadata({ error, sessionId, ownership, context, sanitizeFailureText });
    const sourceId =
      safeString(payload.id) ||
      `${sessionId}:${metadata.messageId || ''}:${metadata.errorName}:${metadata.failureText || ''}`;
    const eventId = stableAuditEventId('session.error', sourceId);
    const classification = classifyDiagnosticFailure({ action: 'session.error', metadata });
    metadata.failureClass = classification.failureClass;
    return {
      dedupeKey: eventId,
      eventId,
      action: 'session.error',
      details: {
        eventId,
        targetType: 'session',
        targetId: sessionId,
        projectId: ownership.project_id,
        sessionId,
        success: false,
        diagnosticImpact: classification.impact,
        diagnosticSource: classification.source,
        metadata,
      },
    };
  }

  if (managedTask) {
    if (!isFinalManagedTaskFailure(payload)) return null;
    const taskId = safeString(managedTask.taskId);
    if (!taskId) return null;
    const failureText = safeFailureText(managedTask.failureReason, sanitizeFailureText);
    const childSessionId = safeString(managedTask.childSessionId);
    const eventId = stableAuditEventId(
      'managed_task.failed',
      `${taskId}:${Number.isSafeInteger(managedTask.sequence) ? managedTask.sequence : ''}:${managedTask.status}`,
    );
    const metadata = {
      kind: 'managed_task',
      branch: ownership.branch_name,
      rootSessionId: sessionId,
      ...(childSessionId ? { childSessionId } : {}),
      taskId,
      ...(safeString(managedTask.priorTaskId) ? { priorTaskId: safeString(managedTask.priorTaskId) } : {}),
      status: managedTask.status,
      ...(safeString(managedTask.providerId) ? { providerId: safeString(managedTask.providerId) } : {}),
      ...(safeString(managedTask.modelId) ? { modelId: safeString(managedTask.modelId) } : {}),
      ...(safeString(managedTask.agent) ? { agent: safeString(managedTask.agent) } : {}),
      ...(safeString(managedTask.failureKind, 160)
        ? { failureKind: safeString(managedTask.failureKind, 160) }
        : {}),
      ...(safeString(managedTask.executionKind, 160)
        ? { executionKind: safeString(managedTask.executionKind, 160) }
        : {}),
      ...(Number.isSafeInteger(managedTask.attempt) ? { attempt: managedTask.attempt } : {}),
      ...(typeof managedTask.partial === 'boolean' ? { partial: managedTask.partial } : {}),
      ...(failureText ? { failureText } : {}),
    };
    const classification = classifyDiagnosticFailure({ action: 'managed_task.failed', metadata });
    metadata.failureClass = classification.failureClass;
    return {
      dedupeKey: eventId,
      eventId,
      action: 'managed_task.failed',
      details: {
        eventId,
        targetType: 'managed_task',
        targetId: taskId,
        projectId: ownership.project_id,
        sessionId,
        success: false,
        diagnosticImpact: classification.impact,
        diagnosticSource: classification.source,
        metadata,
      },
    };
  }

  if (payload.type === 'session.diff') {
    const paths = [...collectPaths(
      assignment,
      payload.properties?.diff,
      'files',
      new Set(),
      0,
      context?.activeDirectory,
    )].sort();
    if (paths.length === 0) return null;
    return {
      dedupeKey: `files:${sessionId}:${paths.join('\u0000')}`,
      action: 'file.change_summary',
      details: {
        targetType: 'session',
        targetId: sessionId,
        projectId: ownership.project_id,
        sessionId,
        metadata: { branch: ownership.branch_name, paths },
      },
    };
  }

  if (FILE_EVENT_TYPES.has(payload.type)) {
    const paths = [...collectPaths(
      assignment,
      payload.properties,
      'files',
      new Set(),
      0,
      context?.activeDirectory,
    )].sort();
    if (paths.length === 0) return null;
    return {
      dedupeKey: `file-event:${payload.type}:${sessionId}:${paths.join('\u0000')}`,
      action: 'file.changed',
      details: {
        targetType: 'session',
        targetId: sessionId,
        projectId: ownership.project_id,
        sessionId,
        metadata: { branch: ownership.branch_name, paths },
      },
    };
  }

  return null;
};
