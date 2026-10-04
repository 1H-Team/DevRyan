import crypto from 'node:crypto';
import express from 'express';
import { createCapabilityAbsentError, OPENCODE_CAPABILITY_ABSENT, resolveOpenCodeGeneration } from './opencode-generation.js';
import { listSessionTree } from './session-tree.js';

const REVERT_SCOPES = new Set(['tree', 'session']);

class ScopedRevertConflictError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ScopedRevertConflictError';
    this.code = code;
    this.status = 409;
    Object.assign(this, details);
  }
}

class ScopedRevertCancelledError extends Error {
  constructor() {
    super('Scoped session revert was cancelled');
    this.name = 'ScopedRevertCancelledError';
    this.code = 'SCOPED_REVERT_CANCELLED';
  }
}

export const bindScopedRevertRequestAbort = (req, res) => {
  const controller = new AbortController();
  const abortRequest = () => controller.abort(new ScopedRevertCancelledError());
  const abortClosedResponse = () => {
    if (!res.writableEnded) abortRequest();
  };
  req.once('aborted', abortRequest);
  res.once('close', abortClosedResponse);
  req.socket?.once('close', abortClosedResponse);

  return {
    signal: controller.signal,
    dispose: () => {
      req.removeListener('aborted', abortRequest);
      res.removeListener('close', abortClosedResponse);
      req.socket?.removeListener('close', abortClosedResponse);
    },
  };
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const parseScopedRevertJson = (req, res, next) => {
  express.json({ limit: '64kb' })(req, res, (error) => {
    if (error) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
    return next();
  });
};

const normalizeText = (value) => value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const splitLines = (value) => {
  const normalized = normalizeText(value);
  if (normalized.length === 0) return [];
  const lines = normalized.split('\n');
  if (normalized.endsWith('\n')) lines.pop();
  return lines;
};

const joinLines = (lines, finalNewline) => {
  if (lines.length === 0) return '';
  return `${lines.join('\n')}${finalNewline ? '\n' : ''}`;
};

export const parseUnifiedPatch = (patch) => {
  if (typeof patch !== 'string' || patch.trim().length === 0) {
    return [];
  }

  const lines = normalizeText(patch).split('\n');
  const hunks = [];
  let current = null;

  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldCount: header[2] ? Number(header[2]) : 1,
        newStart: Number(header[3]),
        newCount: header[4] ? Number(header[4]) : 1,
        lines: [],
      };
      hunks.push(current);
      continue;
    }

    if (!current) continue;
    if (line.startsWith('diff --git ') || line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith('\\')) {
      current.lines.push(line);
      continue;
    }
    if (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-')) {
      current.lines.push(line);
    }
  }

  return hunks;
};

const hunkTargetLines = (hunk) => hunk.lines
  .filter((line) => line.startsWith(' ') || line.startsWith('+'))
  .map((line) => line.slice(1));

const hunkReplacementLines = (hunk) => hunk.lines
  .filter((line) => line.startsWith(' ') || line.startsWith('-'))
  .map((line) => line.slice(1));

const findSequence = (lines, sequence, expectedIndex, { filePath = '' } = {}) => {
  if (sequence.length === 0) {
    return Math.max(0, Math.min(expectedIndex, lines.length));
  }

  const matches = [];
  const limit = lines.length - sequence.length;
  for (let index = 0; index <= limit; index += 1) {
    let matched = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (lines[index + offset] !== sequence[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) matches.push(index);
  }

  if (matches.length === 0) return -1;
  if (matches.length === 1) return matches[0];
  // Repeated blocks: only the candidate sitting exactly where the hunk says it
  // is can be reverted safely. Picking the "nearest" one silently rewrote the
  // wrong copy when another change shifted the file.
  if (matches.includes(expectedIndex)) return expectedIndex;
  throw new ScopedRevertConflictError(
    'ambiguous_hunk',
    `Cannot safely revert ${filePath}; the changed hunk at line ${expectedIndex + 1} matches ${matches.length} places in the file`,
    { file: filePath, candidates: matches.map((index) => index + 1) },
  );
};

export const reverseApplyUnifiedPatch = (currentText, patch, filePath) => {
  // Hunks are reversed bottom-up (descending new-side start), so the lines
  // above a hunk are untouched when it is located: the expected offset is the
  // hunk's stated new-side position and needs no prior-hunk adjustment.
  const hunks = parseUnifiedPatch(patch).sort((a, b) => b.newStart - a.newStart);
  let lines = splitLines(currentText);
  const finalNewline = normalizeText(currentText).endsWith('\n');

  for (const hunk of hunks) {
    const target = hunkTargetLines(hunk);
    const replacement = hunkReplacementLines(hunk);
    const index = findSequence(lines, target, Math.max(0, hunk.newStart - 1), { filePath });
    if (index < 0) {
      throw new Error(`Cannot safely revert ${filePath}; the changed hunk was modified by another change`);
    }
    lines = [
      ...lines.slice(0, index),
      ...replacement,
      ...lines.slice(index + target.length),
    ];
  }

  return joinLines(lines, finalNewline);
};

/** No unowned HTTP/snapshot restore is available. The native coordinator owns mutations. */
export const runScopedSessionRevert = async ({ openCodeClient }) => {
  resolveOpenCodeGeneration(openCodeClient);
  throw createCapabilityAbsentError('conversation_revert');
};
export const runScopedSessionUnrevert = runScopedSessionRevert;

/** Historical worktree diffs do not establish session ownership. */
export const computeScopedSessionChanges = async ({ openCodeClient, directory, sessionID, signal }) => {
  const sessions = await listSessionTree({ openCodeClient, sessionID, directory, signal });
  return { files: [], sessionCount: sessions.length, sessions: [],
    rootSessionID: sessionID, firstUserMessageID: null, hasUnattributedMutations: false,
    coverage: 'partial', reasons: ['historical_capture_unavailable'] };
};

const sendScopedRevertError = (res, error, fallbackMessage) => {
  if (error?.code === 'SCOPED_REVERT_TIMEOUT') {
    return res.status(504).json({
      error: 'Scoped session revert timed out',
      code: 'SCOPED_REVERT_TIMEOUT',
    });
  }
  if (error?.code === 'SCOPED_REVERT_ROLLBACK_FAILED') {
    return res.status(500).json({
      error: 'Scoped session revert rollback could not be confirmed',
      code: 'SCOPED_REVERT_ROLLBACK_FAILED',
    });
  }
  if (error instanceof ScopedRevertConflictError || ['mutation_runtime_unsupported', 'mutation_platform_unsupported',
    'mutation_history_unavailable', 'mutation_cancellation_failed', 'mutation_termination_unconfirmed',
    'mutation_recovery_required', 'mutation_recovery_failed', 'mutation_history_captured', 'mutation_recovery_pending',
    'session_directory_mismatch', 'session_reverting', 'revert_cancelled', OPENCODE_CAPABILITY_ABSENT].includes(error?.code)) {
    const payload = { error: error.message, code: error.code };
    if (Array.isArray(error.files)) payload.files = error.files;
    if (typeof error.file === 'string') payload.file = error.file;
    if (Array.isArray(error.sessions)) payload.sessions = error.sessions;
    return res.status(409).json(payload);
  }
  return res.status(409).json({ error: error?.message || fallbackMessage });
};

export const registerScopedSessionRevertRoute = (app, deps) => {
  const diagnostic = (req, requestID, phase, details = {}) => {
    const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : undefined;
    try {
      void Promise.resolve(deps.recordDiagnostic?.({ type: 'lifecycle', event: 'session_revert',
        sessionID: id(req.params.sessionID), messageID: id(req.body?.messageID),
        payload: { requestID, phase, messageID: id(req.body?.messageID), transactionID: id(details.transactionID),
          errorID: phase === 'failed' ? crypto.randomUUID() : undefined, code: id(details.code) } })).catch(() => {});
    } catch { /* Diagnostics cannot change control-plane settlement. */ }
  };
  const runnerOptions = () => ({ openCodeClient: deps.openCodeClient });

  // Keep JSON parsing route-local because /api/openchamber/* is intentionally
  // registered before the generic /api proxy and is not covered by common API
  // middleware in all runtimes/test harnesses.
  app.post('/api/openchamber/session/:sessionID/scoped-revert', parseScopedRevertJson, async (req, res) => {
    const requestAbort = bindScopedRevertRequestAbort(req, res);
    const requestID = crypto.randomUUID();

    try {
      const sessionID = req.params.sessionID;
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      const body = isObject(req.body) ? req.body : {};
      const messageID = typeof body.messageID === 'string' ? body.messageID : '';
      const scope = body.scope === undefined ? 'tree' : body.scope;

      if (!sessionID) {
        return res.status(400).json({ error: 'sessionID parameter is required' });
      }
      if (!directory) {
        return res.status(400).json({ error: 'directory query parameter is required' });
      }
      if (!messageID) {
        return res.status(400).json({ error: 'messageID is required' });
      }
      if (!REVERT_SCOPES.has(scope)) {
        return res.status(400).json({ error: "scope must be 'tree' or 'session'" });
      }

      diagnostic(req, requestID, 'requested');
      const result = await (deps.sessionRevertCoordinator?.revert ?? runScopedSessionRevert)({
        ...runnerOptions(),
        directory,
        sessionID,
        messageID,
        scope,
        signal: requestAbort.signal,
      });
      diagnostic(req, requestID, 'completed', { transactionID: result.verification?.transactionID });
      return res.json(result);
    } catch (error) {
      diagnostic(req, requestID, 'failed', { code: error?.code });
      console.error('[scoped-revert] Failed to revert session safely:', error);
      return sendScopedRevertError(res, error, 'Failed to revert session safely');
    } finally {
      requestAbort.dispose();
    }
  });

  app.post('/api/openchamber/session/:sessionID/scoped-unrevert', parseScopedRevertJson, async (req, res) => {
    const requestAbort = bindScopedRevertRequestAbort(req, res);
    const requestID = crypto.randomUUID();

    try {
      const sessionID = req.params.sessionID;
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';

      if (!sessionID) {
        return res.status(400).json({ error: 'sessionID parameter is required' });
      }
      if (!directory) {
        return res.status(400).json({ error: 'directory query parameter is required' });
      }

      diagnostic(req, requestID, 'redo_requested');
      const result = await (deps.sessionRevertCoordinator?.redo ?? runScopedSessionUnrevert)({
        ...runnerOptions(),
        directory,
        sessionID,
        signal: requestAbort.signal,
      });
      diagnostic(req, requestID, 'completed', { transactionID: result.verification?.transactionID });
      return res.json(result);
    } catch (error) {
      diagnostic(req, requestID, 'failed', { code: error?.code });
      console.error('[scoped-revert] Failed to redo session revert safely:', error);
      return sendScopedRevertError(res, error, 'Failed to redo session revert safely');
    } finally {
      requestAbort.dispose();
    }
  });

  app.get('/api/openchamber/session/:sessionID/changes', async (req, res) => {
    const requestAbort = bindScopedRevertRequestAbort(req, res);

    try {
      const sessionID = req.params.sessionID;
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';

      if (!sessionID) {
        return res.status(400).json({ error: 'sessionID parameter is required' });
      }
      if (!directory) {
        return res.status(400).json({ error: 'directory query parameter is required' });
      }

      const result = await computeScopedSessionChanges({
        ...runnerOptions(),
        directory,
        sessionID,
        signal: requestAbort.signal,
      });
      return res.json(result);
    } catch (error) {
      console.error('[scoped-revert] Failed to summarize session changes:', error);
      if (error?.code === 'SCOPED_REVERT_TIMEOUT') {
        return res.status(504).json({ error: 'Session change summary timed out', code: 'SCOPED_REVERT_TIMEOUT' });
      }
      if (error instanceof ScopedRevertConflictError) {
        return sendScopedRevertError(res, error, 'Failed to summarize session changes');
      }
      return res.status(500).json({ error: error?.message || 'Failed to summarize session changes' });
    } finally {
      requestAbort.dispose();
    }
  });
};
