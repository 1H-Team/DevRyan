import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_TRACKED_ROOTS = 256;
const MAX_TRACKED_FILES = 256;
const MAX_FINGERPRINT_BYTES = 8 * 1024 * 1024;
const FILE_WRITES = new Set(['write', 'edit', 'multiedit', 'patch', 'apply_patch']);

const targetPaths = (tool, args) => {
  const direct = args?.filePath ?? args?.file_path ?? args?.path;
  if (typeof direct === 'string' && direct.trim()) return [direct.trim()];
  if (tool !== 'patch' && tool !== 'apply_patch') return [];
  const patch = args?.patchText ?? args?.patch ?? args?.input;
  if (typeof patch !== 'string') return [];
  return [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((match) => match[1].trim());
};

const fingerprint = async (directory, target) => {
  const absolute = path.resolve(directory, target);
  let real;
  let before;
  try {
    real = await fs.realpath(absolute);
    before = await fs.stat(real, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { path: absolute, missing: true, hash: null };
    return { path: absolute, missing: false, hash: null };
  }
  if (!before.isFile() || before.size > BigInt(MAX_FINGERPRINT_BYTES)) return { path: real, missing: false, hash: null };
  try {
    const content = await fs.readFile(real);
    const after = await fs.stat(real, { bigint: true });
    const stable = before.dev === after.dev && before.ino === after.ino && before.size === after.size
      && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
    return { path: real, missing: false, hash: stable ? crypto.createHash('sha256').update(content).digest('hex') : null };
  } catch { return { path: real, missing: false, hash: null }; }
};

// Complements native read/edit freshness checks. It does not claim to be a
// filesystem transaction or to infer arbitrary shell write targets. No content
// is retained, and eviction/restart makes an existing target unknown, not fresh.
export const createParentReadFreshness = () => {
  const roots = new Map();
  const rootState = (rootSessionId, directory) => {
    let state = roots.get(rootSessionId);
    if (!state || state.directory !== directory) state = { directory, files: new Map(), reads: new Map() };
    roots.delete(rootSessionId);
    roots.set(rootSessionId, state);
    while (roots.size > MAX_TRACKED_ROOTS) roots.delete(roots.keys().next().value);
    return state;
  };
  return {
    async beginRead({ rootSessionId, directory, tool, args, callId, barrierClear }) {
      if (tool !== 'read' || typeof callId !== 'string') return;
      const state = rootState(rootSessionId, directory);
      const identities = new Map();
      for (const target of targetPaths(tool, args)) {
        const value = await fingerprint(directory, target);
        identities.set(target, value);
      }
      state.reads.set(callId, { barrierClear, identities });
      while (state.reads.size > MAX_TRACKED_FILES) state.reads.delete(state.reads.keys().next().value);
    },
    async observeRead({ rootSessionId, directory, tool, args, callId, barrierClear }) {
      if (tool !== 'read') return;
      const state = rootState(rootSessionId, directory);
      const receipt = state.reads.get(callId);
      state.reads.delete(callId);
      for (const target of targetPaths(tool, args)) {
        const value = await fingerprint(directory, target);
        const before = receipt?.identities.get(target);
        const stable = receipt?.barrierClear && before?.path === value.path && before?.hash === value.hash;
        state.files.delete(value.path);
        state.files.set(value.path, stable && barrierClear && !value.missing ? value.hash : null);
        while (state.files.size > MAX_TRACKED_FILES) state.files.delete(state.files.keys().next().value);
      }
    },
    async assertWrite({ rootSessionId, directory, tool, args }) {
      if (!FILE_WRITES.has(tool)) return;
      const targets = targetPaths(tool, args);
      const state = rootState(rootSessionId, directory);
      let reason = targets.length ? null : 'target_unresolved';
      for (const target of targets) {
        const current = await fingerprint(directory, target);
        if (current.missing && (tool === 'write' || tool === 'patch' || tool === 'apply_patch')) continue;
        if (!current.hash || state.files.get(current.path) !== current.hash) reason = 'read_refresh_required';
      }
      if (reason) {
        const error = new Error('Managed work changed or may have changed this target. Read the current target after the dispatch barrier clears, then rebuild the mutation; do not replay it unchanged.');
        error.code = 'managed_read_refresh_required';
        error.statusCode = 409;
        error.reason = reason;
        throw error;
      }
    },
    invalidate(rootSessionId) { roots.delete(rootSessionId); },
  };
};
