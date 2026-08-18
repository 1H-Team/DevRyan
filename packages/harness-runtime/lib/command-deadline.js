import crypto from 'node:crypto';

export const DEFAULT_COMMAND_TIMEOUT_MS = 240_000;
export const MAX_COMMAND_TIMEOUT_MS = 3_600_000;
export const COMMAND_DEADLINE_GRACE_MS = 30_000;
export const COMMAND_ABORT_CONFIRMATION_MS = 10_000;

const SHELL_TOOL_NAMES = new Set(['bash', 'shell']);
const RUNNING_TOOL_STATUSES = new Set(['pending', 'running']);
const TERMINAL_TOOL_STATUSES = new Set([
  'completed',
  'complete',
  'done',
  'error',
  'failed',
  'aborted',
  'timeout',
  'timedout',
  'cancelled',
  'canceled',
]);

const asRecord = (value) => (
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}
);

const asString = (value) => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : ''
);

const normalizeStatus = (value) => asString(value).toLowerCase().replace(/[\s_-]+/g, '');

const isFiniteTimestamp = (value) => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0
);

const normalizeTimeout = (value) => (
  Number.isSafeInteger(value) && value >= 1_000 && value <= MAX_COMMAND_TIMEOUT_MS
    ? value
    : DEFAULT_COMMAND_TIMEOUT_MS
);

const fingerprintKey = (fingerprint) => crypto
  .createHash('sha256')
  .update(JSON.stringify([
    fingerprint.sessionID,
    fingerprint.messageID,
    fingerprint.partID,
    fingerprint.callID,
    fingerprint.tool,
  ]))
  .digest('hex');

const sameFingerprint = (left, right) => (
  left.sessionID === right.sessionID
  && left.messageID === right.messageID
  && left.partID === right.partID
  && left.callID === right.callID
  && left.tool === right.tool
);

export const validateCommandDeadlineRecord = (value) => {
  const record = asRecord(value);
  const fingerprint = asRecord(record.fingerprint);
  const normalizedFingerprint = {
    sessionID: asString(fingerprint.sessionID),
    messageID: asString(fingerprint.messageID),
    partID: asString(fingerprint.partID),
    callID: asString(fingerprint.callID),
    tool: asString(fingerprint.tool).toLowerCase(),
  };
  if (
    !normalizedFingerprint.sessionID
    || !normalizedFingerprint.messageID
    || !normalizedFingerprint.partID
    || !normalizedFingerprint.callID
    || !SHELL_TOOL_NAMES.has(normalizedFingerprint.tool)
  ) {
    throw new TypeError('command deadline fingerprint is invalid');
  }

  const directory = asString(record.directory);
  if (!directory) throw new TypeError('command deadline directory is required');
  if (!isFiniteTimestamp(record.startedAt)) {
    throw new TypeError('command deadline start time is invalid');
  }
  if (!isFiniteTimestamp(record.deadlineAt) || record.deadlineAt < record.startedAt) {
    throw new TypeError('command deadline is invalid');
  }
  const phase = record.phase === 'recovering' || record.phase === 'unresolved'
    ? record.phase
    : 'active';
  const abortRequestedAt = record.abortRequestedAt === null || record.abortRequestedAt === undefined
    ? null
    : record.abortRequestedAt;
  if (abortRequestedAt !== null && !isFiniteTimestamp(abortRequestedAt)) {
    throw new TypeError('command deadline abort time is invalid');
  }

  return {
    version: 1,
    fingerprint: normalizedFingerprint,
    directory,
    startedAt: record.startedAt,
    deadlineAt: record.deadlineAt,
    phase,
    abortRequestedAt,
  };
};

const parseToolUpdate = (candidate, directoryHint, now) => {
  const envelope = asRecord(candidate);
  const payload = asString(envelope.type) ? envelope : asRecord(envelope.payload);
  if (payload.type !== 'message.part.updated') return null;
  const properties = asRecord(payload.properties);
  const part = asRecord(properties.part);
  if (part.type !== 'tool') return null;
  const tool = asString(part.tool).toLowerCase();
  if (!SHELL_TOOL_NAMES.has(tool)) return null;

  const state = asRecord(part.state);
  const status = normalizeStatus(state.status);
  if (!RUNNING_TOOL_STATUSES.has(status) && !TERMINAL_TOOL_STATUSES.has(status)) return null;
  const info = asRecord(properties.info);
  const fingerprint = {
    sessionID: asString(properties.sessionID ?? properties.sessionId ?? part.sessionID ?? info.sessionID),
    messageID: asString(properties.messageID ?? properties.messageId ?? part.messageID ?? info.id),
    partID: asString(part.id),
    callID: asString(part.callID ?? part.callId),
    tool,
  };
  if (Object.values(fingerprint).some((value) => !value)) return null;

  const time = asRecord(state.time);
  const startedAt = isFiniteTimestamp(time.start) ? time.start : now;
  const timeoutMs = normalizeTimeout(asRecord(state.input).timeout);
  const directory = asString(envelope.directory)
    || asString(directoryHint)
    || asString(properties.directory)
    || asString(info.directory);
  if (!directory) return null;
  return {
    key: fingerprintKey(fingerprint),
    fingerprint,
    directory,
    startedAt,
    deadlineAt: startedAt + timeoutMs,
    status,
    part,
  };
};

const normalizeMessage = (value) => {
  const outer = asRecord(value);
  const data = asRecord(outer.data);
  const message = Object.keys(data).length > 0 ? data : outer;
  const info = asRecord(message.info);
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return { info, parts };
};

const inspectExactCall = (record, value) => {
  if (value === null || value === undefined) return { state: 'replaced', part: null };
  const message = normalizeMessage(value);
  if (
    asString(message.info.id) !== record.fingerprint.messageID
    || asString(message.info.sessionID ?? message.info.sessionId) !== record.fingerprint.sessionID
  ) {
    return { state: 'replaced', part: null };
  }
  const part = message.parts.find((candidate) => {
    const next = asRecord(candidate);
    return asString(next.id) === record.fingerprint.partID
      && asString(next.callID ?? next.callId) === record.fingerprint.callID
      && asString(next.tool).toLowerCase() === record.fingerprint.tool;
  });
  if (!part) return { state: 'replaced', part: null };
  const status = normalizeStatus(asRecord(asRecord(part).state).status);
  if (TERMINAL_TOOL_STATUSES.has(status)) return { state: 'terminal', part };
  if (RUNNING_TOOL_STATUSES.has(status)) return { state: 'running', part };
  return { state: 'replaced', part };
};

const defaultWait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const boundedError = (error, sanitizeError) => {
  const raw = error instanceof Error ? error.message : String(error || 'Unknown recovery error');
  let message = raw;
  if (typeof sanitizeError === 'function') {
    try {
      message = String(sanitizeError(raw));
    } catch {
      message = 'Command deadline recovery failed; diagnostic sanitization also failed';
    }
  }
  return message.replace(/[\r\n]+/g, ' ').slice(0, 500);
};

export const createCommandDeadlineController = (options = {}) => {
  if (!options.store) throw new TypeError('command deadline store is required');
  if (typeof options.fetchMessage !== 'function') {
    throw new TypeError('command deadline fetchMessage adapter is required');
  }
  if (typeof options.abortSession !== 'function') {
    throw new TypeError('command deadline abortSession adapter is required');
  }

  const store = options.store;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  const wait = options.wait ?? defaultWait;
  const graceMs = options.graceMs ?? COMMAND_DEADLINE_GRACE_MS;
  const confirmationMs = options.confirmationMs ?? COMMAND_ABORT_CONFIRMATION_MS;
  const confirmationPollMs = options.confirmationPollMs ?? 500;
  const records = new Map();
  const timers = new Map();
  const inFlight = new Map();
  let initialized = false;
  let draining = false;
  let recoveredCount = 0;
  let lastOutcome = null;
  let lastError = null;
  let updatedAt = null;

  const recordIncident = (event, record, details = {}) => {
    updatedAt = now();
    try {
      options.recordIncident?.({
        type: event,
        at: updatedAt,
        sessionID: record.fingerprint.sessionID,
        messageID: record.fingerprint.messageID,
        partID: record.fingerprint.partID,
        callID: record.fingerprint.callID,
        tool: record.fingerprint.tool,
        directory: record.directory,
        deadlineAt: record.deadlineAt,
        ...details,
      });
    } catch {
      // Diagnostic recording is best effort and must not affect recovery.
    }
  };

  const clearScheduled = (key) => {
    const timer = timers.get(key);
    if (timer) clearTimer(timer);
    timers.delete(key);
  };

  const removeRecord = async (key, outcome, details = {}) => {
    const record = records.get(key);
    if (!record) return;
    clearScheduled(key);
    records.delete(key);
    await store.deleteRecord(key);
    lastOutcome = outcome;
    lastError = null;
    if (outcome === 'recovered') recoveredCount += 1;
    recordIncident(
      outcome === 'recovered' ? 'command_deadline_recovered' : 'command_deadline_cleared',
      record,
      details,
    );
  };

  const markUnresolved = async (key, error) => {
    const current = records.get(key);
    if (!current) return;
    const record = { ...current, phase: 'unresolved' };
    records.set(key, record);
    await store.writeRecord(key, record);
    lastOutcome = 'unresolved';
    lastError = boundedError(error, options.sanitizeError);
    recordIncident('command_deadline_unresolved', record, { error: lastError });
  };

  const publishAuthoritativePart = (record, part) => {
    if (!part || typeof options.publishPart !== 'function') return;
    options.publishPart({ record, part });
  };

  const fetchExact = async (record) => inspectExactCall(
    record,
    await options.fetchMessage({
      ...record.fingerprint,
      directory: record.directory,
    }),
  );

  const settleFromFetch = async (key, record, observation, reason) => {
    if (observation.state === 'terminal') {
      publishAuthoritativePart(record, observation.part);
      await removeRecord(key, 'recovered', { reason });
      return true;
    }
    if (observation.state === 'replaced') {
      await removeRecord(key, 'recovered', { reason: `${reason}_replaced` });
      return true;
    }
    return false;
  };

  const reconcileDue = async (key) => {
    const record = records.get(key);
    if (!record || draining) return;
    clearScheduled(key);

    try {
      const initial = await fetchExact(record);
      if (await settleFromFetch(key, record, initial, 'authoritative_before_abort')) return;

      let current = records.get(key);
      if (!current) return;
      if (current.abortRequestedAt === null) {
        current = {
          ...current,
          phase: 'recovering',
          abortRequestedAt: now(),
        };
        records.set(key, current);
        await store.writeRecord(key, current);
        recordIncident('command_deadline_exceeded', current);
        await options.abortSession({
          sessionID: current.fingerprint.sessionID,
          directory: current.directory,
        });
      }

      const confirmationDeadline = now() + confirmationMs;
      do {
        const afterAbort = await fetchExact(current);
        if (await settleFromFetch(key, current, afterAbort, 'authoritative_after_abort')) return;
        if (now() >= confirmationDeadline) break;
        await wait(Math.min(confirmationPollMs, confirmationDeadline - now()));
      } while (!draining);

      if (draining || !records.has(key)) return;
      const external = typeof options.isExternalRuntime === 'function'
        ? await options.isExternalRuntime()
        : false;
      if (external) {
        await markUnresolved(key, 'External OpenCode still reports the command as running after abort');
        return;
      }

      const activeSessions = typeof options.listActiveSessions === 'function'
        ? await options.listActiveSessions({ directory: current.directory })
        : [];
      const normalizedActive = Array.isArray(activeSessions)
        ? activeSessions.map((entry) => (
            typeof entry === 'string' ? entry : asString(asRecord(entry).sessionID ?? asRecord(entry).sessionId)
          )).filter(Boolean)
        : [];
      if (
        normalizedActive.length === 1
        && normalizedActive[0] === current.fingerprint.sessionID
        && typeof options.restartManagedRuntime === 'function'
      ) {
        await options.restartManagedRuntime({
          sessionID: current.fingerprint.sessionID,
          directory: current.directory,
        });
        if (initial.part) {
          const part = asRecord(initial.part);
          const state = asRecord(part.state);
          publishAuthoritativePart(current, {
            ...part,
            state: {
              ...state,
              status: 'error',
              error: 'Command exceeded its deadline; DevRyan restarted the managed OpenCode runtime.',
              time: { ...asRecord(state.time), end: now() },
            },
          });
        }
        await removeRecord(key, 'recovered', { reason: 'managed_runtime_restarted' });
        return;
      }

      await markUnresolved(
        key,
        normalizedActive.length > 1
          ? 'Other sessions are active; DevRyan preserved them instead of restarting OpenCode'
          : 'The command remained running after abort and a safe managed restart was unavailable',
      );
    } catch (error) {
      await markUnresolved(key, error);
    }
  };

  const runDue = (key) => {
    if (inFlight.has(key)) return inFlight.get(key);
    const operation = reconcileDue(key).finally(() => inFlight.delete(key));
    inFlight.set(key, operation);
    return operation;
  };

  const schedule = (key, record) => {
    clearScheduled(key);
    const dueAt = record.deadlineAt + graceMs;
    const delay = Math.max(0, dueAt - now());
    const timer = setTimer(() => void runDue(key), delay);
    timer?.unref?.();
    timers.set(key, timer);
  };

  const initialize = async () => {
    if (initialized) return;
    await store.initialize();
    for (const { key, record: rawRecord } of await store.listRecords()) {
      const record = validateCommandDeadlineRecord(rawRecord);
      records.set(key, record);
      schedule(key, record);
    }
    initialized = true;
  };

  const observe = async (payload, directory = null) => {
    if (draining) return false;
    await initialize();
    const update = parseToolUpdate(payload, directory, now());
    if (!update) return false;
    const existing = records.get(update.key);
    if (TERMINAL_TOOL_STATUSES.has(update.status)) {
      if (!existing || !sameFingerprint(existing.fingerprint, update.fingerprint)) return false;
      await removeRecord(update.key, existing.phase === 'active' ? 'cleared' : 'recovered', {
        reason: 'terminal_event',
      });
      return true;
    }
    if (existing) {
      // Repeated part updates must never extend the absolute deadline.
      return sameFingerprint(existing.fingerprint, update.fingerprint);
    }
    const record = validateCommandDeadlineRecord({
      version: 1,
      fingerprint: update.fingerprint,
      directory: update.directory,
      startedAt: update.startedAt,
      deadlineAt: update.deadlineAt,
      phase: 'active',
      abortRequestedAt: null,
    });
    records.set(update.key, record);
    await store.writeRecord(update.key, record);
    recordIncident('command_deadline_started', record);
    schedule(update.key, record);
    return true;
  };

  const reconcile = async () => {
    await initialize();
    const due = [...records.entries()]
      .filter(([, record]) => record.deadlineAt + graceMs <= now())
      .map(([key]) => runDue(key));
    await Promise.allSettled(due);
  };

  const getStatus = () => ({
    activeCount: records.size,
    recoveredCount,
    unresolvedCount: [...records.values()].filter((record) => record.phase === 'unresolved').length,
    lastOutcome,
    lastError,
    updatedAt,
  });

  const drain = async () => {
    draining = true;
    for (const key of timers.keys()) clearScheduled(key);
    await Promise.allSettled([...inFlight.values()]);
    await store.drain();
  };

  return {
    initialize,
    observe,
    reconcile,
    getStatus,
    drain,
  };
};
