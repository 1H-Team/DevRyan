import crypto from 'node:crypto';
import os from 'node:os';

import {
  createDiagnosticJournal,
  createDiagnosticSanitizer,
  createHarnessPaths,
  createPromptAdmissionController,
  createRecordStore,
  createWorktreeBootstrapRuntime,
  validateCommandDeadlineRecord,
  validateWorktreeBootstrapReceipt,
} from '@openchamber/harness-runtime';
import { ABORT_SOURCE_HEADER, normalizeAbortSource } from '@openchamber/orchestration-runtime';

// Node lower-cases incoming header names.
const ABORT_SOURCE_REQUEST_HEADER = ABORT_SOURCE_HEADER.toLowerCase();

export const createWebHarnessRuntime = (options = {}) => {
  const paths = createHarnessPaths({ rootDir: options.dataDirectory });
  const sanitizer = createDiagnosticSanitizer({
    homeDir: os.homedir(),
    dataDir: options.dataDirectory,
    knownSecrets: options.knownSecrets ?? [],
  });
  const journal = createDiagnosticJournal({
    directory: paths.journalDir,
    sanitizer,
    runtime: options.runtime ?? 'web',
    maxBytes: options.maxJournalBytes,
  });
  const worktreeStore = createRecordStore({
    directory: paths.worktreeOpsDir,
    validateRecord: validateWorktreeBootstrapReceipt,
    logger: options.logger ?? console,
  });
  const commandDeadlineStore = createRecordStore({
    directory: paths.commandDeadlineDir,
    validateRecord: validateCommandDeadlineRecord,
    logger: options.logger ?? console,
  });
  const promptAdmission = createPromptAdmissionController();
  let initialization = null;
  let worktreeRuntime = null;
  let evidenceRuntime = null;
  let commandDeadlineRuntime = null;
  let primaryRecoveryRuntime = null;
  let nativeSessionIdleObserver = null;
  let sessionChangeHost = null;
  let controlObserver = null;
  let taskContextRuntime = null;

  const initialize = () => {
    initialization ??= Promise.all([
      journal.initialize(),
      worktreeStore.initialize(),
      commandDeadlineStore.initialize(),
      worktreeRuntime?.reconcileOnStartup?.(),
      evidenceRuntime?.initialize?.(),
      commandDeadlineRuntime?.initialize?.(),
      primaryRecoveryRuntime?.initialize?.(),
    ]).then(() => {
      promptAdmission.markReady();
    });
    return initialization;
  };

  const setWorktreeRuntime = (runtime) => {
    worktreeRuntime = runtime;
  };

  const setEvidenceRuntime = (runtime) => {
    evidenceRuntime = runtime;
  };

  const setCommandDeadlineRuntime = (runtime) => {
    commandDeadlineRuntime = runtime;
  };

  const record = (entry) => journal.enqueue({
    at: Date.now(),
    runtime: options.runtime ?? 'web',
    ...entry,
  });

  const requestActor = (req) => {
    const principal = req?.principal;
    if (!principal?.id) return null;
    return { id: principal.id, role: principal.role || null, scope: principal.scope || null };
  };

  const boundedPromptBody = (body) => {
    const serialized = JSON.stringify(body ?? null);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes <= 64 * 1024) return body;
    // Only pay for the Buffer copy + hash on oversized bodies.
    const encoded = Buffer.from(serialized, 'utf8');
    return {
      body: encoded.subarray(0, 60 * 1024).toString('utf8'),
      truncated: true,
      size: bytes,
      sha256: crypto.createHash('sha256').update(encoded).digest('hex'),
    };
  };

  const promptAdmissionMiddleware = (turnTimingRuntime) => (req, res, next) => {
    const admissionBlock = promptAdmission.getBlock();
    if (admissionBlock) {
      res.setHeader('Retry-After', String(admissionBlock.retryAfterSeconds));
      res.status(503).json({
        error: admissionBlock.error,
        code: admissionBlock.code,
      });
      return;
    }

    const sessionID = typeof req.params?.sessionID === 'string' ? req.params.sessionID : '';
    const directory = typeof req.query?.directory === 'string' ? req.query.directory : null;
    const messageID = typeof req.headers?.['x-openchamber-message-id'] === 'string'
      ? req.headers['x-openchamber-message-id']
      : null;
    record({
      type: 'prompt',
      actor: requestActor(req),
      sessionID,
      directory,
      messageID,
      payload: {
        method: req.method,
        body: boundedPromptBody(req.body),
      },
    });
    res.once('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      turnTimingRuntime?.recordPromptAccepted?.({
        sessionID,
        messageID,
        directory,
      });
    });
    next();
  };

  // Attribution only: an unknown or missing value is recorded as 'unknown' and
  // never changes whether the abort proceeds.
  const readAbortSource = (req) => normalizeAbortSource(req.headers?.[ABORT_SOURCE_REQUEST_HEADER]);

  const controlJournalMiddleware = (req, res, next) => {
    const action = String(req.path || '').replace(/^\/+/, '').split('/')[0];
    if (
      req.method !== 'GET'
      && action
      && action !== 'prompt_async'
      && ['abort', 'revert', 'message', 'fork', 'share', 'unshare'].includes(action)
    ) {
      record({
        type: 'control',
        actor: requestActor(req),
        sessionID: typeof req.params?.sessionID === 'string' ? req.params.sessionID : null,
        directory: typeof req.query?.directory === 'string' ? req.query.directory : null,
        action,
        payload: {
          method: req.method,
          body: req.body,
          ...(action === 'abort' ? { source: readAbortSource(req) } : {}),
        },
      });
      if (controlObserver && typeof req.params?.sessionID === 'string') {
        try {
          controlObserver({
            action,
            sessionID: req.params.sessionID,
            directory: typeof req.query?.directory === 'string' ? req.query.directory : null,
            source: action === 'abort' ? readAbortSource(req) : null,
            res,
          });
        } catch {
          // Observers are advisory; a failure must never block the control request.
        }
      }
    }
    next();
  };

  const getWorktreeReceipts = async () => (
    (await worktreeStore.listRecords()).map(({ record: receipt }) => receipt)
  );

  const beginDrain = () => {
    promptAdmission.beginDrain();
  };

  const drain = async () => {
    beginDrain();
    const results = await Promise.allSettled([
      journal.close(),
      worktreeRuntime?.drain?.(),
      evidenceRuntime?.drain?.(),
      commandDeadlineRuntime?.drain?.(),
      primaryRecoveryRuntime?.drain?.(),
      sessionChangeHost?.drain(),
      taskContextRuntime?.drain(),
      worktreeStore.drain(),
      commandDeadlineStore.drain(),
    ]);
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Harness stores did not finish draining');
  };

  return {
    setTaskContextRuntime: (runtime) => { taskContextRuntime = runtime; },
    paths,
    sanitizer,
    journal,
    worktreeStore,
    commandDeadlineStore,
    initialize,
    isReady: promptAdmission.isReady,
    isAcceptingPrompts: promptAdmission.isAccepting,
    getPromptAdmissionBlock: promptAdmission.getBlock,
    acquirePromptAdmissionHold: promptAdmission.acquireHold,
    promptAdmissionMiddleware,
    controlJournalMiddleware,
    record,
    recordOpenCodeEvent(payload, directory = null) {
      primaryRecoveryRuntime?.observe(payload);
      if (nativeSessionIdleObserver && payload?.type === 'session.status' && payload.properties?.status?.type === 'idle'
        && typeof payload.properties.sessionID === 'string' && typeof directory === 'string') {
        void Promise.resolve().then(() => nativeSessionIdleObserver?.({ sessionID: payload.properties.sessionID, directory }))
          .catch(error => record({ type: 'log', event: 'native_todo_continuation_failed', sessionID: payload.properties.sessionID,
            payload: { code: typeof error?.code === 'string' ? error.code : 'native_continuation_unavailable' } }));
      }
      void sessionChangeHost?.observe(payload, directory).catch((error) => record({ type: 'log', event: 'session_changes_observation_failed',
        sessionID: payload?.properties?.part?.sessionID ?? payload?.properties?.sessionID ?? null,
        payload: { callID: payload?.properties?.part?.callID ?? null, code: typeof error?.code === 'string' ? error.code : 'capture_unavailable' },
      }));
      return record({
        type: 'open_code_event',
        directory,
        sessionID: payload?.properties?.sessionID
          ?? payload?.properties?.info?.sessionID
          ?? payload?.properties?.part?.sessionID
          ?? null,
        payload,
      });
    },
    // Session execution host diagnostics (execution and revert phases).
    recordSessionExecution(event) {
      return record({ type: 'lifecycle', event: event.event === 'session_execution' ? 'session_execution' : 'session_revert',
        sessionID: event.sessionID, payload: event });
    },
    // Turn timing marks and per-turn summaries (`turn.<mark>`, `turn.summary`):
    // timings, identities and model selection only, never prompt text.
    recordTurnTiming(entry) {
      if (typeof entry?.mark !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(entry.mark) || typeof entry.sessionId !== 'string') return false;
      return record({ type: 'timing', mark: `turn.${entry.mark}`, sessionID: entry.sessionId,
        ...(typeof entry.userMessageId === 'string' ? { messageID: entry.userMessageId } : {}),
        ...(typeof entry.directory === 'string' ? { directory: entry.directory } : {}),
        payload: entry.payload ?? {} });
    },
    recordLifecycleEvent(event) {
      return record({
        type: 'lifecycle',
        event: event.type,
        sessionID: event.sessionID,
        directory: event.directory,
        turnID: event.turnID,
        userMessageID: event.userMessageID,
        assistantMessageID: event.assistantMessageID,
        payload: event,
      });
    },
    setWorktreeRuntime,
    setEvidenceRuntime,
    setCommandDeadlineRuntime,
    setPrimaryRecoveryRuntime(runtime) { primaryRecoveryRuntime = runtime; },
    setNativeSessionIdleObserver(observer) { nativeSessionIdleObserver = observer; },
    // Receives journaled session controls (with the response, so a rejected
    // request can be withdrawn). Wired by the server, never by a request.
    setControlObserver(observer) { controlObserver = typeof observer === 'function' ? observer : null; },
    setSessionChangeHost(runtime) { sessionChangeHost = runtime; },
    getWorktreeRuntime: () => worktreeRuntime,
    getWorktreeReceipts,
    getCommandDeadlineRecoveryStatus: () => commandDeadlineRuntime?.getStatus?.() ?? null,
    beginDrain,
    drain,
    getStatus: () => journal.getStatus(),
  };
};

export const createConfiguredWorktreeRuntime = (options = {}) => createWorktreeBootstrapRuntime(options);
