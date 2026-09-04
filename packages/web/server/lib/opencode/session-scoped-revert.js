import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import express from 'express';

import { isActiveSessionStatus, listSessionStatuses, listSessionTree } from './session-tree.js';

const execFileAsync = promisify(execFile);
const SESSION_MESSAGE_LIMIT = 1000;
const SCOPED_REVERT_TIMEOUT_MS = 30_000;
const SCOPED_REVERT_CLEANUP_TIMEOUT_MS = 4_000;
const SCOPED_REVERT_SLOW_OPERATION_MS = 2_000;
const SNAPSHOT_CONCURRENCY = 16;
const SESSION_FETCH_CONCURRENCY = 4;
const REVERT_JOURNAL_MAX_BYTES = 8 * 1024 * 1024;
const REVERT_SCOPES = new Set(['tree', 'session']);
const scopedRevertLocks = new Map();

class ScopedRevertConflictError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ScopedRevertConflictError';
    this.code = code;
    this.status = 409;
    Object.assign(this, details);
  }
}

class ScopedRevertTimeoutError extends Error {
  constructor() {
    super('Scoped session revert timed out');
    this.name = 'ScopedRevertTimeoutError';
    this.code = 'SCOPED_REVERT_TIMEOUT';
  }
}

class ScopedRevertCancelledError extends Error {
  constructor() {
    super('Scoped session revert was cancelled');
    this.name = 'ScopedRevertCancelledError';
    this.code = 'SCOPED_REVERT_CANCELLED';
  }
}

class ScopedRevertRollbackError extends Error {
  constructor(cause) {
    super('Scoped session revert rollback could not be confirmed', { cause });
    this.name = 'ScopedRevertRollbackError';
    this.code = 'SCOPED_REVERT_ROLLBACK_FAILED';
  }
}

const throwIfAborted = (signal) => {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new ScopedRevertCancelledError();
};

const abortable = async (promise, signal) => {
  throwIfAborted(signal);
  if (!signal) return promise;

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new ScopedRevertCancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(signal.aborted && signal.reason instanceof Error ? signal.reason : error);
      },
    );
  });
};

const createAbortContext = ({ timeoutMs, signal: parentSignal } = {}) => {
  const controller = new AbortController();
  const abortFromParent = () => {
    controller.abort(parentSignal?.reason instanceof Error ? parentSignal.reason : new ScopedRevertCancelledError());
  };
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  }

  const timeout = setTimeout(() => controller.abort(new ScopedRevertTimeoutError()), timeoutMs);
  timeout.unref?.();

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
};

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

const mapWithConcurrency = async (items, limit, mapper, signal) => {
  const values = Array.from(items);
  const results = new Array(values.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < values.length) {
      throwIfAborted(signal);
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
};

const createSlowOperationDiagnostics = (slowOperationMs = SCOPED_REVERT_SLOW_OPERATION_MS) => {
  const startedAt = Date.now();
  const phaseDurationsMs = {};
  let activePhase = null;
  let activePhaseStartedAt = 0;
  let fileCount = 0;
  let byteCount = 0;
  let rewrittenCount = 0;

  const timer = setTimeout(() => {
    const durations = { ...phaseDurationsMs };
    if (activePhase) {
      durations[activePhase] = (durations[activePhase] ?? 0) + (Date.now() - activePhaseStartedAt);
    }
    console.warn('[scoped-revert] Slow operation', {
      phaseDurationsMs: durations,
      fileCount,
      byteCount,
      rewrittenCount,
    });
  }, slowOperationMs);
  timer.unref?.();

  return {
    runPhase: async (phase, task) => {
      const previousPhase = activePhase;
      const previousStartedAt = activePhaseStartedAt;
      activePhase = phase;
      activePhaseStartedAt = Date.now();
      try {
        return await task();
      } finally {
        phaseDurationsMs[phase] = (phaseDurationsMs[phase] ?? 0) + (Date.now() - activePhaseStartedAt);
        activePhase = previousPhase;
        activePhaseStartedAt = previousStartedAt;
      }
    },
    recordSnapshots: (snapshots) => {
      fileCount = snapshots.size;
      byteCount = 0;
      for (const snapshot of snapshots.values()) {
        if (snapshot.exists) byteCount += snapshot.content.byteLength;
      }
    },
    recordRewrite: () => {
      rewrittenCount += 1;
    },
    dispose: () => {
      clearTimeout(timer);
      return Date.now() - startedAt;
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

const encodeDirectoryQuery = (directory) => {
  const params = new URLSearchParams();
  params.set('directory', directory);
  return params.toString();
};

const toPosixRelative = (relativePath) => relativePath.split(path.sep).join('/');

const ensureInsideDirectory = (directory, filePath) => {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('Invalid diff file path');
  }

  const root = path.resolve(directory);
  const normalized = filePath.replace(/\\/g, '/');
  const absolute = path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(root, normalized.replace(/^\/+/, ''));
  const relative = path.relative(root, absolute);

  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Diff file path escapes the project directory: ${filePath}`);
  }

  return { absolute, relative: toPosixRelative(relative) };
};

const fileExists = async (absolutePath) => {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
};

const readSnapshot = async (directory, filePath, signal) => {
  const { absolute, relative } = ensureInsideDirectory(directory, filePath);
  try {
    return {
      path: relative,
      absolute,
      exists: true,
      content: await abortable(fs.readFile(absolute, signal ? { signal } : undefined), signal),
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { path: relative, absolute, exists: false, content: Buffer.alloc(0) };
    }
    throw error;
  }
};

const writeSnapshot = async (snapshot, signal) => {
  throwIfAborted(signal);
  if (!snapshot.exists) {
    await abortable(fs.rm(snapshot.absolute, { recursive: true, force: true }), signal);
    return;
  }

  await abortable(fs.mkdir(path.dirname(snapshot.absolute), { recursive: true }), signal);
  await abortable(fs.writeFile(snapshot.absolute, snapshot.content, signal ? { signal } : undefined), signal);
};

const snapshotMatchesCurrentFile = async (snapshot, signal) => {
  try {
    const currentContent = await abortable(
      fs.readFile(snapshot.absolute, signal ? { signal } : undefined),
      signal,
    );
    return snapshot.exists && currentContent.equals(snapshot.content);
  } catch (error) {
    if (signal?.aborted) throwIfAborted(signal);
    if (error?.code === 'ENOENT') return !snapshot.exists;
    throw error;
  }
};

const textToSnapshot = (snapshot, text) => ({
  ...snapshot,
  exists: true,
  content: Buffer.from(text, 'utf8'),
});

const deletedSnapshot = (snapshot) => ({
  ...snapshot,
  exists: false,
  content: Buffer.alloc(0),
});

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

const extractPatchSideContent = (patch, side) => {
  const lines = [];
  let finalNewline = true;
  for (const hunk of parseUnifiedPatch(patch)) {
    let previousPrefix = '';
    for (const line of hunk.lines) {
      if (line.startsWith('\\')) {
        const markerApplies = previousPrefix === ' '
          || (side === 'before' ? previousPrefix === '-' : previousPrefix === '+');
        if (markerApplies && line.includes('No newline at end of file')) {
          finalNewline = false;
        }
        continue;
      }
      if (line.startsWith(' ')) {
        lines.push(line.slice(1));
      } else if (side === 'before' && line.startsWith('-')) {
        lines.push(line.slice(1));
      } else if (side === 'after' && line.startsWith('+')) {
        lines.push(line.slice(1));
      }
      previousPrefix = line[0] ?? '';
    }
  }
  return joinLines(lines, finalNewline);
};

const assertSnapshotTextEquals = (snapshot, expectedText, filePath) => {
  const actualText = snapshot.exists ? normalizeText(snapshot.content.toString('utf8')) : '';
  if (actualText !== normalizeText(expectedText)) {
    throw new Error(`Cannot safely revert ${filePath}; the file no longer matches the session diff`);
  }
};

const reverseApplyDiffToSnapshot = (snapshot, diff) => {
  const filePath = diff.file;
  const status = diff.status;
  const patch = typeof diff.patch === 'string' ? diff.patch : '';
  const hunks = parseUnifiedPatch(patch);

  if (status && !['added', 'deleted', 'modified'].includes(status)) {
    throw new Error(`Cannot safely revert ${filePath}; unsupported diff status ${status}`);
  }

  if (diff.binary === true || hunks.length === 0) {
    throw new ScopedRevertConflictError(
      'binary_diff_unsupported',
      `Cannot safely revert ${filePath}; the session diff has no text patch`,
      { file: filePath },
    );
  }

  if (status === 'added') {
    assertSnapshotTextEquals(snapshot, extractPatchSideContent(patch, 'after'), filePath);
    return deletedSnapshot(snapshot);
  }

  if (status === 'deleted') {
    if (snapshot.exists) {
      throw new Error(`Cannot safely revert ${filePath}; the deleted file was recreated by another change`);
    }
    return textToSnapshot(snapshot, extractPatchSideContent(patch, 'before'));
  }

  if (!snapshot.exists) {
    throw new Error(`Cannot safely revert ${filePath}; the file is missing`);
  }

  return textToSnapshot(
    snapshot,
    reverseApplyUnifiedPatch(snapshot.content.toString('utf8'), patch, filePath),
  );
};

const looksLikePorcelainStatus = (entry) => entry.length >= 4 && entry[2] === ' ';

const collectGitStatusFiles = async (directory, signal) => {
  try {
    const { stdout } = await abortable(
      execFileAsync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
        cwd: directory,
        maxBuffer: 10 * 1024 * 1024,
        signal,
      }),
      signal,
    );
    const entries = stdout.split('\0').filter(Boolean);
    const files = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!looksLikePorcelainStatus(entry)) continue;
      files.push(entry.slice(3));
      const status = entry.slice(0, 2);
      if ((status.includes('R') || status.includes('C')) && entries[index + 1] && !looksLikePorcelainStatus(entries[index + 1])) {
        files.push(entries[index + 1]);
        index += 1;
      }
    }
    return files;
  } catch (error) {
    if (signal?.aborted) throwIfAborted(signal);
    const detail = error?.stderr || error?.message || String(error);
    throw new Error(`Scoped session revert requires a Git worktree so unrelated changes can be protected: ${detail}`);
  }
};

const fetchJson = async (url, options, fetchImpl = fetch) => {
  const response = await fetchImpl(url, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = isObject(payload) && typeof payload.error === 'string' ? payload.error : response.statusText;
    const error = new Error(message || `Request failed with status ${response.status}`);
    error.upstreamStatus = response.status;
    throw error;
  }
  return payload;
};

const fetchSessionMessages = async ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, fetchImpl, directory, sessionID, signal }) => {
  const query = new URLSearchParams({ directory, limit: String(SESSION_MESSAGE_LIMIT) });
  return abortable(
    fetchJson(buildOpenCodeUrl(`/session/${encodeURIComponent(sessionID)}/message?${query}`, ''), {
      method: 'GET',
      headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      signal,
    }, fetchImpl),
    signal,
  );
};

const fetchSession = async ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, fetchImpl, directory, sessionID, signal }) => {
  const query = new URLSearchParams({ directory });
  return abortable(
    fetchJson(buildOpenCodeUrl(`/session/${encodeURIComponent(sessionID)}?${query}`, ''), {
      method: 'GET',
      headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      signal,
    }, fetchImpl),
    signal,
  );
};

// Loads the message transcripts of every session in the tree. Descendants
// that no longer exist (404) contribute no messages; the root must load.
const fetchTreeMessages = async ({ client, directory, sessions, signal }) => {
  const recordsBySession = new Map();
  const records = await mapWithConcurrency(
    sessions,
    SESSION_FETCH_CONCURRENCY,
    async (session) => {
      try {
        const payload = await fetchSessionMessages({ ...client, directory, sessionID: session.id, signal });
        return Array.isArray(payload) ? payload : [];
      } catch (error) {
        if (signal?.aborted) throwIfAborted(signal);
        if (session.depth > 0 && error?.upstreamStatus === 404) return [];
        throw error;
      }
    },
    signal,
  );
  sessions.forEach((session, index) => {
    recordsBySession.set(session.id, records[index]);
  });
  return recordsBySession;
};

// Runs the native OpenCode reverts (or unreverts) for every step in order,
// sharing one abort controller so an interruption stops the whole sequence.
// The promise resolves with the last step's Session payload.
const startUpstreamSequence = ({ client, directory, steps, kind }) => {
  const controller = new AbortController();
  const completed = [];
  const run = async () => {
    let last = null;
    for (const step of steps) {
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error ? controller.signal.reason : new ScopedRevertCancelledError();
      }
      const action = kind === 'unrevert' ? 'unrevert' : 'revert';
      try {
        last = await fetchJson(
          client.buildOpenCodeUrl(`/session/${encodeURIComponent(step.sessionID)}/${action}?${encodeDirectoryQuery(directory)}`, ''),
          {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              ...client.getOpenCodeAuthHeaders(),
            },
            body: JSON.stringify(kind === 'unrevert' ? {} : { messageID: step.messageID }),
            signal: controller.signal,
          },
          client.fetchImpl,
        );
      } catch (error) {
        if (kind === 'unrevert' && error?.upstreamStatus === 404 && step.optional) {
          continue;
        }
        throw error;
      }
      completed.push(step);
    }
    return last;
  };
  return {
    promise: run(),
    abort: (reason) => controller.abort(reason),
    completed: () => completed.slice(),
  };
};

// Best-effort native unrevert for sessions whose native revert already
// succeeded before a later step failed. File contents are restored separately.
const rollbackUpstreamReverts = async ({ client, directory, steps, signal }) => {
  // Never throws: the file restore that follows must run even when this
  // request is already aborted (the fetch then rejects and is logged).
  for (const step of [...steps].reverse()) {
    try {
      await fetchJson(
        client.buildOpenCodeUrl(`/session/${encodeURIComponent(step.sessionID)}/unrevert?${encodeDirectoryQuery(directory)}`, ''),
        {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...client.getOpenCodeAuthHeaders() },
          body: '{}',
          signal,
        },
        client.fetchImpl,
      );
    } catch (error) {
      console.warn('[scoped-revert] Could not roll back native revert', { sessionID: step.sessionID, error: error?.message });
    }
  }
};

const assertSessionsIdle = async ({ client, directory, treeSessionIDs, signal }) => {
  const statuses = await abortable(listSessionStatuses({ ...client, directory, signal }), signal);
  const busyInside = [];
  const busyOutside = [];
  for (const [id, status] of Object.entries(statuses)) {
    if (!isActiveSessionStatus(status)) continue;
    (treeSessionIDs.has(id) ? busyInside : busyOutside).push(id);
  }
  if (busyInside.length > 0) {
    throw new ScopedRevertConflictError(
      'session_busy',
      `Cannot revert while a session in this prompt is still running: ${busyInside.join(', ')}`,
      { sessions: busyInside },
    );
  }
  if (busyOutside.length > 0) {
    throw new ScopedRevertConflictError(
      'directory_busy',
      `Cannot revert while another session is working in this directory: ${busyOutside.join(', ')}`,
      { sessions: busyOutside },
    );
  }
};

const sortMessageRecords = (records) => [...records].sort((a, b) => {
  const aInfo = a?.info ?? {};
  const bInfo = b?.info ?? {};
  const aTime = typeof aInfo.time?.created === 'number' ? aInfo.time.created : 0;
  const bTime = typeof bInfo.time?.created === 'number' ? bInfo.time.created : 0;
  if (aTime !== bTime) return aTime - bTime;
  return String(aInfo.id ?? '').localeCompare(String(bInfo.id ?? ''));
});

const messageTime = (record) => (typeof record?.info?.time?.created === 'number' ? record.info.time.created : 0);

const nextUserMessageTime = (ordered, fromIndex) => {
  for (let index = fromIndex + 1; index < ordered.length; index += 1) {
    if (ordered[index]?.info?.role === 'user') return messageTime(ordered[index]);
  }
  return Number.POSITIVE_INFINITY;
};

// OpenCode attaches `summary.diffs` to a user message: the worktree diff
// between the turn's first and last snapshot. Each diff becomes a "diff op"
// whose window is the turn [user message, next user message).
const collectSessionDiffOps = ({ sessionID, depth, ordered, targetIndex, endIndex }) => {
  const ops = [];
  for (let index = targetIndex; index < endIndex; index += 1) {
    const record = ordered[index];
    const info = record?.info;
    if (info?.role !== 'user' || !Array.isArray(info.summary?.diffs)) continue;
    const start = messageTime(record);
    const end = nextUserMessageTime(ordered, index);
    for (const diff of info.summary.diffs) {
      if (!isObject(diff) || typeof diff.file !== 'string' || diff.file.trim().length === 0) continue;
      ops.push({ kind: 'diff', file: diff.file, diff, sessionID, depth, messageID: info.id, start, end });
    }
  }
  return ops;
};

// Resolves one session's participation in a tree revert. The root reverts
// from the clicked message; a descendant reverts from its first message
// created at or after the root target (none → the descendant is untouched).
const buildSessionPlanEntry = ({ session, records, targetMessageID, rootTargetTime }) => {
  const ordered = sortMessageRecords(Array.isArray(records) ? records : []);
  const isRoot = session.depth === 0;
  const targetIndex = isRoot
    ? ordered.findIndex((record) => record?.info?.id === targetMessageID)
    : ordered.findIndex((record) => messageTime(record) >= rootTargetTime);
  if (targetIndex < 0) {
    if (isRoot) throw new Error('Target message was not found in the session');
    return null;
  }

  let endIndex = ordered.length;
  const currentRevertMessageID = typeof session.revert?.messageID === 'string' ? session.revert.messageID : '';
  if (currentRevertMessageID.length > 0) {
    const currentRevertIndex = ordered.findIndex((record) => record?.info?.id === currentRevertMessageID);
    if (currentRevertIndex < 0) {
      throw new Error('Current session revert boundary was not found in the session');
    }
    if (targetIndex <= currentRevertIndex) {
      // Messages at and after the current boundary are already absent from the
      // worktree. Moving farther back reverses only the newly hidden interval.
      endIndex = currentRevertIndex;
    } else if (!isRoot) {
      // The descendant is already reverted at or before this point.
      return null;
    }
  }

  const target = ordered[targetIndex];
  return {
    session,
    sessionID: session.id,
    depth: session.depth,
    ordered,
    targetIndex,
    endIndex,
    targetMessageID: target.info.id,
    targetTime: messageTime(target),
    currentRevertMessageID,
    diffOps: collectSessionDiffOps({ sessionID: session.id, depth: session.depth, ordered, targetIndex, endIndex }),
    snapshotOps: [],
  };
};

/**
 * Builds the tree revert plan: which sessions participate, from which
 * message, and the diff ops harvested from their transcripts. Pure; snapshot
 * ops (patch-part fallbacks) are attached separately because they need disk.
 */
export const collectTreeRevertPlan = ({ sessions, recordsBySession, targetMessageID }) => {
  const root = sessions.find((session) => session.depth === 0) ?? sessions[0];
  if (!root) throw new Error('Session tree is empty');
  const rootEntry = buildSessionPlanEntry({
    session: root,
    records: recordsBySession.get(root.id),
    targetMessageID,
    rootTargetTime: 0,
  });
  const entries = [rootEntry];
  for (const session of sessions) {
    if (session === root || session.depth === 0) continue;
    const entry = buildSessionPlanEntry({
      session,
      records: recordsBySession.get(session.id),
      targetMessageID,
      rootTargetTime: rootEntry.targetTime,
    });
    if (entry) entries.push(entry);
  }
  return {
    rootSessionID: root.id,
    rootTarget: { messageID: rootEntry.targetMessageID, time: rootEntry.targetTime },
    entries,
  };
};

const planOps = (plan) => plan.entries.flatMap((entry) => [...entry.diffOps, ...entry.snapshotOps]);

/**
 * Merges ops across sessions per file. Every summary diff is worktree-wide for
 * its turn window, so an op whose window lies inside another diff op's window
 * on the same file is already covered by it (a sub-agent editing inside its
 * parent's turn) and is dropped; keeping both would reverse the same hunk
 * twice. Kept ops are returned in reverse chronological order, ready to be
 * reverse-applied one after the other.
 */
export const mergeTreeOps = (ops, directory) => {
  const byFile = new Map();
  for (const op of ops) {
    const { relative } = ensureInsideDirectory(directory, op.file);
    if (!byFile.has(relative)) byFile.set(relative, { all: [], kept: [] });
    byFile.get(relative).all.push({ ...op, relative });
  }
  for (const group of byFile.values()) {
    const sorted = [...group.all].sort((a, b) => (
      a.start - b.start || b.end - a.end || a.depth - b.depth || String(a.sessionID).localeCompare(String(b.sessionID))
    ));
    for (const op of sorted) {
      const covered = group.kept.some((kept) => (
        kept.kind === 'diff' && kept !== op && kept.start <= op.start && kept.end >= op.end
      ));
      if (!covered) group.kept.push(op);
    }
    group.kept.sort((a, b) => (
      b.start - a.start || b.depth - a.depth || String(b.sessionID).localeCompare(String(a.sessionID))
    ));
  }
  return byFile;
};

const collectPatchSnapshotTargets = (ordered, targetIndex, endIndex = ordered.length) => {
  const targets = [];
  const seen = new Set();
  for (const record of ordered.slice(targetIndex, endIndex)) {
    for (const part of Array.isArray(record?.parts) ? record.parts : []) {
      if (part?.type !== 'patch' || typeof part.hash !== 'string' || !Array.isArray(part.files)) {
        continue;
      }
      for (const file of part.files) {
        if (typeof file !== 'string' || file.trim().length === 0) continue;
        const key = `${part.hash}\0${file}`;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push({ file, snapshot: part.hash, messageID: record?.info?.id, time: messageTime(record) });
      }
    }
  }
  return targets;
};

const defaultOpenCodeSnapshotRoot = () => {
  const dataRoot = process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.trim().length > 0
    ? process.env.XDG_DATA_HOME
    : path.join(os.homedir(), '.local', 'share');
  return path.join(dataRoot, 'opencode', 'snapshot');
};

const findSnapshotGitDir = async (snapshotRoot, projectID, snapshotHash, signal) => {
  throwIfAborted(signal);
  const projectSnapshotRoot = path.join(snapshotRoot, projectID);
  let entries;
  try {
    entries = await abortable(fs.readdir(projectSnapshotRoot, { withFileTypes: true }), signal);
  } catch {
    if (signal?.aborted) throwIfAborted(signal);
    return null;
  }

  for (const entry of entries) {
    throwIfAborted(signal);
    if (!entry.isDirectory()) continue;
    const gitDir = path.join(projectSnapshotRoot, entry.name);
    try {
      const { stdout } = await abortable(
        execFileAsync('git', ['--git-dir', gitDir, 'cat-file', '-t', snapshotHash], {
          maxBuffer: 64 * 1024,
          signal,
        }),
        signal,
      );
      const type = String(stdout).trim();
      if (type === 'tree' || type === 'commit') {
        return gitDir;
      }
    } catch {
      if (signal?.aborted) throwIfAborted(signal);
      // Keep scanning; OpenCode can leave multiple snapshot repositories.
    }
  }

  return null;
};

const readSnapshotGitFile = async ({ snapshotRoot, projectID, snapshotHash, directory, file, signal }) => {
  const { absolute, relative } = ensureInsideDirectory(directory, file);
  const gitDir = await findSnapshotGitDir(snapshotRoot, projectID, snapshotHash, signal);
  if (!gitDir) {
    throw new Error(`Cannot safely revert ${relative}; OpenCode snapshot ${snapshotHash} was not found`);
  }

  try {
    const { stdout } = await abortable(
      execFileAsync('git', ['--git-dir', gitDir, 'show', `${snapshotHash}:${relative}`], {
        encoding: 'buffer',
        maxBuffer: 100 * 1024 * 1024,
        signal,
      }),
      signal,
    );
    return {
      path: relative,
      absolute,
      exists: true,
      content: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
    };
  } catch (error) {
    if (signal?.aborted) throwIfAborted(signal);
    const message = String(error?.stderr || error?.message || '');
    if (message.includes('exists on disk, but not in') || message.includes('Path') || message.includes('does not exist')) {
      return { path: relative, absolute, exists: false, content: Buffer.alloc(0) };
    }
    throw error;
  }
};

// Patch-part fallback: when a turn has no finalized summary diff (aborted
// turn), restore each touched file to the OpenCode snapshot taken right
// before the first tool call that changed it. These are point-in-time
// "snapshot ops" for the merge.
const collectSnapshotOps = async ({
  directory,
  entry,
  projectID,
  snapshotRoot = defaultOpenCodeSnapshotRoot(),
  signal,
}) => {
  if (!projectID) {
    return [];
  }

  const uniqueTargets = [];
  const seen = new Set();
  for (const target of collectPatchSnapshotTargets(entry.ordered, entry.targetIndex, entry.endIndex)) {
    const { relative } = ensureInsideDirectory(directory, target.file);
    if (seen.has(relative)) continue;
    seen.add(relative);
    uniqueTargets.push({ ...target, relative });
  }
  const snapshots = await mapWithConcurrency(
    uniqueTargets,
    SNAPSHOT_CONCURRENCY,
    (target) => readSnapshotGitFile({
        snapshotRoot,
        projectID,
        snapshotHash: target.snapshot,
        directory,
        file: target.file,
        signal,
      }),
    signal,
  );

  return uniqueTargets.map((target, index) => ({
    kind: 'snapshot',
    file: target.file,
    snapshot: snapshots[index],
    sessionID: entry.sessionID,
    depth: entry.depth,
    messageID: target.messageID,
    start: target.time,
    end: target.time,
  }));
};

const attachSnapshotOps = async ({ plan, directory, snapshotRoot, signal }) => {
  const projectID = plan.entries
    .map((entry) => entry.session.projectID)
    .find((id) => typeof id === 'string' && id.length > 0) ?? '';
  for (const entry of plan.entries) {
    if (entry.diffOps.length > 0) continue;
    entry.snapshotOps = await collectSnapshotOps({ directory, entry, projectID, snapshotRoot, signal });
  }
};

const collectGitTrackedFiles = async (directory, signal) => {
  try {
    const { stdout } = await abortable(
      execFileAsync('git', ['ls-files', '-z'], {
        cwd: directory,
        maxBuffer: 10 * 1024 * 1024,
        signal,
      }),
      signal,
    );
    return new Set(stdout.split('\0').filter(Boolean).map(toPosixRelative));
  } catch (error) {
    if (signal?.aborted) throwIfAborted(signal);
    const detail = error?.stderr || error?.message || String(error);
    throw new Error(`Cannot inspect tracked files before scoped session revert: ${detail}`);
  }
};

const listSnapshotTreeFiles = async ({ snapshotRoot, projectID, snapshotHash, signal }) => {
  const gitDir = await findSnapshotGitDir(snapshotRoot, projectID, snapshotHash, signal);
  if (!gitDir) {
    throw new Error(`Cannot safely inspect OpenCode snapshot ${snapshotHash}`);
  }

  try {
    const { stdout } = await abortable(
      execFileAsync(
        'git',
        ['--git-dir', gitDir, 'ls-tree', '-r', '-z', '--name-only', snapshotHash],
        // Names only — even huge snapshots stay far below this.
        { maxBuffer: 20 * 1024 * 1024, signal },
      ),
      signal,
    );
    return stdout.split('\0').filter(Boolean);
  } catch (error) {
    if (signal?.aborted) throwIfAborted(signal);
    const detail = error?.stderr || error?.message || String(error);
    throw new Error(`Cannot safely inspect OpenCode snapshot ${snapshotHash}: ${detail}`);
  }
};

const collectSnapshotTreeProtectionPaths = async ({
  directory,
  projectID,
  snapshotHashes,
  snapshotRoot = defaultOpenCodeSnapshotRoot(),
  signal,
}) => {
  // Git status cannot represent an absent untracked path. OpenCode's broad
  // revert/unrevert can still rehydrate that path from either the current
  // unrevert snapshot or a turn's initial patch snapshot, so protect those
  // non-Git paths explicitly (including an "absent" snapshot tombstone).
  if (snapshotHashes.size === 0) {
    return [];
  }
  if (!projectID) {
    throw new Error('Cannot safely inspect OpenCode snapshots without a session project ID');
  }

  const trackedFiles = await collectGitTrackedFiles(directory, signal);
  const protectedPaths = new Set();
  for (const snapshotHash of snapshotHashes) {
    throwIfAborted(signal);
    const snapshotFiles = await listSnapshotTreeFiles({ snapshotRoot, projectID, snapshotHash, signal });
    for (const file of snapshotFiles) {
      throwIfAborted(signal);
      const { relative } = ensureInsideDirectory(directory, file);
      if (!trackedFiles.has(relative)) {
        protectedPaths.add(relative);
      }
    }
  }
  return Array.from(protectedPaths);
};

const collectTreeSnapshotProtectionPaths = async ({ directory, plan, snapshotRoot, signal }) => {
  const snapshotHashes = new Set();
  let projectID = '';
  for (const entry of plan.entries) {
    const existingRevertSnapshot = entry.session.revert?.snapshot;
    if (typeof existingRevertSnapshot === 'string' && existingRevertSnapshot.length > 0) {
      snapshotHashes.add(existingRevertSnapshot);
    }
    // The native revert replays every patch part after the target, so the
    // first one bounds what it can rehydrate (unclamped on purpose).
    const firstPatchSnapshot = collectPatchSnapshotTargets(entry.ordered, entry.targetIndex)[0]?.snapshot;
    if (firstPatchSnapshot) {
      snapshotHashes.add(firstPatchSnapshot);
    }
    if (!projectID && typeof entry.session.projectID === 'string') {
      projectID = entry.session.projectID;
    }
  }
  return collectSnapshotTreeProtectionPaths({ directory, projectID, snapshotHashes, snapshotRoot, signal });
};

const captureProtectedSnapshots = async (
  directory,
  { targetFiles, snapshotProtectionPaths = [], signal, diagnostics } = {},
) => {
  // Decision: use Git status as the protection boundary before calling OpenCode's
  // broad revert. Without a worktree status snapshot we cannot know which
  // unrelated files another chat changed, so the endpoint fails instead of
  // risking hidden data loss.
  const protectedFiles = new Set(await collectGitStatusFiles(directory, signal));
  for (const file of snapshotProtectionPaths) {
    protectedFiles.add(ensureInsideDirectory(directory, file).relative);
  }
  for (const file of targetFiles) protectedFiles.add(file);

  const snapshots = new Map();
  const protectedSnapshots = await mapWithConcurrency(
    Array.from(protectedFiles),
    SNAPSHOT_CONCURRENCY,
    (file) => readSnapshot(directory, file, signal),
    signal,
  );
  for (const snapshot of protectedSnapshots) {
    snapshots.set(snapshot.path, snapshot);
  }
  diagnostics?.recordSnapshots(snapshots);
  return snapshots;
};

// Dry run: derives the desired post-revert content of every target file from
// the captured snapshots by replaying the merged ops (newest first). Nothing is
// written here, so an ambiguous hunk, a binary diff or a drifted hunk aborts
// before the worktree is touched.
const prepareScopedRevert = async (
  directory,
  mergedOps,
  snapshotProtectionPaths = [],
  { signal, diagnostics } = {},
) => {
  const targetFiles = new Set(mergedOps.keys());
  const snapshots = await captureProtectedSnapshots(directory, {
    targetFiles,
    snapshotProtectionPaths,
    signal,
    diagnostics,
  });

  const desiredTargetSnapshots = new Map();
  for (const [file, group] of mergedOps) {
    let desired = snapshots.get(file);
    for (const op of group.kept) {
      throwIfAborted(signal);
      desired = op.kind === 'snapshot'
        ? { ...op.snapshot }
        : reverseApplyDiffToSnapshot(desired, op.diff);
    }
    desiredTargetSnapshots.set(file, desired);
  }

  return { snapshots, desiredTargetSnapshots, targetFiles };
};

const restoreProtectedSnapshots = async (
  { snapshots, desiredTargetSnapshots },
  { restoreOriginal = false, signal, diagnostics } = {},
) => {
  const failures = [];
  await mapWithConcurrency(
    snapshots,
    SNAPSHOT_CONCURRENCY,
    async ([file, snapshot]) => {
      const targetSnapshot = (restoreOriginal ? snapshot : desiredTargetSnapshots.get(file)) ?? snapshot;
      try {
        if (await snapshotMatchesCurrentFile(targetSnapshot, signal)) return;
        await writeSnapshot(targetSnapshot, signal);
        diagnostics?.recordRewrite();
      } catch (error) {
        if (signal?.aborted) throwIfAborted(signal);
        failures.push(`${file}: ${error?.message || String(error)}`);
      }
    },
    signal,
  );

  if (failures.length > 0) {
    throw new Error(`Failed to restore protected files after session revert: ${failures.join('; ')}`);
  }
};

const withDirectoryScopedRevertLock = async (directory, task, signal) => {
  const key = path.resolve(directory);
  const previous = scopedRevertLocks.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const chained = previous.catch(() => {}).then(() => current);
  scopedRevertLocks.set(key, chained);

  try {
    await abortable(previous.catch(() => {}), signal);
    return await task();
  } finally {
    release();
    void chained.finally(() => {
      if (scopedRevertLocks.get(key) === chained) {
        scopedRevertLocks.delete(key);
      }
    });
  }
};

const isScopedRevertInterruption = (error) => (
  error?.code === 'SCOPED_REVERT_TIMEOUT' || error?.code === 'SCOPED_REVERT_CANCELLED'
);

const restoreAfterInterruption = async (prepared, options, { timeoutMs, diagnostics, upstreamOperation }) => {
  // Cleanup must not inherit the primary request signal: both the deadline and
  // an HTTP disconnect abort that signal before rollback begins. The upstream
  // operation gets an independent bounded settlement window so the directory
  // lock stays authoritative for abort-insensitive handlers. If it remains
  // stalled, abort its transport before the final restoration pass.
  const cleanupTimeoutMs = Math.min(SCOPED_REVERT_CLEANUP_TIMEOUT_MS, Math.max(timeoutMs, 250));
  const cleanupContext = createAbortContext({ timeoutMs: cleanupTimeoutMs });
  try {
    await restoreProtectedSnapshots(prepared, {
      ...options,
      signal: cleanupContext.signal,
      diagnostics,
    });
    const finalRestoreReserveMs = Math.min(1_000, Math.max(100, Math.floor(cleanupTimeoutMs / 4)));
    const settlementWaitMs = Math.max(0, cleanupTimeoutMs - finalRestoreReserveMs);
    let settlementTimer;
    const upstreamSettled = await Promise.race([
      upstreamOperation.promise.then(() => true, () => true),
      new Promise((resolve) => {
        settlementTimer = setTimeout(() => resolve(false), settlementWaitMs);
        settlementTimer.unref?.();
      }),
    ]);
    if (settlementTimer) clearTimeout(settlementTimer);
    if (!upstreamSettled) {
      upstreamOperation.abort(new ScopedRevertTimeoutError());
    }
    await restoreProtectedSnapshots(prepared, {
      ...options,
      signal: cleanupContext.signal,
      diagnostics,
    });
  } finally {
    cleanupContext.dispose();
  }
};

const attemptInterruptionCleanup = async (prepared, options, context) => {
  try {
    await restoreAfterInterruption(prepared, options, context);
  } catch (error) {
    console.error('[scoped-revert] Interrupted revert cleanup failed:', error);
    throw new ScopedRevertRollbackError(error);
  }
};

// ---------------------------------------------------------------------------
// Captured-vs-current guard and post-restore verification
// ---------------------------------------------------------------------------

const assertSnapshotsUnchanged = async (snapshots, signal) => {
  const changed = [];
  await mapWithConcurrency(
    snapshots,
    SNAPSHOT_CONCURRENCY,
    async ([file, snapshot]) => {
      if (!(await snapshotMatchesCurrentFile(snapshot, signal))) changed.push(file);
    },
    signal,
  );
  if (changed.length > 0) {
    changed.sort();
    throw new ScopedRevertConflictError(
      'working_tree_changed',
      `The working tree changed while the revert was being prepared: ${changed.join(', ')}`,
      { files: changed },
    );
  }
};

const verifyRestoredSnapshots = async ({ snapshots, desiredTargetSnapshots }, signal) => {
  const files = [];
  await mapWithConcurrency(
    snapshots,
    SNAPSHOT_CONCURRENCY,
    async ([file, snapshot]) => {
      const expected = desiredTargetSnapshots.get(file) ?? snapshot;
      if (!(await snapshotMatchesCurrentFile(expected, signal))) files.push(file);
    },
    signal,
  );
  files.sort();
  if (files.length > 0) {
    console.warn('[scoped-revert] Post-restore verification found unexpected file contents', { files });
  }
  return { ok: files.length === 0, files };
};

const snapshotsEqual = (a, b) => a.exists === b.exists && (!a.exists || a.content.equals(b.content));

const describeChangedFiles = ({ snapshots, desiredTargetSnapshots }) => {
  const files = [];
  for (const [file, desired] of desiredTargetSnapshots) {
    const original = snapshots.get(file);
    if (!original || snapshotsEqual(original, desired)) continue;
    const status = !desired.exists ? 'deleted' : (!original.exists ? 'recreated' : 'restored');
    files.push({ path: file, status });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
};

// ---------------------------------------------------------------------------
// Redo journal: <dataDir>/revert-journal/<sha1(directory)>/<rootSessionID>.json
// ---------------------------------------------------------------------------

const hashBytes = (buffer) => crypto.createHash('sha1').update(buffer).digest('hex');

const resolveOpenChamberDataDir = (explicit) => {
  if (typeof explicit === 'string' && explicit.trim().length > 0) return path.resolve(explicit);
  if (process.env.OPENCHAMBER_DATA_DIR) return path.resolve(process.env.OPENCHAMBER_DATA_DIR);
  return path.join(os.homedir(), '.config', 'openchamber');
};

export const resolveRevertJournalPath = ({ openchamberDataDir, directory, rootSessionID }) => path.join(
  resolveOpenChamberDataDir(openchamberDataDir),
  'revert-journal',
  hashBytes(Buffer.from(path.resolve(directory), 'utf8')),
  `${String(rootSessionID).replace(/[^A-Za-z0-9._-]/g, '_')}.json`,
);

const journalContent = (snapshot) => (snapshot?.exists
  ? { hash: hashBytes(snapshot.content), content: snapshot.content.toString('base64') }
  : { hash: null, content: null });

const isJournalFile = (entry) => isObject(entry)
  && typeof entry.path === 'string'
  && (entry.beforeHash === null || typeof entry.beforeHash === 'string')
  && (entry.afterHash === null || typeof entry.afterHash === 'string')
  && (entry.before === null || typeof entry.before === 'string')
  && (entry.after === null || typeof entry.after === 'string');

const readRevertJournal = async (journalPath) => {
  let raw;
  try {
    raw = await fs.readFile(journalPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isObject(parsed) || !Array.isArray(parsed.files) || !Array.isArray(parsed.sessions)) return null;
    if (!parsed.files.every(isJournalFile)) return null;
    return {
      ...parsed,
      sessions: parsed.sessions.filter((entry) => isObject(entry) && typeof entry.id === 'string' && entry.id.length > 0),
    };
  } catch {
    return null;
  }
};

const mergeRevertJournal = (existing, next) => {
  if (!existing) return next;
  const files = new Map(existing.files.map((file) => [file.path, file]));
  for (const file of next.files) {
    const previous = files.get(file.path);
    // A file already journaled keeps its earliest "before"; only the redo
    // target ("after") moves with the newest revert.
    files.set(file.path, previous
      ? { ...previous, afterHash: file.afterHash, after: file.after }
      : file);
  }
  const sessions = new Map(existing.sessions.map((session) => [session.id, session]));
  for (const session of next.sessions) sessions.set(session.id, session);
  return {
    ...next,
    createdAt: existing.createdAt ?? next.createdAt,
    updatedAt: next.createdAt,
    sessions: Array.from(sessions.values()),
    files: Array.from(files.values()),
  };
};

const recordRevertJournal = async ({ openchamberDataDir, directory, rootSessionID, steps, prepared, changedFiles }) => {
  const journalPath = resolveRevertJournalPath({ openchamberDataDir, directory, rootSessionID });
  const next = {
    createdAt: new Date().toISOString(),
    directory: path.resolve(directory),
    rootSessionID,
    sessions: steps.map((step) => ({ id: step.sessionID, targetMessageID: step.messageID })),
    files: changedFiles.map(({ path: file }) => {
      const before = journalContent(prepared.snapshots.get(file));
      const after = journalContent(prepared.desiredTargetSnapshots.get(file));
      return { path: file, beforeHash: before.hash, afterHash: after.hash, before: before.content, after: after.content };
    }),
  };
  const merged = mergeRevertJournal(await readRevertJournal(journalPath), next);
  const serialized = JSON.stringify(merged);
  if (Buffer.byteLength(serialized, 'utf8') > REVERT_JOURNAL_MAX_BYTES) {
    // Too large to keep. A stale journal must not offer a redo that no longer
    // matches the worktree, so drop it.
    await fs.rm(journalPath, { force: true });
    return { redoAvailable: false, journalPath };
  }
  await fs.mkdir(path.dirname(journalPath), { recursive: true });
  const tempPath = `${journalPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, serialized, 'utf8');
  await fs.rename(tempPath, journalPath);
  return { redoAvailable: true, journalPath };
};

const journalFileToSnapshot = (directory, entry, side) => {
  const { absolute, relative } = ensureInsideDirectory(directory, entry.path);
  const content = entry[side];
  return content === null
    ? { path: relative, absolute, exists: false, content: Buffer.alloc(0) }
    : { path: relative, absolute, exists: true, content: Buffer.from(content, 'base64') };
};

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

const createClient = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, fetchImpl }) => ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders: typeof getOpenCodeAuthHeaders === 'function' ? getOpenCodeAuthHeaders : () => ({}),
  fetchImpl: typeof fetchImpl === 'function' ? fetchImpl : fetch,
});

const normalizeScope = (scope) => {
  if (scope === undefined || scope === null || scope === '') return 'tree';
  if (!REVERT_SCOPES.has(scope)) {
    throw new Error(`Unsupported revert scope: ${String(scope)}`);
  }
  return scope;
};

// Descendants first (deepest first), the root last so its native response is
// the Session the caller sees.
const orderRevertSteps = (entries) => [...entries]
  .sort((a, b) => b.depth - a.depth || String(a.sessionID).localeCompare(String(b.sessionID)))
  .map((entry) => ({ sessionID: entry.sessionID, messageID: entry.targetMessageID }));

const toSessionSummary = (steps) => steps.map((step) => ({ id: step.sessionID, targetMessageID: step.messageID }));

/**
 * Reverts a prompt's session tree back to `messageID` (root) and, for every
 * descendant, to its first message created at or after that root message.
 * One protected snapshot/restore brackets all native reverts under the
 * directory lock. Returns `{ ...session, session, reverted: { files, sessions },
 * verification, redoAvailable }`.
 */
export const runScopedSessionRevert = async ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchImpl,
  directory,
  sessionID,
  messageID,
  scope,
  openCodeSnapshotRoot,
  openchamberDataDir,
  timeoutMs = SCOPED_REVERT_TIMEOUT_MS,
  slowOperationMs = SCOPED_REVERT_SLOW_OPERATION_MS,
  signal: parentSignal,
  onBeforeUpstreamRevert,
}) => {
  const revertScope = normalizeScope(scope);
  const client = createClient({ buildOpenCodeUrl, getOpenCodeAuthHeaders, fetchImpl });
  const abortContext = createAbortContext({ timeoutMs, signal: parentSignal });
  const signal = abortContext.signal;
  const diagnostics = createSlowOperationDiagnostics(slowOperationMs);

  try {
    const sessions = await diagnostics.runPhase('list-tree', () => abortable(listSessionTree({
      ...client,
      sessionID,
      directory,
      signal,
      maxDepth: revertScope === 'session' ? 0 : undefined,
    }), signal));
    const treeSessionIDs = new Set(sessions.map((session) => session.id));
    await diagnostics.runPhase('busy-guard', () => assertSessionsIdle({ client, directory, treeSessionIDs, signal }));

    return await withDirectoryScopedRevertLock(directory, async () => {
      const recordsBySession = await diagnostics.runPhase('load-session', () => fetchTreeMessages({
        client,
        directory,
        sessions,
        signal,
      }));
      const plan = collectTreeRevertPlan({ sessions, recordsBySession, targetMessageID: messageID });
      await diagnostics.runPhase('read-target-snapshots', () => attachSnapshotOps({
        plan,
        directory,
        snapshotRoot: openCodeSnapshotRoot,
        signal,
      }));
      const mergedOps = mergeTreeOps(planOps(plan), directory);
      const snapshotProtectionPaths = await diagnostics.runPhase('inspect-protection', () => collectTreeSnapshotProtectionPaths({
        directory,
        plan,
        snapshotRoot: openCodeSnapshotRoot,
        signal,
      }));
      const prepared = await diagnostics.runPhase('snapshot-files', () => prepareScopedRevert(
        directory,
        mergedOps,
        snapshotProtectionPaths,
        { signal, diagnostics },
      ));
      if (typeof onBeforeUpstreamRevert === 'function') {
        await onBeforeUpstreamRevert({ prepared, plan });
      }
      // Anything that changed a protected file since it was captured would be
      // silently overwritten by the restore pass, so refuse instead.
      await diagnostics.runPhase('verify-unchanged', () => assertSnapshotsUnchanged(prepared.snapshots, signal));

      const steps = orderRevertSteps(plan.entries);
      const upstreamOperation = startUpstreamSequence({ client, directory, steps, kind: 'revert' });
      let revertedSession;
      try {
        revertedSession = await diagnostics.runPhase('upstream-revert', () => abortable(upstreamOperation.promise, signal));
      } catch (error) {
        if (isScopedRevertInterruption(error)) {
          await diagnostics.runPhase('restore-original', () => attemptInterruptionCleanup(
            prepared,
            { restoreOriginal: true },
            { timeoutMs, diagnostics, upstreamOperation },
          ));
        } else {
          await diagnostics.runPhase('rollback-upstream', () => rollbackUpstreamReverts({
            client,
            directory,
            steps: upstreamOperation.completed(),
            signal,
          }));
          await diagnostics.runPhase('restore-original', () => restoreProtectedSnapshots(prepared, {
            restoreOriginal: true,
            signal,
            diagnostics,
          }));
        }
        throw error;
      }

      try {
        await diagnostics.runPhase('restore-files', () => restoreProtectedSnapshots(prepared, { signal, diagnostics }));
      } catch (error) {
        if (isScopedRevertInterruption(error)) {
          await diagnostics.runPhase('restore-files-cleanup', () => attemptInterruptionCleanup(
            prepared,
            {},
            { timeoutMs, diagnostics, upstreamOperation },
          ));
        }
        throw error;
      }

      const verification = await diagnostics.runPhase('verify-files', () => verifyRestoredSnapshots(prepared, signal));
      const changedFiles = describeChangedFiles(prepared);
      let redoAvailable = false;
      try {
        ({ redoAvailable } = await diagnostics.runPhase('journal', () => recordRevertJournal({
          openchamberDataDir,
          directory,
          rootSessionID: plan.rootSessionID,
          steps,
          prepared,
          changedFiles,
        })));
      } catch (error) {
        console.warn('[scoped-revert] Could not record the redo journal:', error);
      }

      const session = isObject(revertedSession) ? revertedSession : { id: sessionID };
      return {
        ...session,
        session,
        reverted: { files: changedFiles, sessions: toSessionSummary(steps) },
        verification,
        redoAvailable,
      };
    }, signal);
  } finally {
    abortContext.dispose();
    diagnostics.dispose();
  }
};

/**
 * Redoes the most recent scoped revert(s) recorded for a root session: puts the
 * journaled files back to their pre-revert bytes and clears the native revert
 * markers of every journaled session. Returns
 * `{ ...session, session, restored: [{ path, status }], sessions, verification }`.
 */
export const runScopedSessionUnrevert = async ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchImpl,
  directory,
  sessionID,
  openCodeSnapshotRoot,
  openchamberDataDir,
  timeoutMs = SCOPED_REVERT_TIMEOUT_MS,
  slowOperationMs = SCOPED_REVERT_SLOW_OPERATION_MS,
  signal: parentSignal,
}) => {
  const client = createClient({ buildOpenCodeUrl, getOpenCodeAuthHeaders, fetchImpl });
  const abortContext = createAbortContext({ timeoutMs, signal: parentSignal });
  const signal = abortContext.signal;
  const diagnostics = createSlowOperationDiagnostics(slowOperationMs);
  const journalPath = resolveRevertJournalPath({ openchamberDataDir, directory, rootSessionID: sessionID });
  const redoUnavailable = () => new ScopedRevertConflictError(
    'redo_unavailable',
    'There is no scoped revert to redo for this session',
  );

  try {
    const preview = await readRevertJournal(journalPath);
    if (!preview) throw redoUnavailable();
    const journalSessionIDs = new Set([sessionID, ...preview.sessions.map((session) => session.id)]);
    await diagnostics.runPhase('busy-guard', () => assertSessionsIdle({
      client,
      directory,
      treeSessionIDs: journalSessionIDs,
      signal,
    }));

    return await withDirectoryScopedRevertLock(directory, async () => {
      const journal = await readRevertJournal(journalPath);
      if (!journal) throw redoUnavailable();

      const targets = new Map();
      const changed = [];
      for (const entry of journal.files) {
        const snapshot = await readSnapshot(directory, entry.path, signal);
        const hash = snapshot.exists ? hashBytes(snapshot.content) : null;
        if (hash !== entry.afterHash) changed.push(snapshot.path);
        targets.set(snapshot.path, entry);
      }
      if (changed.length > 0) {
        changed.sort();
        throw new ScopedRevertConflictError(
          'working_tree_changed',
          `The working tree changed since the revert; redo would overwrite: ${changed.join(', ')}`,
          { files: changed },
        );
      }

      // Descendants first, the root last (its native response is returned).
      const journaledSessions = [
        ...journal.sessions.filter((session) => session.id !== sessionID),
        ...journal.sessions.filter((session) => session.id === sessionID),
      ];
      if (!journaledSessions.some((session) => session.id === sessionID)) {
        journaledSessions.push({ id: sessionID });
      }
      const steps = [];
      const snapshotHashes = new Set();
      let projectID = '';
      for (const entry of journaledSessions) {
        let session = null;
        try {
          session = await fetchSession({ ...client, directory, sessionID: entry.id, signal });
        } catch (error) {
          if (signal.aborted) throwIfAborted(signal);
          if (error?.upstreamStatus !== 404) throw error;
        }
        if (!session && entry.id !== sessionID) continue;
        const revertSnapshot = session?.revert?.snapshot;
        if (typeof revertSnapshot === 'string' && revertSnapshot.length > 0) snapshotHashes.add(revertSnapshot);
        if (!projectID && typeof session?.projectID === 'string') projectID = session.projectID;
        steps.push({ sessionID: entry.id, optional: entry.id !== sessionID });
      }

      // The native unrevert restores the whole worktree snapshot taken at
      // revert time, so every protected file is captured first and written
      // back afterwards; only journaled files receive their "before" bytes.
      const snapshotProtectionPaths = await diagnostics.runPhase('inspect-protection', () => collectSnapshotTreeProtectionPaths({
        directory,
        projectID,
        snapshotHashes,
        snapshotRoot: openCodeSnapshotRoot,
        signal,
      }));
      const targetFiles = new Set(targets.keys());
      const snapshots = await diagnostics.runPhase('snapshot-files', () => captureProtectedSnapshots(directory, {
        targetFiles,
        snapshotProtectionPaths,
        signal,
        diagnostics,
      }));
      const desiredTargetSnapshots = new Map();
      for (const [file, entry] of targets) {
        desiredTargetSnapshots.set(file, journalFileToSnapshot(directory, entry, 'before'));
      }
      const prepared = { snapshots, desiredTargetSnapshots, targetFiles };

      const upstreamOperation = startUpstreamSequence({ client, directory, steps, kind: 'unrevert' });
      let restoredSession;
      try {
        restoredSession = await diagnostics.runPhase('upstream-unrevert', () => abortable(upstreamOperation.promise, signal));
      } catch (error) {
        if (isScopedRevertInterruption(error)) {
          await diagnostics.runPhase('restore-original', () => attemptInterruptionCleanup(
            prepared,
            { restoreOriginal: true },
            { timeoutMs, diagnostics, upstreamOperation },
          ));
        } else {
          await diagnostics.runPhase('restore-original', () => restoreProtectedSnapshots(prepared, {
            restoreOriginal: true,
            signal,
            diagnostics,
          }));
        }
        throw error;
      }

      try {
        await diagnostics.runPhase('restore-files', () => restoreProtectedSnapshots(prepared, { signal, diagnostics }));
      } catch (error) {
        if (isScopedRevertInterruption(error)) {
          await diagnostics.runPhase('restore-files-cleanup', () => attemptInterruptionCleanup(
            prepared,
            {},
            { timeoutMs, diagnostics, upstreamOperation },
          ));
        }
        throw error;
      }

      const verification = await diagnostics.runPhase('verify-files', () => verifyRestoredSnapshots(prepared, signal));
      const restoredFiles = describeChangedFiles(prepared);
      await fs.rm(journalPath, { force: true });

      const session = isObject(restoredSession) ? restoredSession : { id: sessionID };
      return {
        ...session,
        session,
        restored: restoredFiles,
        sessions: steps.map((step) => ({ id: step.sessionID })),
        verification,
      };
    }, signal);
  } finally {
    abortContext.dispose();
    diagnostics.dispose();
  }
};

// ---------------------------------------------------------------------------
// Change summary (read-only)
// ---------------------------------------------------------------------------

/** Legacy hosts without capture support must not attribute worktree snapshots
 * to a session. The managed hosts mount SessionChangeHost before this route. */
export const computeScopedSessionChanges = async ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, fetchImpl, directory, sessionID, signal }) => {
  const client = createClient({ buildOpenCodeUrl, getOpenCodeAuthHeaders, fetchImpl });
  const sessions = await listSessionTree({ ...client, sessionID, directory, signal });
  return { files: [], sessionCount: sessions.length, sessions: [],
    rootSessionID: sessionID, firstUserMessageID: null, hasUnattributedMutations: false,
    coverage: 'partial', reasons: ['historical_capture_unavailable'] };
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

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
  if (error instanceof ScopedRevertConflictError) {
    const payload = { error: error.message, code: error.code };
    if (Array.isArray(error.files)) payload.files = error.files;
    if (typeof error.file === 'string') payload.file = error.file;
    if (Array.isArray(error.sessions)) payload.sessions = error.sessions;
    return res.status(409).json(payload);
  }
  return res.status(409).json({ error: error?.message || fallbackMessage });
};

export const registerScopedSessionRevertRoute = (app, deps) => {
  const runnerOptions = () => ({
    buildOpenCodeUrl: deps.buildOpenCodeUrl,
    getOpenCodeAuthHeaders: deps.getOpenCodeAuthHeaders,
    fetchImpl: deps.fetchImpl,
    openCodeSnapshotRoot: deps.openCodeSnapshotRoot,
    openchamberDataDir: deps.openchamberDataDir,
    timeoutMs: deps.scopedRevertTimeoutMs,
    slowOperationMs: deps.scopedRevertSlowOperationMs,
  });

  // Keep JSON parsing route-local because /api/openchamber/* is intentionally
  // registered before the generic /api proxy and is not covered by common API
  // middleware in all runtimes/test harnesses.
  app.post('/api/openchamber/session/:sessionID/scoped-revert', parseScopedRevertJson, async (req, res) => {
    const requestAbort = bindScopedRevertRequestAbort(req, res);

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

      const result = await runScopedSessionRevert({
        ...runnerOptions(),
        directory,
        sessionID,
        messageID,
        scope,
        signal: requestAbort.signal,
      });
      return res.json(result);
    } catch (error) {
      console.error('[scoped-revert] Failed to revert session safely:', error);
      return sendScopedRevertError(res, error, 'Failed to revert session safely');
    } finally {
      requestAbort.dispose();
    }
  });

  app.post('/api/openchamber/session/:sessionID/scoped-unrevert', parseScopedRevertJson, async (req, res) => {
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

      const result = await runScopedSessionUnrevert({
        ...runnerOptions(),
        directory,
        sessionID,
        signal: requestAbort.signal,
      });
      return res.json(result);
    } catch (error) {
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
