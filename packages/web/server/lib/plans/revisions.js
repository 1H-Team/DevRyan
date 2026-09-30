import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import pathModule from 'node:path';
import { constants } from 'node:fs';
import { withCrossProcessFileLock } from '@openchamber/harness-runtime';
import { createProjectIdFromPath } from '../projects/project-id.js';
import { resolvePlanProjectStorageId } from '@openchamber/shared-runtime/lib/plan-storage-id.js';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

const normalizePath = (value) => {
  const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  return normalized || (String(value || '').trim().startsWith('/') ? '/' : '');
};

const sanitizePlanPathSegment = (value) => String(value || '')
  .trim()
  .replace(/[\\/]+/g, '-')
  .replace(/\.+/g, '-')
  .replace(/[^A-Za-z0-9_-]+/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-+|-+$/g, '');

export const planError = (statusCode, code, message = code) => Object.assign(new Error(message), { statusCode, code });
const routeError = (statusCode, message) => planError(statusCode, 'plan_identity_invalid', message);

export const resolveSessionPlanRevision = async ({
  dataDirectory,
  directory,
  sessionCreated,
  sessionSlug,
  sourceMessageID,
  path = pathModule,
}) => {
  const normalizedDataDirectory = normalizePath(dataDirectory);
  const normalizedDirectory = normalizePath(directory);
  const created = Number(sessionCreated);
  const slug = sanitizePlanPathSegment(sessionSlug);
  const sourceID = String(sourceMessageID || '').trim();

  if (!normalizedDataDirectory || !path.isAbsolute(normalizedDataDirectory)) {
    throw routeError(500, 'Plan storage is unavailable');
  }
  if (!normalizedDirectory || !path.isAbsolute(normalizedDirectory)) {
    throw routeError(400, 'Plan directory must be an absolute path');
  }
  if (!Number.isFinite(created) || created <= 0 || Math.trunc(created) !== created) {
    throw routeError(400, 'Plan session creation time is invalid');
  }
  if (!slug) {
    throw routeError(400, 'Plan session slug is invalid');
  }
  if (!SESSION_ID_PATTERN.test(sourceID)) {
    throw routeError(400, 'Plan source message ID is invalid');
  }

  const projectID = await resolvePlanProjectStorageId(sanitizePlanPathSegment(createProjectIdFromPath(normalizedDirectory)));
  if (!projectID) {
    throw routeError(400, 'Plan project identity is invalid');
  }

  const plansDirectory = path.join(normalizedDataDirectory, 'projects', projectID, 'plans');
  const fileName = `${Math.trunc(created)}-${slug}-${sourceID}.md`;
  return {
    dataDirectory: normalizedDataDirectory,
    directory: plansDirectory,
    path: path.join(plansDirectory, fileName),
  };
};


export const MAX_PLAN_BYTES = 256 * 1024;
const versionOf = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export const validatePlanText = (text) => {
  if (typeof text !== 'string' || !text.trim()) throw planError(400, 'plan_text_required', 'Plan Markdown must not be blank');
  if (Buffer.byteLength(text) > MAX_PLAN_BYTES) throw planError(413, 'plan_text_too_large', 'Plan Markdown exceeds 256 KiB');
};

const assertDirectory = async (revision, fsApi) => {
  const root = await fsApi.realpath(revision.dataDirectory);
  const directory = await fsApi.realpath(revision.directory);
  const relative = pathModule.relative(revision.dataDirectory, revision.directory);
  if (relative.startsWith('..') || pathModule.isAbsolute(relative)
    || directory !== pathModule.join(root, relative)) {
    throw planError(409, 'plan_path_unsafe', 'The canonical plan directory must not be a symlink');
  }
};

export const readPlanRevision = async (revision, { fsApi = fs } = {}) => {
  try {
    await assertDirectory(revision, fsApi);
    const stat = await fsApi.lstat(revision.path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw planError(409, 'plan_path_unsafe', 'The canonical plan path is not a regular file');
    const directory = await fsApi.realpath(revision.directory);
    if (await fsApi.realpath(revision.path) !== pathModule.join(directory, pathModule.basename(revision.path))) {
      throw planError(409, 'plan_path_unsafe', 'Plan revision escapes its project');
    }
    const handle = await fsApi.open(revision.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_PLAN_BYTES) throw planError(413, 'plan_text_too_large', 'Plan revision exceeds 256 KiB');
      const bytes = await handle.readFile();
      if (bytes.length > MAX_PLAN_BYTES) throw planError(413, 'plan_text_too_large');
      return { path: revision.path, content: bytes.toString('utf8'), version: versionOf(bytes) };
    } finally { await handle.close(); }
  } catch (error) {
    if (error?.code === 'ENOENT') throw planError(404, 'plan_revision_missing', 'Plan revision not found');
    throw error;
  }
};

// Both HTTP edits and root-agent updates share this lock and byte version.
export const writePlanRevision = async (revision, { text, expectedVersion, create = false,
  authorize = async () => {}, fsApi = fs } = {}) => {
  validatePlanText(text);
  if (!create && (typeof expectedVersion !== 'string' || !expectedVersion)) {
    throw planError(428, 'plan_version_required', 'Read the plan before updating it');
  }
  if (!create && !/^[a-f0-9]{64}$/.test(expectedVersion)) throw planError(400, 'plan_version_invalid');
  if (create) {
    let directory = revision.dataDirectory;
    for (const segment of pathModule.relative(directory, revision.directory).split(pathModule.sep)) {
      directory = pathModule.join(directory, segment);
      try { await fsApi.mkdir(directory); }
      catch (error) { if (error?.code !== 'EEXIST') throw error; }
      await assertDirectory({ ...revision, directory }, fsApi);
    }
  }
  try { await assertDirectory(revision, fsApi); }
  catch (error) {
    if (error?.code === 'ENOENT') throw planError(404, 'plan_revision_missing', 'Plan revision not found');
    throw error;
  }
  return withCrossProcessFileLock(`${revision.path}.lock`, async () => {
    await authorize();
    let current;
    try { current = await readPlanRevision(revision, { fsApi }); }
    catch (error) { if (!create || error?.code !== 'plan_revision_missing') throw error; }
    if (create && current) return { path: revision.path, created: false, version: current.version };
    if (!create && current.version !== expectedVersion) {
      throw Object.assign(planError(409, 'plan_version_conflict', 'The saved plan changed; reload before saving'), { version: current.version });
    }
    const version = versionOf(Buffer.from(text));
    const temporary = `${revision.path}.${crypto.randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fsApi.open(temporary, 'wx', 0o600);
      await handle.writeFile(text, 'utf8');
      await handle.sync();
      await handle.close(); handle = null;
      await assertDirectory(revision, fsApi);
      await authorize();
      await fsApi.rename(temporary, revision.path);
    } finally {
      await handle?.close().catch(() => {});
      await fsApi.unlink(temporary).catch(() => {});
    }
    return { path: revision.path, ...(create ? { created: true } : { saved: true }), version };
  }, { fs: fsApi });
};
