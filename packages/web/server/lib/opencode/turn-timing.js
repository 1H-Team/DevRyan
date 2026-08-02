import crypto from 'node:crypto';

import { createLifecycleTracker } from '@openchamber/harness-runtime';
import { classifyProviderTransportFailure } from '@openchamber/orchestration-runtime';

import {
  createHarnessError,
  createHarnessSuccess,
  withHarnessResult,
} from './harness-result.js';

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;
const DEFAULT_MAX_TOOL_CALLS = 20;
const MALFORMED_TOOL_CALL_MARKER = 'Skipped malformed tool call "';
const TOOL_LOOP_GUARD_MARKER = 'Tool loop guard stopped repeated schema-invalid calls to "';

const KNOWN_TURN_MARKS = new Set([
  'send_started',
  'cursor_draft_session_create_started',
  'cursor_draft_session_created',
  'cursor_prewarm_started',
  'cursor_prewarm_completed',
  'cursor_agent_prepare_started',
  'cursor_agent_prepared',
  'cursor_baseline_diff_deferred',
  'cursor_workspace_repair_started',
  'cursor_workspace_repair_completed',
  'prompt_request_started',
  'prompt_accepted',
  'cursor_worker_spawned',
  'cursor_worker_first_event',
  'cursor_worker_ready',
  'cursor_run_create_started',
  'cursor_run_created',
  'cursor_provider_send_started',
  'cursor_provider_send_accepted',
  'cursor_first_sdk_delta',
  'cursor_first_stream_event',
  'cursor_first_emitted_text_delta',
  'session_status_busy',
  'assistant_message_created',
  'first_part_updated',
  'first_step_start',
  'first_tool_started',
  'first_tool_completed',
  'first_text_delta',
  'assistant_message_completed',
  'session_status_idle',
  'renderer_event_received',
  'renderer_first_assistant_part_reduced',
  'renderer_first_visible_text_committed',
  'renderer_assistant_completion_observed',
  'renderer_status_idle_visible',
  'renderer_tool_input_stall_confirmed',
  'renderer_provider_inference_stall_confirmed',
  'cursor_abort_requested',
]);

const DURATION_PAIRS = [
  ['cursor_draft_session_create_started', 'cursor_draft_session_created'],
  ['cursor_prewarm_started', 'cursor_prewarm_completed'],
  ['cursor_agent_prepare_started', 'cursor_agent_prepared'],
  ['send_started', 'cursor_workspace_repair_started'],
  ['send_started', 'prompt_request_started'],
  ['send_started', 'prompt_accepted'],
  ['cursor_workspace_repair_started', 'cursor_workspace_repair_completed'],
  ['cursor_workspace_repair_completed', 'prompt_request_started'],
  ['prompt_request_started', 'prompt_accepted'],
  ['prompt_accepted', 'cursor_worker_spawned'],
  ['prompt_accepted', 'cursor_worker_first_event'],
  ['prompt_accepted', 'cursor_worker_ready'],
  ['prompt_accepted', 'cursor_baseline_diff_deferred'],
  ['prompt_accepted', 'cursor_run_create_started'],
  ['prompt_accepted', 'cursor_run_created'],
  ['prompt_accepted', 'cursor_first_sdk_delta'],
  ['prompt_accepted', 'cursor_first_stream_event'],
  ['prompt_accepted', 'cursor_first_emitted_text_delta'],
  ['cursor_worker_spawned', 'cursor_worker_first_event'],
  ['cursor_worker_ready', 'cursor_run_create_started'],
  ['cursor_run_create_started', 'cursor_run_created'],
  ['cursor_run_created', 'cursor_provider_send_started'],
  ['cursor_provider_send_started', 'cursor_provider_send_accepted'],
  ['cursor_provider_send_accepted', 'cursor_first_sdk_delta'],
  ['cursor_provider_send_accepted', 'cursor_first_stream_event'],
  ['cursor_run_created', 'cursor_first_sdk_delta'],
  ['cursor_run_created', 'cursor_first_stream_event'],
  ['cursor_first_sdk_delta', 'first_text_delta'],
  ['cursor_first_stream_event', 'first_text_delta'],
  ['cursor_first_sdk_delta', 'cursor_first_emitted_text_delta'],
  ['cursor_first_stream_event', 'cursor_first_emitted_text_delta'],
  ['prompt_accepted', 'session_status_busy'],
  ['prompt_accepted', 'assistant_message_created'],
  ['prompt_accepted', 'first_part_updated'],
  ['prompt_accepted', 'first_step_start'],
  ['prompt_accepted', 'first_tool_started'],
  ['prompt_accepted', 'first_tool_completed'],
  ['prompt_accepted', 'first_text_delta'],
  ['prompt_accepted', 'assistant_message_completed'],
  ['prompt_accepted', 'renderer_event_received'],
  ['prompt_accepted', 'renderer_first_assistant_part_reduced'],
  ['prompt_accepted', 'renderer_first_visible_text_committed'],
  ['first_text_delta', 'renderer_event_received'],
  ['first_text_delta', 'renderer_first_assistant_part_reduced'],
  ['first_text_delta', 'renderer_first_visible_text_committed'],
  ['assistant_message_created', 'first_part_updated'],
  ['assistant_message_created', 'first_text_delta'],
  ['renderer_event_received', 'renderer_first_assistant_part_reduced'],
  ['renderer_first_assistant_part_reduced', 'renderer_first_visible_text_committed'],
  ['assistant_message_completed', 'renderer_assistant_completion_observed'],
  ['assistant_message_completed', 'session_status_idle'],
  ['assistant_message_completed', 'renderer_status_idle_visible'],
  ['renderer_assistant_completion_observed', 'renderer_status_idle_visible'],
];

const FINAL_TOOL_STATUSES = new Set(['completed', 'complete', 'done', 'error', 'failed', 'aborted', 'timeout', 'timedout', 'cancelled', 'canceled']);
const ACTIVE_TOOL_STATUSES = new Set(['running', 'started', 'inprogress', 'pending', 'processing', 'executing']);
const MUTATING_TOOL_NAMES = new Set([
  'edit',
  'multiedit',
  'apply_patch',
  'str_replace',
  'str_replace_based_edit_tool',
  'write',
  'create',
  'file_write',
]);
const TOOL_NAME_ALIASES = new Map([
  ['applypatch', 'apply_patch'],
  ['apply_patch_tool', 'apply_patch'],
  ['patch', 'apply_patch'],
  ['file_patch', 'apply_patch'],
  ['patch_file', 'apply_patch'],
  ['apply_diff', 'apply_patch'],
  ['edit_file', 'edit'],
  ['file_edit', 'edit'],
  ['write_file', 'write'],
  ['create_file', 'create'],
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function normalizeToolStatus(status) {
  const value = normalizeString(status);
  return value ? value.toLowerCase().replace(/[\s_-]+/g, '') : '';
}

function isFinalToolStatus(status) {
  const normalized = normalizeToolStatus(status);
  return normalized ? FINAL_TOOL_STATUSES.has(normalized) : false;
}

function isActiveToolStatus(status) {
  const normalized = normalizeToolStatus(status);
  return normalized ? ACTIVE_TOOL_STATUSES.has(normalized) : false;
}

function normalizeToolName(toolName) {
  const trimmed = normalizeString(toolName);
  if (!trimmed) return '';

  let normalized = trimmed.replace(/:\d+$/, '');
  if (normalized.includes('.')) {
    const parts = normalized.split('.').filter(Boolean);
    normalized = parts[parts.length - 1] || normalized;
  }

  normalized = normalized
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase()
    .replace(/_?tool_?call$/, '');

  return TOOL_NAME_ALIASES.get(normalized) || normalized;
}

function normalizeDirectory(value) {
  const directory = normalizeString(value);
  return directory || null;
}

function normalizeMark(value) {
  const mark = normalizeString(value);
  return KNOWN_TURN_MARKS.has(mark) ? mark : '';
}

function getEventProperties(payload) {
  return isObject(payload?.properties) ? payload.properties : {};
}

function getStatusType(properties) {
  const status = isObject(properties.status) ? properties.status : {};
  const info = isObject(properties.info) ? properties.info : {};
  return normalizeString(status.type) || normalizeString(info.type);
}

function getMessageInfo(properties) {
  if (isObject(properties.info)) return properties.info;
  if (isObject(properties.message)) return properties.message;
  return {};
}

function getPartInfo(properties) {
  if (isObject(properties.part)) return properties.part;
  return {};
}

function getToolStateStatus(part) {
  const state = isObject(part.state) ? part.state : {};
  return normalizeToolStatus(state.status || state.type);
}

function markName(start, end) {
  return `${start}_to_${end}`;
}

function sanitizeBoolean(value) {
  return value === true ? true : value === false ? false : undefined;
}

function sanitizeClientMarkMetadata(mark, metadata) {
  if (!isObject(metadata)) return undefined;

  const sanitized = {};
  for (const key of ['providerID', 'modelID', 'agent', 'variant']) {
    if (typeof metadata[key] === 'string' && metadata[key].trim()) {
      sanitized[key] = metadata[key].trim();
    } else if (metadata[key] === null) {
      sanitized[key] = null;
    }
  }

  if (mark === 'cursor_workspace_repair_completed') {
    const changed = sanitizeBoolean(metadata.changed);
    const restarted = sanitizeBoolean(metadata.restarted);
    const cached = sanitizeBoolean(metadata.cached);
    const failed = sanitizeBoolean(metadata.failed);
    if (typeof changed === 'boolean') sanitized.changed = changed;
    if (typeof restarted === 'boolean') sanitized.restarted = restarted;
    if (typeof cached === 'boolean') sanitized.cached = cached;
    if (typeof failed === 'boolean') sanitized.failed = failed;
  }

  if (mark.startsWith('renderer_')) {
    for (const key of ['runtime', 'transport', 'visibilityState', 'source']) {
      if (typeof metadata[key] === 'string' && metadata[key].trim()) {
        sanitized[key] = metadata[key].trim();
      }
    }
    const stalledForMs = metadata.stalledForMs;
    if (typeof stalledForMs === 'number' && Number.isFinite(stalledForMs) && stalledForMs >= 0) {
      sanitized.stalledForMs = Math.trunc(stalledForMs);
    }
  }

  if (mark === 'cursor_abort_requested') {
    const source = normalizeString(metadata.source);
    if (source) sanitized.source = source;
  }

  if (mark === 'cursor_worker_ready') {
    const workerMode = normalizeString(metadata.workerMode);
    if (workerMode) sanitized.workerMode = workerMode;
  }

  if (
    mark === 'cursor_prewarm_completed'
    || mark === 'cursor_agent_prepared'
  ) {
    const cacheHit = sanitizeBoolean(metadata.cacheHit);
    const ok = sanitizeBoolean(metadata.ok);
    if (typeof cacheHit === 'boolean') sanitized.cacheHit = cacheHit;
    if (typeof ok === 'boolean') sanitized.ok = ok;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function cloneMetadata(metadata) {
  return isObject(metadata) ? { ...metadata } : undefined;
}

function sanitizeCursorWorkspaceRepair(metadata) {
  if (!isObject(metadata)) return null;
  return {
    changed: metadata.changed === true,
    restarted: metadata.restarted === true,
  };
}

function parseDiffCount(value) {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function getSummaryDiffTotals(summary) {
  if (!isObject(summary)) {
    return { additions: 0, deletions: 0 };
  }
  let additions = parseDiffCount(summary.additions);
  let deletions = parseDiffCount(summary.deletions);
  if (Array.isArray(summary.diffs)) {
    for (const diff of summary.diffs) {
      if (!isObject(diff)) continue;
      additions += parseDiffCount(diff.additions);
      deletions += parseDiffCount(diff.deletions);
    }
  }
  return { additions, deletions };
}

function hasMutationEvidence(summary) {
  const totals = getSummaryDiffTotals(summary);
  return totals.additions > 0 || totals.deletions > 0;
}

function buildTextDeltaSignature(delta) {
  const trimmed = delta.trim();
  if (trimmed.length < 20) {
    return null;
  }
  const hash = crypto.createHash('sha256').update(trimmed).digest('hex');
  return `${trimmed.length}:${hash}`;
}

function getPromptAcceptedMetadata(record) {
  const metadata = record?.marks?.prompt_accepted?.metadata;
  if (!isObject(metadata)) {
    return undefined;
  }
  const providerID = normalizeString(metadata.providerID);
  const modelID = normalizeString(metadata.modelID);
  const agent = normalizeString(metadata.agent);
  const variant = normalizeString(metadata.variant);
  if (!providerID && !modelID && !agent && !variant) {
    return undefined;
  }
  return {
    providerID: providerID || null,
    modelID: modelID || null,
    agent: agent || null,
    variant: variant || null,
  };
}

function createTurnTimingRuntime(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const maxRecords = Number.isFinite(options.maxRecords) && options.maxRecords > 0
    ? Math.trunc(options.maxRecords)
    : DEFAULT_MAX_RECORDS;
  const maxAgeMs = Number.isFinite(options.maxAgeMs) && options.maxAgeMs > 0
    ? Math.trunc(options.maxAgeMs)
    : DEFAULT_MAX_AGE_MS;
  const maxToolCalls = Number.isFinite(options.maxToolCalls) && options.maxToolCalls > 0
    ? Math.trunc(options.maxToolCalls)
    : DEFAULT_MAX_TOOL_CALLS;
  const lifecycleTracker = options.lifecycleTracker ?? createLifecycleTracker({
    clock: now,
    onTurnEvent: options.onTurnEvent,
  });

  const records = [];
  const recordsByUserMessage = new Map();
  const recordsByAssistantMessage = new Map();
  const activeTurnsBySession = new Map();

  const userKey = (sessionId, messageId) => `${sessionId}\n${messageId}`;

  const removeRecord = (record) => {
    const index = records.indexOf(record);
    if (index >= 0) records.splice(index, 1);
    if (record.sessionId && record.userMessageId) {
      recordsByUserMessage.delete(userKey(record.sessionId, record.userMessageId));
    }
    if (record.assistantMessageId) {
      recordsByAssistantMessage.delete(record.assistantMessageId);
    }
    if (activeTurnsBySession.get(record.sessionId)?.record === record) {
      activeTurnsBySession.delete(record.sessionId);
    }
  };

  const pruneRecords = () => {
    const timestamp = now();
    for (const record of [...records]) {
      if (timestamp - record.updatedAt > maxAgeMs) {
        removeRecord(record);
      }
    }

    while (records.length > maxRecords) {
      removeRecord(records[0]);
    }
  };

  const indexRecord = (record) => {
    if (record.sessionId && record.userMessageId) {
      recordsByUserMessage.set(userKey(record.sessionId, record.userMessageId), record);
    }
    if (record.assistantMessageId) {
      recordsByAssistantMessage.set(record.assistantMessageId, record);
    }
  };

  const findLatestRecordForSession = (sessionId, predicate = () => true) => {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      if (record.sessionId === sessionId && predicate(record)) {
        return record;
      }
    }
    return null;
  };

  const getOrCreateUserRecord = ({ sessionId, userMessageId, directory }) => {
    const normalizedSessionId = normalizeString(sessionId);
    const normalizedUserMessageId = normalizeString(userMessageId);
    if (!normalizedSessionId) return null;

    if (normalizedUserMessageId) {
      const existing = recordsByUserMessage.get(userKey(normalizedSessionId, normalizedUserMessageId));
      if (existing) {
        if (directory) existing.directory = normalizeDirectory(directory);
        return existing;
      }
    } else {
      const existing = findLatestRecordForSession(normalizedSessionId, (item) => (
        !item.userMessageId
        && !item.assistantMessageId
        && !item.marks.assistant_message_completed
      ));
      if (existing) {
        if (directory) existing.directory = normalizeDirectory(directory);
        return existing;
      }
    }

    const timestamp = now();
    const record = {
      sessionId: normalizedSessionId,
      userMessageId: normalizedUserMessageId || null,
      assistantMessageId: null,
      directory: normalizeDirectory(directory),
      marks: {},
      diagnostics: {
        malformedToolCallCount: 0,
        toolLoopGuardCount: 0,
        repeatedTextFrameCount: 0,
        mutationEvidence: false,
        cursorWorkspaceRepair: null,
        mutatingToolCalls: [],
        terminalFailure: null,
        concurrency: {
          evidenceOnly: true,
          atAcceptance: null,
          atTerminalFailure: null,
        },
      },
      toolCalls: [],
      latestToolCall: null,
      toolCallOrdinal: 0,
      lastTextDeltaSignaturesByPart: {},
      pendingTerminalFailure: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    records.push(record);
    indexRecord(record);
    pruneRecords();
    return record;
  };

  const claimLatestUnassignedUserRecord = ({ sessionId, userMessageId }) => {
    const record = findLatestRecordForSession(sessionId, (item) => (
      !item.userMessageId
      && !item.assistantMessageId
      && !item.marks.assistant_message_completed
    ));
    if (!record) return null;
    record.userMessageId = userMessageId;
    indexRecord(record);
    return record;
  };

  const getOrCreateAssistantRecord = ({ sessionId, assistantMessageId, userMessageId }) => {
    const normalizedSessionId = normalizeString(sessionId);
    const normalizedAssistantMessageId = normalizeString(assistantMessageId);
    const normalizedUserMessageId = normalizeString(userMessageId);

    if (normalizedAssistantMessageId && recordsByAssistantMessage.has(normalizedAssistantMessageId)) {
      const existing = recordsByAssistantMessage.get(normalizedAssistantMessageId);
      if (normalizedUserMessageId && !existing.userMessageId && normalizedSessionId) {
        existing.userMessageId = normalizedUserMessageId;
        indexRecord(existing);
      }
      return existing;
    }

    let record = normalizedSessionId && normalizedUserMessageId
      ? recordsByUserMessage.get(userKey(normalizedSessionId, normalizedUserMessageId))
      : null;

    if (!record && normalizedSessionId && normalizedUserMessageId) {
      record = claimLatestUnassignedUserRecord({
        sessionId: normalizedSessionId,
        userMessageId: normalizedUserMessageId,
      });
    }

    if (!record && normalizedSessionId) {
      record = getOrCreateUserRecord({
        sessionId: normalizedSessionId,
        userMessageId: normalizedUserMessageId,
        directory: null,
      });
    }

    if (record && normalizedAssistantMessageId) {
      if (record.assistantMessageId && record.assistantMessageId !== normalizedAssistantMessageId) {
        recordsByAssistantMessage.delete(record.assistantMessageId);
      }
      record.assistantMessageId = normalizedAssistantMessageId;
      indexRecord(record);
    }

    return record;
  };

  const setMark = (record, mark, metadata, sanitizeMetadata = false) => {
    if (!record || !mark || record.marks[mark]) return false;
    const timestamp = now();
    const entry = { at: timestamp };
    const clonedMetadata = sanitizeMetadata
      ? sanitizeClientMarkMetadata(mark, metadata)
      : cloneMetadata(metadata);
    if (clonedMetadata) entry.metadata = clonedMetadata;
    record.marks[mark] = entry;
    if (mark === 'cursor_workspace_repair_completed') {
      record.diagnostics.cursorWorkspaceRepair = sanitizeCursorWorkspaceRepair(metadata);
    }
    record.updatedAt = timestamp;
    pruneRecords();
    return true;
  };

  const captureConcurrency = (providerID) => {
    const normalizedProviderID = normalizeString(providerID);
    let activeSameProvider = null;
    if (normalizedProviderID) {
      activeSameProvider = 0;
      for (const active of activeTurnsBySession.values()) {
        if (active.providerID === normalizedProviderID) {
          activeSameProvider += 1;
        }
      }
    }
    return {
      activeTotal: activeTurnsBySession.size,
      activeSameProvider,
    };
  };

  const activateAcceptedTurn = (record) => {
    const model = getPromptAcceptedMetadata(record);
    const providerID = normalizeString(model?.providerID);
    activeTurnsBySession.set(record.sessionId, {
      record,
      providerID,
    });
    record.diagnostics.concurrency.atAcceptance = captureConcurrency(providerID);
  };

  const buildTerminalFailure = (record, info) => {
    if (!record || !isObject(info.error)) return null;
    const error = info.error;
    const errorData = isObject(error.data) ? error.data : {};
    const errorName = normalizeString(error.name);
    const errorDetail = normalizeString(errorData.message)
      || normalizeString(error.message)
      || errorName;
    if (!errorName && !errorDetail) return null;

    const time = isObject(info.time) ? info.time : {};
    const createdAt = typeof time.created === 'number' && Number.isFinite(time.created)
      ? time.created
      : null;
    const completedAt = typeof time.completed === 'number' && Number.isFinite(time.completed)
      ? time.completed
      : null;
    const acceptedAt = record.marks.prompt_accepted?.at;
    const fallbackCompletedAt = completedAt ?? now();
    const elapsedMs = createdAt !== null && fallbackCompletedAt >= createdAt
      ? fallbackCompletedAt - createdAt
      : typeof acceptedAt === 'number' && fallbackCompletedAt >= acceptedAt
        ? fallbackCompletedAt - acceptedAt
        : null;
    return {
      kind: classifyProviderTransportFailure(errorName, errorDetail),
      elapsedMs,
    };
  };

  const captureTerminalFailure = (record, terminalFailure) => {
    if (!record || record.diagnostics.terminalFailure || !terminalFailure) return;
    const providerID = getPromptAcceptedMetadata(record)?.providerID;

    record.diagnostics.terminalFailure = terminalFailure;
    record.diagnostics.concurrency.atTerminalFailure = captureConcurrency(providerID);
    record.updatedAt = now();
  };

  const recordMutatingToolCall = (record, toolName, status) => {
    const tool = normalizeToolName(toolName);
    if (!tool || !MUTATING_TOOL_NAMES.has(tool)) return;
    const normalizedStatus = normalizeToolStatus(status) || null;
    const final = isFinalToolStatus(normalizedStatus);
    const entry = { tool, status: normalizedStatus, final };
    const existing = record.diagnostics.mutatingToolCalls.find((item) => (
      item.tool === entry.tool && item.status === entry.status && item.final === entry.final
    ));
    if (existing) return;
    if (record.diagnostics.mutatingToolCalls.length >= 20) {
      record.diagnostics.mutatingToolCalls.shift();
    }
    record.diagnostics.mutatingToolCalls.push(entry);
  };

  const recordToolCall = (record, part, properties, toolName, status) => {
    const callId = normalizeString(part.callID || part.callId || properties.callID || properties.callId);
    const partId = normalizeString(part.id || properties.partID || properties.partId);
    const identities = [
      callId ? `call:${callId}` : '',
      partId ? `part:${partId}` : '',
    ].filter(Boolean);
    if (identities.length === 0) return;

    let entry = record.toolCalls.find((toolCall) => (
      identities.some((identity) => toolCall.identities.has(identity))
    ));
    if (
      !entry
      && record.latestToolCall
      && identities.some((identity) => record.latestToolCall.identities.has(identity))
    ) {
      entry = record.latestToolCall;
    }
    if (!entry) {
      record.toolCallOrdinal += 1;
      entry = {
        identities: new Set(),
        ordinal: record.toolCallOrdinal,
        tool: '',
        status: null,
        final: false,
      };
      if (record.toolCalls.length < maxToolCalls) {
        record.toolCalls.push(entry);
      }
    }
    for (const identity of identities) entry.identities.add(identity);

    const tool = normalizeToolName(toolName);
    const normalizedStatus = normalizeToolStatus(status);
    if (tool) entry.tool = tool;
    if (normalizedStatus && (!entry.final || isFinalToolStatus(normalizedStatus))) {
      entry.status = normalizedStatus;
      entry.final = isFinalToolStatus(normalizedStatus);
    }
    record.latestToolCall = entry;
    record.updatedAt = now();
    pruneRecords();
  };

  const processSessionStatus = (properties) => {
    const sessionId = normalizeString(properties.sessionID || properties.sessionId);
    const statusType = getStatusType(properties).toLowerCase();
    if (!sessionId || !statusType) return;

    if (statusType === 'busy' || statusType === 'retry') {
      const record = findLatestRecordForSession(sessionId, (item) => !item.marks.session_status_idle);
      setMark(record, 'session_status_busy', { status: statusType });
      return;
    }

    if (statusType === 'idle') {
      const record = findLatestRecordForSession(sessionId, (item) => !item.marks.session_status_idle);
      if (record?.pendingTerminalFailure) {
        captureTerminalFailure(record, record.pendingTerminalFailure);
        record.pendingTerminalFailure = null;
      }
      setMark(record, 'session_status_idle', { status: statusType });
      activeTurnsBySession.delete(sessionId);
    }
  };

  const processMessageUpdated = (properties) => {
    const info = getMessageInfo(properties);
    const role = normalizeString(info.role);

    const sessionId = normalizeString(info.sessionID || info.sessionId || properties.sessionID || properties.sessionId);
    const messageId = normalizeString(info.id || properties.messageID || properties.messageId);
    const userMessageId = normalizeString(info.parentID || info.parentId);
    if (!sessionId || !messageId) return;

    if (hasMutationEvidence(info.summary)) {
      const existingRecord = role === 'assistant'
        ? getOrCreateAssistantRecord({ sessionId, assistantMessageId: messageId, userMessageId })
        : recordsByUserMessage.get(userKey(sessionId, messageId)) || findLatestRecordForSession(sessionId);
      if (existingRecord) {
        existingRecord.diagnostics.mutationEvidence = true;
      }
    }

    if (role !== 'assistant') return;

    const record = getOrCreateAssistantRecord({ sessionId, assistantMessageId: messageId, userMessageId });
    setMark(record, 'assistant_message_created', { messageId });

    const time = isObject(info.time) ? info.time : {};
    if (typeof time.completed === 'number' && Number.isFinite(time.completed) && time.completed > 0) {
      setMark(record, 'assistant_message_completed', {
        messageId,
        finish: normalizeString(info.finish) || undefined,
      });
      record.pendingTerminalFailure = buildTerminalFailure(record, info);
      if (record.marks.session_status_idle && record.pendingTerminalFailure) {
        captureTerminalFailure(record, record.pendingTerminalFailure);
        record.pendingTerminalFailure = null;
      }
    }
  };

  const processSessionUpdated = (properties) => {
    const info = isObject(properties.info) ? properties.info : {};
    const sessionId = normalizeString(info.id || properties.sessionID || properties.sessionId);
    if (!sessionId || !hasMutationEvidence(info.summary)) return;
    const record = findLatestRecordForSession(sessionId);
    if (record) {
      record.diagnostics.mutationEvidence = true;
    }
  };

  const processPartUpdated = (properties) => {
    const part = getPartInfo(properties);
    const assistantMessageId = normalizeString(part.messageID || part.messageId || properties.messageID || properties.messageId);
    if (!assistantMessageId) return;

    const partType = normalizeString(part.type);
    const existingRecord = recordsByAssistantMessage.get(assistantMessageId);
    if (!existingRecord && partType === 'text') return;

    const record = existingRecord
      || getOrCreateAssistantRecord({
        sessionId: part.sessionID || part.sessionId || properties.sessionID || properties.sessionId,
        assistantMessageId,
        userMessageId: null,
      });
    if (!record) return;

    setMark(record, 'first_part_updated', { partId: normalizeString(part.id || properties.partID || properties.partId), type: partType });

    if (partType === 'text' || partType === 'reasoning') {
      const text = typeof part.text === 'string' ? part.text : '';
      if (text.length > 0) {
        setMark(record, 'first_text_delta', {
          partId: normalizeString(part.id || properties.partID || properties.partId),
          source: 'part_updated',
        });
      }
    }

    if (partType === 'step-start') {
      setMark(record, 'first_step_start', { partId: normalizeString(part.id || properties.partID || properties.partId) });
      return;
    }

    if (partType !== 'tool') return;
    const toolName = part.tool || part.name || properties.tool;
    const status = getToolStateStatus(part);
    recordToolCall(record, part, properties, toolName, status);
    recordMutatingToolCall(record, toolName, status);
    if (isActiveToolStatus(status)) {
      setMark(record, 'first_tool_started', { partId: normalizeString(part.id || properties.partID || properties.partId), status });
      return;
    }
    if (isFinalToolStatus(status)) {
      setMark(record, 'first_tool_completed', { partId: normalizeString(part.id || properties.partID || properties.partId), status });
    }
  };

  const processPartDelta = (properties) => {
    const field = normalizeString(properties.field);
    if (field && field !== 'text') return;
    const delta = properties.delta;
    if (typeof delta !== 'string' || delta.length === 0) return;

    const part = getPartInfo(properties);
    const assistantMessageId = normalizeString(properties.messageID || properties.messageId || part.messageID || part.messageId);
    if (!assistantMessageId) return;

    const record = recordsByAssistantMessage.get(assistantMessageId)
      || getOrCreateAssistantRecord({
        sessionId: properties.sessionID || properties.sessionId || part.sessionID || part.sessionId,
        assistantMessageId,
        userMessageId: null,
      });
    if (record) {
      if (delta.includes(MALFORMED_TOOL_CALL_MARKER)) {
        record.diagnostics.malformedToolCallCount += 1;
      }
      if (delta.includes(TOOL_LOOP_GUARD_MARKER)) {
        record.diagnostics.toolLoopGuardCount += 1;
      }
      const partId = normalizeString(properties.partID || properties.partId || part.id);
      const signature = buildTextDeltaSignature(delta);
      if (signature && partId) {
        if (record.lastTextDeltaSignaturesByPart[partId] === signature) {
          record.diagnostics.repeatedTextFrameCount += 1;
        }
        record.lastTextDeltaSignaturesByPart[partId] = signature;
      }
    }
    setMark(record, 'first_text_delta', {
      partId: normalizeString(properties.partID || properties.partId || part.id),
    });
  };

  const buildDurations = (marks) => {
    const durations = {};
    for (const [start, end] of DURATION_PAIRS) {
      if (!marks[start] || !marks[end]) continue;
      const durationMs = marks[end].at - marks[start].at;
      if (Number.isFinite(durationMs) && durationMs >= 0) {
        durations[markName(start, end)] = durationMs;
      }
    }
    return durations;
  };

  const toRecordResponse = (record) => ({
    sessionId: record.sessionId,
    userMessageId: record.userMessageId,
    assistantMessageId: record.assistantMessageId,
    directory: record.directory,
    model: getPromptAcceptedMetadata(record),
    diagnostics: {
      ...record.diagnostics,
      cursorWorkspaceRepair: record.diagnostics.cursorWorkspaceRepair
        ? { ...record.diagnostics.cursorWorkspaceRepair }
        : null,
      mutatingToolCalls: record.diagnostics.mutatingToolCalls.map((item) => ({ ...item })),
      terminalFailure: record.diagnostics.terminalFailure
        ? { ...record.diagnostics.terminalFailure }
        : null,
      concurrency: {
        evidenceOnly: true,
        atAcceptance: record.diagnostics.concurrency.atAcceptance
          ? { ...record.diagnostics.concurrency.atAcceptance }
          : null,
        atTerminalFailure: record.diagnostics.concurrency.atTerminalFailure
          ? { ...record.diagnostics.concurrency.atTerminalFailure }
          : null,
      },
      toolCalls: record.toolCalls.map((item) => ({
        ordinal: item.ordinal,
        tool: item.tool,
        status: item.status,
        final: item.final,
      })),
      latestToolCall: record.latestToolCall
        ? {
            ordinal: record.latestToolCall.ordinal,
            tool: record.latestToolCall.tool,
            status: record.latestToolCall.status,
            final: record.latestToolCall.final,
          }
        : null,
    },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    marks: Object.fromEntries(Object.entries(record.marks).map(([mark, value]) => [mark, { ...value }])),
    durationsMs: buildDurations(record.marks),
  });

  return {
    recordClientMark(input = {}) {
      const sessionId = normalizeString(input.sessionId);
      const messageId = normalizeString(input.messageId || input.messageID);
      const assistantMessageId = normalizeString(input.assistantMessageId || input.assistantMessageID);
      const mark = normalizeMark(input.mark);
      if ((!sessionId && !assistantMessageId) || !mark) {
        return false;
      }

      const record = assistantMessageId
        ? recordsByAssistantMessage.get(assistantMessageId)
          || (sessionId
            ? getOrCreateAssistantRecord({
                sessionId,
                assistantMessageId,
                userMessageId: messageId,
              })
            : null)
        : getOrCreateUserRecord({
            sessionId,
            userMessageId: messageId,
            directory: input.directory,
          });
      if (!record) {
        return false;
      }
      const marked = setMark(record, mark, input.metadata, true);
      if (marked && mark === 'prompt_accepted') {
        activateAcceptedTurn(record);
      }
      if (input.directory && record) {
        record.directory = normalizeDirectory(input.directory);
      }
      return true;
    },

    processOpenCodeEvent(payload) {
      if (!isObject(payload)) return;
      lifecycleTracker.processEvent(payload);
      const type = normalizeString(payload.type);
      const properties = getEventProperties(payload);
      if (type === 'session.status') {
        processSessionStatus(properties);
      } else if (type === 'session.deleted') {
        const info = isObject(properties.info) ? properties.info : {};
        const sessionId = normalizeString(
          info.id || properties.sessionID || properties.sessionId,
        );
        if (sessionId) activeTurnsBySession.delete(sessionId);
      } else if (type === 'session.updated') {
        processSessionUpdated(properties);
      } else if (type === 'message.updated') {
        processMessageUpdated(properties);
      } else if (type === 'message.part.updated') {
        processPartUpdated(properties);
      } else if (type === 'message.part.delta') {
        processPartDelta(properties);
      }
    },

    recordPromptAccepted(input = {}) {
      return lifecycleTracker.recordPromptAccepted(input);
    },

    subscribeLifecycle(listener) {
      return lifecycleTracker.subscribe(listener);
    },

    getRecentTimings(options = {}) {
      pruneRecords();
      const sessionId = normalizeString(options.sessionId);
      const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.trunc(options.limit) : 20;
      const filtered = sessionId
        ? records.filter((record) => record.sessionId === sessionId)
        : records;
      return {
        records: filtered.slice(Math.max(0, filtered.length - limit)).map(toRecordResponse),
      };
    },
  };
}

function registerTurnTimingRoutes(app, runtime, options = {}) {
  app.post('/api/diagnostics/turn-timing/mark', (req, res) => {
    const input = req.body || {};
    const accepted = runtime.recordClientMark(input);
    if (!accepted) {
      res.status(400).json(withHarnessResult(
        { ok: false, error: 'Invalid turn timing mark' },
        createHarnessError({
          summary: 'Invalid turn timing mark',
          nextActions: ['Send sessionId and a supported timing mark'],
          recovery: {
            rootCauseHint: 'The mark payload was missing required timing fields',
            safeRetry: 'Retry with a valid sessionId and mark value',
            stopCondition: 'Stop retrying until the client can provide the missing fields',
            retryable: true,
          },
        }),
      ));
      return;
    }
    options.onAcceptedMark?.(input);
    res.json(withHarnessResult(
      { ok: true },
      createHarnessSuccess({
        summary: 'Turn timing mark recorded',
        nextActions: [],
      }),
    ));
  });

  app.get('/api/diagnostics/turn-timing/recent', (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    res.json(withHarnessResult(
      runtime.getRecentTimings({ sessionId, limit }),
      createHarnessSuccess({
        summary: 'Turn timing diagnostics loaded',
        nextActions: [],
      }),
    ));
  });
}

export { createTurnTimingRuntime, registerTurnTimingRoutes };
