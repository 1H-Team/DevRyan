import { resolveProviderPromptTools } from './provider-prompt-tools.js';
import { formatManagedTaskDisplayName } from './contract.js';
import {
  classifyProviderTransportFailure,
  isDefiniteProviderUsageLimit,
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
// Provider streams can remain half-open after a network failure while OpenCode
// continues to report the session as busy. Bound that silent state without
// interrupting long-running tools or provider-managed retry backoff.
const DEFAULT_LIVE_PROGRESS_TIMEOUT_MS = 5 * 60 * 1_000;
export const MANAGED_RETRY_IN_PLACE_PROMPT = 'Continue the task from the existing progress. The previous provider could not continue. Do not repeat completed work.';
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

const isCursorSdkProvider = (providerId) => trimString(providerId).toLowerCase() === 'cursor-acp';

const assertReadOnlyProviderSupport = (task) => {
  if (!task.readOnly || !isCursorSdkProvider(task.providerId)) return;
  throw new Error(
    'Plan-mode managed tasks cannot use Cursor because its SDK does not expose enforceable per-prompt write restrictions',
  );
};

const resolveTaskPrompt = (task, prompt) => (
  task.readOnly
    ? `${MANAGED_READ_ONLY_PROMPT}\n\n${prompt}`
    : prompt
);

const resolveTaskPromptTools = (task) => resolveProviderPromptTools(
  task.providerId,
  task.agent,
  { readOnly: task.readOnly },
);

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

const extractToolOutput = (part) => {
  const candidates = [part?.state?.output, part?.output, part?.state?.error];
  for (const candidate of candidates) {
    const value = trimString(candidate);
    if (value) return value;
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

const matchesManagedUserPrompt = (value, prompt) => {
  const normalized = trimString(value);
  return normalized === prompt
    || normalized === `${MANAGED_READ_ONLY_PROMPT}\n\n${prompt}`;
};

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

const analyzeMessages = (records, childSessionId) => {
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
  if (!latest) {
    return {
      canonicalRefs: [],
      childSessionId,
      emptyOutputContinuationCount,
      failureReason: null,
      finish: '',
      hasUsefulWork: false,
      recoverablePreview: '',
      progressSignature,
      terminal: false,
      transientTransportContinuationCount,
      transientTransportFailureCount,
    };
  }

  const latestWork = extractAssistantWork(latest);
  const hasInFlightTool = assistants.some((record) => (
    (Array.isArray(record.parts) ? record.parts : []).some(toolPartIsInFlight)
  ));
  let usefulWork = latestWork;
  if (!latestWork.hasUsefulWork) {
    for (let index = assistants.length - 2; index >= 0; index -= 1) {
      const candidate = extractAssistantWork(assistants[index]);
      if (!candidate.hasUsefulWork) continue;
      usefulWork = candidate;
      break;
    }
  }
  const canonicalRefs = usefulWork !== latestWork
    ? [...usefulWork.canonicalRefs, ...latestWork.canonicalRefs]
    : latestWork.canonicalRefs;

  const finish = trimString(latest.info?.finish).toLowerCase();
  const completedAt = latest.info?.time?.completed;
  const failureReason = extractFailureReason(latest.info?.error);
  const isToolCallHandoff = finish === 'tool-calls';
  return {
    canonicalRefs,
    childSessionId,
    emptyOutputContinuationCount,
    failureReason,
    finish,
    hasFinalUsefulWork: latestWork.hasUsefulWork,
    hasInFlightTool,
    hasUsefulWork: usefulWork.hasUsefulWork,
    recoverablePreview: usefulWork.recoverablePreview,
    progressSignature,
    terminal: !isToolCallHandoff && Boolean(
      failureReason
      || finish
      || (typeof completedAt === 'number' && Number.isFinite(completedAt) && completedAt > 0)
    ),
    transientTransportContinuationCount,
    transientTransportFailureCount,
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
  const idleStablePolls = options.idleStablePolls ?? 2;
  const now = options.now ?? Date.now;
  const observationFailureGraceMs = options.observationFailureGraceMs
    ?? DEFAULT_OBSERVATION_FAILURE_GRACE_MS;
  const liveTranscriptRefreshMs = options.liveTranscriptRefreshMs
    ?? DEFAULT_LIVE_TRANSCRIPT_REFRESH_MS;
  const liveProgressTimeoutMs = options.liveProgressTimeoutMs
    ?? DEFAULT_LIVE_PROGRESS_TIMEOUT_MS;
  const retryStopMaxAborts = options.retryStopMaxAborts ?? 3;
  const retryStopPollLimit = options.retryStopPollLimit ?? 80;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0) {
    throw new RangeError('pollIntervalMs must be a non-negative safe integer');
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
  const sleep = options.sleep ?? defaultSleep;
  const shutdownController = new AbortController();
  const retryStops = new Map();

  const assertRunning = () => {
    if (shutdownController.signal.aborted) {
      throw shutdownController.signal.reason ?? new Error('Managed OpenCode executor shut down');
    }
  };

  const normalizeStatusFields = (status) => ({
    statusType: trimString(status?.type).toLowerCase(),
    statusMessage: trimString(status?.message),
    statusAttempt: Number.isFinite(status?.attempt) ? status.attempt : null,
    statusNext: Number.isFinite(status?.next) ? status.next : null,
  });

  // Liveness only. Deliberately does NOT read messages: the transcript can run to
  // tens of megabytes, and while the child is live it cannot be terminal anyway.
  const readLiveStatus = async (task) => {
    assertRunning();
    const status = await transport.readStatus({
      sessionId: task.childSessionId,
      directory: task.directory,
      providerId: task.providerId,
    });
    assertRunning();
    return status;
  };

  // `knownStatus` lets a caller that already polled status reuse it, so one loop
  // iteration still costs exactly one status read.
  const readObservation = async (task, knownStatus) => {
    assertRunning();
    const input = {
      sessionId: task.childSessionId,
      directory: task.directory,
      providerId: task.providerId,
    };
    const status = knownStatus !== undefined
      ? knownStatus
      : await transport.readStatus(input);
    const messages = await transport.readMessages(input);
    assertRunning();
    return {
      ...analyzeMessages(messages, task.childSessionId),
      ...normalizeStatusFields(status),
    };
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
    Number.isFinite(status?.attempt) ? status.attempt : '',
    Number.isFinite(status?.next) ? status.next : '',
  ].join('\u0000');

  const startRetryStop = (task, initialStatus = null) => {
    const existing = retryStops.get(task.childSessionId);
    if (existing) return existing;

    let operation;
    operation = (async () => {
      try {
        let abortCount = 1;
        let lastRetryIdentity = retryStatusIdentity(initialStatus);
        await transport.abortSession(retryStopInput(task));
        for (let poll = 0; poll < retryStopPollLimit; poll += 1) {
          assertRunning();
          const status = await transport.readStatus(retryStopInput(task));
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

  const ensureRetryStopped = async (task) => {
    const pending = retryStops.get(task.childSessionId);
    if (pending) return await pending;
    const status = await transport.readStatus(retryStopInput(task));
    const statusType = trimString(status?.type).toLowerCase();
    if (!LIVE_STATUS_TYPES.has(statusType)) return null;
    return await startRetryStop(task, status);
  };

  const waitForTerminal = async (task, waitOptions = {}) => {
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
    while (true) {
      let observation;
      try {
        // Cheap gate first. A live child (busy, or retrying for a reason other
        // than a definite usage limit) can never produce a terminal result, so
        // it does not need a transcript read on every poll. The status itself is
        // handed to readObservation so an iteration still costs one status read.
        const status = await readLiveStatus(task);
        const liveStatus = normalizeStatusFields(status);
        if (
          LIVE_STATUS_TYPES.has(liveStatus.statusType)
          && !(liveStatus.statusType === 'retry' && isDefiniteProviderUsageLimit(liveStatus.statusMessage))
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
            if (liveObservation.progressSignature !== lastLiveProgressSignature) {
              lastLiveProgressSignature = liveObservation.progressSignature;
              lastLiveProgressAt = observedAt;
            } else if (
              liveStatus.statusType === 'busy'
              && !liveObservation.hasInFlightTool
              && lastLiveProgressAt !== null
              && observedAt - lastLiveProgressAt >= liveProgressTimeoutMs
            ) {
              const continuationAlreadyUsed = transientTransportContinuations
                >= MAX_TRANSIENT_TRANSPORT_CONTINUATIONS
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
              if (continuationAlreadyUsed) {
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
              await transport.promptSession({
                sessionId: task.childSessionId,
                directory: task.directory,
                providerId: task.providerId,
                modelId: task.modelId,
                agent: task.agent,
                variant: task.variant,
                prompt: resolveTaskPrompt(task, MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT),
                tools: resolveTaskPromptTools(task),
              });
              lastTranscriptReadAt = null;
              lastLiveProgressAt = null;
              lastLiveProgressSignature = null;
              await sleep(pollIntervalMs, { signal: shutdownController.signal });
              assertRunning();
              continue;
            }
          }
          await sleep(pollIntervalMs, { signal: shutdownController.signal });
          assertRunning();
          continue;
        }
        observation = await readObservation(task, status);
        lastTranscriptReadAt = now();
        lastSuccessfulObservation = observation;
        firstTransientFailureAt = null;
      } catch (error) {
        if (shutdownController.signal.aborted) {
          throw shutdownController.signal.reason ?? error;
        }
        if (isTransientObservationError(error)) {
          // Transient reads must not stall the task forever. Before this bound
          // existed, an unreadable child (e.g. a transcript too large to fetch
          // inside the request budget) polled silently until the hard deadline
          // and then reported a bare timeout, discarding finished work.
          firstTransientFailureAt ??= now();
          if (now() - firstTransientFailureAt >= observationFailureGraceMs) {
            return {
              status: 'interrupted',
              failureReason: extractFailureReason(error)
                || 'Managed child session could not be observed',
              partial: lastSuccessfulObservation?.hasUsefulWork === true,
              recoverablePreview: lastSuccessfulObservation?.recoverablePreview ?? '',
              canonicalRefs: lastSuccessfulObservation?.canonicalRefs ?? [],
              resumable: true,
            };
          }
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
      if (
        observation.statusType === 'retry'
        && isDefiniteProviderUsageLimit(observation.statusMessage)
      ) {
        void startRetryStop(task, {
          type: observation.statusType,
          message: observation.statusMessage,
          attempt: observation.statusAttempt,
          next: observation.statusNext,
        });
        return {
          status: 'failed',
          failureReason: observation.statusMessage,
          partial: observation.hasUsefulWork,
          recoverablePreview: observation.recoverablePreview,
          canonicalRefs: observation.canonicalRefs,
          resumable: true,
        };
      }
      if (
        !LIVE_STATUS_TYPES.has(observation.statusType)
        && isTransientAssistantTransportFailure(observation.failureReason)
        && observation.transientTransportFailureCount <= MAX_TRANSIENT_TRANSPORT_CONTINUATIONS
        && observation.transientTransportContinuationCount < MAX_TRANSIENT_TRANSPORT_CONTINUATIONS
        && transientTransportContinuations < MAX_TRANSIENT_TRANSPORT_CONTINUATIONS
      ) {
        transientTransportContinuations += 1;
        await transport.promptSession({
          sessionId: task.childSessionId,
          directory: task.directory,
          providerId: task.providerId,
          modelId: task.modelId,
          agent: task.agent,
          variant: task.variant,
          // No explicit messageId: OpenCode only runs a turn when the incoming
          // message sorts after the session's latest one, and a task-derived id
          // sorts arbitrarily. When it landed low the continuation was written
          // into the past and silently never ran. Repeat continuations are
          // already bounded by the transcript failure count and the local counter.
          prompt: resolveTaskPrompt(task, MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT),
          tools: resolveTaskPromptTools(task),
        });
        await sleep(pollIntervalMs, { signal: shutdownController.signal });
        assertRunning();
        continue;
      }
      if (
        isEmptyTerminalObservation(observation)
        && observation.emptyOutputContinuationCount < MAX_EMPTY_OUTPUT_CONTINUATIONS
        && emptyOutputContinuations < MAX_EMPTY_OUTPUT_CONTINUATIONS
      ) {
        emptyOutputContinuations += 1;
        await transport.promptSession({
          sessionId: task.childSessionId,
          directory: task.directory,
          providerId: task.providerId,
          modelId: task.modelId,
          agent: task.agent,
          variant: task.variant,
          prompt: resolveTaskPrompt(task, MANAGED_EMPTY_OUTPUT_CONTINUATION_PROMPT),
          tools: resolveTaskPromptTools(task),
        });
        await sleep(pollIntervalMs, { signal: shutdownController.signal });
        assertRunning();
        continue;
      }
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
    assertReadOnlyProviderSupport(task);
    const child = await transport.createSession({
      directory: task.directory,
      parentSessionId: task.rootSessionId,
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
    await transport.promptSession({
      sessionId: childSessionId,
      directory: task.directory,
      providerId: task.providerId,
      modelId: task.modelId,
      agent: task.agent,
      variant: task.variant,
      prompt: resolveTaskPrompt(task, task.prompt),
      tools: resolveTaskPromptTools(task),
    });
    await retainCheckpoint({
      task,
      childSessionId,
      checkpoint: () => control.markAccepted(),
      stage: 'after provider prompt',
      deleteSession: true,
    });
    return await waitForTerminal(runningTask);
  };

  const observe = async (task) => await waitForTerminal(task);

  const retryInPlace = async (task, control) => {
    if (!task.childSessionId) {
      throw new Error(`Managed task ${task.taskId} has no child session`);
    }
    assertReadOnlyProviderSupport(task);
    const stopError = await ensureRetryStopped(task);
    if (stopError) throw stopError;
    await transport.promptSession({
      sessionId: task.childSessionId,
      directory: task.directory,
      providerId: task.providerId,
      modelId: task.modelId,
      agent: task.agent,
      variant: task.variant,
      prompt: resolveTaskPrompt(task, MANAGED_RETRY_IN_PLACE_PROMPT),
      tools: resolveTaskPromptTools(task),
    });
    await retainCheckpoint({
      task,
      childSessionId: task.childSessionId,
      checkpoint: () => control.markAccepted(),
      stage: 'after retry-in-place prompt',
      deleteSession: false,
    });
    return await waitForTerminal(task, { deferEmptyTerminal: true });
  };

  const readRecoverableResult = async (task) => {
    if (!task.childSessionId) {
      return { recoverablePreview: '', canonicalRefs: [], resumable: false };
    }
    const observation = await readObservation(task);
    return {
      recoverablePreview: observation.recoverablePreview,
      canonicalRefs: observation.canonicalRefs,
      partial: observation.hasUsefulWork,
      resumable: true,
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
    start,
    resume: observe,
    retryInPlace,
    observe,
    async abort(task, options = {}) {
      if (!task.childSessionId) return { aborted: false, failureReason: 'Managed task has no child session' };
      const aborted = await transport.abortSession({
        sessionId: task.childSessionId,
        directory: task.directory,
        providerId: task.providerId,
        signal: options.signal,
      });
      return {
        aborted: aborted !== false,
        ...(aborted === false ? { failureReason: 'Provider did not confirm the managed child abort' } : {}),
      };
    },
    reconcile,
    readRecoverableResult,
    async shutdown() {
      if (!shutdownController.signal.aborted) {
        shutdownController.abort(new Error('Managed OpenCode executor shut down'));
      }
    },
  };
};
