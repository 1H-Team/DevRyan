import { resolveProviderPromptTools } from './provider-prompt-tools.js';
import { formatManagedTaskDisplayName } from './contract.js';

const LIVE_STATUS_TYPES = new Set(['busy', 'retry']);
export const MANAGED_RETRY_IN_PLACE_PROMPT = 'Continue the task from the existing progress. The previous provider could not continue. Do not repeat completed work.';
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

const analyzeMessages = (records, childSessionId) => {
  const assistants = Array.isArray(records)
    ? records.filter((record) => record?.info?.role === 'assistant')
    : [];
  const latest = assistants.at(-1) ?? null;
  if (!latest) {
    return {
      canonicalRefs: [],
      childSessionId,
      failureReason: null,
      finish: '',
      hasUsefulWork: false,
      recoverablePreview: '',
      terminal: false,
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
    failureReason,
    finish,
    hasFinalUsefulWork: latestWork.hasUsefulWork,
    hasInFlightTool,
    hasUsefulWork: usefulWork.hasUsefulWork,
    recoverablePreview: usefulWork.recoverablePreview,
    terminal: !isToolCallHandoff && Boolean(
      failureReason
      || finish
      || (typeof completedAt === 'number' && Number.isFinite(completedAt) && completedAt > 0)
    ),
  };
};

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
  ];
  for (const method of requiredMethods) {
    if (typeof transport?.[method] !== 'function') {
      throw new TypeError(`transport.${method} is required`);
    }
  }
  const pollIntervalMs = options.pollIntervalMs ?? 750;
  const idleStablePolls = options.idleStablePolls ?? 2;
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
  const sleep = options.sleep ?? defaultSleep;
  const shutdownController = new AbortController();
  const retryStops = new Map();

  const assertRunning = () => {
    if (shutdownController.signal.aborted) {
      throw shutdownController.signal.reason ?? new Error('Managed OpenCode executor shut down');
    }
  };

  const readObservation = async (task) => {
    assertRunning();
    const input = {
      sessionId: task.childSessionId,
      directory: task.directory,
      providerId: task.providerId,
    };
    const status = await transport.readStatus(input);
    const messages = await transport.readMessages(input);
    assertRunning();
    return {
      ...analyzeMessages(messages, task.childSessionId),
      statusType: trimString(status?.type).toLowerCase(),
      statusMessage: trimString(status?.message),
      statusAttempt: Number.isFinite(status?.attempt) ? status.attempt : null,
      statusNext: Number.isFinite(status?.next) ? status.next : null,
    };
  };

  const retryStopInput = (task) => ({
    sessionId: task.childSessionId,
    directory: task.directory,
    providerId: task.providerId,
  });

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
    while (true) {
      let observation;
      try {
        observation = await readObservation(task);
        lastSuccessfulObservation = observation;
      } catch (error) {
        if (shutdownController.signal.aborted) {
          throw shutdownController.signal.reason ?? error;
        }
        if (isTransientObservationError(error)) {
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
    const child = await transport.createSession({
      directory: task.directory,
      parentSessionId: task.rootSessionId,
      title: formatManagedTaskDisplayName(task.label),
    });
    const childSessionId = trimString(child?.id);
    if (!childSessionId) {
      throw new Error('OpenCode did not return a managed child session ID');
    }
    await control.setChildSessionId(childSessionId);
    const runningTask = { ...task, childSessionId };
    await transport.promptSession({
      sessionId: childSessionId,
      directory: task.directory,
      providerId: task.providerId,
      modelId: task.modelId,
      agent: task.agent,
      variant: task.variant,
      prompt: task.prompt,
      tools: resolveProviderPromptTools(task.providerId),
    });
    await control.markAccepted();
    return await waitForTerminal(runningTask);
  };

  const observe = async (task) => await waitForTerminal(task);

  const retryInPlace = async (task, control) => {
    if (!task.childSessionId) {
      throw new Error(`Managed task ${task.taskId} has no child session`);
    }
    const stopError = await ensureRetryStopped(task);
    if (stopError) throw stopError;
    await transport.promptSession({
      sessionId: task.childSessionId,
      directory: task.directory,
      providerId: task.providerId,
      modelId: task.modelId,
      agent: task.agent,
      variant: task.variant,
      prompt: MANAGED_RETRY_IN_PLACE_PROMPT,
      tools: resolveProviderPromptTools(task.providerId),
    });
    await control.markAccepted();
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
    const terminal = toTerminalResult(observation);
    if (terminal) return { state: 'terminal', result: terminal };
    return { state: 'live' };
  };

  return {
    start,
    resume: observe,
    retryInPlace,
    observe,
    async abort(task) {
      if (!task.childSessionId) return { aborted: false, failureReason: 'Managed task has no child session' };
      const aborted = await transport.abortSession({
        sessionId: task.childSessionId,
        directory: task.directory,
        providerId: task.providerId,
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
