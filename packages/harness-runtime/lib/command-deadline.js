import crypto from 'node:crypto';

export const DEFAULT_COMMAND_TIMEOUT_MS = 240_000;
export const MAX_COMMAND_TIMEOUT_MS = 3_600_000;
export const COMMAND_DEADLINE_GRACE_MS = 30_000;
export const COMMAND_ABORT_CONFIRMATION_MS = 10_000;
// A streaming (`pending`) call has no process and no final input yet. It is a
// candidate: never cancelled, re-checked against the authoritative message with
// backoff until it runs (and is armed), ends, or ages out.
export const COMMAND_DISCOVERY_DELAY_MS = 5_000;
export const COMMAND_DISCOVERY_MAX_DELAY_MS = 60_000;
export const COMMAND_CANDIDATE_MAX_AGE_MS = 30 * 60_000;
// A command that already exited while its publication still runs is re-checked,
// never escalated to a session abort.
export const COMMAND_PUBLISHING_RECHECK_MS = 30_000;

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
const PHASES = new Set(['candidate', 'active', 'recovering', 'unresolved']);
const SOURCES = new Set(['registered', 'observed', 'legacy']);
// Background registrations (no native timeout) remembered so a later observed
// `running` update does not arm a watchdog for them.
const UNWATCHED_LIMIT = 1_024;

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

const requestedTimeout = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);

// The watchdog's view of a requested timeout: absent or sub-second values use
// the default; values above the maximum are clamped, never shortened.
export const normalizeCommandTimeout = (value) => (
  Number.isSafeInteger(value) && value >= 1_000
    ? Math.min(value, MAX_COMMAND_TIMEOUT_MS)
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

const normalizeFingerprint = (value) => {
  const fingerprint = asRecord(value);
  const normalized = {
    sessionID: asString(fingerprint.sessionID),
    messageID: asString(fingerprint.messageID),
    partID: asString(fingerprint.partID),
    callID: asString(fingerprint.callID),
    tool: asString(fingerprint.tool).toLowerCase(),
  };
  if (
    !normalized.sessionID
    || !normalized.messageID
    || !normalized.partID
    || !normalized.callID
    || !SHELL_TOOL_NAMES.has(normalized.tool)
  ) {
    throw new TypeError('command deadline fingerprint is invalid');
  }
  return normalized;
};

const optionalNonNegative = (value, label) => {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`command deadline ${label} is invalid`);
  return value;
};

/**
 * Version 2 records keep the requested timeout, the effective (native or
 * normalized) timeout and the deadline apart; the watchdog fires at
 * `deadlineAt + grace`. Version 1 records (no `version`, or 1) are read as
 * `legacy`: their deadline came from an observed part and is revalidated
 * against the authoritative message before any cancellation.
 */
export const validateCommandDeadlineRecord = (value) => {
  const record = asRecord(value);
  const fingerprint = normalizeFingerprint(record.fingerprint);
  const directory = asString(record.directory);
  if (!directory) throw new TypeError('command deadline directory is required');
  if (!isFiniteTimestamp(record.startedAt)) {
    throw new TypeError('command deadline start time is invalid');
  }
  if (!isFiniteTimestamp(record.deadlineAt) || record.deadlineAt < record.startedAt) {
    throw new TypeError('command deadline is invalid');
  }
  const abortRequestedAt = record.abortRequestedAt === null || record.abortRequestedAt === undefined
    ? null
    : record.abortRequestedAt;
  if (abortRequestedAt !== null && !isFiniteTimestamp(abortRequestedAt)) {
    throw new TypeError('command deadline abort time is invalid');
  }
  if (record.version === undefined || record.version === 1) {
    const phase = record.phase === 'recovering' || record.phase === 'unresolved' ? record.phase : 'active';
    return {
      version: 2,
      fingerprint,
      directory,
      source: 'legacy',
      phase,
      startedAt: record.startedAt,
      deadlineAt: record.deadlineAt,
      requestedTimeoutMs: null,
      effectiveTimeoutMs: record.deadlineAt - record.startedAt,
      abortRequestedAt,
      nextCheckAt: null,
      checks: 0,
    };
  }
  if (record.version !== 2) throw new TypeError('command deadline version is unsupported');
  if (!PHASES.has(record.phase)) throw new TypeError('command deadline phase is invalid');
  if (!SOURCES.has(record.source)) throw new TypeError('command deadline source is invalid');
  const nextCheckAt = record.nextCheckAt === null || record.nextCheckAt === undefined ? null : record.nextCheckAt;
  if (nextCheckAt !== null && !isFiniteTimestamp(nextCheckAt)) throw new TypeError('command deadline check time is invalid');
  const effectiveTimeoutMs = optionalNonNegative(record.effectiveTimeoutMs, 'effective timeout');
  if (record.phase === 'candidate' ? nextCheckAt === null : effectiveTimeoutMs === null) {
    throw new TypeError('command deadline record is incomplete');
  }
  const checks = record.checks === undefined ? 0 : record.checks;
  if (!Number.isSafeInteger(checks) || checks < 0) throw new TypeError('command deadline check count is invalid');
  return {
    version: 2,
    fingerprint,
    directory,
    source: record.source,
    phase: record.phase,
    startedAt: record.startedAt,
    deadlineAt: record.deadlineAt,
    requestedTimeoutMs: optionalNonNegative(record.requestedTimeoutMs, 'requested timeout'),
    effectiveTimeoutMs,
    abortRequestedAt,
    nextCheckAt,
    checks,
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
  const directory = asString(envelope.directory)
    || asString(directoryHint)
    || asString(properties.directory)
    || asString(info.directory);
  if (!directory) return null;
  return {
    key: fingerprintKey(fingerprint),
    fingerprint,
    directory,
    startedAt: isFiniteTimestamp(time.start) ? time.start : now,
    requestedTimeoutMs: requestedTimeout(asRecord(state.input).timeout),
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
  if (RUNNING_TOOL_STATUSES.has(status)) return { state: status === 'pending' ? 'pending' : 'running', part };
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
  const discoveryDelayMs = options.discoveryDelayMs ?? COMMAND_DISCOVERY_DELAY_MS;
  const discoveryMaxDelayMs = options.discoveryMaxDelayMs ?? COMMAND_DISCOVERY_MAX_DELAY_MS;
  const candidateMaxAgeMs = options.candidateMaxAgeMs ?? COMMAND_CANDIDATE_MAX_AGE_MS;
  const publishingRecheckMs = options.publishingRecheckMs ?? COMMAND_PUBLISHING_RECHECK_MS;
  const records = new Map();
  const timers = new Map();
  const inFlight = new Map();
  const unwatched = new Set();
  let initialized = false;
  let draining = false;
  let recoveredCount = 0;
  let lastOutcome = null;
  let lastError = null;
  let updatedAt = null;

  const timing = (record) => ({
    source: record.source,
    startedAt: record.startedAt,
    ...(record.phase === 'candidate' ? {} : {
      deadlineAt: record.deadlineAt,
      watchdogAt: record.deadlineAt + graceMs,
      effectiveTimeoutMs: record.effectiveTimeoutMs,
    }),
    graceMs,
    ...(record.requestedTimeoutMs === null ? {} : { requestedTimeoutMs: record.requestedTimeoutMs }),
  });

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
        ...timing(record),
        ...details,
      });
    } catch {
      // Diagnostic recording is best effort and must not affect recovery.
    }
  };

  const dueAt = (record) => record.nextCheckAt ?? record.deadlineAt + graceMs;

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

  // Candidates stay in memory: they exist only while a call streams, and an
  // older host would read a persisted candidate as an already-due deadline.
  const saveRecord = async (key, record) => {
    records.set(key, record);
    if (record.phase !== 'candidate') await store.writeRecord(key, record);
    return record;
  };

  const markUnresolved = async (key, error) => {
    const current = records.get(key);
    if (!current) return;
    const record = { ...current, phase: 'unresolved', nextCheckAt: null };
    await saveRecord(key, record);
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

  // An armed record from an authoritative running part: its start time and
  // requested timeout, never the streaming placeholder's empty input.
  const armedFromPart = (record, part) => {
    const state = asRecord(asRecord(part).state);
    const time = asRecord(state.time);
    const startedAt = isFiniteTimestamp(time.start) ? time.start : record.startedAt;
    const requestedTimeoutMs = requestedTimeout(asRecord(state.input).timeout);
    const effectiveTimeoutMs = normalizeCommandTimeout(requestedTimeoutMs);
    return {
      ...record,
      source: record.source === 'registered' ? 'registered' : 'observed',
      phase: 'active',
      startedAt,
      deadlineAt: startedAt + effectiveTimeoutMs,
      requestedTimeoutMs,
      effectiveTimeoutMs,
      nextCheckAt: null,
      checks: 0,
    };
  };

  const schedule = (key, record) => {
    clearScheduled(key);
    const delay = Math.max(0, dueAt(record) - now());
    const timer = setTimer(() => void runDue(key), delay);
    timer?.unref?.();
    timers.set(key, timer);
  };

  const discover = async (key, record, observation) => {
    if (observation.state === 'terminal' || observation.state === 'replaced') {
      await removeRecord(key, 'cleared', { reason: `candidate_${observation.state}` });
      return;
    }
    if (observation.state === 'running') {
      const armed = await saveRecord(key, armedFromPart(record, observation.part));
      recordIncident('command_deadline_started', armed, { reason: 'discovered' });
      schedule(key, armed);
      return;
    }
    if (now() - record.startedAt >= candidateMaxAgeMs) {
      await removeRecord(key, 'cleared', { reason: 'candidate_expired' });
      return;
    }
    const checks = record.checks + 1;
    const next = await saveRecord(key, {
      ...record,
      checks,
      nextCheckAt: now() + Math.min(discoveryMaxDelayMs, discoveryDelayMs * 2 ** checks),
    });
    schedule(key, next);
  };

  const reconcileDue = async (key) => {
    const record = records.get(key);
    if (!record || draining) return;
    clearScheduled(key);

    try {
      const initial = await fetchExact(record);
      if (record.phase === 'candidate') {
        await discover(key, record, initial);
        return;
      }
      if (await settleFromFetch(key, record, initial, 'authoritative_before_abort')) return;

      let current = records.get(key);
      if (!current) return;
      // Observed and legacy deadlines are revalidated against the
      // authoritative running part; a registered deadline is final.
      if (current.phase === 'active' && current.source !== 'registered' && initial.state === 'running') {
        const rebound = armedFromPart(current, initial.part);
        if (rebound.deadlineAt > current.deadlineAt) {
          await saveRecord(key, rebound);
          recordIncident('command_deadline_rebound', rebound, { previousDeadlineAt: current.deadlineAt });
          schedule(key, rebound);
          return;
        }
      }
      if (current.abortRequestedAt === null) {
        if (current.phase === 'active') {
          // The cancellation intent is durable and journaled before any
          // effect, so a kill that settles first is still attributable.
          current = await saveRecord(key, { ...current, phase: 'recovering', nextCheckAt: null });
          recordIncident('command_deadline_exceeded', current, { elapsedMs: Math.max(0, now() - current.startedAt) });
        }
        let outcome = false;
        if (typeof options.cancelCommand === 'function') {
          try {
            outcome = await options.cancelCommand({
              directory: current.directory,
              fingerprint: current.fingerprint,
              reason: 'command_deadline_exceeded',
              timing: { ...timing(current), elapsedMs: Math.max(0, now() - current.startedAt) },
            });
          } catch {
            // An unconfirmed process receipt cannot settle the call. Retain
            // the bounded session fallback and concurrent-session protection.
          }
        }
        if (outcome === 'publishing') {
          // The process already exited; aborting now could discard its
          // published result. Re-check after the publication settles.
          const next = await saveRecord(key, { ...current, nextCheckAt: now() + publishingRecheckMs });
          recordIncident('command_deadline_publishing', next);
          schedule(key, next);
          return;
        }
        if (outcome === true) {
          const deadline = now() + confirmationMs;
          do {
            if (await settleFromFetch(key, current, await fetchExact(current), 'authoritative_after_command_cancel')) return;
            if (now() >= deadline) break;
            await wait(Math.min(confirmationPollMs, deadline - now()));
          } while (!draining);
          if (draining || !records.has(key)) return;
        }
        current = await saveRecord(key, {
          ...current,
          phase: 'recovering',
          abortRequestedAt: now(),
          nextCheckAt: null,
        });
        recordIncident('command_deadline_session_abort', current);
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

  const forget = (key) => {
    unwatched.delete(key);
    unwatched.add(key);
    while (unwatched.size > UNWATCHED_LIMIT) unwatched.delete(unwatched.values().next().value);
  };

  /**
   * Authoritative registration from the execution owner, with the command's
   * real start time and the timeout the native shell enforces. It replaces an
   * observed or candidate record; later observed updates never change it. A
   * call without a native timeout (a background job) is not watched.
   */
  const register = async (input = {}) => {
    if (draining) return false;
    await initialize();
    const fingerprint = normalizeFingerprint(input.fingerprint);
    const directory = asString(input.directory);
    if (!directory) throw new TypeError('command deadline directory is required');
    if (!isFiniteTimestamp(input.startedAt)) throw new TypeError('command deadline start time is invalid');
    const key = fingerprintKey(fingerprint);
    const existing = records.get(key);
    if (existing && (existing.phase === 'recovering' || existing.phase === 'unresolved')) return false;
    const effective = Number.isSafeInteger(input.effectiveTimeoutMs) && input.effectiveTimeoutMs > 0
      ? Math.min(input.effectiveTimeoutMs, MAX_COMMAND_TIMEOUT_MS)
      : null;
    if (effective === null) {
      forget(key);
      if (existing) await removeRecord(key, 'cleared', { reason: 'registered_without_timeout' });
      return false;
    }
    const record = validateCommandDeadlineRecord({
      version: 2,
      fingerprint,
      directory,
      source: 'registered',
      phase: 'active',
      startedAt: input.startedAt,
      deadlineAt: input.startedAt + effective,
      requestedTimeoutMs: requestedTimeout(input.requestedTimeoutMs),
      effectiveTimeoutMs: effective,
      abortRequestedAt: null,
      nextCheckAt: null,
      checks: 0,
    });
    await saveRecord(key, record);
    recordIncident('command_deadline_started', record, { reason: 'registered' });
    schedule(key, record);
    return true;
  };

  const observe = async (payload, directory = null) => {
    if (draining) return false;
    await initialize();
    const update = parseToolUpdate(payload, directory, now());
    if (!update) return false;
    const existing = records.get(update.key);
    if (TERMINAL_TOOL_STATUSES.has(update.status)) {
      unwatched.delete(update.key);
      if (!existing || !sameFingerprint(existing.fingerprint, update.fingerprint)) return false;
      await removeRecord(update.key, existing.phase === 'active' || existing.phase === 'candidate' ? 'cleared' : 'recovered', {
        reason: 'terminal_event',
      });
      return true;
    }
    if (unwatched.has(update.key)) return true;
    if (existing && existing.phase !== 'candidate') {
      // Repeated part updates must never extend the absolute deadline.
      return sameFingerprint(existing.fingerprint, update.fingerprint);
    }
    if (update.status === 'pending') {
      if (existing) return true;
      const candidate = validateCommandDeadlineRecord({
        version: 2,
        fingerprint: update.fingerprint,
        directory: update.directory,
        source: 'observed',
        phase: 'candidate',
        startedAt: now(),
        deadlineAt: now(),
        requestedTimeoutMs: null,
        effectiveTimeoutMs: null,
        abortRequestedAt: null,
        nextCheckAt: now() + discoveryDelayMs,
        checks: 0,
      });
      await saveRecord(update.key, candidate);
      recordIncident('command_deadline_discovered', candidate);
      schedule(update.key, candidate);
      return true;
    }
    const effectiveTimeoutMs = normalizeCommandTimeout(update.requestedTimeoutMs);
    const record = validateCommandDeadlineRecord({
      version: 2,
      fingerprint: update.fingerprint,
      directory: update.directory,
      source: 'observed',
      phase: 'active',
      startedAt: update.startedAt,
      deadlineAt: update.startedAt + effectiveTimeoutMs,
      requestedTimeoutMs: update.requestedTimeoutMs,
      effectiveTimeoutMs,
      abortRequestedAt: null,
      nextCheckAt: null,
      checks: 0,
    });
    await saveRecord(update.key, record);
    recordIncident('command_deadline_started', record, { reason: 'observed' });
    schedule(update.key, record);
    return true;
  };

  const reconcile = async () => {
    await initialize();
    const due = [...records.entries()]
      .filter(([, record]) => dueAt(record) <= now())
      .map(([key]) => runDue(key));
    await Promise.allSettled(due);
  };

  const getStatus = () => {
    const values = [...records.values()];
    return {
      activeCount: values.filter((record) => record.phase !== 'candidate').length,
      candidateCount: values.filter((record) => record.phase === 'candidate').length,
      recoveredCount,
      unresolvedCount: values.filter((record) => record.phase === 'unresolved').length,
      lastOutcome,
      lastError,
      updatedAt,
    };
  };

  const drain = async () => {
    draining = true;
    for (const key of timers.keys()) clearScheduled(key);
    await Promise.allSettled([...inFlight.values()]);
    await store.drain();
  };

  return {
    initialize,
    observe,
    register,
    reconcile,
    getStatus,
    drain,
  };
};
