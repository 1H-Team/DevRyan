import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeNativeServerSource, patchNativeServerSource, prepareNativeContextModeHotfix } from './context-mode-native-hotfix.js';

export const CONTEXT_MODE_HOTFIX_VERSION = '1.0.169';
export const CONTEXT_MODE_HOTFIX_ORIGINAL_SHA256 =
  'e7162fe44bc899b6a8582864b47d3e00e5f84fa3098022226a5725b3822709ec';
export const CONTEXT_MODE_HOTFIX_INCOMPATIBLE = 'CONTEXT_MODE_HOTFIX_INCOMPATIBLE';

export const CONTEXT_MODE_CONTENT_STORE_RECOVERY_SOURCE = String.raw`const CONTEXT_MODE_IOERR_PATTERNS = [
  /\bSQLITE_IOERR\b/i,
  /\bdisk I\/O error\b/i,
];

const PASSTHROUGH_METHODS = new Set(['cleanup', 'close', 'setDenyChecker']);

const failureText = (error) => {
  if (error instanceof Error) return error.name + ': ' + error.message;
  return typeof error === 'string' ? error : '';
};

export const isRecoverableContextModeStoreError = (error) => (
  CONTEXT_MODE_IOERR_PATTERNS.some((pattern) => pattern.test(failureText(error)))
);

export const createRecoveringContentStore = ({ createStore, onRecovery = () => {} }) => {
  if (typeof createStore !== 'function') {
    throw new TypeError('createStore must be a function');
  }

  let currentStore = createStore();
  let generation = 0;
  let denyChecker;
  let closed = false;

  const replaceFailedGeneration = (failedStore, failedGeneration, error) => {
    if (closed) throw error;
    if (currentStore !== failedStore || generation !== failedGeneration) {
      return currentStore;
    }

    try {
      failedStore.close?.();
    } catch {
      // A poisoned handle may reject close; reopening the same DB is still safe.
    }

    const replacement = createStore();
    if (denyChecker !== undefined) replacement.setDenyChecker?.(denyChecker);
    currentStore = replacement;
    generation += 1;
    onRecovery({ generation, error });
    return replacement;
  };

  const invoke = (method, args, retryAllowed = true) => {
    const store = currentStore;
    const storeGeneration = generation;
    let result;
    try {
      result = Reflect.apply(store[method], store, args);
    } catch (error) {
      if (!retryAllowed || !isRecoverableContextModeStoreError(error)) throw error;
      const replacement = replaceFailedGeneration(store, storeGeneration, error);
      return Reflect.apply(replacement[method], replacement, args);
    }

    if (!result || typeof result.then !== 'function') return result;
    return result.catch((error) => {
      if (!retryAllowed || !isRecoverableContextModeStoreError(error)) throw error;
      const replacement = replaceFailedGeneration(store, storeGeneration, error);
      return Reflect.apply(replacement[method], replacement, args);
    });
  };

  return new Proxy({}, {
    get(_target, property) {
      if (property === 'setDenyChecker') {
        return (checker) => {
          denyChecker = checker;
          return currentStore.setDenyChecker?.(checker);
        };
      }
      if (property === 'close') {
        return (...args) => {
          closed = true;
          return Reflect.apply(currentStore[property], currentStore, args);
        };
      }
      if (property === 'cleanup') {
        return (...args) => Reflect.apply(currentStore[property], currentStore, args);
      }

      const value = currentStore[property];
      if (typeof value !== 'function') return value;
      return (...args) => invoke(property, args, !PASSTHROUGH_METHODS.has(property));
    },
  });
};
`;

const STORE_IMPORT_ORIGINAL =
  'import { ContentStore, cleanupStaleDBs, cleanupStaleContentDBs } from "./store.js";';
const STORE_IMPORT_PATCHED = [
  'import { ContentStore, cleanupStaleDBs } from "./store.js";',
  'import { createRecoveringContentStore } from "./devryan-content-store-recovery.js";',
].join('\n');
const STORE_CONSTRUCTION_ORIGINAL = '        _store = new ContentStore(dbPath);';
const STORE_CONSTRUCTION_PATCHED = [
  '        _store = createRecoveringContentStore({',
  '            createStore: () => new ContentStore(dbPath),',
  '        });',
].join('\n');
const STALE_FILE_CLEANUP_ORIGINAL = [
  '        // One-time startup cleanup: remove stale content DBs (>14 days)',
  '        try {',
  '            const contentDir = dirname(getStorePath());',
  '            cleanupStaleContentDBs(contentDir, 14);',
  '            _store.cleanupStaleSources(14);',
  '            // Also clean legacy shared dir from before platform isolation',
  '            const legacyDir = join(homedir(), ".context-mode", "content");',
  '            if (existsSync(legacyDir))',
  '                cleanupStaleContentDBs(legacyDir, 0);',
  '        }',
  '        catch { /* best-effort */ }',
].join('\n');
const STALE_FILE_CLEANUP_PATCHED = [
  '        // DevRyan hotfix: retain row cleanup, but never unlink content DB',
  '        // files after a live ContentStore handle has opened them.',
  '        try {',
  '            _store.cleanupStaleSources(14);',
  '        }',
  '        catch { /* best-effort */ }',
].join('\n');
const CTX_INDEX_PATH_POLICY_ORIGINAL = [
  '    if (path) {',
  '        const pathDenied = checkFilePathDenyPolicy(path, "ctx_index");',
  '        if (pathDenied)',
  '            return pathDenied;',
  '    }',
].join('\n');
const CTX_INDEX_PATH_POLICY_PATCHED = [
  '    if (path) {',
  '        // DevRyan hotfix: read-only indexing must stay inside the verified project boundary.',
  '        const boundaryDenied = checkProjectBoundary(path, "ctx_index");',
  '        if (boundaryDenied)',
  '            return boundaryDenied;',
  '        const pathDenied = checkFilePathDenyPolicy(path, "ctx_index");',
  '        if (pathDenied)',
  '            return pathDenied;',
  '    }',
].join('\n');

export const resolveContextModeCapability = ({
  isOpenCodeReady,
  isRestartingOpenCode,
  isExternalOpenCode,
  skipOpenCodeStart,
  configuredOpenCodeHost,
} = {}) => Boolean(
  isOpenCodeReady
  && !isRestartingOpenCode
  && !isExternalOpenCode
  && !skipOpenCodeStart
  && !configuredOpenCodeHost
);

// Compatibility alias for callers introduced when indexing was the only
// prompt-level Context Mode grant.
export const resolveContextModeReadOnlyIndexingCapability = resolveContextModeCapability;

const sha256 = (content) => crypto.createHash('sha256').update(content).digest('hex');

const replaceExactlyOnce = (source, original, replacement, label) => {
  const first = source.indexOf(original);
  if (first < 0 || source.indexOf(original, first + original.length) >= 0) {
    throw new Error(`Context-mode hotfix anchor mismatch: ${label}`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + original.length)}`;
};

export const transformContextModeServerSource = (source) => {
  let patched = replaceExactlyOnce(source, STORE_IMPORT_ORIGINAL, STORE_IMPORT_PATCHED, 'store import');
  patched = replaceExactlyOnce(
    patched,
    STORE_CONSTRUCTION_ORIGINAL,
    STORE_CONSTRUCTION_PATCHED,
    'store construction',
  );
  patched = replaceExactlyOnce(
    patched,
    STALE_FILE_CLEANUP_ORIGINAL,
    STALE_FILE_CLEANUP_PATCHED,
    'stale file cleanup',
  );
  return replaceExactlyOnce(
    patched,
    CTX_INDEX_PATH_POLICY_ORIGINAL,
    CTX_INDEX_PATH_POLICY_PATCHED,
    'ctx_index project boundary',
  );
};

const atomicWrite = ({ fsApi, filePath, content }) => {
  fsApi.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fsApi.writeFileSync(temporaryPath, content, 'utf8');
    fsApi.renameSync(temporaryPath, filePath);
  } finally {
    try {
      if (fsApi.existsSync(temporaryPath)) fsApi.unlinkSync(temporaryPath);
    } catch {
      // The target rename already completed or cleanup is best-effort.
    }
  }
};

const incompatible = (message, details = {}) => ({
  ok: false,
  changed: false,
  code: CONTEXT_MODE_HOTFIX_INCOMPATIBLE,
  error: message,
  ...details,
});

export const applyContextModeHotfix = ({
  configDirectory,
  fs: fsApi = fs,
  expectedOriginalSha256 = CONTEXT_MODE_HOTFIX_ORIGINAL_SHA256,
  expectedPluginSha256,
  expectedExecutorSha256,
  recoveryModuleSource,
} = {}) => {
  const packageRoot = path.join(configDirectory, 'node_modules', 'context-mode');
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const serverPath = path.join(packageRoot, 'build', 'server.js');
  const recoveryPath = path.join(packageRoot, 'build', 'devryan-content-store-recovery.js');

  let packageJson;
  let serverSource;
  try {
    packageJson = JSON.parse(fsApi.readFileSync(packageJsonPath, 'utf8'));
    serverSource = normalizeNativeServerSource(fsApi.readFileSync(serverPath, 'utf8'));
  } catch (error) {
    return incompatible(`Context-mode hotfix files are unavailable: ${error?.message || error}`);
  }

  if (packageJson?.version !== CONTEXT_MODE_HOTFIX_VERSION) {
    return incompatible(
      `Context-mode hotfix requires ${CONTEXT_MODE_HOTFIX_VERSION}, found ${packageJson?.version || 'unknown'}`,
      { installedVersion: packageJson?.version || null },
    );
  }

  let patchedSource;
  try {
    patchedSource = transformContextModeServerSource(serverSource);
  } catch {
    // An already-patched file intentionally lacks the original anchors.
    try {
      const originalCandidate = serverSource
        .replace(STORE_IMPORT_PATCHED, STORE_IMPORT_ORIGINAL)
        .replace(STORE_CONSTRUCTION_PATCHED, STORE_CONSTRUCTION_ORIGINAL)
        .replace(STALE_FILE_CLEANUP_PATCHED, STALE_FILE_CLEANUP_ORIGINAL)
        .replace(CTX_INDEX_PATH_POLICY_PATCHED, CTX_INDEX_PATH_POLICY_ORIGINAL);
      patchedSource = transformContextModeServerSource(originalCandidate);
    } catch (error) {
      return incompatible(`Context-mode server source is incompatible: ${error?.message || error}`, {
        observedSha256: sha256(serverSource),
      });
    }
  }

  const originalCandidate = serverSource
    .replace(STORE_IMPORT_PATCHED, STORE_IMPORT_ORIGINAL)
    .replace(STORE_CONSTRUCTION_PATCHED, STORE_CONSTRUCTION_ORIGINAL)
    .replace(STALE_FILE_CLEANUP_PATCHED, STALE_FILE_CLEANUP_ORIGINAL)
    .replace(CTX_INDEX_PATH_POLICY_PATCHED, CTX_INDEX_PATH_POLICY_ORIGINAL);
  const observedOriginalSha256 = sha256(originalCandidate);
  if (observedOriginalSha256 !== expectedOriginalSha256) {
    return incompatible('Context-mode server source hash is incompatible', {
      observedSha256: sha256(serverSource),
      observedOriginalSha256,
    });
  }

  let nativeFiles;
  try {
    nativeFiles = prepareNativeContextModeHotfix({ packageRoot, fsApi, expectedPluginSha256, expectedExecutorSha256 });
  } catch (error) {
    return incompatible(error.message);
  }
  patchedSource = patchNativeServerSource(patchedSource);
  const helperSource = recoveryModuleSource
    ?? CONTEXT_MODE_CONTENT_STORE_RECOVERY_SOURCE;
  const serverChanged = fsApi.readFileSync(serverPath, 'utf8') !== patchedSource;
  const helperChanged = !fsApi.existsSync(recoveryPath)
    || fsApi.readFileSync(recoveryPath, 'utf8') !== helperSource;

  // Validate every upstream hash before touching any file. Helpers and server
  // land before the adapter that activates workers; interrupted provisioning
  // is idempotent and the existing adapter remains usable until its rename.
  let nativeChanged = false;
  for (const [filePath, content] of nativeFiles.slice(1)) {
    if (!fsApi.existsSync(filePath) || fsApi.readFileSync(filePath, 'utf8') !== content) {
      atomicWrite({ fsApi, filePath, content });
      nativeChanged = true;
    }
  }
  if (helperChanged) atomicWrite({ fsApi, filePath: recoveryPath, content: helperSource });
  if (serverChanged) atomicWrite({ fsApi, filePath: serverPath, content: patchedSource });
  const [pluginPath, pluginSource] = nativeFiles[0];
  if (fsApi.readFileSync(pluginPath, 'utf8') !== pluginSource) {
    atomicWrite({ fsApi, filePath: pluginPath, content: pluginSource });
    nativeChanged = true;
  }

  return {
    ok: true,
    changed: helperChanged || serverChanged || nativeChanged,
    version: CONTEXT_MODE_HOTFIX_VERSION,
    originalSha256: observedOriginalSha256,
    patchedSha256: sha256(patchedSource),
  };
};
