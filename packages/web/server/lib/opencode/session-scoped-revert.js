import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import express from 'express';

const execFileAsync = promisify(execFile);
const SESSION_MESSAGE_LIMIT = 1000;
const scopedRevertLocks = new Map();

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

const readSnapshot = async (directory, filePath) => {
  const { absolute, relative } = ensureInsideDirectory(directory, filePath);
  try {
    return {
      path: relative,
      absolute,
      exists: true,
      content: await fs.readFile(absolute),
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { path: relative, absolute, exists: false, content: Buffer.alloc(0) };
    }
    throw error;
  }
};

const writeSnapshot = async (snapshot) => {
  if (!snapshot.exists) {
    await fs.rm(snapshot.absolute, { recursive: true, force: true });
    return;
  }

  await fs.mkdir(path.dirname(snapshot.absolute), { recursive: true });
  await fs.writeFile(snapshot.absolute, snapshot.content);
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

const findSequence = (lines, sequence, preferredIndex) => {
  if (sequence.length === 0) {
    return Math.max(0, Math.min(preferredIndex, lines.length));
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
  return matches.reduce((best, candidate) => (
    Math.abs(candidate - preferredIndex) < Math.abs(best - preferredIndex) ? candidate : best
  ), matches[0]);
};

export const reverseApplyUnifiedPatch = (currentText, patch, filePath) => {
  const hunks = parseUnifiedPatch(patch).sort((a, b) => b.newStart - a.newStart);
  let lines = splitLines(currentText);
  const finalNewline = normalizeText(currentText).endsWith('\n');

  for (const hunk of hunks) {
    const target = hunkTargetLines(hunk);
    const replacement = hunkReplacementLines(hunk);
    const index = findSequence(lines, target, Math.max(0, hunk.newStart - 1));
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

  if (hunks.length === 0) {
    throw new Error(`Cannot safely revert ${filePath}; the session diff has no text patch`);
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

const collectGitStatusFiles = async (directory) => {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: directory,
      maxBuffer: 10 * 1024 * 1024,
    });
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
    const detail = error?.stderr || error?.message || String(error);
    throw new Error(`Scoped session revert requires a Git worktree so unrelated changes can be protected: ${detail}`);
  }
};

const fetchJson = async (url, options) => {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = isObject(payload) && typeof payload.error === 'string' ? payload.error : response.statusText;
    throw new Error(message || `Request failed with status ${response.status}`);
  }
  return payload;
};

const fetchSessionMessages = async ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, directory, sessionID }) => {
  const query = new URLSearchParams({ directory, limit: String(SESSION_MESSAGE_LIMIT) });
  return fetchJson(buildOpenCodeUrl(`/session/${encodeURIComponent(sessionID)}/message?${query}`, ''), {
    method: 'GET',
    headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
    signal: AbortSignal.timeout(15_000),
  });
};

const fetchSession = async ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, directory, sessionID }) => {
  const query = new URLSearchParams({ directory });
  return fetchJson(buildOpenCodeUrl(`/session/${encodeURIComponent(sessionID)}?${query}`, ''), {
    method: 'GET',
    headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
    signal: AbortSignal.timeout(15_000),
  });
};

const callUpstreamRevert = async ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, directory, sessionID, messageID }) => fetchJson(
  buildOpenCodeUrl(`/session/${encodeURIComponent(sessionID)}/revert?${encodeDirectoryQuery(directory)}`, ''),
  {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...getOpenCodeAuthHeaders(),
    },
    body: JSON.stringify({ messageID }),
    signal: AbortSignal.timeout(30_000),
  },
);

const sortMessageRecords = (records) => [...records].sort((a, b) => {
  const aInfo = a?.info ?? {};
  const bInfo = b?.info ?? {};
  const aTime = typeof aInfo.time?.created === 'number' ? aInfo.time.created : 0;
  const bTime = typeof bInfo.time?.created === 'number' ? bInfo.time.created : 0;
  if (aTime !== bTime) return aTime - bTime;
  return String(aInfo.id ?? '').localeCompare(String(bInfo.id ?? ''));
});

const collectRevertDiffs = (records, messageID, currentRevertMessageID) => {
  const ordered = sortMessageRecords(Array.isArray(records) ? records : []);
  const targetIndex = ordered.findIndex((record) => record?.info?.id === messageID);
  if (targetIndex < 0) {
    throw new Error('Target message was not found in the session');
  }

  let endIndex = ordered.length;
  if (typeof currentRevertMessageID === 'string' && currentRevertMessageID.length > 0) {
    const currentRevertIndex = ordered.findIndex((record) => record?.info?.id === currentRevertMessageID);
    if (currentRevertIndex < 0) {
      throw new Error('Current session revert boundary was not found in the session');
    }
    if (targetIndex <= currentRevertIndex) {
      // Messages at and after the current boundary are already absent from the
      // worktree. Moving farther back reverses only the newly hidden interval.
      endIndex = currentRevertIndex;
    }
  }

  const diffs = [];
  for (const record of ordered.slice(targetIndex, endIndex)) {
    const info = record?.info;
    if (info?.role !== 'user' || !Array.isArray(info.summary?.diffs)) continue;
    for (const diff of info.summary.diffs) {
      if (typeof diff?.file === 'string' && typeof diff.patch === 'string') {
        diffs.push(diff);
      }
    }
  }

  return diffs;
};

const collectPatchSnapshotTargets = (records, messageID) => {
  const ordered = sortMessageRecords(Array.isArray(records) ? records : []);
  const targetIndex = ordered.findIndex((record) => record?.info?.id === messageID);
  if (targetIndex < 0) {
    throw new Error('Target message was not found in the session');
  }

  const targets = [];
  const seen = new Set();
  for (const record of ordered.slice(targetIndex)) {
    for (const part of Array.isArray(record?.parts) ? record.parts : []) {
      if (part?.type !== 'patch' || typeof part.hash !== 'string' || !Array.isArray(part.files)) {
        continue;
      }
      for (const file of part.files) {
        if (typeof file !== 'string' || file.trim().length === 0) continue;
        const key = `${part.hash}\0${file}`;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push({ file, snapshot: part.hash });
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

const findSnapshotGitDir = async (snapshotRoot, projectID, snapshotHash) => {
  const projectSnapshotRoot = path.join(snapshotRoot, projectID);
  let entries;
  try {
    entries = await fs.readdir(projectSnapshotRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const gitDir = path.join(projectSnapshotRoot, entry.name);
    try {
      const { stdout } = await execFileAsync('git', ['--git-dir', gitDir, 'cat-file', '-t', snapshotHash], {
        maxBuffer: 64 * 1024,
      });
      const type = String(stdout).trim();
      if (type === 'tree' || type === 'commit') {
        return gitDir;
      }
    } catch {
      // Keep scanning; OpenCode can leave multiple snapshot repositories.
    }
  }

  return null;
};

const readSnapshotGitFile = async ({ snapshotRoot, projectID, snapshotHash, directory, file }) => {
  const { absolute, relative } = ensureInsideDirectory(directory, file);
  const gitDir = await findSnapshotGitDir(snapshotRoot, projectID, snapshotHash);
  if (!gitDir) {
    throw new Error(`Cannot safely revert ${relative}; OpenCode snapshot ${snapshotHash} was not found`);
  }

  try {
    const { stdout } = await execFileAsync('git', ['--git-dir', gitDir, 'show', `${snapshotHash}:${relative}`], {
      encoding: 'buffer',
      maxBuffer: 100 * 1024 * 1024,
    });
    return {
      path: relative,
      absolute,
      exists: true,
      content: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
    };
  } catch (error) {
    const message = String(error?.stderr || error?.message || '');
    if (message.includes('exists on disk, but not in') || message.includes('Path') || message.includes('does not exist')) {
      return { path: relative, absolute, exists: false, content: Buffer.alloc(0) };
    }
    throw error;
  }
};

const collectSnapshotTargetSnapshots = async ({
  directory,
  records,
  messageID,
  session,
  snapshotRoot = defaultOpenCodeSnapshotRoot(),
}) => {
  const projectID = typeof session?.projectID === 'string' ? session.projectID : '';
  if (!projectID) {
    return [];
  }

  const snapshotsByFile = new Map();
  for (const target of collectPatchSnapshotTargets(records, messageID)) {
    const { relative } = ensureInsideDirectory(directory, target.file);
    if (snapshotsByFile.has(relative)) continue;
    snapshotsByFile.set(
      relative,
      await readSnapshotGitFile({
        snapshotRoot,
        projectID,
        snapshotHash: target.snapshot,
        directory,
        file: target.file,
      }),
    );
  }

  return Array.from(snapshotsByFile.values());
};

const collectGitTrackedFiles = async (directory) => {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '-z'], {
      cwd: directory,
      maxBuffer: 10 * 1024 * 1024,
    });
    return new Set(stdout.split('\0').filter(Boolean).map(toPosixRelative));
  } catch (error) {
    const detail = error?.stderr || error?.message || String(error);
    throw new Error(`Cannot inspect tracked files before scoped session revert: ${detail}`);
  }
};

const listSnapshotTreeFiles = async ({ snapshotRoot, projectID, snapshotHash }) => {
  const gitDir = await findSnapshotGitDir(snapshotRoot, projectID, snapshotHash);
  if (!gitDir) {
    throw new Error(`Cannot safely inspect OpenCode snapshot ${snapshotHash}`);
  }

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['--git-dir', gitDir, 'ls-tree', '-r', '-z', '--name-only', snapshotHash],
      { maxBuffer: 100 * 1024 * 1024 },
    );
    return stdout.split('\0').filter(Boolean);
  } catch (error) {
    const detail = error?.stderr || error?.message || String(error);
    throw new Error(`Cannot safely inspect OpenCode snapshot ${snapshotHash}: ${detail}`);
  }
};

const collectSnapshotProtectionPaths = async ({
  directory,
  records,
  messageID,
  session,
  snapshotRoot = defaultOpenCodeSnapshotRoot(),
}) => {
  // Git status cannot represent an absent untracked path. OpenCode's broad
  // revert can still rehydrate that path from either the current unrevert
  // snapshot or the target turn's initial patch snapshot, so protect those
  // non-Git paths explicitly (including an "absent" snapshot tombstone).
  const snapshotHashes = new Set();
  const existingRevertSnapshot = session?.revert?.snapshot;
  if (typeof existingRevertSnapshot === 'string' && existingRevertSnapshot.length > 0) {
    snapshotHashes.add(existingRevertSnapshot);
  }

  const firstPatchSnapshot = collectPatchSnapshotTargets(records, messageID)[0]?.snapshot;
  if (firstPatchSnapshot) {
    snapshotHashes.add(firstPatchSnapshot);
  }
  if (snapshotHashes.size === 0) {
    return [];
  }

  const projectID = typeof session?.projectID === 'string' ? session.projectID : '';
  if (!projectID) {
    throw new Error('Cannot safely inspect OpenCode snapshots without a session project ID');
  }

  const trackedFiles = await collectGitTrackedFiles(directory);
  const protectedPaths = new Set();
  for (const snapshotHash of snapshotHashes) {
    const snapshotFiles = await listSnapshotTreeFiles({ snapshotRoot, projectID, snapshotHash });
    for (const file of snapshotFiles) {
      const { relative } = ensureInsideDirectory(directory, file);
      if (!trackedFiles.has(relative)) {
        protectedPaths.add(relative);
      }
    }
  }
  return Array.from(protectedPaths);
};

const prepareScopedRevert = async (
  directory,
  diffs,
  snapshotTargetSnapshots = [],
  snapshotProtectionPaths = [],
) => {
  const targetFiles = new Set();
  for (const diff of diffs) {
    targetFiles.add(ensureInsideDirectory(directory, diff.file).relative);
  }
  for (const snapshot of snapshotTargetSnapshots) {
    targetFiles.add(snapshot.path);
  }

  // Decision: use Git status as the protection boundary before calling OpenCode's
  // broad revert. Without a worktree status snapshot we cannot know which
  // unrelated files another chat changed, so the endpoint fails instead of
  // risking hidden data loss.
  const protectedFiles = new Set(await collectGitStatusFiles(directory));
  for (const file of snapshotProtectionPaths) {
    protectedFiles.add(ensureInsideDirectory(directory, file).relative);
  }
  for (const file of targetFiles) protectedFiles.add(file);

  const snapshots = new Map();
  for (const file of protectedFiles) {
    const snapshot = await readSnapshot(directory, file);
    snapshots.set(snapshot.path, snapshot);
  }

  const desiredTargetSnapshots = new Map();
  for (const file of targetFiles) {
    desiredTargetSnapshots.set(file, snapshots.get(file) ?? await readSnapshot(directory, file));
  }

  for (const diff of [...diffs].reverse()) {
    const { relative } = ensureInsideDirectory(directory, diff.file);
    desiredTargetSnapshots.set(relative, reverseApplyDiffToSnapshot(desiredTargetSnapshots.get(relative), diff));
  }
  for (const snapshot of snapshotTargetSnapshots) {
    desiredTargetSnapshots.set(snapshot.path, snapshot);
  }

  return { snapshots, desiredTargetSnapshots };
};

const restoreProtectedSnapshots = async ({ snapshots, desiredTargetSnapshots }, { restoreOriginal = false } = {}) => {
  const failures = [];
  for (const [file, snapshot] of snapshots) {
    const targetSnapshot = restoreOriginal ? snapshot : desiredTargetSnapshots.get(file);
    try {
      await writeSnapshot(targetSnapshot ?? snapshot);
    } catch (error) {
      failures.push(`${file}: ${error?.message || String(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Failed to restore protected files after session revert: ${failures.join('; ')}`);
  }
};

const withDirectoryScopedRevertLock = async (directory, task) => {
  const key = path.resolve(directory);
  const previous = scopedRevertLocks.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const chained = previous.catch(() => {}).then(() => current);
  scopedRevertLocks.set(key, chained);

  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (scopedRevertLocks.get(key) === chained) {
      scopedRevertLocks.delete(key);
    }
  }
};

export const runScopedSessionRevert = async ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  directory,
  sessionID,
  messageID,
  openCodeSnapshotRoot,
}) => {
  return withDirectoryScopedRevertLock(directory, async () => {
    const [records, sessionSnapshot] = await Promise.all([
      fetchSessionMessages({ buildOpenCodeUrl, getOpenCodeAuthHeaders, directory, sessionID }),
      fetchSession({ buildOpenCodeUrl, getOpenCodeAuthHeaders, directory, sessionID }).catch(() => null),
    ]);
    const currentRevertMessageID = typeof sessionSnapshot?.revert?.messageID === 'string'
      ? sessionSnapshot.revert.messageID
      : '';
    const diffs = collectRevertDiffs(records, messageID, currentRevertMessageID);
    const snapshotTargetSnapshots = diffs.length === 0
      ? await collectSnapshotTargetSnapshots({
        directory,
        records,
        messageID,
        session: sessionSnapshot,
        snapshotRoot: openCodeSnapshotRoot,
      })
      : [];
    const snapshotProtectionPaths = await collectSnapshotProtectionPaths({
      directory,
      records,
      messageID,
      session: sessionSnapshot,
      snapshotRoot: openCodeSnapshotRoot,
    });
    const prepared = await prepareScopedRevert(
      directory,
      diffs,
      snapshotTargetSnapshots,
      snapshotProtectionPaths,
    );
    let revertedSession;
    try {
      revertedSession = await callUpstreamRevert({ buildOpenCodeUrl, getOpenCodeAuthHeaders, directory, sessionID, messageID });
    } catch (error) {
      await restoreProtectedSnapshots(prepared, { restoreOriginal: true });
      throw error;
    }
    await restoreProtectedSnapshots(prepared);
    return revertedSession;
  });
};

export const registerScopedSessionRevertRoute = (app, deps) => {
  // Keep JSON parsing route-local because /api/openchamber/* is intentionally
  // registered before the generic /api proxy and is not covered by common API
  // middleware in all runtimes/test harnesses.
  app.post('/api/openchamber/session/:sessionID/scoped-revert', parseScopedRevertJson, async (req, res) => {
    try {
      const sessionID = req.params.sessionID;
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      const body = isObject(req.body) ? req.body : {};
      const messageID = typeof body.messageID === 'string' ? body.messageID : '';

      if (!sessionID) {
        return res.status(400).json({ error: 'sessionID parameter is required' });
      }
      if (!directory) {
        return res.status(400).json({ error: 'directory query parameter is required' });
      }
      if (!messageID) {
        return res.status(400).json({ error: 'messageID is required' });
      }

      const session = await runScopedSessionRevert({
        buildOpenCodeUrl: deps.buildOpenCodeUrl,
        getOpenCodeAuthHeaders: deps.getOpenCodeAuthHeaders,
        directory,
        sessionID,
        messageID,
        openCodeSnapshotRoot: deps.openCodeSnapshotRoot,
      });
      return res.json(session);
    } catch (error) {
      console.error('[scoped-revert] Failed to revert session safely:', error);
      return res.status(409).json({ error: error?.message || 'Failed to revert session safely' });
    }
  });
};
