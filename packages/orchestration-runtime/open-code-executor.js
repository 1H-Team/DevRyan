import { waitForSharedOperation } from './single-flight.js';
import { resolveProviderPromptTools } from './provider-prompt-tools.js';
import { appendManagedAssignment, stripManagedAssignment } from './continuation-assignment.js';
import { isManagedAssistantActivityPart } from './assistant-activity.js';
import { createManagedRecoveryMessageId, isProviderConfigurationRecovery } from './transport-recovery.js';
import {
  MANAGED_READ_ONLY_AGENT_UNSUPPORTED,
  MANAGED_READ_ONLY_AGENT_UNSUPPORTED_MESSAGE,
  MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED,
  MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED_MESSAGE,
  supportsManagedReadOnlyAgent,
  supportsManagedReadOnlyProvider,
} from './provider-capabilities.js';
import { formatManagedTaskDisplayName, MAX_MANAGED_TASK_PREVIEW_BYTES, truncateManagedText } from './contract.js';
import {
  PROVIDER_USAGE_LIMIT_FAILURE_KIND,
  classifyProviderRetryStatus,
  classifyProviderTransportFailure,
  isDefiniteProviderUsageLimit,
  isManagedTaskModelUnavailable,
  isProviderAuthenticationFailure,
  isProviderConfigurationFailure,
} from './provider-retry-policy.js';

const LIVE_STATUS_TYPES = new Set(['busy', 'retry']);
// A child that is still demonstrably live tells us nothing new in its transcript,
// and that transcript can be very large (OpenCode attaches a full git diff
// snapshot to user messages). Gate the expensive read behind the cheap status
// read so ordinary polling never pays for it.
const DEFAULT_OBSERVATION_FAILURE_GRACE_MS = 5 * 60 * 1_000;
// How often a still-live child's transcript is re-read, purely to keep a recent
// partial-work snapshot for interruption reporting. Polling reads status at
// `pollIntervalMs`; only this much rarer read touches the transcript.
const DEFAULT_LIVE_TRANSCRIPT_REFRESH_MS = 30 * 1_000;
const MAX_TRANSCRIPT_FAILURE_BACKOFF_MS = 30 * 1_000;
const OBSERVATION_STOP_RETRY_MS = 30 * 1_000;
// Provider streams can remain half-open after a network failure while OpenCode
// continues to report the session as busy. Bound that silent state without
// interrupting long-running tools or provider-managed retry backoff.
const DEFAULT_LIVE_PROGRESS_TIMEOUT_MS = 5 * 60 * 1_000;
// A child aborted moments earlier is still tearing the killed turn down. Give that
// teardown a bounded window to settle before classifying, so a recovery attempt is not
// judged by the previous attempt's abort.
const DEFAULT_RESUME_TEARDOWN_SETTLE_MS = 30 * 1_000;
// How long a continuation may sit without producing a new assistant message before it is
// assumed lost and re-posted once.
const DEFAULT_CONTINUATION_START_GRACE_MS = 2 * 60 * 1_000;
const MAX_STALE_TAIL_REPROMPTS = 1;
// Turn-budget backstop: once a task has used its assistant-turn budget it is told
// once to wrap up; a child that keeps going this many turns past that is aborted
// and reported as a resumable failure carrying whatever partial work it produced.
export const MANAGED_TURN_BUDGET_ABORT_GRACE_TURNS = 20;
export const MANAGED_TURN_BUDGET_PROMPT = 'You have used the turn budget for this task. Finish with the current state now: report what changed and what remains, then end with **Status:** complete or **Status:** blocked.';
export const MANAGED_RETRY_IN_PLACE_PROMPT = 'Continue the task from the existing progress. The previous provider could not continue. Do not repeat completed work.';
// Appended to an in-place retry prompt as `Continuing on <provider>/<model>[ · <variant>]
// after a provider usage limit.` so the transcript records which execution took over.
// Prompt recognition strips it, so counting and stale-tail anchoring see the bare prompt.
export const MANAGED_MODEL_CONTINUATION_NOTICE_PREFIX = 'Continuing on ';
export const MANAGED_RESUME_CONTINUATION_PROMPT = 'Continue the task from the existing progress. The previous managed turn stopped before completion. Do not repeat completed work.';
export const MANAGED_TRANSIENT_TIMEOUT_CONTINUATION_PROMPT = 'Continue the task from the existing progress. The previous model request timed out. Do not repeat completed work.';
export const MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT = 'Continue the task from the existing progress. The previous model connection was interrupted. Do not repeat completed work.';
export const MANAGED_EMPTY_OUTPUT_CONTINUATION_PROMPT = 'Continue the task from the existing progress. The previous model ended before providing a final answer. Reuse completed work and tool results, retry only missing work, and return the requested final output.';
export const MANAGED_READ_ONLY_PROMPT = '[devryan-managed-read-only:v1] The parent session is in plan mode. Inspect and report only. Do not edit, create, delete, rename, or move files; do not run commands that mutate the workspace; and do not delegate work.';
const MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPTS = Object.freeze([
  MANAGED_TRANSIENT_TIMEOUT_CONTINUATION_PROMPT,
  MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT,
]);
const MAX_TRANSIENT_TRANSPORT_CONTINUATIONS = 1;
const MAX_EMPTY_OUTPUT_CONTINUATIONS = 1;
const ABORT_FINISH_REASONS = new Set(['abort', 'aborted', 'cancelled', 'canceled']);
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429]);
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);
const FINAL_TOOL_STATUSES = new Set([
  'completed',
  'complete',
  'error',
  'failed',
  'aborted',
  'timeout',
  'timedout',
  'done',
  'cancelled',
  'canceled',
]);

const defaultSleep = (delayMs, { signal } = {}) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(signal.reason ?? new Error('Sleep aborted'));
    return;
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, delayMs);
  timer.unref?.();
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal.reason ?? new Error('Sleep aborted'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
});

const trimString = (value) => (typeof value === 'string' ? value.trim() : '');

const getProviderUsageLimitFailureReason = (status) => {
  const message = trimString(status?.statusMessage);
  if (isDefiniteProviderUsageLimit(message)) return message;
  return message
    ? `Provider usage limit reached: ${message}`
    : 'Provider usage limit reached';
};

const assertReadOnlyProviderSupport = (task) => {
  if (!task.readOnly || supportsManagedReadOnlyProvider(task.providerId)) return;
  const error = new Error(MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED_MESSAGE);
  error.code = MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED;
  error.statusCode = 409;
  throw error;
};

const assertReadOnlyAgentSupport = (task) => {
  if (!task.readOnly || supportsManagedReadOnlyAgent(task.agent)) return;
  const error = new Error(MANAGED_READ_ONLY_AGENT_UNSUPPORTED_MESSAGE);
  error.code = MANAGED_READ_ONLY_AGENT_UNSUPPORTED;
  error.statusCode = 409;
  throw error;
};

const resolveTaskPrompt = (task, prompt) => (
  task.readOnly
    ? `${MANAGED_READ_ONLY_PROMPT}\n\n${prompt}`
    : prompt
);

const resolveContinuationTaskPrompt = (task, prompt) => (
  resolveTaskPrompt(task, appendManagedAssignment(task, prompt))
);

const resolveInitialTaskPrompt = (task, preamble = null) => {
  const prompt = resolveTaskPrompt(task, task.prompt);
  // A host-supplied preamble (e.g. the compact agent contract for Claude
  // compatibility mode) sits ahead of the task prompt so it reads as the
  // child's standing rules. It belongs to the first prompt of a fresh child only;
  // resume and retry continuations never repeat it.
  const trimmedPreamble = typeof preamble === 'string' ? preamble.trim() : '';
  return trimmedPreamble ? `${trimmedPreamble}\n\n${prompt}` : prompt;
};

const resolveTaskPromptTools = (task) => ({
  ...resolveProviderPromptTools(
    task.providerId,
    task.agent,
    { readOnly: task.readOnly },
  ),
  // Managed tasks are already child sessions. Keep all further delegation
  // root-owned even when project agent permissions expose OpenCode's task tool.
  task: false,
});

const normalizeToolStatus = (value) => trimString(value)
  .toLowerCase()
  .replace(/[\s_-]+/g, '');

const toolPartIsInFlight = (part) => {
  if (part?.type !== 'tool') return false;
  const start = part.state?.time?.start;
  const end = part.state?.time?.end;
  const hasValidEnd = typeof end === 'number'
    && Number.isFinite(end)
    && (!(typeof start === 'number' && Number.isFinite(start)) || end >= start);
  if (hasValidEnd) return false;
  const status = normalizeToolStatus(part.state?.status);
  return !FINAL_TOOL_STATUSES.has(status);
};

const isEmptyPlainObject = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).length === 0
);

// A provider can stop mid-token while it is still constructing a tool call.
// OpenCode represents that half-written call as pending with no start time and
// no input. It is not executing user code and must not exempt a silent stream
// from the managed-child liveness timeout.
const toolPartIsBlankPendingInput = (part) => {
  if (!toolPartIsInFlight(part)) return false;
  if (normalizeToolStatus(part.state?.status) !== 'pending') return false;
  if (Number.isFinite(part.state?.time?.start)) return false;
  const raw = part.state?.raw;
  return isEmptyPlainObject(part.state?.input)
    && (raw === undefined || raw === null || raw === '');
};

const toolPartBlocksLiveProgressTimeout = (part) => (
  toolPartIsInFlight(part) && !toolPartIsBlankPendingInput(part)
);

const extractFailureReason = (error) => {
  if (typeof error === 'string') return error.trim() || null;
  if (!error || typeof error !== 'object') return null;
  const candidates = [
    error.data?.message,
    error.message,
    error.name,
  ];
  for (const candidate of candidates) {
    const value = trimString(candidate);
    if (value) return value;
  }
  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized !== '{}' ? serialized : null;
  } catch {
    return null;
  }
};

const isTransientAssistantTransportFailure = (failureReason) => (
  classifyProviderTransportFailure(null, failureReason) !== null
);

const isTransientObservationError = (error) => {
  if (!error || typeof error !== 'object') return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;

  const status = [
    error.status,
    error.statusCode,
    error.response?.status,
    error.cause?.status,
    error.cause?.statusCode,
  ].find((candidate) => Number.isSafeInteger(candidate));
  if (TRANSIENT_HTTP_STATUSES.has(status) || (status >= 500 && status <= 599)) return true;

  const code = trimString(error.code ?? error.cause?.code).toUpperCase();
  if (TRANSIENT_NETWORK_CODES.has(code)) return true;

  return error instanceof TypeError && /fetch|network|socket|connection/i.test(error.message);
};

// A tool killed by an abort reports this and nothing else. Treating it as recoverable
// output makes the whole preview read "Tool execution aborted", hiding the real work the
// child completed before it was killed.
const ABORTED_TOOL_ERROR_PATTERN = /^tool execution (?:was )?aborted\.?$/i;

const extractToolOutput = (part) => {
  const candidates = [part?.state?.output, part?.output, part?.state?.error];
  for (const candidate of candidates) {
    const value = trimString(candidate);
    if (value && !ABORTED_TOOL_ERROR_PATTERN.test(value)) return value;
  }
  return '';
};

const stringLength = (value) => (typeof value === 'string' ? value.length : 0);

const createTranscriptProgressSignature = (records) => {
  if (!Array.isArray(records) || records.length === 0) return 'empty';
  const latest = records.at(-1) ?? {};
  const info = latest.info ?? {};
  const parts = Array.isArray(latest.parts) ? latest.parts : [];
  return JSON.stringify([
    records.length,
    trimString(info.id),
    trimString(info.role),
    trimString(info.finish),
    Number.isFinite(info.time?.completed) ? info.time.completed : null,
    extractFailureReason(info.error),
    parts.map((part) => [
      trimString(part?.id ?? part?.callID ?? part?.callId),
      trimString(part?.type),
      stringLength(part?.text),
      trimString(part?.state?.status),
      Number.isFinite(part?.state?.time?.end) ? part.state.time.end : null,
      stringLength(part?.state?.output ?? part?.output),
      stringLength(part?.state?.error),
    ]),
  ]);
};

const extractAssistantWork = (record) => {
  const messageId = trimString(record.info?.id);
  const canonicalRefs = messageId ? [{ type: 'message', id: messageId }] : [];
  const text = [];
  const toolOutput = [];
  let hasToolReference = false;
  for (const part of Array.isArray(record.parts) ? record.parts : []) {
    if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      text.push(part.text.trim());
    }
    if (part?.type !== 'tool') continue;
    const toolId = trimString(part.callID ?? part.callId ?? part.id);
    if (toolId) {
      hasToolReference = true;
      canonicalRefs.push({
        type: 'tool',
        id: toolId,
        ...(messageId ? { messageId } : {}),
      });
    }
    const output = extractToolOutput(part);
    if (output) toolOutput.push(output);
  }

  const recoverablePreview = (text.length > 0 ? text : toolOutput).join('\n\n');
  return {
    canonicalRefs,
    hasUsefulWork: Boolean(recoverablePreview || hasToolReference),
    recoverablePreview,
  };
};

// A native compaction summary is maintenance output, never a child's result:
// an idle child whose latest assistant is a summary gets the empty-output
// continuation (which re-appends its assignment), not collection.
const isCompactionSummaryRecord = (record) => record?.info?.summary === true
  || record?.info?.mode === 'compaction' || record?.info?.agent === 'compaction';
const NO_ASSISTANT_WORK = Object.freeze({ canonicalRefs: [], hasUsefulWork: false, recoverablePreview: '' });
const extractResultWork = (record) => (isCompactionSummaryRecord(record) ? NO_ASSISTANT_WORK : extractAssistantWork(record));

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MODEL_CONTINUATION_NOTICE_PATTERN = new RegExp(
  `\\n\\n${escapeRegExp(MANAGED_MODEL_CONTINUATION_NOTICE_PREFIX)}[^\\n]*$`,
);

const buildModelContinuationNotice = (task, failureReason, configuration = false) => (
  `${MANAGED_MODEL_CONTINUATION_NOTICE_PREFIX}${task.providerId}/${task.modelId}`
  + `${task.variant ? ` · ${task.variant}` : ''}`
  + (isDefiniteProviderUsageLimit(failureReason)
    ? ' after a provider usage limit.'
    : configuration || isProviderConfigurationFailure(failureReason)
      ? ' after a provider configuration rejection.'
    : isTransientAssistantTransportFailure(failureReason)
      ? ' after a provider connection interruption.'
      : ' to continue the previous task.')
);

const matchesManagedUserPrompt = (value, prompt) => {
  const candidate = trimString(value);
  const readOnlyPrompt = `${MANAGED_READ_ONLY_PROMPT}\n\n${prompt}`;
  // Transcript observation checks several continuation kinds. Parse the full
  // assignment only for a matching prefix, never once for every candidate kind.
  if (!candidate.startsWith(prompt) && !candidate.startsWith(readOnlyPrompt)) return false;
  const normalized = stripManagedAssignment(candidate).replace(MODEL_CONTINUATION_NOTICE_PATTERN, '');
  return normalized === prompt
    || normalized === readOnlyPrompt;
};

export const isManagedTransientTransportContinuationPrompt = (value) => (
  MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPTS.some((prompt) => (
    matchesManagedUserPrompt(value, prompt)
  ))
);

export const isManagedResumeContinuationPrompt = (value) => (
  matchesManagedUserPrompt(value, MANAGED_RESUME_CONTINUATION_PROMPT)
);

export const isManagedRetryInPlacePrompt = (value) => (
  matchesManagedUserPrompt(value, MANAGED_RETRY_IN_PLACE_PROMPT)
);

const isManagedAttemptContinuationPrompt = (value) => (
  isManagedTransientTransportContinuationPrompt(value)
  || isManagedResumeContinuationPrompt(value)
  || isManagedRetryInPlacePrompt(value)
  || matchesManagedUserPrompt(value, MANAGED_EMPTY_OUTPUT_CONTINUATION_PROMPT)
);

const countExactUserPrompts = (records, prompt) => (
  Array.isArray(records)
    ? records.reduce((count, record) => {
      if (record?.info?.role !== 'user') return count;
      const matched = (Array.isArray(record.parts) ? record.parts : []).some((part) => (
        part?.type === 'text'
        && matchesManagedUserPrompt(part.text, prompt)
      ));
      return count + (matched ? 1 : 0);
    }, 0)
    : 0
);

const countTransientTransportContinuationPrompts = (records) => (
  MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPTS.reduce(
    (count, prompt) => count + countExactUserPrompts(records, prompt),
    0,
  )
);

const findLastRecordIndex = (records, predicate) => {
  if (!Array.isArray(records)) return -1;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (predicate(records[index])) return index;
  }
  return -1;
};

const orderMessageRecordsChronologically = (records) => {
  if (!Array.isArray(records) || records.length < 2) return records;
  const indexed = records.map((record, index) => ({
    createdAt: record?.info?.time?.created,
    index,
    record,
  }));
  if (indexed.some(({ createdAt }) => !Number.isFinite(createdAt))) return records;

  const hasInversion = indexed.some((entry, index) => (
    index > 0 && entry.createdAt < indexed[index - 1].createdAt
  ));
  if (!hasInversion) return records;

  indexed.sort((left, right) => left.createdAt - right.createdAt || left.index - right.index);
  return indexed.map(({ record }) => record);
};

const analyzeMessages = (inputRecords, childSessionId, recovery = null) => {
  const records = orderMessageRecordsChronologically(inputRecords);
  const progressSignature = createTranscriptProgressSignature(records);
  const transientTransportContinuationCount = countTransientTransportContinuationPrompts(records);
  const assistants = Array.isArray(records)
    ? records.filter((record) => record?.info?.role === 'assistant')
    : [];
  const latest = assistants.at(-1) ?? null;
  const transientTransportFailureCount = assistants.reduce((count, record) => (
    isTransientAssistantTransportFailure(extractFailureReason(record.info?.error))
      ? count + 1
      : count
  ), 0);
  const emptyOutputContinuationCount = countExactUserPrompts(
    records,
    MANAGED_EMPTY_OUTPUT_CONTINUATION_PROMPT,
  );
  const resumeContinuationCount = countExactUserPrompts(
    records,
    MANAGED_RESUME_CONTINUATION_PROMPT,
  );
  const lastAssistantIndex = findLastRecordIndex(
    records,
    (record) => record?.info?.role === 'assistant',
  );
  const lastResumeContinuationIndex = findLastRecordIndex(
    records,
    (record) => record?.info?.role === 'user'
      && (Array.isArray(record.parts) ? record.parts : []).some((part) => (
        part?.type === 'text'
        && isManagedResumeContinuationPrompt(part.text)
      )),
  );
  const lastContinuationIndex = findLastRecordIndex(
    records,
    (record) => record?.info?.role === 'user'
      && (Array.isArray(record.parts) ? record.parts : []).some((part) => (
        part?.type === 'text'
        && (isManagedResumeContinuationPrompt(part.text) || isManagedRetryInPlacePrompt(part.text))
      )),
  );
  const lastAttemptContinuationIndex = findLastRecordIndex(
    records,
    (record) => record?.info?.role === 'user'
      && (Array.isArray(record.parts) ? record.parts : []).some((part) => (
        part?.type === 'text'
        && isManagedAttemptContinuationPrompt(part.text)
      )),
  );
  const currentAttemptAssistants = (
    lastAttemptContinuationIndex >= 0
      ? records.slice(lastAttemptContinuationIndex + 1)
      : records
  ).filter((record) => record?.info?.role === 'assistant');
  const resumeContinuationPending = lastResumeContinuationIndex > lastAssistantIndex;
  const continuationPending = lastContinuationIndex > lastAssistantIndex;
  const latestAssistantMessageId = trimString(latest?.info?.id) || null;
  const lastUser = records.findLast((record) => record?.info?.role === 'user');
  const recoveryObservation = {
    latestMessageId: trimString(records.at(-1)?.info?.id) || null,
    latestAssistantParentId: trimString(latest?.info?.parentID) || null,
    latestUserMessageId: trimString(lastUser?.info?.id) || null,
    latestUserCreatedAt: Number.isFinite(lastUser?.info?.time?.created) ? lastUser.info.time.created : null,
    hasNewerUserInput: Boolean(lastUser && records.indexOf(lastUser) > lastAssistantIndex),
    assistantCompleted: Number.isFinite(latest?.info?.time?.completed),
    assistantCompletedAt: latest?.info?.time?.completed ?? null,
    recoveryPromptPresent: Boolean(recovery && records.some((record) => (
      record.info?.role === 'user' && record.info.id === recovery.recoveryMessageId
    ))),
    // A tool that started and was aborted may already have changed external state.
    // A blank pending call torn down before execution (as in the incident) is safe.
    hasUncertainTool: currentAttemptAssistants.some((record) => record.parts?.some((part) => (
      part?.type === 'tool'
      && ['error', 'failed', 'aborted', 'cancelled', 'canceled', 'timeout', 'timedout'].includes(normalizeToolStatus(part.state?.status))
      && /abort|cancel|timeout|timed out/i.test(trimString(part.state?.error) || trimString(part.state?.status))
      && (Number.isFinite(part.state?.time?.start) || !isEmptyPlainObject(part.state?.input))
    ))),
  };
  const assistantActivityIds = currentAttemptAssistants
    .filter((record) => record.parts?.some(isManagedAssistantActivityPart))
    .map((record) => record.info.id);
  const assistantActivityBindings = currentAttemptAssistants.map(record => ({
    messageId: record.info.id, createdAt: record.info.time?.created,
    ...(Number.isFinite(record.info.time?.completed) ? { completedAt: record.info.time.completed } : {}),
  }));
  if (!latest) {
    return {
      assistantCount: assistants.length,
      canonicalRefs: [],
      childSessionId,
      continuationPending,
      emptyOutputContinuationCount,
      failureReason: null,
      finish: '',
      hasBlockingInFlightTool: false,
      hasInFlightTool: false,
      hasUsefulWork: false,
      latestAssistantMessageId,
      assistantActivityIds,
      assistantActivityBindings,
      assistantMessageIds: assistants.map((record) => record.info.id),
      recoverablePreview: '',
      progressSignature,
      resumeContinuationCount,
      resumeContinuationPending,
      terminal: false,
      transientTransportContinuationCount,
      transientTransportFailureCount,
      ...recoveryObservation,
    };
  }

  const latestWork = extractResultWork(latest);
  const hasInFlightTool = currentAttemptAssistants.some((record) => (
    (Array.isArray(record.parts) ? record.parts : []).some(toolPartIsInFlight)
  ));
  const hasBlockingInFlightTool = currentAttemptAssistants.some((record) => (
    (Array.isArray(record.parts) ? record.parts : []).some(toolPartBlocksLiveProgressTimeout)
  ));
  let usefulWork = latestWork;
  if (!latestWork.hasUsefulWork) {
    for (let index = assistants.length - 2; index >= 0; index -= 1) {
      const candidate = extractResultWork(assistants[index]);
      if (!candidate.hasUsefulWork) continue;
      usefulWork = candidate;
      break;
    }
  }
  // An attempt killed mid-flight leaves a tail carrying tool references but nothing
  // salvageable to read, so the preview has to come from the last turn that actually
  // produced something. Without this the user sees an empty preview for real work.
  let previewWork = usefulWork.recoverablePreview ? usefulWork : null;
  if (!previewWork) {
    for (let index = assistants.length - 1; index >= 0; index -= 1) {
      const candidate = extractResultWork(assistants[index]);
      if (!candidate.recoverablePreview) continue;
      previewWork = candidate;
      break;
    }
  }
  const refSources = [];
  if (previewWork && previewWork !== latestWork) refSources.push(previewWork);
  if (usefulWork !== latestWork && usefulWork !== previewWork) refSources.push(usefulWork);
  const canonicalRefs = refSources.length > 0
    ? [...refSources.flatMap((source) => source.canonicalRefs), ...latestWork.canonicalRefs]
    : latestWork.canonicalRefs;

  const finish = trimString(latest.info?.finish).toLowerCase();
  const completedAt = latest.info?.time?.completed;
  const failureReason = extractFailureReason(latest.info?.error);
  const isToolCallHandoff = finish === 'tool-calls';
  const handoffRejected = (Array.isArray(latest.parts) ? latest.parts : []).some((part) => (
    part?.type === 'tool' && /rejected permission|dismissed this question|rejected the question/i.test(trimString(part.state?.error))
  ));
  return {
    handoffRejected,
    assistantCount: assistants.length,
    canonicalRefs,
    childSessionId,
    continuationPending,
    emptyOutputContinuationCount,
    failureReason,
    finish,
    hasBlockingInFlightTool,
    hasFinalUsefulWork: latestWork.hasUsefulWork,
    hasInFlightTool,
    hasUsefulWork: usefulWork.hasUsefulWork,
    latestAssistantMessageId,
    assistantActivityIds,
    assistantActivityBindings,
    assistantMessageIds: assistants.map((record) => record.info.id),
    recoverablePreview: previewWork?.recoverablePreview ?? '',
    progressSignature,
    resumeContinuationCount,
    resumeContinuationPending,
    terminal: !isToolCallHandoff && Boolean(
      failureReason
      || finish
      || (typeof completedAt === 'number' && Number.isFinite(completedAt) && completedAt > 0)
    ),
    transientTransportContinuationCount,
    transientTransportFailureCount,
    ...recoveryObservation,
  };
};

const isEmptyTerminalObservation = (observation) => (
  !LIVE_STATUS_TYPES.has(observation.statusType)
  && observation.terminal
  && !observation.failureReason
  && !ABORT_FINISH_REASONS.has(observation.finish)
  && !observation.hasFinalUsefulWork
  && !observation.hasInFlightTool
);

// Idle in a runtime that started after the child's latest input, with a turn
// that never settled: it ran in a process that has since exited.
const isRuntimeOrphanObservation = (observation, runtimeStartedAt) => (
  Number.isFinite(runtimeStartedAt)
  && !LIVE_STATUS_TYPES.has(observation.statusType)
  && Number.isFinite(observation.latestUserCreatedAt)
  && observation.latestUserCreatedAt < runtimeStartedAt
  && (observation.continuationPending || observation.hasInFlightTool || !toTerminalResult(observation))
);

// A child that stopped between steps never continues on its own: its last
// step handed off to tools, every tool settled, no newer input is waiting and
// the session is idle. OpenCode ends a turn this way when the user rejects a
// permission or a question. Left alone, the task runs until its deadline
// (60 minutes for Designer and Fixer) while its parent waits.
// Kill switch, read per poll: DEVRYAN_MANAGED_STOPPED_HANDOFF=0.
export const MANAGED_STOPPED_HANDOFF_MS = 30_000;
const isStoppedHandoffObservation = (observation) => (
  globalThis.process?.env?.DEVRYAN_MANAGED_STOPPED_HANDOFF !== '0'
  && !LIVE_STATUS_TYPES.has(observation.statusType)
  && observation.finish === 'tool-calls'
  && observation.assistantCompleted === true
  && !observation.failureReason
  && !observation.hasInFlightTool
  && !observation.continuationPending
  && !observation.hasNewerUserInput
);
const toStoppedHandoffResult = (observation) => ({
  status: 'failed',
  failureReason: observation.handoffRejected
    ? 'Managed child stopped before finishing: a tool permission or question was rejected'
    : 'Managed child stopped before finishing its turn',
  partial: observation.hasUsefulWork === true,
  recoverablePreview: observation.recoverablePreview,
  canonicalRefs: observation.canonicalRefs,
  resumable: Boolean(observation.childSessionId),
});

const toTerminalResult = (observation) => {
  if (LIVE_STATUS_TYPES.has(observation.statusType)) return null;
  const hasUsefulOutput = observation.hasUsefulWork === true;
  if (observation.failureReason) {
    return {
      status: 'failed',
      failureReason: observation.failureReason,
      partial: hasUsefulOutput,
      recoverablePreview: observation.recoverablePreview,
      canonicalRefs: observation.canonicalRefs,
      resumable: Boolean(observation.childSessionId),
    };
  }
  if (ABORT_FINISH_REASONS.has(observation.finish)) {
    return {
      status: 'aborted',
      failureReason: 'Managed child session was aborted',
      partial: hasUsefulOutput,
      recoverablePreview: observation.recoverablePreview,
      canonicalRefs: observation.canonicalRefs,
      resumable: Boolean(observation.childSessionId),
    };
  }
  if (
    observation.terminal
    && !observation.hasFinalUsefulWork
    && !observation.hasInFlightTool
  ) {
    return {
      status: 'failed',
      failureReason: 'Managed child session completed without useful assistant output',
      partial: false,
      recoverablePreview: '',
      canonicalRefs: observation.canonicalRefs,
      resumable: Boolean(observation.childSessionId),
    };
  }
  if (
    observation.terminal
    && observation.hasFinalUsefulWork
    && !observation.hasInFlightTool
  ) {
    return {
      status: 'completed',
      failureReason: null,
      partial: false,
      recoverablePreview: observation.recoverablePreview,
      canonicalRefs: observation.canonicalRefs,
      resumable: false,
    };
  }
  return null;
};

export const createManagedOpenCodeExecutor = (options = {}) => {
  const transport = options.transport;
  const requiredMethods = [
    'createSession',
    'promptSession',
    'readSession',
    'readStatus',
    'readMessages',
    'abortSession',
    'deleteSession',
  ];
  for (const method of requiredMethods) {
    if (typeof transport?.[method] !== 'function') {
      throw new TypeError(`transport.${method} is required`);
    }
  }
  const pollIntervalMs = options.pollIntervalMs ?? 750;
  // Preserve the existing reconciliation ceiling unless a measured cohort
  // explicitly selects another bound. Events improve latency independently.
  const eventReconcileIntervalMs = options.eventReconcileIntervalMs ?? pollIntervalMs;
  const idleStablePolls = options.idleStablePolls ?? 2;
  const stoppedHandoffMs = options.stoppedHandoffMs ?? MANAGED_STOPPED_HANDOFF_MS;
  const now = options.now ?? Date.now;
  const observationFailureGraceMs = options.observationFailureGraceMs
    ?? DEFAULT_OBSERVATION_FAILURE_GRACE_MS;
  const liveTranscriptRefreshMs = options.liveTranscriptRefreshMs
    ?? DEFAULT_LIVE_TRANSCRIPT_REFRESH_MS;
  const liveProgressTimeoutMs = options.liveProgressTimeoutMs
    ?? DEFAULT_LIVE_PROGRESS_TIMEOUT_MS;
  const resumeTeardownSettleMs = options.resumeTeardownSettleMs
    ?? DEFAULT_RESUME_TEARDOWN_SETTLE_MS;
  const continuationStartGraceMs = options.continuationStartGraceMs
    ?? DEFAULT_CONTINUATION_START_GRACE_MS;
  const retryStopMaxAborts = options.retryStopMaxAborts ?? 3;
  const retryStopPollLimit = options.retryStopPollLimit ?? 80;
  const resolveTaskPromptPreamble = typeof options.resolveTaskPromptPreamble === 'function'
    ? options.resolveTaskPromptPreamble
    : null;
  const maxAssistantTurns = options.maxAssistantTurns ?? null;
  const resolveTaskTurnBudget = typeof options.resolveTaskTurnBudget === 'function'
    ? options.resolveTaskTurnBudget
    : null;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0) {
    throw new RangeError('pollIntervalMs must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(eventReconcileIntervalMs) || eventReconcileIntervalMs < 0) {
    throw new RangeError('eventReconcileIntervalMs must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(idleStablePolls) || idleStablePolls < 1) {
    throw new RangeError('idleStablePolls must be a positive safe integer');
  }
  if (!Number.isSafeInteger(retryStopMaxAborts) || retryStopMaxAborts < 1) {
    throw new RangeError('retryStopMaxAborts must be a positive safe integer');
  }
  if (!Number.isSafeInteger(retryStopPollLimit) || retryStopPollLimit < 1) {
    throw new RangeError('retryStopPollLimit must be a positive safe integer');
  }
  if (!Number.isSafeInteger(liveProgressTimeoutMs) || liveProgressTimeoutMs < 1) {
    throw new RangeError('liveProgressTimeoutMs must be a positive safe integer');
  }
  if (
    maxAssistantTurns !== null
    && (!Number.isSafeInteger(maxAssistantTurns) || maxAssistantTurns < 1)
  ) {
    throw new RangeError('maxAssistantTurns must be null or a positive safe integer');
  }
  const sleep = options.sleep ?? defaultSleep;
  const shutdownController = new AbortController();
  const retryStops = new Map();
  const activeExecutions = new Map();
  const attemptContext = Symbol('managedExecutionAttempt');
  const settlementRead = Symbol('cancelledAttemptSettlementRead');
  const attemptFor = (task) => {
    if (task[attemptContext]) return task[attemptContext];
    const attempt = activeExecutions.get(task.taskId);
    return attempt?.leaseToken === task.leaseToken ? attempt : null;
  };
  const copyRecovery = (result) => result ? {
    ...result, canonicalRefs: result.canonicalRefs.map((reference) => ({ ...reference })),
  } : null;
  const recoveryFrom = (observation) => ({
    recoverablePreview: truncateManagedText(observation.recoverablePreview, MAX_MANAGED_TASK_PREVIEW_BYTES),
    canonicalRefs: observation.canonicalRefs.slice(0, 256).filter((reference) => (
      typeof reference.id === 'string' && reference.id.length <= 512
      && (reference.messageId === undefined || reference.messageId.length <= 512)
    )).map((reference) => ({ ...reference })),
    partial: observation.hasUsefulWork,
    resumable: toTerminalResult(observation)?.status !== 'completed',
  });

  const assertRunning = () => {
    if (shutdownController.signal.aborted) {
      throw shutdownController.signal.reason ?? new Error('Managed OpenCode executor shut down');
    }
  };

  // A task-specific budget wins over the executor-wide one; `null` from either
  // disables the backstop, and an absent per-task answer falls through.
  const resolveTurnBudget = (task) => {
    const taskBudget = resolveTaskTurnBudget ? resolveTaskTurnBudget(task) : undefined;
    const budget = taskBudget === undefined ? maxAssistantTurns : taskBudget;
    if (budget === null || budget === undefined) return null;
    if (!Number.isSafeInteger(budget) || budget < 1) {
      throw new RangeError(
        `Turn budget for managed task ${task.taskId} must be null or a positive safe integer`,
      );
    }
    return budget;
  };

  const normalizeStatusFields = (status) => ({
    statusType: trimString(status?.type).toLowerCase(),
    statusMessage: trimString(status?.message),
    statusAttempt: Number.isFinite(status?.attempt) ? status.attempt : null,
    statusNext: Number.isFinite(status?.next) ? status.next : null,
    statusActionReason: trimString(status?.action?.reason),
    statusFailureKind: classifyProviderRetryStatus(status),
  });

  const authenticationFailureIdentity = (task, observation) => {
    const failureReason = trimString(observation?.failureReason);
    const after = attemptFor(task)?.operatorAbortAfter ?? task.startedAt ?? 0;
    const identifiers = [observation?.latestAssistantMessageId,
      observation?.latestAssistantParentId, observation?.latestUserMessageId];
    if (!identifiers.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 512)
      || identifiers[1] !== identifiers[2] || !isProviderAuthenticationFailure(failureReason)
      || failureReason.length > 2_000 || observation.hasNewerUserInput || observation.continuationPending
      || !observation.assistantCompleted || !Number.isFinite(observation.latestUserCreatedAt)
      || observation.latestUserCreatedAt < after
      || observation.latestUserCreatedAt > now() || observation.assistantCompletedAt > now()
      || observation.assistantCompletedAt < observation.latestUserCreatedAt) return null;
    return { assistantId: identifiers[0], userId: identifiers[2],
      userCreatedAt: observation.latestUserCreatedAt, completedAt: observation.assistantCompletedAt, failureReason };
  };
  const sameAuthenticationFailure = (left, right) => Boolean(left && right
    && left.assistantId === right.assistantId && left.userId === right.userId
    && left.userCreatedAt === right.userCreatedAt && left.completedAt === right.completedAt
    && left.failureReason === right.failureReason);

  const observationSignal = (task) => AbortSignal.any([shutdownController.signal,
    ...(!task[settlementRead] && attemptFor(task)?.controller.signal ? [attemptFor(task).controller.signal] : [])]);

  // Liveness only. Deliberately does NOT read messages: the transcript can run to
  // tens of megabytes, and while the child is live it cannot be terminal anyway.
  const readLiveStatus = async (task) => {
    assertRunning();
    const attempt = attemptFor(task);
    const signal = observationSignal(task);
    signal.throwIfAborted();
    let status;
    try {
      status = await waitForSharedOperation(transport.readStatus({
        sessionId: task.childSessionId,
        directory: task.directory,
        providerId: task.providerId, signal,
      }), { signal });
    } catch (error) {
      if (attempt && !signal.aborted && isTransientObservationError(error)) {
        attempt.statusFailure = { firstAt: attempt.statusFailure?.firstAt ?? now(), error };
      }
      throw error;
    }
    assertRunning();
    if (attempt) attempt.statusFailure = null;
    return status;
  };

  // `knownStatus` lets a caller that already polled status reuse it, so one loop
  // iteration still costs exactly one status read.
  const readObservation = async (task, knownStatus, { fresh = false } = {}) => {
    assertRunning();
    const signal = observationSignal(task);
    signal.throwIfAborted();
    const input = {
      sessionId: task.childSessionId,
      directory: task.directory,
      providerId: task.providerId, signal,
    };
    const status = knownStatus !== undefined
      ? knownStatus
      : await readLiveStatus(task);
    const attempt = attemptFor(task);
    const failure = attempt?.transcriptFailure;
    if (!fresh && failure && now() < failure.nextReadAt) throw failure.error;
    let messages;
    try { messages = await waitForSharedOperation(transport.readMessages(input), { signal }); }
    catch (error) {
      if (attempt && !signal.aborted) {
        const previous = attempt.transcriptFailure;
        const delayMs = Math.min(MAX_TRANSCRIPT_FAILURE_BACKOFF_MS,
          previous ? previous.delayMs * 2 : Math.max(1, pollIntervalMs));
        attempt.transcriptFailure = {
          firstAt: previous?.firstAt ?? now(), error, delayMs, nextReadAt: now() + delayMs,
        };
      }
      throw error;
    }
    assertRunning();
    if (attempt) attempt.transcriptFailure = null;
    const observation = {
      ...analyzeMessages(messages, task.childSessionId, task.transportRecovery),
      ...normalizeStatusFields(status),
    };
    if (attempt) {
      attempt.recovery = recoveryFrom(observation);
      const identity = authenticationFailureIdentity(task, observation);
      attempt.authenticationFailureSnapshot = identity ? { identity, observedAt: now() } : null;
      if (attempt.steeringUserId && observation.latestUserCreatedAt > attempt.steeredAbortAt) {
        attempt.steeringUserId = observation.latestUserMessageId;
      }
    }
    return observation;
  };

  // Stop is revocable until the runtime accepts it. Re-read after transcript
  // observation so a rejected request cannot suppress a later prompt. A new
  // user message after Stop is deliberate steering, not automatic recovery.
  const readApplicableOperatorAbort = async (task, after) => {
    if (typeof transport.readOperatorAbort !== 'function') return null;
    const input = { sessionId: task.childSessionId, directory: task.directory, providerId: task.providerId, after };
    const request = await transport.readOperatorAbort(input);
    if (!request) return null;
    const attempt = attemptFor(task);
    if (request.requestedAt === attempt?.steeredAbortAt) return null;
    let observation;
    try { observation = await readObservation(task); }
    catch {
      // A Stop still suppresses dispatch when harvesting fails. Its observer
      // retains ownership and the normal transport timeout/recovery allowance.
      const current = await transport.readOperatorAbort(input);
      return current ? { request: current, observation: null } : null;
    }
    const current = await transport.readOperatorAbort(input);
    if (!current) return null;
    if (Number.isFinite(observation.latestUserCreatedAt) && observation.latestUserCreatedAt > current.requestedAt) {
      if (attempt) {
        attempt.steeredAbortAt = current.requestedAt;
        attempt.steeringUserId = observation.latestUserMessageId;
      }
      return { request: current, observation, steered: true };
    }
    return { request: current, observation };
  };

  const promptTask = async (task, input) => {
    const attempt = attemptFor(task);
    assertRunning();
    if (attempt && activeExecutions.get(task.taskId) !== attempt) {
      throw new Error('Managed task execution lease changed before provider prompt');
    }
    attempt?.controller.signal.throwIfAborted();
    const stopped = await readApplicableOperatorAbort(task, attempt?.operatorAbortAfter ?? task.startedAt ?? 0);
    assertRunning();
    if (attempt && activeExecutions.get(task.taskId) !== attempt) {
      throw new Error('Managed task execution lease changed before provider prompt');
    }
    attempt?.controller.signal.throwIfAborted();
    if (stopped) return false;
    // No asynchronous work between the last guard and the transport call.
    await transport.promptSession({ ...input, taskId: task.taskId, leaseToken: task.leaseToken,
      signal: attempt?.controller.signal });
    return true;
  };

  const readAuthoritativeTerminalError = async (task, after, previousObservation = null) => {
    if (typeof transport.readTerminalError !== 'function') return null;
    const previousAuthenticationFailure = attemptFor(task)?.authenticationFailureSnapshot;
    const error = await transport.readTerminalError({
      sessionId: task.childSessionId,
      directory: task.directory,
      providerId: task.providerId,
      after,
    });
    if (!error || (error.eventId && error.eventId === task.transportRecovery?.eventId)) return null;

    let observation = previousObservation;
    try {
      observation = await readObservation(task);
    } catch {
      // The terminal event is authoritative even if the final transcript/status
      // snapshot is no longer readable. Preserve the last successful snapshot.
    }
    const message = trimString(error.message) || 'Managed child session failed';
    const classifiedFailure = [error.errorName, error.code, message]
      .map(trimString)
      .filter(Boolean)
      .join(': ');
    const result = {
      status: 'failed',
      failureReason: isManagedTaskModelUnavailable(classifiedFailure)
        ? (isManagedTaskModelUnavailable(message) ? message : `Model unavailable: ${message}`)
        : message,
      partial: observation?.hasUsefulWork === true,
      recoverablePreview: observation?.recoverablePreview ?? '',
      canonicalRefs: observation?.canonicalRefs ?? [],
      resumable: true,
    };
    return { error, observation, result, previousAuthenticationFailure,
      transportKind: classifyProviderTransportFailure(error.errorName, message) };
  };

  const saveTransportRecovery = async (task, control, changes) => {
    const previous = task.transportRecovery;
    const recovery = { ...previous, ...changes, revision: (previous?.revision ?? 0) + 1 };
    if (typeof control?.recordTransportRecovery !== 'function'
      || await control.recordTransportRecovery(recovery, previous?.revision ?? 0) !== true) {
      throw new Error('Managed transport recovery could not retain its durable execution lease');
    }
    task.transportRecovery = recovery;
    const attempt = attemptFor(task);
    if (attempt) attempt.transportRecovery = recovery;
    if (attempt && attempt.sourceTask.leaseToken === attempt.leaseToken) attempt.sourceTask.transportRecovery = recovery;
    return recovery;
  };

  const transportRecoveryResult = (observation, failureReason, status = 'interrupted') => ({
    status,
    failureReason,
    partial: observation?.hasUsefulWork === true,
    recoverablePreview: observation?.recoverablePreview ?? '',
    canonicalRefs: observation?.canonicalRefs ?? [],
    resumable: true,
  });

  const configurationFailure = async (task, control, initial, result, event = null) => {
    if (!isProviderConfigurationFailure(result.failureReason) || task.transportRecovery) return result;
    // Native providers can announce failure/retry before their assistant finalizer.
    // Stop the futile retry loop, then wait for authoritative settlement; never
    // reserve a backup from the event alone or from an unfinished tool tail.
    if (LIVE_STATUS_TYPES.has(initial?.statusType) && await ensureRetryStopped(task)) return result;
    let observation = initial;
    const deadline = now() + resumeTeardownSettleMs;
    while (!observation?.assistantCompleted || LIVE_STATUS_TYPES.has(observation.statusType)) {
      if (now() >= deadline) return result;
      await sleep(pollIntervalMs, { signal: shutdownController.signal });
      observation = await readObservation(task);
    }
    if ((initial?.latestAssistantMessageId && initial.latestAssistantMessageId !== observation.latestAssistantMessageId)
      || observation.hasInFlightTool || observation.hasUncertainTool || observation.hasNewerUserInput
      || observation.continuationPending || !observation.latestAssistantMessageId || !observation.latestAssistantParentId) return result;
    // Reuse the durable one-backup protocol without sending a futile same-model
    // prompt. The receipt keeps the downgrade-compatible wire shape: the
    // same-model budget is recorded as spent and the configuration class is
    // derived from the task's failure reason (isProviderConfigurationRecovery).
    await saveTransportRecovery(task, control, { phase: 'exhausted', kind: 'connection_failure',
      sameModelAttempts: 1, backupAttempts: 0, failedMessageId: observation.latestAssistantMessageId,
      failedUserMessageId: observation.latestAssistantParentId, recoveryMessageId: observation.latestAssistantParentId,
      eventId: event?.eventId ?? null, reservedAt: now(), submittedAt: null });
    return result;
  };

  // A backup attempt is a new task without the source failure; the scheduler
  // exposes its predecessor's reason read-only so the receipt can keep the
  // downgrade-compatible wire shape.
  const isConfigurationReceipt = (task, control) => isProviderConfigurationRecovery(task)
    || (Boolean(task.transportRecovery)
      && isProviderConfigurationFailure(control?.readPriorFailureReason?.() ?? null));

  const sendTransportRecovery = async (task, control, observation, event = null, backup = false) => {
    const configuration = isConfigurationReceipt(task, control);
    let prompt;
    try {
      prompt = resolveContinuationTaskPrompt(task, backup
        ? `${MANAGED_RETRY_IN_PLACE_PROMPT}\n\n${buildModelContinuationNotice(task, observation.failureReason, configuration)}`
        : MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT);
    } catch (error) {
      // Invalid local context is not an ambiguous transport submission. Settle
      // before reserving an attempt instead of waiting for a POST never made.
      return { ...transportRecoveryResult(observation, error.message, 'failed'), resumable: false };
    }
    const reservedAt = now();
    const recoveryMessageId = createManagedRecoveryMessageId(reservedAt, observation.latestMessageId);
    try {
      await saveTransportRecovery(task, control, {
        phase: 'reserved',
        // A configuration receipt keeps its recorded kind even when the stopped
        // retry left a different settled error on the turn.
        kind: (configuration ? task.transportRecovery.kind : null)
          ?? classifyProviderTransportFailure(null, observation.failureReason) ?? task.transportRecovery?.kind ?? 'stream_idle_timeout',
        sameModelAttempts: 1,
        backupAttempts: backup ? 1 : 0,
        failedMessageId: observation.latestAssistantMessageId,
        failedUserMessageId: observation.latestAssistantParentId ?? observation.latestUserMessageId,
        recoveryMessageId,
        eventId: event?.eventId ?? (backup ? task.transportRecovery?.eventId ?? null : null),
        reservedAt,
        submittedAt: null,
      });
    } catch (error) {
      return transportRecoveryResult(observation, error.message);
    }
    try {
      assertRunning();
      const signal = attemptFor(task)?.controller.signal;
      signal?.throwIfAborted();
      const current = await readObservation(task);
      if (await readApplicableOperatorAbort(task, attemptFor(task)?.operatorAbortAfter ?? task.startedAt ?? 0)) return null;
      if (LIVE_STATUS_TYPES.has(current.statusType) || current.hasInFlightTool || current.hasUncertainTool
        || !current.assistantCompleted || current.hasNewerUserInput
        || current.latestAssistantMessageId !== observation.latestAssistantMessageId
        || current.latestUserMessageId !== observation.latestUserMessageId) {
        await saveTransportRecovery(task, control, { phase: 'blocked' });
        return transportRecoveryResult(current, 'Managed connection recovery was superseded before dispatch');
      }
      assertRunning();
      signal?.throwIfAborted();
      watchActivity(task, control, reservedAt, observation.latestAssistantMessageId);
      const submitted = await promptTask(task, {
        sessionId: task.childSessionId,
        directory: task.directory,
        providerId: task.providerId,
        modelId: task.modelId,
        agent: task.agent,
        variant: task.variant,
        messageId: recoveryMessageId,
        signal,
        prompt,
        tools: resolveTaskPromptTools(task),
      });
      if (submitted) await saveTransportRecovery(task, control, { phase: 'submitted', submittedAt: now() });
    } catch {
      attemptFor(task)?.controller.signal.throwIfAborted();
      // Reservation is durable. A rejected/ambiguous POST is never blindly resent.
      // Observation below can still prove that its exact message was accepted.
      return null;
    }
    return null;
  };

  const retryStopInput = (task) => ({
    sessionId: task.childSessionId,
    directory: task.directory,
    providerId: task.providerId,
  });

  const discardStaleChild = async (task, childSessionId, { deleteSession }) => {
    const input = {
      sessionId: childSessionId,
      directory: task.directory,
      providerId: task.providerId,
    };
    let abortFailure = null;
    try {
      const aborted = await transport.abortSession(input);
      if (aborted === false) {
        abortFailure = new Error(`Provider did not confirm abort for stale child ${childSessionId}`);
      }
    } catch (error) {
      abortFailure = error instanceof Error ? error : new Error(String(error));
    }
    let deleteFailure = null;
    let deletionConfirmed = false;
    if (deleteSession) {
      try {
        const deleted = await transport.deleteSession(input);
        if (deleted === false) {
          deleteFailure = new Error(`OpenCode did not confirm deletion of stale child ${childSessionId}`);
        } else {
          deletionConfirmed = true;
        }
      } catch (error) {
        deleteFailure = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (deletionConfirmed) return;
    const failures = [abortFailure, deleteFailure].filter(Boolean);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Failed to fully discard stale managed child ${childSessionId}`,
      );
    }
  };

  const retainCheckpoint = async ({
    task,
    childSessionId,
    checkpoint,
    stage,
    deleteSession,
  }) => {
    let checkpointError = null;
    try {
      const retained = await checkpoint();
      if (retained !== false) return;
      checkpointError = new Error(
        `Managed task ${task.taskId} lost launch ownership ${stage}`,
      );
    } catch (error) {
      checkpointError = error instanceof Error ? error : new Error(String(error));
    }

    try {
      await discardStaleChild(task, childSessionId, { deleteSession });
    } catch (cleanupError) {
      throw new AggregateError(
        [checkpointError, cleanupError],
        `${checkpointError.message}; stale child cleanup also failed`,
      );
    }
    throw checkpointError;
  };

  const retryStatusIdentity = (status) => [
    trimString(status?.message),
    trimString(status?.action?.reason),
    Number.isFinite(status?.attempt) ? status.attempt : '',
    Number.isFinite(status?.next) ? status.next : '',
  ].join('\u0000');

  const stopMatchingAuthenticationRetry = async (task, observation, failureReason, event = null, previous = null) => {
    const attempt = attemptFor(task);
    const identity = authenticationFailureIdentity(task, observation);
    if (!attempt || attempt.authenticationStopIssued || attempt.steeringUserId || !identity
      || observation.statusType !== 'retry' || observation.statusMessage !== identity.failureReason
      || identity.failureReason !== trimString(failureReason)) return;
    // session.error carries no turn ID. Receipt time alone cannot associate it
    // with a retry; require the same canonical failure observed before the event.
    if (event && (event.sessionId !== task.childSessionId
      || !Number.isFinite(event.observedAt) || event.observedAt > now()
      || identity.userCreatedAt > event.observedAt
      || !previous || previous.observedAt >= event.observedAt
      || !sameAuthenticationFailure(previous.identity, identity))) return;
    const matchesRetry = (status) => trimString(status?.type).toLowerCase() === 'retry'
      && trimString(status?.message) === identity.failureReason;
    const expectedRetry = retryStatusIdentity({ message: observation.statusMessage,
      attempt: observation.statusAttempt, next: observation.statusNext, action: { reason: observation.statusActionReason } });
    try {
      const status = await readLiveStatus(task);
      if (!matchesRetry(status) || retryStatusIdentity(status) !== expectedRetry) return;
      const current = await readObservation(task, status);
      if (!sameAuthenticationFailure(identity, authenticationFailureIdentity(task, current))) return;
      const finalStatus = await readLiveStatus(task);
      if (!matchesRetry(finalStatus) || retryStatusIdentity(finalStatus) !== retryStatusIdentity(status)
        || activeExecutions.get(task.taskId) !== attempt || attempt.controller.signal.aborted
        || attempt.authenticationStopIssued) return;
      attempt.authenticationStopIssued = true;
      // Exactly one abort of this verified retry. Never chase busy/newer retries.
      await transport.abortSession(retryStopInput(task));
    } catch {
      // Failure reporting remains authoritative; missing proof cannot authorize
      // another abort, and cleanup failure does not resend or switch models.
      assertRunning();
    }
  };

  const startRetryStop = (task, initialStatus = null, expectedAttempt = null) => {
    const existing = retryStops.get(task.childSessionId);
    if (existing) return existing;

    let operation;
    operation = (async () => {
      try {
        const assertOwnership = () => {
          if (expectedAttempt && activeExecutions.get(task.taskId) !== expectedAttempt) {
            throw new Error('Managed task execution lease changed during observation cleanup');
          }
        };
        let abortCount = 1;
        let lastRetryIdentity = retryStatusIdentity(initialStatus);
        assertOwnership();
        await transport.abortSession(retryStopInput(task));
        for (let poll = 0; poll < retryStopPollLimit; poll += 1) {
          assertRunning();
          const status = await transport.readStatus(retryStopInput(task));
          assertOwnership();
          const statusType = trimString(status?.type).toLowerCase();
          if (!LIVE_STATUS_TYPES.has(statusType)) return null;
          const retryIdentity = retryStatusIdentity(status);
          const shouldReabort = statusType === 'busy'
            || (statusType === 'retry' && retryIdentity !== lastRetryIdentity);
          if (shouldReabort && abortCount < retryStopMaxAborts) {
            await transport.abortSession(retryStopInput(task));
            abortCount += 1;
          }
          if (statusType === 'retry') lastRetryIdentity = retryIdentity;
          await sleep(pollIntervalMs, { signal: shutdownController.signal });
        }
        return new Error(`Managed child session ${task.childSessionId} provider retry loop did not stop`);
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
    })().finally(() => {
      if (retryStops.get(task.childSessionId) === operation) {
        retryStops.delete(task.childSessionId);
      }
    });
    retryStops.set(task.childSessionId, operation);
    return operation;
  };

  const ensureRetryStopped = async (task, expectedAttempt = null) => {
    const pending = retryStops.get(task.childSessionId);
    if (pending) return await pending;
    const status = await transport.readStatus(retryStopInput(task));
    const statusType = trimString(status?.type).toLowerCase();
    if (!LIVE_STATUS_TYPES.has(statusType)) return null;
    return await startRetryStop(task, status, expectedAttempt);
  };

  // Successful status and transcript reads reset only their own failure clock.
  // An unreadable child remains owned until a fresh status confirms it is idle.
  const settleObservationFailure = async (task, otherFailure = null) => {
    const attempt = attemptFor(task);
    const overdueFailure = () => [attempt?.statusFailure, attempt?.transcriptFailure, otherFailure]
      .filter((failure) => failure && now() - failure.firstAt >= observationFailureGraceMs)
      .sort((left, right) => left.firstAt - right.firstAt)[0];
    let failure = attempt?.observationCleanupFailure ?? overdueFailure();
    if (!failure) return null;
    if (activeExecutions.get(task.taskId) !== attempt) {
      throw new Error('Managed task execution lease changed during observation');
    }
    const isIdle = (status) => status === null || trimString(status?.type).toLowerCase() === 'idle';
    const result = () => ({
      status: 'interrupted',
      failureReason: extractFailureReason(failure.error) || 'Managed child session could not be observed',
      recoverablePreview: '', canonicalRefs: [], partial: false,
      ...copyRecovery(attempt.recovery), resumable: true,
    });
    try {
      let status;
      try { status = await readLiveStatus(task); }
      catch { assertRunning(); }
      if (activeExecutions.get(task.taskId) !== attempt) return null;
      failure = attempt.observationCleanupFailure ?? overdueFailure();
      if (!failure) return null;
      if (isIdle(status)) return result();
      // Once teardown begins, neither a stale terminal event nor a recovered
      // transcript can release a child whose liveness is still unconfirmed.
      attempt.observationCleanupFailure = failure;
      if (now() < (attempt.observationStopNotBefore ?? 0)) return 'pending';
      attempt.observationStopNotBefore = now() + OBSERVATION_STOP_RETRY_MS;
      let stopError;
      try { stopError = await startRetryStop(task, status, attempt); }
      finally { attempt.observationStopNotBefore = now() + OBSERVATION_STOP_RETRY_MS; }
      if (!stopError && isIdle(await readLiveStatus(task))
        && activeExecutions.get(task.taskId) === attempt) return result();
    } catch {
      assertRunning();
    }
    return 'pending';
  };

  const settleProviderUsageLimit = (task, observation) => {
    if (
      observation.statusType !== 'retry'
      || observation.statusFailureKind !== PROVIDER_USAGE_LIMIT_FAILURE_KIND
    ) {
      return null;
    }
    void startRetryStop(task, {
      type: observation.statusType,
      message: observation.statusMessage,
      attempt: observation.statusAttempt,
      next: observation.statusNext,
      ...(observation.statusActionReason
        ? { action: { reason: observation.statusActionReason } }
        : {}),
    });
    return {
      status: 'failed',
      failureReason: getProviderUsageLimitFailureReason(observation),
      partial: observation.hasUsefulWork,
      recoverablePreview: observation.recoverablePreview,
      canonicalRefs: observation.canonicalRefs,
      resumable: true,
      providerResetAt: observation.statusNext ?? null,
    };
  };

  // Progress stamps are advisory: a control without `recordProgress` (bare
  // observation, older hosts) and a lost lease both leave the task untouched.
  const recordProgress = async (control, progress) => {
    if (typeof control?.recordProgress !== 'function') return;
    try {
      await control.recordProgress(progress);
    } catch {
      // The stamp never decides the task outcome.
    }
  };

  const activityWatches = new Map();
  const activityKey = (task) => `${task.taskId}:${task.leaseToken ?? ''}`;
  // A provider can create its assistant shell before prompt_async returns, so
  // restart observation must use the attempt start, not the acceptance stamp.
  const watchActivity = (task, control, after = task.startedAt ?? task.childPromptedAt ?? now(), excludedMessageId = null) => {
    const attempt = attemptFor(task);
    const existing = activityWatches.get(activityKey(task));
    if (existing && existing.attempt === attempt && after <= existing.after
      && (!excludedMessageId || excludedMessageId === existing.excludedMessageId)) return existing;
    const firstOutput = existing?.attempt === attempt ? existing.firstOutput : {
      settled: task.firstAssistantPartAt != null, pending: false,
    };
    after = Math.max(after, existing?.attempt === attempt ? existing.after : after);
    existing?.dispose();
    let disposed = false;
    let lastProgressAt = null;
    let unsubscribe = () => {};
    const stamp = async ({ messageId, observedAt }, source) => {
      if (disposed || firstOutput.settled || firstOutput.pending || typeof control?.recordProgress !== 'function') return;
      firstOutput.pending = true;
      try {
        const accepted = await control.recordProgress({ firstAssistantPartAt: observedAt });
        firstOutput.settled = true;
        if (accepted !== false) {
          try {
            await options.onFirstAssistantActivity?.({
              taskId: task.taskId, childSessionId: task.childSessionId,
              messageId, observedAt, source,
            });
          } catch { /* Diagnostics cannot affect execution. */ }
        }
      } catch { /* A later event or transcript observation can retry persistence. */ }
      finally { firstOutput.pending = false; }
    };
    const watch = { taskId: task.taskId, attempt, after, excludedMessageId, stamp,
      firstOutput, progressAt: () => !disposed && activeExecutions.get(task.taskId) === attempt ? lastProgressAt : null,
      dispose: () => { disposed = true; lastProgressAt = null; unsubscribe(); } };
    activityWatches.set(activityKey(task), watch);
    if (options.subscribeAssistantActivity) {
      unsubscribe = options.subscribeAssistantActivity({
        sessionId: task.childSessionId, directory: task.directory, after, excludedMessageId,
      }, (activity) => { void stamp(activity, 'event'); }, ({ observedAt }) => {
        if (!disposed && activeExecutions.get(task.taskId) === attempt && !attempt?.controller.signal.aborted
          && Number.isFinite(observedAt) && observedAt >= after && observedAt <= now()) {
          lastProgressAt = Math.max(lastProgressAt ?? observedAt, observedAt);
        }
      });
      if (disposed) unsubscribe();
    }
    return watch;
  };
  const releaseActivity = (task) => {
    const watch = activityWatches.get(activityKey(task));
    if (watch?.attempt !== attemptFor(task)) return;
    watch?.dispose();
    activityWatches.delete(activityKey(task));
  };
  const withActivityCleanup = (execute) => async (task, control) => {
    const attempt = {
      leaseToken: task.leaseToken,
      operatorAbortAfter: Number.isFinite(task.startedAt) ? task.startedAt : now(),
      controller: new AbortController(), recovery: null, abortConfirmed: false,
      childSessionId: task.childSessionId,
      transportRecovery: task.transportRecovery,
      sourceTask: task,
    };
    const runningTask = { ...task, [attemptContext]: attempt };
    activeExecutions.set(task.taskId, attempt);
    try {
      try { return await execute(runningTask, control); }
      catch (error) {
        if (!attempt.controller.signal.aborted || shutdownController.signal.aborted || !attempt.childSessionId) throw error;
        // Cancelling a local POST/observer is not proof its remote child stopped.
        // Keep ownership until confirmed abort or canonical idle settlement.
        const cancelledTask = { ...runningTask, childSessionId: attempt.childSessionId };
        return await observeCancelledAttempt(cancelledTask);
      }
    } finally {
      releaseActivity(runningTask);
      if (activeExecutions.get(task.taskId) === attempt) activeExecutions.delete(task.taskId);
    }
  };

  const observeCancelledAttempt = async (task) => {
    task = { ...task, [settlementRead]: true };
    const attempt = attemptFor(task);
    // A cancelled recovery retains its ambiguous receipt and resumable outcome;
    // stopping the child does not prove whether that continuation was accepted.
    // Explicit scheduler cancellation still owns its separate terminal commit.
    const recoveryPending = ['reserved', 'submitted'].includes(attempt.transportRecovery?.phase);
    const statusOnCancellation = recoveryPending ? 'interrupted' : 'aborted';
    const failureReason = recoveryPending
      ? 'Managed connection recovery was cancelled; the continuation was not resent'
      : 'Managed task cancelled';
    while (true) {
      assertRunning();
      if (attempt.abortConfirmed) return { status: statusOnCancellation, failureReason, ...copyRecovery(attempt.recovery), ...(recoveryPending ? { resumable: true } : {}) };
      const interrupted = await settleObservationFailure(task);
      if (interrupted === 'pending') {
        await sleep(pollIntervalMs, { signal: shutdownController.signal });
        continue;
      }
      if (interrupted) return interrupted;
      try {
        const status = await readLiveStatus(task);
        if (LIVE_STATUS_TYPES.has(normalizeStatusFields(status).statusType)) {
          await sleep(pollIntervalMs, { signal: shutdownController.signal });
          continue;
        }
        const observation = await readObservation(task, status);
        if (!LIVE_STATUS_TYPES.has(observation.statusType) && !observation.hasInFlightTool && !observation.hasUncertainTool) {
          return toTerminalResult(observation)?.status === 'completed'
            ? toTerminalResult(observation)
            : transportRecoveryResult(observation, failureReason, statusOnCancellation);
        }
      } catch {
        // An unreadable child is still owned. A later Stop can retry its abort;
        // shutdown releases observation without claiming remote termination.
        assertRunning();
      }
      await sleep(pollIntervalMs, { signal: shutdownController.signal });
    }
  };

  const waitForTerminal = async (task, waitOptions = {}) => {
    if (typeof options.subscribeSessionChanges !== 'function') return observeTerminal(task, waitOptions);
    let revision = 0;
    let wake;
    const dispose = options.subscribeSessionChanges({ sessionId: task.childSessionId, directory: task.directory }, () => {
      revision += 1; wake?.();
    });
    const changes = {
      revision: () => revision,
      async wait(after) {
        if (revision !== after) return;
        const timer = new AbortController();
        const attemptSignal = attemptFor(task)?.controller.signal;
        const signal = AbortSignal.any([shutdownController.signal, timer.signal, ...attemptSignal ? [attemptSignal] : []]);
        const notified = new Promise(resolve => { wake = resolve; });
        const elapsed = defaultSleep(eventReconcileIntervalMs, { signal });
        try { await Promise.race([notified, elapsed]); }
        finally { wake = undefined; timer.abort(); await elapsed.catch(() => {}); }
        assertRunning();
      },
    };
    try { return await observeTerminal(task, { ...waitOptions, changes }); }
    finally { wake = undefined; dispose(); }
  };

  const observeTerminal = async (task, waitOptions = {}) => {
    if (!task.childSessionId) {
      throw new Error(`Managed task ${task.taskId} has no child session`);
    }
    let emptyTerminalPolls = 0;
    let lastSuccessfulObservation = null;
    let transientTransportContinuations = 0;
    let emptyOutputContinuations = 0;
    let firstTransientFailureAt = null;
    let lastTranscriptReadAt = null;
    let lastLiveProgressAt = null;
    let lastLiveProgressSignature = null;
    let hasStaleTailAnchor = Boolean(waitOptions.staleTailAnchor);
    const staleTailAnchorId = trimString(waitOptions.staleTailAnchor?.assistantMessageId) || null;
    let staleTailPromptPostedAt = Number.isFinite(waitOptions.staleTailAnchor?.promptPostedAt)
      ? waitOptions.staleTailAnchor.promptPostedAt
      : now();
    const staleTailPrompt = trimString(waitOptions.staleTailAnchor?.prompt) || '';
    let staleTailReprompts = 0;
    let staleTailGraceExhausted = false;
    // First assistant output of THIS attempt: the inherited stale tail never counts.
    const activityWatch = watchActivity(task, waitOptions.control);
    const stampFirstAssistantPart = async (observation) => {
      const currentWatch = activityWatches.get(activityKey(task)) ?? activityWatch;
      options.bindAssistantActivity?.({
        sessionId: task.childSessionId, directory: task.directory,
        after: currentWatch.after, excludedMessageId: currentWatch.excludedMessageId,
      }, observation.assistantActivityBindings ?? []);
      const messageId = observation.assistantActivityIds?.at(-1);
      if (!messageId || messageId === staleTailAnchorId) return;
      if (staleTailAnchorId && observation.assistantMessageIds.indexOf(messageId)
        <= observation.assistantMessageIds.indexOf(staleTailAnchorId)) return;
      await currentWatch.stamp({ messageId, observedAt: now() }, 'transcript');
    };
    // Turn-budget backstop. Turns are counted from this wait's baseline: 0 for a
    // fresh child, the inherited tail for resume/retry (a deliberately resumed
    // attempt gets a fresh budget instead of an instant re-abort), and the first
    // transcript read for a bare observe.
    const turnBudget = resolveTurnBudget(task);
    let turnBudgetBaseline = Number.isSafeInteger(waitOptions.turnBudgetBaseline)
      && waitOptions.turnBudgetBaseline >= 0
      ? waitOptions.turnBudgetBaseline
      : null;
    let turnBudgetPromptSent = false;
    const enforceTurnBudget = async (observation) => {
      if (attemptFor(task)?.steeringUserId) return null;
      if (turnBudget === null) return null;
      if (turnBudgetBaseline === null) turnBudgetBaseline = observation.assistantCount;
      const usedTurns = observation.assistantCount - turnBudgetBaseline;
      if (usedTurns >= turnBudget + MANAGED_TURN_BUDGET_ABORT_GRACE_TURNS) {
        const failureReason = `turn budget (${turnBudget}) exceeded; partial results reported`;
        const stopError = await ensureRetryStopped(task);
        return {
          status: stopError ? 'interrupted' : 'failed',
          failureReason: stopError
            ? `${failureReason}; failed to stop the managed child: ${extractFailureReason(stopError) || 'unknown abort failure'}`
            : failureReason,
          partial: observation.hasUsefulWork,
          recoverablePreview: observation.recoverablePreview,
          canonicalRefs: observation.canonicalRefs,
          resumable: true,
        };
      }
      if (usedTurns >= turnBudget && !turnBudgetPromptSent) {
        // Posted exactly once per wait, the way the other continuations are. OpenCode
        // queues it behind the running turn, so the child is not aborted here.
        turnBudgetPromptSent = await promptTask(task, {
          sessionId: task.childSessionId,
          directory: task.directory,
          providerId: task.providerId,
          modelId: task.modelId,
          agent: task.agent,
          variant: task.variant,
          prompt: resolveContinuationTaskPrompt(task, MANAGED_TURN_BUDGET_PROMPT),
          tools: resolveTaskPromptTools(task),
        });
      }
      return null;
    };
    let terminalErrorAfter = Number.isFinite(waitOptions.terminalErrorAfter)
      ? waitOptions.terminalErrorAfter
      : Number.isFinite(task.startedAt) ? task.startedAt : 0;
    // A user Stop belongs to this attempt; recovery bumps never move this baseline.
    const operatorAbortAfter = attemptFor(task)?.operatorAbortAfter ?? terminalErrorAfter;
    terminalErrorAfter = Math.max(terminalErrorAfter, task.transportRecovery?.reservedAt ?? 0);
    let orphanPolls = 0;
    let stoppedHandoff = null;
    let operatorAbortSeenAt = null;
    let operatorAbortStopNotBefore = null;
    const settleOperatorAbort = async () => {
      const stopped = await readApplicableOperatorAbort(task, operatorAbortAfter);
      if (!stopped || stopped.steered) {
        operatorAbortSeenAt = null;
        operatorAbortStopNotBefore = null;
        return null;
      }
      const { observation } = stopped;
      if (!observation) return 'pending';
      if (!LIVE_STATUS_TYPES.has(observation.statusType)) {
        const terminal = toTerminalResult(observation);
        if (terminal?.status === 'completed') return terminal;
        return transportRecoveryResult(observation, 'Stopped by the user', 'aborted');
      }
      // Still live: never continue, recover or re-prompt on the user's behalf.
      operatorAbortSeenAt ??= now();
      if (now() - operatorAbortSeenAt >= resumeTeardownSettleMs
        && now() >= (operatorAbortStopNotBefore ?? 0)) {
        operatorAbortStopNotBefore = now() + OBSERVATION_STOP_RETRY_MS;
        await ensureRetryStopped(task, attemptFor(task));
        operatorAbortStopNotBefore = now() + OBSERVATION_STOP_RETRY_MS;
      }
      // An unconfirmed Stop retains ownership; a later canonical idle snapshot
      // settles it, while withdrawal and newer steering remain observable.
      return 'pending';
    };
    let pendingTransportEvent = null;
    let settlementStartedAt = null;
    let recoveryAssistantSeen = false;
    let steeringAccepted = false;
    while (true) {
      // Subscribe before observation and retain changes across awaited reads;
      // a completion between readStatus and wait registration cannot be lost.
      const eventRevision = waitOptions.changes?.revision();
      let observation;
      try {
        attemptFor(task)?.controller.signal.throwIfAborted();
        const interrupted = await settleObservationFailure(task);
        if (interrupted === 'pending') {
          await sleep(pollIntervalMs, { signal: shutdownController.signal });
          continue;
        }
        if (interrupted) return interrupted;
        const operatorAbort = await settleOperatorAbort();
        if (operatorAbort === 'pending') {
          await sleep(pollIntervalMs, { signal: shutdownController.signal });
          assertRunning();
          continue;
        }
        if (operatorAbort) return operatorAbort;
        if (attemptFor(task)?.steeringUserId && !steeringAccepted) {
          if (typeof waitOptions.control?.markAccepted === 'function') {
            await retainInPlaceAcceptance(task, waitOptions.control, 'after user steering');
          }
          steeringAccepted = true;
        }
        const authoritativeError = attemptFor(task)?.steeringUserId ? null : await readAuthoritativeTerminalError(
          task,
          terminalErrorAfter,
          lastSuccessfulObservation,
        );
        if (authoritativeError && !authoritativeError.transportKind) {
          if (isProviderAuthenticationFailure(authoritativeError.result.failureReason)) {
            await stopMatchingAuthenticationRetry(task, authoritativeError.observation,
              authoritativeError.result.failureReason, authoritativeError.error, authoritativeError.previousAuthenticationFailure);
          }
          return configurationFailure(task, waitOptions.control,
            authoritativeError.observation, authoritativeError.result, authoritativeError.error);
        }
        if (authoritativeError && (!pendingTransportEvent
          || pendingTransportEvent.eventId !== authoritativeError.error.eventId)) {
          pendingTransportEvent = {
            ...authoritativeError.error,
            failedMessageId: authoritativeError.observation?.latestAssistantMessageId ?? null,
          };
          settlementStartedAt ??= now();
        }
        // Cheap gate first. A live child (busy, or retrying for a reason other
        // than a definite usage limit) can never produce a terminal result, so
        // it does not need a transcript read on every poll. The status itself is
        // handed to readObservation so an iteration still costs one status read.
        const status = await readLiveStatus(task);
        const liveStatus = normalizeStatusFields(status);
        if (liveStatus.statusType === 'retry' && isProviderConfigurationFailure(liveStatus.statusMessage)) {
          const rejected = await readObservation(task, status);
          return configurationFailure(task, waitOptions.control, rejected, {
            status: 'failed', failureReason: liveStatus.statusMessage, partial: rejected.hasUsefulWork,
            recoverablePreview: rejected.recoverablePreview, canonicalRefs: rejected.canonicalRefs, resumable: true,
          });
        }
        if (liveStatus.statusType === 'retry' && isProviderAuthenticationFailure(liveStatus.statusMessage)) {
          // Park sign-in failures for manual recovery. Stop only a freshly
          // matched canonical turn; do not chase changed or unidentified retries.
          const rejected = await readObservation(task, status);
          await stopMatchingAuthenticationRetry(task, rejected, liveStatus.statusMessage);
          return {
            status: 'failed', failureReason: liveStatus.statusMessage, partial: rejected.hasUsefulWork,
            recoverablePreview: rejected.recoverablePreview, canonicalRefs: rejected.canonicalRefs, resumable: true,
          };
        }

        if (
          LIVE_STATUS_TYPES.has(liveStatus.statusType)
          && !pendingTransportEvent
          && (!task.transportRecovery || recoveryAssistantSeen || attemptFor(task)?.steeringUserId)
          && !(
            liveStatus.statusType === 'retry'
            && liveStatus.statusFailureKind === PROVIDER_USAGE_LIMIT_FAILURE_KIND
          )
        ) {
          firstTransientFailureAt = null;
          // A live child is not settled, so it clears any pending empty-terminal
          // debounce exactly as a non-terminal observation used to.
          emptyTerminalPolls = 0;
          // Still refresh the partial-work snapshot on the first live poll and
          // periodically after it, so an interruption can surface recoverable
          // output — just not at the polling rate, which is what made a large
          // transcript unaffordable.
          if (
            lastTranscriptReadAt === null
            || now() - lastTranscriptReadAt >= liveTranscriptRefreshMs
          ) {
            const observedAt = now();
            const liveObservation = await readObservation(task, status);
            lastSuccessfulObservation = liveObservation;
            lastTranscriptReadAt = observedAt;
            await stampFirstAssistantPart(liveObservation);
            const turnBudgetResult = await enforceTurnBudget(liveObservation);
            if (turnBudgetResult) return turnBudgetResult;
            if (liveObservation.progressSignature !== lastLiveProgressSignature) {
              if (lastLiveProgressSignature !== null && liveStatus.statusType === 'busy') {
                await recordProgress(waitOptions.control, { assistantProgressAt: observedAt });
              }
              lastLiveProgressSignature = liveObservation.progressSignature;
              lastLiveProgressAt = observedAt;
            } else if (
              liveStatus.statusType === 'busy'
              && !attemptFor(task)?.steeringUserId
              && !liveObservation.hasBlockingInFlightTool
              && lastLiveProgressAt !== null
              && observedAt - Math.max(lastLiveProgressAt,
                (activityWatches.get(activityKey(task)) ?? activityWatch).progressAt() ?? lastLiveProgressAt) >= liveProgressTimeoutMs
            ) {
              const continuationAlreadyUsed = transientTransportContinuations
                  >= MAX_TRANSIENT_TRANSPORT_CONTINUATIONS
                || Boolean(task.transportRecovery)
                || liveObservation.transientTransportContinuationCount
                  >= MAX_TRANSIENT_TRANSPORT_CONTINUATIONS;
              const stopError = await ensureRetryStopped(task);
              if (stopError) {
                return {
                  status: 'interrupted',
                  failureReason: `Stream idle timeout; failed to stop the silent managed child: ${extractFailureReason(stopError) || 'unknown abort failure'}`,
                  partial: liveObservation.hasUsefulWork,
                  recoverablePreview: liveObservation.recoverablePreview,
                  canonicalRefs: liveObservation.canonicalRefs,
                  resumable: true,
                };
              }
              const settledObservation = await readObservation(task);
              const settledResult = toTerminalResult(settledObservation);
              if (settledResult?.status === 'completed') {
                return settledResult;
              }
              if (settledObservation.hasInFlightTool || settledObservation.hasUncertainTool
                || settledObservation.hasNewerUserInput || settledObservation.continuationPending
                || !settledObservation.assistantCompleted
                || LIVE_STATUS_TYPES.has(settledObservation.statusType)) {
                return transportRecoveryResult(settledObservation,
                  'Managed connection recovery needs attention: provider or tool settlement is unconfirmed');
              }
              if (continuationAlreadyUsed) {
                if (task.transportRecovery) {
                  if (settledObservation.latestAssistantParentId !== task.transportRecovery.recoveryMessageId) {
                    return transportRecoveryResult(settledObservation, 'Managed connection recovery was superseded by newer input');
                  }
                  await saveTransportRecovery(task, waitOptions.control, { phase: 'exhausted',
                    failedMessageId: settledObservation.latestAssistantMessageId,
                    failedUserMessageId: settledObservation.latestAssistantParentId });
                }
                return {
                  status: 'failed',
                  failureReason: 'Stream idle timeout: managed child stopped producing response data after one automatic recovery',
                  partial: liveObservation.hasUsefulWork,
                  recoverablePreview: liveObservation.recoverablePreview,
                  canonicalRefs: liveObservation.canonicalRefs,
                  resumable: true,
                };
              }

              transientTransportContinuations += 1;
              const failedRecovery = await sendTransportRecovery(task, waitOptions.control, settledObservation);
              if (failedRecovery) return failedRecovery;
              terminalErrorAfter = task.transportRecovery.reservedAt;
              lastTranscriptReadAt = null;
              lastLiveProgressAt = null;
              lastLiveProgressSignature = null;
              await sleep(pollIntervalMs, { signal: shutdownController.signal });
              assertRunning();
              continue;
            }
          }
          if (waitOptions.changes) await waitOptions.changes.wait(eventRevision);
          else await sleep(pollIntervalMs, { signal: shutdownController.signal });
          assertRunning();
          continue;
        }
        observation = await readObservation(task, status);
        lastTranscriptReadAt = now();
        lastSuccessfulObservation = observation;
        firstTransientFailureAt = null;
        await stampFirstAssistantPart(observation);
      } catch (error) {
        attemptFor(task)?.controller.signal.throwIfAborted();
        if (shutdownController.signal.aborted) {
          throw shutdownController.signal.reason ?? error;
        }
        if (attemptFor(task)?.transcriptFailure || isTransientObservationError(error)) {
          // Retain the fallback clock for transient control/registry failures;
          // healthy status never resets the independent transcript clock.
          firstTransientFailureAt ??= now();
          const attempt = attemptFor(task);
          const readFailure = attempt?.statusFailure?.error === error || attempt?.transcriptFailure?.error === error;
          const interrupted = await settleObservationFailure(task,
            readFailure ? null : { firstAt: firstTransientFailureAt, error });
          if (interrupted && interrupted !== 'pending') return interrupted;
          await sleep(pollIntervalMs, { signal: shutdownController.signal });
          assertRunning();
          continue;
        }
        return {
          status: 'interrupted',
          failureReason: extractFailureReason(error) || 'Managed child observation was interrupted',
          partial: lastSuccessfulObservation?.hasUsefulWork === true,
          recoverablePreview: lastSuccessfulObservation?.recoverablePreview ?? '',
          canonicalRefs: lastSuccessfulObservation?.canonicalRefs ?? [],
          resumable: true,
        };
      }
      const steeringUserId = attemptFor(task)?.steeringUserId;
      if (steeringUserId) {
        // A deliberate send supersedes every pending automatic continuation,
        // including a reserved recovery or stale-tail repost. Observe its own
        // assistant; do not collect the inherited tail or dispatch over it.
        const terminal = toTerminalResult(observation);
        if (!LIVE_STATUS_TYPES.has(observation.statusType)
          && observation.latestAssistantParentId === steeringUserId && terminal) return terminal;
        await sleep(pollIntervalMs, { signal: shutdownController.signal });
        continue;
      }
      const providerUsageLimit = settleProviderUsageLimit(task, observation);
      if (providerUsageLimit) return providerUsageLimit;
      // Only a rejection of this attempt's own turn settles it: right after a
      // new prompt the inherited failed tail (a stale anchor, or a recovery's
      // pre-continuation turn) can still be the latest assistant.
      if (isProviderConfigurationFailure(observation.failureReason)
        && !(hasStaleTailAnchor && observation.latestAssistantMessageId === staleTailAnchorId)
        && !(task.transportRecovery && observation.latestAssistantParentId !== task.transportRecovery.recoveryMessageId)) {
        const result = toTerminalResult(observation);
        if (result) return configurationFailure(task, waitOptions.control, observation, result);
      }
      if (pendingTransportEvent && !observation.failureReason
        && observation.latestAssistantMessageId !== pendingTransportEvent.failedMessageId
        && observation.assistantCompletedAt >= pendingTransportEvent.observedAt) {
        pendingTransportEvent = null;
        settlementStartedAt = null;
      }
      const recovery = task.transportRecovery;
      if (recovery) {
        const ownAssistant = observation.latestAssistantParentId === recovery.recoveryMessageId;
        recoveryAssistantSeen ||= ownAssistant;
        const newerUser = observation.latestUserMessageId
          && observation.latestUserMessageId !== recovery.recoveryMessageId
          && observation.latestUserMessageId !== recovery.failedUserMessageId;
        if (newerUser) {
          await saveTransportRecovery(task, waitOptions.control, { phase: 'blocked' });
          return transportRecoveryResult(observation, 'Managed connection recovery was superseded by newer input');
        }
        if (recovery.phase === 'uncertain' || recovery.phase === 'blocked') {
          return transportRecoveryResult(observation, 'Managed connection recovery requires manual review');
        }
        if (!ownAssistant) {
          if (now() - recovery.reservedAt < continuationStartGraceMs) {
            await sleep(pollIntervalMs, { signal: shutdownController.signal });
            continue;
          }
          await saveTransportRecovery(task, waitOptions.control, { phase: 'uncertain' });
          return transportRecoveryResult(observation,
            'Managed connection recovery delivery or execution is unconfirmed; the continuation was not resent');
        }
        // An accepted recovery's current assistant, rather than an old event or
        // the inherited failed tail, owns its outcome.
        if (pendingTransportEvent && !observation.failureReason) {
          pendingTransportEvent = null;
          settlementStartedAt = null;
        }
        const terminal = toTerminalResult(observation);
        if (terminal?.status === 'completed') {
          await saveTransportRecovery(task, waitOptions.control, { phase: 'recovered' });
          return terminal;
        }
      }
      const transportFailure = isTransientAssistantTransportFailure(observation.failureReason);
      if ((pendingTransportEvent || transportFailure)
        && !(hasStaleTailAnchor && observation.latestAssistantMessageId === staleTailAnchorId && !recovery)) {
        // Historical continuation markers retain their prior terminal outcome;
        // they never acquire a new reservation or automatic backup on upgrade.
        if (!recovery && (observation.transientTransportFailureCount > MAX_TRANSIENT_TRANSPORT_CONTINUATIONS
          || observation.transientTransportContinuationCount >= MAX_TRANSIENT_TRANSPORT_CONTINUATIONS
          || transientTransportContinuations >= MAX_TRANSIENT_TRANSPORT_CONTINUATIONS)) {
          const legacyResult = toTerminalResult(observation);
          if (legacyResult) return legacyResult;
        }
        settlementStartedAt ??= now();
        if (observation.hasNewerUserInput) {
          if (recovery) await saveTransportRecovery(task, waitOptions.control, { phase: 'blocked' });
          return transportRecoveryResult(observation, 'Managed connection recovery was superseded by newer input');
        }
        const settled = !LIVE_STATUS_TYPES.has(observation.statusType)
          && observation.assistantCompleted
          && transportFailure
          && !observation.hasInFlightTool
          && !observation.hasUncertainTool
          && !observation.continuationPending;
        if (!settled) {
          if (now() - settlementStartedAt >= resumeTeardownSettleMs) {
            if (recovery) await saveTransportRecovery(task, waitOptions.control, { phase: 'blocked' });
            return transportRecoveryResult(observation,
              'Managed connection recovery needs attention: provider or tool settlement is unconfirmed');
          }
          await sleep(pollIntervalMs, { signal: shutdownController.signal });
          continue;
        }
        if (recovery) {
          await saveTransportRecovery(task, waitOptions.control, {
            phase: 'exhausted', failedMessageId: observation.latestAssistantMessageId,
            failedUserMessageId: observation.latestAssistantParentId,
            eventId: pendingTransportEvent?.eventId ?? recovery.eventId,
          });
          return toTerminalResult(observation);
        }
        // Legacy transcripts already containing a recovery retain their consumed
        // budget. They do not acquire the new automatic backup policy on upgrade.
        if (observation.transientTransportFailureCount > MAX_TRANSIENT_TRANSPORT_CONTINUATIONS
          || observation.transientTransportContinuationCount >= MAX_TRANSIENT_TRANSPORT_CONTINUATIONS
          || transientTransportContinuations >= MAX_TRANSIENT_TRANSPORT_CONTINUATIONS) {
          return toTerminalResult(observation);
        }
        const failedRecovery = await sendTransportRecovery(task, waitOptions.control, observation, pendingTransportEvent);
        if (failedRecovery) return failedRecovery;
        transientTransportContinuations += 1;
        terminalErrorAfter = task.transportRecovery.reservedAt;
        pendingTransportEvent = null;
        settlementStartedAt = null;
        await sleep(pollIntervalMs, { signal: shutdownController.signal });
        continue;
      }
      // The tail of the previous attempt is not this attempt's result. A resume or
      // retry dispatched moments after an abort would otherwise read the killed turn's
      // error and terminalize instantly, before the child had run a single token. This
      // check deliberately precedes `continuationPending`: a prompt that reached the
      // transcript but never started still needs the bounded re-post/failure path.
      if (
        hasStaleTailAnchor
        && observation.latestAssistantMessageId === staleTailAnchorId
      ) {
        if (now() - staleTailPromptPostedAt < continuationStartGraceMs) {
          await sleep(pollIntervalMs, { signal: shutdownController.signal });
          assertRunning();
          continue;
        }
        if (staleTailReprompts < MAX_STALE_TAIL_REPROMPTS && staleTailPrompt) {
          // The continuation never reached the child (the abort tore the POST down).
          watchActivity(task, waitOptions.control, now(), staleTailAnchorId);
          const submitted = await promptTask(task, {
            sessionId: task.childSessionId,
            directory: task.directory,
            providerId: task.providerId,
            modelId: task.modelId,
            agent: task.agent,
            variant: task.variant,
            prompt: resolveContinuationTaskPrompt(task, staleTailPrompt),
            tools: resolveTaskPromptTools(task),
          });
          if (submitted) {
            staleTailReprompts += 1;
            staleTailPromptPostedAt = now();
          }
          await sleep(pollIntervalMs, { signal: shutdownController.signal });
          assertRunning();
          continue;
        }
        // Out of grace and out of re-posts: stop suppressing and report what is there
        // rather than polling to the hard deadline.
        hasStaleTailAnchor = false;
        staleTailGraceExhausted = true;
      }
      // The OpenCode process that ran this turn exited: the restarted runtime
      // reports the child idle but never settles its unfinished turn.
      const runtimeStartedAt = typeof transport.readRuntimeStartedAt === 'function'
        ? await transport.readRuntimeStartedAt({ providerId: task.providerId })
        : null;
      if (isRuntimeOrphanObservation(observation, runtimeStartedAt)) {
        orphanPolls += 1;
        if (orphanPolls >= idleStablePolls) {
          return transportRecoveryResult(observation,
            'Managed child was interrupted: the OpenCode runtime restarted while it was running');
        }
        await sleep(pollIntervalMs, { signal: shutdownController.signal });
        assertRunning();
        continue;
      }
      orphanPolls = 0;
      if (observation.continuationPending && !staleTailGraceExhausted) {
        await sleep(pollIntervalMs, { signal: shutdownController.signal });
        assertRunning();
        continue;
      }
      if (
        isEmptyTerminalObservation(observation)
        && !task.transportRecovery
        && observation.emptyOutputContinuationCount < MAX_EMPTY_OUTPUT_CONTINUATIONS
        && emptyOutputContinuations < MAX_EMPTY_OUTPUT_CONTINUATIONS
      ) {
        watchActivity(task, waitOptions.control, now(), observation.latestAssistantMessageId);
        const submitted = await promptTask(task, {
          sessionId: task.childSessionId,
          directory: task.directory,
          providerId: task.providerId,
          modelId: task.modelId,
          agent: task.agent,
          variant: task.variant,
          prompt: resolveContinuationTaskPrompt(task, MANAGED_EMPTY_OUTPUT_CONTINUATION_PROMPT),
          tools: resolveTaskPromptTools(task),
        });
        if (submitted) emptyOutputContinuations += 1;
        await sleep(pollIntervalMs, { signal: shutdownController.signal });
        assertRunning();
        continue;
      }
      if (!observation.terminal) {
        // Idle between steps (a tool-call handoff) still counts toward the budget;
        // a child that has already stopped is reported as-is below.
        const turnBudgetResult = await enforceTurnBudget(observation);
        if (turnBudgetResult) return turnBudgetResult;
      }
      if (isStoppedHandoffObservation(observation)) {
        // The same stopped step must be seen for the whole window.
        if (stoppedHandoff?.messageId !== observation.latestAssistantMessageId) {
          stoppedHandoff = { messageId: observation.latestAssistantMessageId, since: now() };
        } else if (now() - stoppedHandoff.since >= stoppedHandoffMs) {
          return toStoppedHandoffResult(observation);
        }
      } else stoppedHandoff = null;
      const terminal = toTerminalResult(observation);
      if (terminal) {
        const isEmptyTerminal = terminal.status === 'failed'
          && terminal.failureReason === 'Managed child session completed without useful assistant output';
        if (waitOptions.deferEmptyTerminal && isEmptyTerminal) {
          emptyTerminalPolls += 1;
          if (emptyTerminalPolls >= Math.max(2, idleStablePolls)) return terminal;
        } else {
          return terminal;
        }
      } else {
        emptyTerminalPolls = 0;
      }

      await sleep(pollIntervalMs, { signal: shutdownController.signal });
      assertRunning();
    }
  };

  const start = async (task, control) => {
    assertRunning();
    assertReadOnlyAgentSupport(task);
    assertReadOnlyProviderSupport(task);
    // Resolved before the child exists so a failing host hook cannot orphan a session.
    const promptPreamble = resolveTaskPromptPreamble
      ? await resolveTaskPromptPreamble(task)
      : null;
    const child = await transport.createSession({
      taskId: task.taskId,
      leaseToken: task.leaseToken,
      directory: task.directory,
      parentSessionId: task.rootSessionId,
      ...(task.dispatchCallId ? { parentCallID: task.dispatchCallId } : {}),
      title: formatManagedTaskDisplayName(task.label),
    });
    const childSessionId = trimString(child?.id);
    if (!childSessionId) {
      throw new Error('OpenCode did not return a managed child session ID');
    }
    await retainCheckpoint({
      task,
      childSessionId,
      checkpoint: () => control.setChildSessionId(childSessionId),
      stage: 'before provider prompt',
      deleteSession: true,
    });
    const runningTask = { ...task, childSessionId };
    attemptFor(task).childSessionId = childSessionId;
    const terminalErrorAfter = now();
    watchActivity(runningTask, control, terminalErrorAfter);
    const submitted = await promptTask(runningTask, {
      sessionId: childSessionId,
      directory: task.directory,
      providerId: task.providerId,
      modelId: task.modelId,
      agent: task.agent,
      variant: task.variant,
      prompt: resolveInitialTaskPrompt(task, promptPreamble),
      tools: resolveTaskPromptTools(task),
    });
    if (!submitted) return await waitForTerminal(runningTask, { terminalErrorAfter, turnBudgetBaseline: 0, control });
    await recordProgress(control, { childPromptedAt: now() });
    await retainCheckpoint({
      task,
      childSessionId,
      checkpoint: () => control.markAccepted(),
      stage: 'after provider prompt',
      deleteSession: true,
    });
    return await waitForTerminal(runningTask, { terminalErrorAfter, turnBudgetBaseline: 0, control });
  };

  const observe = async (task, control) => await waitForTerminal(task, { control });

  const retainInPlaceAcceptance = async (task, control, stage) => {
    await retainCheckpoint({
      task,
      childSessionId: task.childSessionId,
      checkpoint: () => control.markAccepted(),
      stage,
      deleteSession: false,
    });
  };

  const resume = async (task, control) => {
    if (!task.childSessionId) {
      throw new Error(`Managed task ${task.taskId} has no child session`);
    }
    assertReadOnlyAgentSupport(task);
    assertReadOnlyProviderSupport(task);

    let status;
    let observation;
    try {
      // A resume dispatched seconds after the previous attempt was aborted finds the
      // child still reporting busy while that turn tears down. Treating that as "live"
      // skipped the continuation prompt entirely, and the attempt then died on the
      // previous turn's abort. Wait a bounded moment for the teardown to settle.
      status = await readLiveStatus(task);
      const settleDeadline = now() + resumeTeardownSettleMs;
      while (normalizeStatusFields(status).statusType === 'busy' && now() < settleDeadline) {
        await sleep(pollIntervalMs, { signal: shutdownController.signal });
        assertRunning();
        status = await readLiveStatus(task);
      }
      const liveStatus = normalizeStatusFields(status);
      if (
        LIVE_STATUS_TYPES.has(liveStatus.statusType)
        && !(
          liveStatus.statusType === 'retry'
          && liveStatus.statusFailureKind === PROVIDER_USAGE_LIMIT_FAILURE_KIND
        )
      ) {
        // Still live past the settle window: a genuinely running child, not teardown.
        await retainInPlaceAcceptance(task, control, 'before resumed live observation');
        return await waitForTerminal(task, { control });
      }
      observation = await readObservation(task, status);
    } catch (error) {
      if (!isTransientObservationError(error)) throw error;
      await retainInPlaceAcceptance(task, control, 'before resumed observation');
      return await waitForTerminal(task, { control });
    }

    const providerUsageLimit = settleProviderUsageLimit(task, observation);
    if (providerUsageLimit) {
      await retainInPlaceAcceptance(task, control, 'before accepting provider-limit result');
      return providerUsageLimit;
    }

    const terminal = toTerminalResult(observation);
    if (terminal?.status === 'completed') {
      await retainInPlaceAcceptance(task, control, 'before accepting completed resumed work');
      return terminal;
    }

    if (
      terminal
      && !observation.continuationPending
      && !isTransientAssistantTransportFailure(observation.failureReason)
      && !isEmptyTerminalObservation(observation)
    ) {
      // Anchored to this attempt's tail rather than to a transcript-lifetime count: a
      // child that was already resumed once still needs its own continuation now.
      const staleTailAssistantMessageId = observation.latestAssistantMessageId;
      const terminalErrorAfter = now();
      watchActivity(task, control, terminalErrorAfter, staleTailAssistantMessageId);
      const submitted = await promptTask(task, {
        sessionId: task.childSessionId,
        directory: task.directory,
        providerId: task.providerId,
        modelId: task.modelId,
        agent: task.agent,
        variant: task.variant,
        prompt: resolveContinuationTaskPrompt(task, MANAGED_RESUME_CONTINUATION_PROMPT),
        tools: resolveTaskPromptTools(task),
      });
      if (!submitted) return await waitForTerminal(task, { control, turnBudgetBaseline: observation.assistantCount });
      await recordProgress(control, { childPromptedAt: now() });
      const staleTailAnchor = {
        assistantMessageId: staleTailAssistantMessageId,
        promptPostedAt: now(),
        prompt: MANAGED_RESUME_CONTINUATION_PROMPT,
      };
      await retainInPlaceAcceptance(task, control, 'after resume continuation prompt');
      await sleep(pollIntervalMs, { signal: shutdownController.signal });
      assertRunning();
      return await waitForTerminal(task, {
        control,
        deferEmptyTerminal: true,
        staleTailAnchor,
        terminalErrorAfter,
        turnBudgetBaseline: observation.assistantCount,
      });
    }

    await retainInPlaceAcceptance(task, control, 'before resumed observation');
    return await waitForTerminal(task, { control, turnBudgetBaseline: observation.assistantCount });
  };

  const retryInPlace = async (task, control) => {
    if (!task.childSessionId) {
      throw new Error(`Managed task ${task.taskId} has no child session`);
    }
    assertReadOnlyAgentSupport(task);
    assertReadOnlyProviderSupport(task);
    if (task.transportRecovery?.phase === 'backup_pending') {
      // Automatic fallback never aborts a newer turn to make room for itself.
      const observation = await readObservation(task);
      // Stopping a native retry can replace the error with MessageAbortedError.
      // Configuration rejection and host-observed silent-stream cancellation
      // retain the exact settled turn before reserving their backup.
      const permitsSettledCancellation = isConfigurationReceipt(task, control)
        || task.transportRecovery.kind === 'stream_idle_timeout';
      const settledTurnMatches = permitsSettledCancellation
        && observation.latestAssistantMessageId === task.transportRecovery.failedMessageId
        && observation.latestUserMessageId === task.transportRecovery.failedUserMessageId;
      if (LIVE_STATUS_TYPES.has(observation.statusType) || !observation.assistantCompleted
        || observation.hasInFlightTool || observation.hasUncertainTool || observation.continuationPending
        || observation.hasNewerUserInput
        || !(permitsSettledCancellation
          ? settledTurnMatches : isTransientAssistantTransportFailure(observation.failureReason))
        || observation.latestAssistantParentId !== task.transportRecovery.recoveryMessageId) {
        await saveTransportRecovery(task, control, { phase: 'blocked' });
        return transportRecoveryResult(observation, 'Automatic backup needs attention: the failed turn is no longer safely resumable');
      }
      await retainInPlaceAcceptance(task, control, 'before automatic backup continuation');
      const failedRecovery = await sendTransportRecovery(task, control, observation, null, true);
      if (failedRecovery) return failedRecovery;
      return await waitForTerminal(task, { control, terminalErrorAfter: task.transportRecovery.reservedAt });
    }
    const stopError = await ensureRetryStopped(task);
    if (stopError) throw stopError;
    // Capture the tail this retry inherits, so the first poll cannot settle on the
    // previous attempt's result before OpenCode has started the new turn.
    const priorObservation = await readObservation(task);
    const staleTailAssistantMessageId = priorObservation.latestAssistantMessageId;
    const terminalErrorAfter = now();
    watchActivity(task, control, terminalErrorAfter, staleTailAssistantMessageId);
    const submitted = await promptTask(task, {
      sessionId: task.childSessionId,
      directory: task.directory,
      providerId: task.providerId,
      modelId: task.modelId,
      agent: task.agent,
      variant: task.variant,
      prompt: resolveContinuationTaskPrompt(
        task,
        `${MANAGED_RETRY_IN_PLACE_PROMPT}\n\n${buildModelContinuationNotice(task, priorObservation.failureReason)}`,
      ),
      tools: resolveTaskPromptTools(task),
    });
    if (!submitted) return await waitForTerminal(task, { control, turnBudgetBaseline: priorObservation.assistantCount });
    await recordProgress(control, { childPromptedAt: now() });
    // The anchor re-posts the bare prompt; recognition strips the notice either way.
    const staleTailAnchor = {
      assistantMessageId: staleTailAssistantMessageId,
      promptPostedAt: now(),
      prompt: MANAGED_RETRY_IN_PLACE_PROMPT,
    };
    await retainCheckpoint({
      task,
      childSessionId: task.childSessionId,
      checkpoint: () => control.markAccepted(),
      stage: 'after retry-in-place prompt',
      deleteSession: false,
    });
    return await waitForTerminal(task, {
      control,
      deferEmptyTerminal: true,
      staleTailAnchor,
      terminalErrorAfter,
      turnBudgetBaseline: priorObservation.assistantCount,
    });
  };

  const readRecoverableResult = async (task) => {
    if (!task.childSessionId) {
      return { recoverablePreview: '', canonicalRefs: [], resumable: false };
    }
    // Cancellation harvesting always gets a fresh attempt with the host's full
    // transcript allowance, even while ordinary observation is backing off.
    const observation = await readObservation(task, undefined, { fresh: true });
    const terminal = toTerminalResult(observation);
    return {
      recoverablePreview: observation.recoverablePreview,
      canonicalRefs: observation.canonicalRefs,
      partial: observation.hasUsefulWork,
      resumable: terminal?.status !== 'completed',
    };
  };

  const reconcile = async (task) => {
    if (!task.childSessionId) {
      return {
        state: 'unavailable',
        failureReason: `Managed task ${task.taskId} has no child session`,
      };
    }
    const input = {
      sessionId: task.childSessionId,
      directory: task.directory,
      providerId: task.providerId,
    };
    try {
      const session = await transport.readSession(input);
      if (!session) {
        return {
          state: 'unavailable',
          failureReason: `Managed child session ${task.childSessionId} is unavailable`,
          recovery: {
            recoverablePreview: '',
            canonicalRefs: [],
            resumable: false,
          },
        };
      }
      const observation = await readObservation(task);
      if (task.transportRecovery?.phase === 'backup_pending') return { state: 'relaunch' };
      if (task.transportRecovery) return { state: 'live' };
      const providerUsageLimit = settleProviderUsageLimit(task, observation);
      if (providerUsageLimit) {
        return { state: 'terminal', result: providerUsageLimit };
      }
      if (observation.continuationPending) {
        return { state: 'live' };
      }
      if (
        task.executionKind === 'resume'
        && observation.terminal
        && !isTransientAssistantTransportFailure(observation.failureReason)
        && !isEmptyTerminalObservation(observation)
        && toTerminalResult(observation)?.status !== 'completed'
      ) {
        return { state: 'relaunch' };
      }
      if (
        !LIVE_STATUS_TYPES.has(observation.statusType)
        && isTransientAssistantTransportFailure(observation.failureReason)
        && observation.transientTransportFailureCount <= MAX_TRANSIENT_TRANSPORT_CONTINUATIONS
        && observation.transientTransportContinuationCount < MAX_TRANSIENT_TRANSPORT_CONTINUATIONS
      ) {
        return { state: 'live' };
      }
      if (
        isEmptyTerminalObservation(observation)
        && observation.emptyOutputContinuationCount < MAX_EMPTY_OUTPUT_CONTINUATIONS
      ) {
        return { state: 'live' };
      }
      const terminal = toTerminalResult(observation);
      if (terminal) return { state: 'terminal', result: terminal };
      return { state: 'live' };
    } catch (error) {
      if (shutdownController.signal.aborted) {
        throw shutdownController.signal.reason ?? error;
      }
      if (isTransientObservationError(error)) {
        return {
          state: 'transient',
          failureReason: extractFailureReason(error) || 'Managed child reconciliation is temporarily unavailable',
        };
      }
      throw error;
    }
  };

  return {
    start: withActivityCleanup(start),
    resume: withActivityCleanup(resume),
    retryInPlace: withActivityCleanup(retryInPlace),
    observe: withActivityCleanup(observe),
    async abort(task, options = {}) {
      const active = activeExecutions.get(task.taskId);
      if (active && active.leaseToken !== task.leaseToken) {
        return { aborted: false, failureReason: 'Managed task execution lease changed' };
      }
      const attempt = attemptFor(task);
      attempt?.controller.abort(new Error('Managed task cancelled'));
      releaseActivity(task);
      // The native removal owner already awaited the actual runner, process
      // receipts and publication fence. Still close this executor's observer.
      if (options.nativeSettled === true) {
        if (attempt) attempt.abortConfirmed = true;
        return { aborted: true };
      }
      if (!task.childSessionId) return { aborted: false, failureReason: 'Managed task has no child session' };
      const aborted = await transport.abortSession({
        sessionId: task.childSessionId,
        directory: task.directory,
        providerId: task.providerId,
        signal: options.signal,
      });
      if (attempt && aborted !== false) attempt.abortConfirmed = true;
      return {
        aborted: aborted !== false,
        ...(aborted === false ? { failureReason: 'Provider did not confirm the managed child abort' } : {}),
      };
    },
    reconcile,
    readRecoverableResult,
    getLastRecoverableResult: (task) => copyRecovery(attemptFor(task)?.recovery),
    async shutdown() {
      for (const watch of activityWatches.values()) watch.dispose();
      activityWatches.clear();
      if (!shutdownController.signal.aborted) {
        shutdownController.abort(new Error('Managed OpenCode executor shut down'));
      }
      for (const attempt of activeExecutions.values()) {
        attempt.controller.abort(shutdownController.signal.reason);
      }
      activeExecutions.clear();
    },
  };
};
