// Native launch observation. Legacy database discovery below is read-only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getOpenChamberDataDir } from './managed-process-registry.js';
import { resolveOpenCodeDbPath } from './opencode-db-path.js';

export const OPENCODE_RUNTIME_SELECTION_FILE = 'opencode-runtime-selection.json';
export const OPENCODE_RUNTIME_SELECTION_VERSION = 1;
export const OPENCODE_RUNTIME_GENERATIONS = Object.freeze([2]);
export const OPENCODE_RUNTIME_KINDS = Object.freeze(['host']);
export const OPENCODE_RUNTIME_CHANNELS = Object.freeze(['opencode']);
export const OPENCODE_DATABASE_SOURCES = Object.freeze(['OPENCODE_DB', 'channel']);

const nonEmptyString = (value) => (typeof value === 'string' && value.trim().length > 0 ? value : null);

const resolveDataDir = ({ dataDir, env = process.env } = {}) => (
  nonEmptyString(dataDir) ? path.resolve(dataDir) : getOpenChamberDataDir(env)
);

export const getOpenCodeRuntimeSelectionPath = (options = {}) => (
  path.join(resolveDataDir(options), OPENCODE_RUNTIME_SELECTION_FILE)
);

/** OpenCode's data directory for `env` (mirrors `git/service.js` `getOpenCodeDataPath`). */
export const resolveOpenCodeDataDirectory = (env = process.env, { homeDirectory = os.homedir() } = {}) => {
  const xdgDataHome = nonEmptyString(env?.XDG_DATA_HOME) || path.join(homeDirectory, '.local', 'share');
  return path.join(xdgDataHome, 'opencode');
};

/** A validated copy of `raw`, or null when it is not a version-1 selection. */
export const normalizeOpenCodeRuntimeSelection = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.version !== OPENCODE_RUNTIME_SELECTION_VERSION) return null;
  const { runtime, opencode } = raw;
  if (!runtime || typeof runtime !== 'object' || !opencode || typeof opencode !== 'object') return null;
  if (!OPENCODE_RUNTIME_GENERATIONS.includes(runtime.generation)) return null;
  if (!OPENCODE_RUNTIME_KINDS.includes(runtime.kind)) return null;
  if (!OPENCODE_RUNTIME_CHANNELS.includes(runtime.channel)) return null;
  const binary = nonEmptyString(runtime.binary);
  const dataDirectory = nonEmptyString(opencode.dataDirectory);
  const databasePath = nonEmptyString(opencode.databasePath);
  if (!binary || !dataDirectory || !databasePath) return null;
  if (!path.isAbsolute(dataDirectory) || !path.isAbsolute(databasePath)) return null;
  if (!OPENCODE_DATABASE_SOURCES.includes(opencode.databaseSource)) return null;
  const configDirectory = opencode.configDirectory === null || opencode.configDirectory === undefined
    ? null
    : nonEmptyString(opencode.configDirectory);
  if (opencode.configDirectory !== null && opencode.configDirectory !== undefined && configDirectory === null) return null;
  const writtenAt = Number(raw.writtenAt);
  const ownerPid = Number(raw.ownerPid);
  return {
    version: OPENCODE_RUNTIME_SELECTION_VERSION,
    writtenAt: Number.isFinite(writtenAt) ? Math.trunc(writtenAt) : 0,
    ownerPid: Number.isFinite(ownerPid) && ownerPid > 0 ? Math.trunc(ownerPid) : null,
    runtime: { generation: runtime.generation, kind: runtime.kind, binary, channel: runtime.channel },
    opencode: { dataDirectory, databasePath, configDirectory, databaseSource: opencode.databaseSource },
  };
};

/** Atomic write (temp file + rename), owner-only mode. Returns the manifest path. */
export const writeOpenCodeRuntimeSelection = (selection, options = {}) => {
  const normalized = normalizeOpenCodeRuntimeSelection(selection);
  if (!normalized) throw new TypeError('writeOpenCodeRuntimeSelection requires a valid runtime selection');
  const file = getOpenCodeRuntimeSelectionPath(options);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    // `mode` applies only on creation; a leftover temp file keeps its own.
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
  return file;
};

/** Removes the manifest (storage writers then refuse to mutate). Missing is fine. */
export const clearOpenCodeRuntimeSelection = (options = {}) => {
  fs.rmSync(getOpenCodeRuntimeSelectionPath(options), { force: true });
};

/**
 * Removes the manifest only when `ownerPid` (this server by default) wrote
 * it, so a record another live server owns is never deleted. Returns whether
 * a record was removed.
 */
export const forgetOwnOpenCodeRuntimeSelection = ({ ownerPid = process.pid, ...options } = {}) => {
  const selection = readOpenCodeRuntimeSelection(options);
  if (!selection || selection.ownerPid !== ownerPid) return false;
  clearOpenCodeRuntimeSelection(options);
  return true;
};

/** The recorded selection, or null when absent, malformed or of an unknown version. Never throws. */
export const readOpenCodeRuntimeSelection = (options = {}) => {
  try {
    return normalizeOpenCodeRuntimeSelection(JSON.parse(fs.readFileSync(getOpenCodeRuntimeSelectionPath(options), 'utf8')));
  } catch {
    return null;
  }
};

/**
 * The database storage code should act on. `selection` when a manifest
 * written by `ownerPid` (this server by default) exists; otherwise
 * `legacy-newest` (newest of the known files by mtime), which callers may use
 * for read-only inspection only. A record from another process describes a
 * runtime this server did not launch and is ignored.
 */
export const resolveOpenCodeDatabaseSelection = ({
  dataDir,
  env = process.env,
  opencodeDataPath,
  ownerPid = process.pid,
} = {}) => {
  const selection = readOpenCodeRuntimeSelection({ dataDir, env });
  if (selection && selection.ownerPid === ownerPid) {
    return { path: selection.opencode.databasePath, source: 'selection', selection };
  }
  const dataPath = nonEmptyString(opencodeDataPath) || resolveOpenCodeDataDirectory(env);
  return { path: resolveOpenCodeDbPath(dataPath), source: 'legacy-newest', selection: null };
};
