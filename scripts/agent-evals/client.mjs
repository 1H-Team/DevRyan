import { resolveProviderPromptTools } from '../../packages/orchestration-runtime/provider-prompt-tools.js';
import { redactUrl } from './report.mjs';
import { retainPrivateToolInterval } from './tool-evidence.mjs';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const MAX_SESSION_TREE_SIZE = 100;
const SUCCESS_STATUS = 'idle';
const FAILURE_STATUSES = new Set(['error', 'failed', 'aborted', 'cancelled', 'canceled']);
const FAILURE_FINISHES = new Set(['error', 'failed', 'abort', 'aborted', 'cancelled', 'canceled']);
const FINAL_TOOL_STATUSES = new Set(['completed', 'error', 'failed', 'aborted', 'cancelled', 'canceled']);

const normalizeString = (value) => (
  typeof value === 'string' && value.trim() ? value.trim() : ''
);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const unwrapPayload = (value) => (
  value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'data')
    ? value.data
    : value
);

const normalizeApiBase = (baseUrl) => {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError('Evaluation client requires a valid loopback base URL');
  }
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]';
  if (!loopback || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new TypeError('Evaluation client requires a credential-free loopback base URL');
  }
  if (url.search || url.hash) {
    throw new TypeError('Evaluation client base URL must not contain a query or fragment');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (path && path !== '/api') {
    throw new TypeError('Evaluation client base URL path must be empty or /api');
  }
  url.pathname = path === '/api' ? '/api' : '/api';
  return url.toString().replace(/\/$/, '');
};

const appendQuery = (pathname, query = {}) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const serialized = params.toString();
  return serialized ? `${pathname}?${serialized}` : pathname;
};

const combineSignals = (...signals) => {
  const usable = signals.filter(Boolean);
  if (usable.length === 0) return undefined;
  if (usable.length === 1) return usable[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(usable);
  const controller = new AbortController();
  const abort = (event) => controller.abort(event.target?.reason);
  for (const signal of usable) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', abort, { once: true });
  }
  return controller.signal;
};

export class EvaluationHttpError extends Error {
  constructor({ label, statusCode, url }) {
    super(`${label} failed (${statusCode}) at ${redactUrl(url)}`);
    this.name = 'EvaluationHttpError';
    this.code = 'evaluation_http_error';
    this.statusCode = statusCode;
  }
}

export class EvaluationTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Evaluation session exceeded its ${timeoutMs}ms timeout`);
    this.name = 'EvaluationTimeoutError';
    this.code = 'evaluation_timeout';
    this.timeoutMs = timeoutMs;
    this.cleanup = { abortedSessionIds: [], abortFailureCount: 0 };
  }
}

export class EvaluationAbortedError extends Error {
  constructor() {
    super('Evaluation session was aborted');
    this.name = 'EvaluationAbortedError';
    this.code = 'evaluation_aborted';
    this.cleanup = { abortedSessionIds: [], abortFailureCount: 0 };
  }
}

export class EvaluationSessionTerminalError extends Error {
  constructor() {
    super('Evaluation session reached an unsuccessful terminal state');
    this.name = 'EvaluationSessionTerminalError';
    this.code = 'evaluation_session_terminal_failure';
    this.cleanup = {
      complete: false,
      discoveryComplete: false,
      reasonCodes: [],
      discoveredSessionIds: [],
      abortedSessionIds: [],
      abortFailureCount: 0,
    };
  }
}

export class EvaluationManagedUnavailableError extends Error {
  constructor() {
    super('Managed orchestration is unavailable for the managed evaluation case');
    this.name = 'EvaluationManagedUnavailableError';
    this.code = 'evaluation_managed_unavailable';
  }
}

const parseResponse = async (response, label, url) => {
  if (!response.ok) {
    // Consume the body so keep-alive sockets remain reusable, but never include it in diagnostics.
    await response.arrayBuffer().catch(() => null);
    throw new EvaluationHttpError({ label, statusCode: response.status, url });
  }
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return unwrapPayload(JSON.parse(text));
  } catch {
    const error = new Error(`${label} returned invalid JSON at ${redactUrl(url)}`);
    error.name = 'EvaluationProtocolError';
    error.code = 'evaluation_invalid_json';
    throw error;
  }
};

export const createEvaluationClient = (options = {}) => {
  const apiBase = normalizeApiBase(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new RangeError('requestTimeoutMs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0) {
    throw new RangeError('pollIntervalMs must be a non-negative safe integer');
  }

  const request = async (pathname, requestOptions = {}) => {
    const url = `${apiBase}${pathname}`;
    const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
    const response = await fetchImpl(url, {
      method: requestOptions.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(requestOptions.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(requestOptions.body === undefined ? {} : { body: JSON.stringify(requestOptions.body) }),
      signal: combineSignals(requestOptions.signal, timeoutSignal),
    });
    return await parseResponse(response, requestOptions.label ?? 'DevRyan request', url);
  };

  return Object.freeze({
    pollIntervalMs,
    async createSession(directory, title, signal) {
      const session = await request(appendQuery('/session', { directory }), {
        method: 'POST',
        body: { title },
        signal,
        label: 'session.create',
      });
      const sessionId = normalizeString(session?.id);
      if (!sessionId) {
        const error = new Error('session.create returned no session ID');
        error.code = 'evaluation_invalid_session';
        throw error;
      }
      return session;
    },
    async promptSession(sessionId, directory, selection, prompt, signal) {
      const tools = resolveProviderPromptTools(selection.providerId, selection.agent, {
        readOnly: normalizeString(selection.agent).toLowerCase() === 'oracle',
        contextModeAvailable: normalizeString(selection.providerId).toLowerCase() !== 'cursor-acp',
      });
      return await request(appendQuery(`/session/${encodeURIComponent(sessionId)}/prompt_async`, { directory }), {
        method: 'POST',
        body: {
          agent: selection.agent,
          model: {
            providerID: selection.providerId,
            modelID: selection.modelId,
          },
          ...(selection.variant === null ? {} : { variant: selection.variant }),
          ...(tools ? { tools } : {}),
          parts: [{ type: 'text', text: prompt }],
        },
        signal,
        label: 'session.prompt_async',
      });
    },
    async getStatuses(directory, signal) {
      const payload = await request(appendQuery('/session/status', { directory }), {
        signal,
        label: 'session.status',
      });
      return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    },
    async getMessages(sessionId, directory, signal) {
      const payload = await request(appendQuery(
        `/session/${encodeURIComponent(sessionId)}/message`,
        { directory, limit: 100 },
      ), { signal, label: 'session.messages' });
      return Array.isArray(payload) ? payload : [];
    },
    async getChildren(sessionId, directory, signal) {
      const payload = await request(appendQuery(
        `/session/${encodeURIComponent(sessionId)}/children`,
        { directory },
      ), { signal, label: 'session.children' });
      return Array.isArray(payload) ? payload : [];
    },
    async abortSession(sessionId, directory, signal) {
      await request(appendQuery(`/session/${encodeURIComponent(sessionId)}/abort`, { directory }), {
        method: 'POST',
        body: {},
        signal,
        label: 'session.abort',
      });
      return true;
    },
    async getTurnTiming(sessionId, signal) {
      const payload = await request(appendQuery('/diagnostics/turn-timing/recent', {
        sessionId,
        limit: 20,
      }), { signal, label: 'turn-timing.recent' });
      return payload && typeof payload === 'object' ? payload : { records: [] };
    },
    async getManagedSnapshot(rootSessionId, signal) {
      const payload = await request(appendQuery('/orchestration/snapshot', { rootSessionId }), {
        signal,
        label: 'orchestration.snapshot',
      });
      return payload && typeof payload === 'object'
        ? payload
        : { tasks: [], resultEnvelopes: [] };
    },
  });
};

const childId = (value) => normalizeString(typeof value === 'string' ? value : value?.id);

export const fetchSessionTree = async (client, rootSessionId, directory, options = {}) => {
  const maximum = options.maximum ?? MAX_SESSION_TREE_SIZE;
  const signal = options.signal;
  const visited = new Set();
  const result = [];

  const visit = async (sessionId, parentSessionId) => {
    if (!sessionId || visited.has(sessionId)) return;
    if (visited.size >= maximum) {
      const error = new Error(`Session tree exceeded ${maximum} entries`);
      error.code = 'evaluation_session_tree_limit';
      throw error;
    }
    visited.add(sessionId);
    const messages = await client.getMessages(sessionId, directory, signal);
    const children = await client.getChildren(sessionId, directory, signal);
    result.push({ sessionId, parentSessionId, messages });
    for (const child of children) {
      await visit(childId(child), sessionId);
    }
  };

  await visit(rootSessionId, null);
  for (const sessionId of options.additionalSessionIds ?? []) {
    await visit(sessionId, rootSessionId);
  }
  return result;
};

const beforeDeadline = async (operation, deadline, signal) => {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    const error = new Error('Evaluation cleanup deadline exceeded');
    error.code = 'cleanup_deadline_exceeded';
    throw error;
  }
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error('Evaluation cleanup deadline exceeded');
          error.code = 'cleanup_deadline_exceeded';
          reject(error);
        }, remainingMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    if (Date.now() >= deadline) signal?.abort?.();
  }
};

export const abortSessionTree = async (client, rootSessionId, directory, options = {}) => {
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 1
    ? options.timeoutMs
    : DEFAULT_CLEANUP_TIMEOUT_MS;
  const maximum = Number.isSafeInteger(options.maximum) && options.maximum > 0
    ? options.maximum
    : MAX_SESSION_TREE_SIZE;
  const startedAt = Date.now();
  const discoveryDeadline = startedAt + Math.max(1, Math.floor(timeoutMs / 2));
  const cleanupDeadline = startedAt + timeoutMs;
  const discoveryController = new AbortController();
  const abortController = new AbortController();
  const reasons = new Set();
  const depthById = new Map();
  const queue = [];
  const seed = (sessionId, depth) => {
    const normalized = childId(sessionId);
    if (!normalized || depthById.has(normalized)) return false;
    depthById.set(normalized, depth);
    queue.push(normalized);
    return true;
  };
  seed(rootSessionId, 0);
  const additionalSeeds = [...(options.knownSessionIds ?? [])];
  let additionalSeedIndex = 0;

  let expanded = 0;
  while (queue.length > 0 || additionalSeedIndex < additionalSeeds.length) {
    if (queue.length === 0) {
      while (additionalSeedIndex < additionalSeeds.length) {
        const added = seed(additionalSeeds[additionalSeedIndex], 1);
        additionalSeedIndex += 1;
        if (added) break;
      }
      if (queue.length === 0) break;
    }
    const sessionId = queue.shift();
    const depth = depthById.get(sessionId) ?? 0;
    if (expanded >= maximum) {
      reasons.add('session_tree_limit');
      continue;
    }
    expanded += 1;
    let children;
    try {
      children = await beforeDeadline(
        () => client.getChildren(sessionId, directory, discoveryController.signal),
        discoveryDeadline,
        discoveryController,
      );
    } catch (error) {
      if (error?.code === 'cleanup_deadline_exceeded') {
        reasons.add('cleanup_deadline_exceeded');
        discoveryController.abort(error);
        break;
      }
      reasons.add('children_fetch_failed');
      continue;
    }
    for (const child of Array.isArray(children) ? children : []) {
      const id = childId(child);
      if (!id) continue;
      if (!seed(id, depth + 1)) reasons.add('cycle_detected');
    }
  }
  // A timed-out discovery must not discard session IDs already observed by the caller.
  while (additionalSeedIndex < additionalSeeds.length) {
    seed(additionalSeeds[additionalSeedIndex], 1);
    additionalSeedIndex += 1;
  }

  const orderedSessionIds = [...depthById.keys()].sort((left, right) => {
    const depthDifference = (depthById.get(right) ?? 0) - (depthById.get(left) ?? 0);
    return depthDifference || left.localeCompare(right);
  });
  const abortedSessionIds = [];
  let abortFailureCount = 0;
  for (let index = 0; index < orderedSessionIds.length; index += 1) {
    const sessionId = orderedSessionIds[index];
    try {
      await beforeDeadline(
        () => client.abortSession(sessionId, directory, abortController.signal),
        cleanupDeadline,
        abortController,
      );
      abortedSessionIds.push(sessionId);
    } catch (error) {
      abortFailureCount += 1;
      if (error?.code === 'cleanup_deadline_exceeded') {
        reasons.add('cleanup_deadline_exceeded');
        abortFailureCount += orderedSessionIds.length - index - 1;
        abortController.abort(error);
        break;
      }
    }
  }
  const reasonCodes = [...reasons];
  const discoveryComplete = !reasonCodes.some((reason) => [
    'children_fetch_failed',
    'cycle_detected',
    'session_tree_limit',
    'cleanup_deadline_exceeded',
  ].includes(reason));
  return {
    complete: discoveryComplete && abortFailureCount === 0,
    discoveryComplete,
    reasonCodes,
    discoveredSessionIds: [...depthById.keys()],
    abortedSessionIds,
    abortFailureCount,
  };
};

const wait = (durationMs, signal) => new Promise((resolve, reject) => {
  if (durationMs <= 0) {
    resolve();
    return;
  }
  const timeout = setTimeout(done, durationMs);
  const onAbort = () => done(signal.reason ?? new EvaluationAbortedError(), true);
  function done(value, failed = false) {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
    if (failed) reject(value);
    else resolve(value);
  }
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
});

const terminalAssistantEvidence = (messages) => {
  const assistants = (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.info?.role === 'assistant');
  const latest = assistants.at(-1);
  if (!latest) return { terminal: false, failed: false };
  const finish = normalizeString(latest.info?.finish).toLowerCase();
  const completedAt = latest.info?.time?.completed;
  const hasInFlightTool = (Array.isArray(latest.parts) ? latest.parts : []).some((part) => {
    if (part?.type !== 'tool') return false;
    const status = normalizeString(part.state?.status || part.status).toLowerCase();
    return !FINAL_TOOL_STATUSES.has(status);
  });
  const terminal = finish !== 'tool-calls'
    && !hasInFlightTool
    && (Boolean(finish) || (Number.isFinite(completedAt) && completedAt > 0));
  return {
    terminal,
    failed: terminal && (Boolean(latest.info?.error) || FAILURE_FINISHES.has(finish)),
  };
};

const waitForTerminalGraph = async ({
  client,
  rootSessionId,
  directory,
  signal,
  statuses,
  knownSessionIds,
  requireManaged,
}) => {
  const stateBySessionId = new Map();
  let settledSignature = '';
  let settledSnapshots = 0;
  while (true) {
    if (signal.aborted) throw signal.reason ?? new EvaluationAbortedError();
    const [statusSnapshot, sessionTree, managedPayload] = await Promise.all([
      client.getStatuses(directory, signal),
      fetchSessionTree(client, rootSessionId, directory, {
        signal,
        additionalSessionIds: [...knownSessionIds].filter((id) => id !== rootSessionId),
      }),
      client.getManagedSnapshot(rootSessionId, signal),
    ]);
    const tasks = (Array.isArray(managedPayload?.tasks) ? managedPayload.tasks : [])
      .filter((task) => !task?.rootSessionId || task.rootSessionId === rootSessionId);
    if (requireManaged && managedPayload?.available === false) {
      throw new EvaluationManagedUnavailableError();
    }
    for (const task of tasks) {
      const childSessionId = childId(task?.childSessionId);
      if (childSessionId) knownSessionIds.add(childSessionId);
    }
    const sessionIdsInTree = new Set(sessionTree.map((entry) => entry.sessionId));
    for (const sessionId of sessionIdsInTree) knownSessionIds.add(sessionId);

    let sessionsComplete = true;
    let rootProof = '';
    for (const session of sessionTree) {
      const state = stateBySessionId.get(session.sessionId) ?? { sawActive: false };
      const statusType = normalizeString(statusSnapshot?.[session.sessionId]?.type).toLowerCase();
      if (statusType && session.sessionId === rootSessionId && statuses.at(-1) !== statusType) {
        statuses.push(statusType);
      }
      if (FAILURE_STATUSES.has(statusType)) throw new EvaluationSessionTerminalError();
      if (statusType && statusType !== SUCCESS_STATUS) state.sawActive = true;
      const assistant = terminalAssistantEvidence(session.messages);
      if (assistant.failed) throw new EvaluationSessionTerminalError();
      const proof = assistant.terminal
        ? 'assistant'
        : state.sawActive && statusType === SUCCESS_STATUS
          ? 'status-transition'
          : '';
      if (!proof) sessionsComplete = false;
      if (session.sessionId === rootSessionId) rootProof = proof;
      stateBySessionId.set(session.sessionId, state);
    }

    let tasksComplete = true;
    for (const task of tasks) {
      const taskStatus = normalizeString(task?.status).toLowerCase();
      if (FAILURE_STATUSES.has(taskStatus) || ['interrupted'].includes(taskStatus)) {
        throw new EvaluationSessionTerminalError();
      }
      if (taskStatus !== 'completed') tasksComplete = false;
      const taskChildId = childId(task?.childSessionId);
      if (taskChildId && !sessionIdsInTree.has(taskChildId)) tasksComplete = false;
    }

    const allComplete = Boolean(rootProof) && sessionsComplete && tasksComplete;
    const signature = JSON.stringify({
      sessions: sessionTree.map((entry) => [
        entry.sessionId,
        normalizeString(statusSnapshot?.[entry.sessionId]?.type).toLowerCase(),
      ]),
      tasks: tasks.map((task) => [task?.taskId, task?.status, task?.childSessionId]),
    });
    if (allComplete && signature === settledSignature) settledSnapshots += 1;
    else if (allComplete) {
      settledSignature = signature;
      settledSnapshots = 1;
    } else {
      settledSignature = '';
      settledSnapshots = 0;
    }
    if (settledSnapshots >= 2) {
      return {
        sessionTree,
        managedPayload,
        terminalEvidence: {
          complete: true,
          proof: rootProof,
          sessionCount: sessionTree.length,
          managedTaskCount: tasks.length,
        },
      };
    }
    await wait(client.pollIntervalMs, signal);
  }
};

const normalizeOwnedTestRelativePath = (ownedTestRelativePath) => {
  if (typeof ownedTestRelativePath !== 'string') return '';
  const expected = ownedTestRelativePath.trim();
  return expected && /^[a-zA-Z0-9_./-]+$/.test(expected) ? expected : '';
};

export const buildOwnedTestEvidenceCommand = (ownedTestRelativePath) => {
  const expected = normalizeOwnedTestRelativePath(ownedTestRelativePath);
  if (!expected) throw new TypeError('Owned test relative path is invalid');
  return `devryan_eval_test_exit=0; node --test ${expected} || devryan_eval_test_exit=$?; printf '\\nDEVRYAN_EVAL_TEST_EXIT_CODE=%s\\n' "$devryan_eval_test_exit"`;
};

const ownedTestCommandKind = (command, ownedTestRelativePath) => {
  if (typeof command !== 'string') return '';
  const expected = normalizeOwnedTestRelativePath(ownedTestRelativePath);
  if (!expected) return '';
  const normalized = command.trim().replace(/\s+/g, ' ');
  if ([
    `node --test ${expected}`,
    `node --test "${expected}"`,
    `node --test '${expected}'`,
  ].includes(normalized)) return 'direct';
  return command === buildOwnedTestEvidenceCommand(expected) ? 'wrapper' : '';
};

const normalizeOwnedTestExitCode = (value) => (
  Number.isSafeInteger(value) && value >= 0 && value <= 255 ? value : null
);

const parseCursorShellResult = (output) => {
  if (typeof output !== 'string') return { kind: 'absent' };
  const normalized = output.trimStart();
  if (!normalized.startsWith('{')) return { kind: 'absent' };
  const recognizablePrefix = /^\{\s*"status"\s*:/.test(normalized);
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return recognizablePrefix ? { kind: 'invalid' } : { kind: 'absent' };
  }
  const recognizableEnvelope = isRecord(parsed)
    && Object.hasOwn(parsed, 'status')
    && (
      Object.hasOwn(parsed, 'value')
      || parsed.status === 'success'
      || parsed.status === 'error'
    );
  if (!recognizableEnvelope) {
    return { kind: 'absent' };
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || parsed.status !== 'success'
    || !parsed.value
    || typeof parsed.value !== 'object'
    || Array.isArray(parsed.value)
    || !Number.isFinite(parsed.value.executionTime)
    || parsed.value.executionTime < 0
    || normalizeOwnedTestExitCode(parsed.value.exitCode) === null
    || (parsed.value.signal !== null && parsed.value.signal !== '')
    || typeof parsed.value.stderr !== 'string'
    || typeof parsed.value.stdout !== 'string'
  ) {
    return { kind: 'invalid' };
  }
  return {
    kind: 'valid',
    exitCode: parsed.value.exitCode,
    stdout: parsed.value.stdout,
  };
};

const parseOwnedTestExitMarker = (output) => {
  if (typeof output !== 'string') return null;
  const match = output.match(
    /(?:^|\r?\n)DEVRYAN_EVAL_TEST_EXIT_CODE=(0|[1-9]\d{0,2})\r?\n?$/,
  );
  return match ? normalizeOwnedTestExitCode(Number(match[1])) : null;
};

const ownedTestExitCode = (part, commandKind, status) => {
  if (status !== 'completed') return null;
  if (commandKind === 'direct') {
    const metadata = part.state?.metadata;
    const hasMetadataExit = metadata && Object.hasOwn(metadata, 'exitCode');
    const metadataExit = hasMetadataExit
      ? normalizeOwnedTestExitCode(metadata.exitCode)
      : null;
    if (hasMetadataExit && metadataExit === null) return null;
    const cursorResult = parseCursorShellResult(part.state?.output);
    if (cursorResult.kind === 'invalid') return null;
    if (
      metadataExit !== null
      && cursorResult.kind === 'valid'
      && cursorResult.exitCode !== metadataExit
    ) {
      return null;
    }
    return metadataExit ?? (cursorResult.kind === 'valid' ? cursorResult.exitCode : null);
  }
  if (commandKind !== 'wrapper') return null;
  const metadata = part.state?.metadata;
  const hasMetadataExit = metadata && Object.hasOwn(metadata, 'exitCode');
  const metadataExit = hasMetadataExit
    ? normalizeOwnedTestExitCode(metadata.exitCode)
    : null;
  if (hasMetadataExit && metadataExit === null) return null;
  const cursorResult = parseCursorShellResult(part.state?.output);
  if (cursorResult.kind === 'invalid') return null;
  const cursorExit = cursorResult.kind === 'valid' ? cursorResult.exitCode : null;
  if (metadataExit !== null && cursorExit !== null && metadataExit !== cursorExit) {
    return null;
  }
  if ((metadataExit ?? cursorExit) !== 0) return null;
  const markerOutput = cursorResult.kind === 'valid'
    ? cursorResult.stdout
    : part.state?.output;
  return parseOwnedTestExitMarker(markerOutput);
};

const isSyntheticWorkspacePatchPart = (part) => {
  if (part?.type !== 'tool') return false;
  if (normalizeString(part.tool || part.name).toLowerCase() !== 'apply_patch') return false;
  const messageID = normalizeString(part.messageID);
  const sessionID = normalizeString(part.sessionID);
  if (!messageID || !sessionID) return false;
  const partID = normalizeString(part.id);
  const partIDPrefix = `${messageID}_part_`;
  if (!partID.startsWith(partIDPrefix)) return false;
  if (!/^\d{6}_tool_synthetic_workspace_patch$/.test(partID.slice(partIDPrefix.length))) return false;

  const state = part.state;
  const metadata = state?.metadata;
  if (!isRecord(state) || !isRecord(metadata)) return false;
  if (normalizeString(state.status).toLowerCase() !== 'completed') return false;
  if (metadata.syntheticWorkspacePatch !== true) return false;

  const patchText = metadata.patchText;
  if (typeof patchText !== 'string' || !patchText.trim()) return false;
  if (part.input?.patchText !== patchText || state.input?.patchText !== patchText) return false;
  if (typeof state.output !== 'string' || part.output !== state.output) return false;

  const files = metadata.files;
  if (!Array.isArray(files) || files.length === 0) return false;
  const expectedOutput = `Applied ${files.length} ${files.length === 1 ? 'patch' : 'patches'}.`;
  if (state.output !== expectedOutput) return false;

  const validFiles = files.every((file) => (
    isRecord(file)
    && normalizeString(file.relativePath)
    && file.filePath === file.relativePath
    && Number.isSafeInteger(file.additions)
    && file.additions >= 0
    && Number.isSafeInteger(file.deletions)
    && file.deletions >= 0
    && typeof file.patch === 'string'
    && file.patch.trim()
  ));
  if (!validFiles) return false;
  return files.map((file) => file.patch).join('\n') === patchText;
};

const sanitizeToolEvent = (part, ownedTestRelativePath, sessionScope) => {
  if (part?.type !== 'tool') return null;
  if (isSyntheticWorkspacePatchPart(part)) return null;
  const tool = normalizeString(part.tool || part.name).toLowerCase();
  if (!tool) return null;
  const status = normalizeString(part.state?.status || part.status || 'unknown').toLowerCase();
  const event = {
    tool,
    status,
    final: FINAL_TOOL_STATUSES.has(status),
    sessionScope,
  };
  const commandKind = ownedTestCommandKind(
    part.state?.input?.command,
    ownedTestRelativePath,
  );
  const exitCode = ownedTestExitCode(part, commandKind, status);
  if (
    ['bash', 'shell', 'terminal', 'exec', 'exec_command'].includes(tool)
    && commandKind
    && event.final
    && exitCode !== null
  ) {
    event.ownedTestOutcome = exitCode === 0 ? 'passed' : 'failed';
  }
  return event;
};

export const collectSanitizedTools = (sessionTree, options = {}) => {
  const tools = [];
  for (const session of Array.isArray(sessionTree) ? sessionTree : []) {
    for (const message of Array.isArray(session?.messages) ? session.messages : []) {
      for (const part of Array.isArray(message?.parts) ? message.parts : []) {
        if (part?.type !== 'tool') continue;
        const event = sanitizeToolEvent(
          part,
          options.ownedTestRelativePath,
          session?.sessionId === options.rootSessionId ? 'root' : 'child',
        );
        if (!event) continue;
        retainPrivateToolInterval(event, {
          start: part.state?.time?.start,
          end: part.state?.time?.end,
        });
        tools.push(event);
      }
    }
  }
  return tools;
};

const ORACLE_REVIEW_SIGNAL_PATTERNS = Object.freeze({
  authorization_boundary: [
    /\b(?:authori[sz]ation|permission|owner|ownership|admin)\b/i,
    /\b(?:actor|caller|user|profile)\b/i,
    /\b(?:bypass|check|verify|unauthori[sz]ed|forbidden)\b/i,
  ],
  stale_write: [
    /\b(?:revision|version|expectedrevision)\b/i,
    /(?:\bstale\b|\bconcurren\w*|\bcompare\w*|\blost update\b|\bignored\b)/i,
  ],
  idempotency_order: [
    /(?:\bidempoten\w*|\bduplicate\w*|\battempt\b|\boperation\b)/i,
    /\b(?:reserve|persist|record|store)\w*\b/i,
    /\b(?:before|after|external|gateway|stripe)\b/i,
  ],
  webhook_monotonicity: [
    /\b(?:webhook|event)\b/i,
    /\b(?:monotonic|regress|out[- ]of[- ]order|terminal|stale)\w*\b/i,
  ],
});

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const collectOracleReviewEvidence = (sessionTree, options = {}) => {
  const rootSessionId = normalizeString(options.rootSessionId);
  const assistantText = [];
  for (const session of Array.isArray(sessionTree) ? sessionTree : []) {
    if (session?.sessionId !== rootSessionId) continue;
    for (const message of Array.isArray(session?.messages) ? session.messages : []) {
      const role = normalizeString(message?.info?.role ?? message?.role).toLowerCase();
      if (role !== 'assistant') continue;
      for (const part of Array.isArray(message?.parts) ? message.parts : []) {
        if (part?.type === 'text' && typeof part.text === 'string') assistantText.push(part.text);
      }
    }
  }
  const text = assistantText.join('\n');
  const signals = Object.entries(ORACLE_REVIEW_SIGNAL_PATTERNS)
    .filter(([, patterns]) => patterns.every((pattern) => pattern.test(text)))
    .map(([signal]) => signal)
    .sort();
  const scopedPaths = [
    options.runFiles?.sourceRelativePath,
    options.runFiles?.testRelativePath,
  ].filter((value) => typeof value === 'string' && value);
  const pathLineEvidence = scopedPaths.some((relativePath) => (
    new RegExp(`${escapeRegExp(relativePath)}(?::|\\D){1,8}\\d+`, 'i').test(text)
  ));
  return {
    signals,
    pathLineEvidence,
    terminalComplete: /<status>complete<\/status>\s*$/i.test(text),
  };
};

const sanitizeTurnTiming = (payload) => ({
  records: (Array.isArray(payload?.records) ? payload.records : []).map((record) => ({
    durationsMs: Object.fromEntries(
      Object.entries(record?.durationsMs ?? {})
        .filter(([, value]) => Number.isFinite(value) && value >= 0)
        .map(([key, value]) => [key, value]),
    ),
    tools: (Array.isArray(record?.diagnostics?.toolCalls) ? record.diagnostics.toolCalls : [])
      .map((item) => ({
        tool: normalizeString(item?.tool).toLowerCase(),
        status: normalizeString(item?.status).toLowerCase(),
        final: item?.final === true,
      }))
      .filter((item) => item.tool),
  })),
});

const sanitizeManagedSnapshot = (payload) => ({
  available: payload?.available !== false,
  tasks: (Array.isArray(payload?.tasks) ? payload.tasks : []).map((task) => ({
    taskId: normalizeString(task?.taskId),
    rootSessionId: normalizeString(task?.rootSessionId),
    childSessionId: normalizeString(task?.childSessionId) || null,
    status: normalizeString(task?.status).toLowerCase(),
  })),
  resultEnvelopes: (
    Array.isArray(payload?.resultEnvelopes)
      ? payload.resultEnvelopes
      : Array.isArray(payload?.results)
        ? payload.results
        : []
  ).map((envelope) => ({
    taskId: normalizeString(envelope?.taskId),
    status: normalizeString(envelope?.status).toLowerCase(),
    action: envelope?.action === null ? null : normalizeString(envelope?.action).toLowerCase(),
  })),
});

export const runSessionTurn = async (options = {}) => {
  const { client, directory, selection, prompt, timeoutMs } = options;
  const title = options.title ?? `DevRyan agent evaluation: ${options.caseId ?? 'case'}`;
  const startedAt = Date.now();
  const timeoutError = new EvaluationTimeoutError(timeoutMs);
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(timeoutError), timeoutMs);
  const signal = combineSignals(options.signal, timeoutController.signal);
  const statuses = [];
  const knownSessionIds = new Set();
  let rootSessionId = '';
  try {
    const session = await client.createSession(directory, title, signal);
    rootSessionId = session.id;
    knownSessionIds.add(rootSessionId);
    await client.promptSession(rootSessionId, directory, selection, prompt, signal);
    const terminal = await waitForTerminalGraph({
      client,
      rootSessionId,
      directory,
      signal,
      statuses,
      knownSessionIds,
      requireManaged: options.caseId === 'managed-change',
    });
    const timingPayload = await client.getTurnTiming(rootSessionId, signal);
    const { sessionTree, managedPayload, terminalEvidence } = terminal;
    return {
      rootSessionId,
      childSessionIds: sessionTree.slice(1).map((entry) => entry.sessionId),
      sessionTree,
      statuses,
      tools: collectSanitizedTools(sessionTree, {
        rootSessionId,
        ownedTestRelativePath: options.runFiles?.testRelativePath,
      }),
      oracleReviewEvidence: collectOracleReviewEvidence(sessionTree, {
        rootSessionId,
        runFiles: options.runFiles,
      }),
      turnTiming: sanitizeTurnTiming(timingPayload),
      managedSnapshot: sanitizeManagedSnapshot(managedPayload),
      terminalEvidence,
      durationMs: Date.now() - startedAt,
      cleanup: {
        complete: true,
        discoveryComplete: true,
        reasonCodes: [],
        discoveredSessionIds: [...knownSessionIds],
        abortedSessionIds: [],
        abortFailureCount: 0,
      },
    };
  } catch (error) {
    const normalizedError = timeoutController.signal.aborted
      ? timeoutError
      : options.signal?.aborted
        ? new EvaluationAbortedError()
        : error;
    if (rootSessionId) {
      normalizedError.cleanup = await abortSessionTree(client, rootSessionId, directory, {
        timeoutMs: options.cleanupTimeoutMs,
        knownSessionIds,
      });
      normalizedError.rootSessionId = rootSessionId;
    }
    throw normalizedError;
  } finally {
    clearTimeout(timeout);
  }
};
