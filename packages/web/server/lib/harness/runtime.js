import crypto from 'node:crypto';
import os from 'node:os';

import {
  createDiagnosticJournal,
  createDiagnosticSanitizer,
  createHarnessPaths,
  createRecordStore,
  createWorktreeBootstrapRuntime,
  validateWorktreeBootstrapReceipt,
} from '@openchamber/harness-runtime';

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
  let ready = false;
  let acceptingPrompts = false;
  let initialization = null;
  let worktreeRuntime = null;
  let evidenceRuntime = null;

  const initialize = () => {
    initialization ??= Promise.all([
      journal.initialize(),
      worktreeStore.initialize(),
      worktreeRuntime?.reconcileOnStartup?.(),
      evidenceRuntime?.initialize?.(),
    ]).then(() => {
      ready = true;
      acceptingPrompts = true;
    });
    return initialization;
  };

  const setWorktreeRuntime = (runtime) => {
    worktreeRuntime = runtime;
  };

  const setEvidenceRuntime = (runtime) => {
    evidenceRuntime = runtime;
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
    if (!ready || !acceptingPrompts) {
      res.setHeader('Retry-After', '1');
      res.status(503).json({
        error: !ready
          ? 'DevRyan harness is still initializing'
          : 'DevRyan is shutting down',
        code: !ready ? 'HARNESS_INITIALIZING' : 'HARNESS_DRAINING',
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

  const controlJournalMiddleware = (req, _res, next) => {
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
        },
      });
    }
    next();
  };

  const getWorktreeReceipts = async () => (
    (await worktreeStore.listRecords()).map(({ record: receipt }) => receipt)
  );

  const beginDrain = () => {
    acceptingPrompts = false;
  };

  const drain = async () => {
    beginDrain();
    await Promise.allSettled([
      journal.close(),
      worktreeRuntime?.drain?.(),
      evidenceRuntime?.drain?.(),
      worktreeStore.drain(),
    ]);
  };

  return {
    paths,
    sanitizer,
    journal,
    worktreeStore,
    initialize,
    isReady: () => ready,
    isAcceptingPrompts: () => acceptingPrompts,
    promptAdmissionMiddleware,
    controlJournalMiddleware,
    record,
    recordOpenCodeEvent(payload, directory = null) {
      return record({
        type: 'open_code_event',
        directory,
        sessionID: payload?.properties?.sessionID
          ?? payload?.properties?.info?.sessionID
          ?? null,
        payload,
      });
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
    getWorktreeRuntime: () => worktreeRuntime,
    getWorktreeReceipts,
    beginDrain,
    drain,
    getStatus: () => journal.getStatus(),
  };
};

export const createConfiguredWorktreeRuntime = (options = {}) => createWorktreeBootstrapRuntime(options);
