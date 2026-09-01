import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONTEXT_MODE_HOTFIX_INCOMPATIBLE,
  applyContextModeHotfix,
  resolveContextModeCapability,
  resolveContextModeReadOnlyIndexingCapability,
  transformContextModeServerSource,
} from './context-mode-hotfix.js';
import {
  createRecoveringContentStore,
  isRecoverableContextModeStoreError,
} from './context-mode-content-store-recovery.js';
import { NATIVE_EXECUTE_ORIGINAL, patchNativeServerSource } from './context-mode-native-hotfix.js';

const ORIGINAL_PLUGIN_SOURCE = NATIVE_EXECUTE_ORIGINAL;
const ORIGINAL_EXECUTOR_SOURCE = '            let timedOut = false;\n            let resolved = false;\n            proc.on("close", (exitCode) => {\n                clearTimeout(timer);';

const ORIGINAL_SERVER_SOURCE = `import { ContentStore, cleanupStaleDBs, cleanupStaleContentDBs } from "./store.js";
function getStore() {
    if (!_store) {
        const dbPath = getStorePath();
        _store = new ContentStore(dbPath);
        _store.setDenyChecker(() => false);
        // One-time startup cleanup: remove stale content DBs (>14 days)
        try {
            const contentDir = dirname(getStorePath());
            cleanupStaleContentDBs(contentDir, 14);
            _store.cleanupStaleSources(14);
            // Also clean legacy shared dir from before platform isolation
            const legacyDir = join(homedir(), ".context-mode", "content");
            if (existsSync(legacyDir))
                cleanupStaleContentDBs(legacyDir, 0);
        }
        catch { /* best-effort */ }
        cleanupStaleDBs();
    }
    return _store;
}
async function ctxIndexHandler({ content, path }) {
    if (path) {
        const pathDenied = checkFilePathDenyPolicy(path, "ctx_index");
        if (pathDenied)
            return pathDenied;
    }
    return { indexed: path ?? content };
}
`;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

describe('context-mode provisioning hotfix', () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  const createFixture = ({ version = '1.0.169', source = ORIGINAL_SERVER_SOURCE } = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-context-mode-hotfix-'));
    roots.push(root);
    const packageRoot = path.join(root, 'node_modules', 'context-mode');
    fs.mkdirSync(path.join(packageRoot, 'build'), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      `${JSON.stringify({ name: 'context-mode', version })}\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(packageRoot, 'build', 'server.js'), source, 'utf8');
    fs.mkdirSync(path.join(packageRoot, 'build', 'adapters', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'build', 'adapters', 'opencode', 'plugin.js'), ORIGINAL_PLUGIN_SOURCE);
    fs.writeFileSync(path.join(packageRoot, 'build', 'executor.js'), ORIGINAL_EXECUTOR_SOURCE);
    return root;
  };

  it('validates the exact version/hash, removes live file sweeps, and applies idempotently', async () => {
    const configDirectory = createFixture();
    const options = {
      configDirectory,
      expectedOriginalSha256: sha256(ORIGINAL_SERVER_SOURCE),
      expectedPluginSha256: sha256(ORIGINAL_PLUGIN_SOURCE),
      expectedExecutorSha256: sha256(ORIGINAL_EXECUTOR_SOURCE),
    };

    const first = applyContextModeHotfix(options);
    const patched = fs.readFileSync(
      path.join(configDirectory, 'node_modules', 'context-mode', 'build', 'server.js'),
      'utf8',
    );
    const second = applyContextModeHotfix(options);
    const recoveryPath = path.join(
      configDirectory,
      'node_modules',
      'context-mode',
      'build',
      'devryan-content-store-recovery.js',
    );
    const recoverySource = fs.readFileSync(recoveryPath, 'utf8');
    const recoveryModule = await import(`${pathToFileURL(recoveryPath).href}?test=${Date.now()}`);

    expect(first).toMatchObject({ ok: true, changed: true, version: '1.0.169' });
    expect(second).toMatchObject({ ok: true, changed: false, version: '1.0.169' });
    expect(patched).toContain('createRecoveringContentStore');
    expect(patched).toContain('_store.cleanupStaleSources(14)');
    expect(patched).not.toContain('cleanupStaleContentDBs');
    expect(patched).toContain('checkProjectBoundary(path, "ctx_index")');
    expect(patched.indexOf('checkProjectBoundary(path, "ctx_index")'))
      .toBeLessThan(patched.indexOf('checkFilePathDenyPolicy(path, "ctx_index")'));
    expect(recoverySource).toContain('export const createRecoveringContentStore');
    expect(recoverySource).toContain('isRecoverableContextModeStoreError');
    expect(recoveryModule.isRecoverableContextModeStoreError(new Error('disk I/O error'))).toBe(true);
    expect(patchNativeServerSource(transformContextModeServerSource(ORIGINAL_SERVER_SOURCE))).toBe(patched);
  });

  it('checks every file or directory path before deny policy and leaves inline content alone', async () => {
    const blockedPaths = new Set([
      '../outside.md',
      '/outside/project.md',
      '/workspace/symlink-escape.md',
    ]);
    const checkProjectBoundary = vi.fn((candidate) => (
      blockedPaths.has(candidate) ? { error: 'outside project' } : null
    ));
    const checkFilePathDenyPolicy = vi.fn((candidate) => (
      candidate === '/workspace/.env' ? { error: 'denied file' } : null
    ));
    const executableSource = transformContextModeServerSource(ORIGINAL_SERVER_SOURCE)
      .replace(/^import .*$/gm, '');
    const handler = vm.runInNewContext(`${executableSource}\nctxIndexHandler`, {
      checkProjectBoundary,
      checkFilePathDenyPolicy,
    });

    for (const candidate of blockedPaths) {
      expect(await handler({ path: candidate })).toEqual({ error: 'outside project' });
    }
    expect(checkFilePathDenyPolicy).not.toHaveBeenCalledWith('../outside.md', 'ctx_index');
    expect(checkFilePathDenyPolicy).not.toHaveBeenCalledWith('/outside/project.md', 'ctx_index');
    expect(checkFilePathDenyPolicy).not.toHaveBeenCalledWith('/workspace/symlink-escape.md', 'ctx_index');

    await expect(handler({ path: '/workspace/file.md' })).resolves.toEqual({
      indexed: '/workspace/file.md',
    });
    await expect(handler({ path: '/workspace/docs' })).resolves.toEqual({
      indexed: '/workspace/docs',
    });
    await expect(handler({ path: '/workspace/.env' })).resolves.toEqual({ error: 'denied file' });

    checkProjectBoundary.mockClear();
    checkFilePathDenyPolicy.mockClear();
    await expect(handler({ content: '# Inline docs' })).resolves.toEqual({ indexed: '# Inline docs' });
    expect(checkProjectBoundary).not.toHaveBeenCalled();
    expect(checkFilePathDenyPolicy).not.toHaveBeenCalled();
  });

  it('fails closed for an unexpected version or source hash', () => {
    const wrongVersion = applyContextModeHotfix({
      configDirectory: createFixture({ version: '1.0.170' }),
      expectedOriginalSha256: sha256(ORIGINAL_SERVER_SOURCE),
      recoveryModuleSource: '',
    });
    const wrongHash = applyContextModeHotfix({
      configDirectory: createFixture(),
      expectedOriginalSha256: '0'.repeat(64),
      recoveryModuleSource: '',
    });

    expect(wrongVersion).toMatchObject({ ok: false, code: CONTEXT_MODE_HOTFIX_INCOMPATIBLE });
    expect(wrongHash).toMatchObject({ ok: false, code: CONTEXT_MODE_HOTFIX_INCOMPATIBLE });
  });

  it('does not partially patch a package when the native adapter or executor is incompatible', () => {
    for (const relativePath of ['adapters/opencode/plugin.js', 'executor.js']) {
      const configDirectory = createFixture();
      const build = path.join(configDirectory, 'node_modules/context-mode/build');
      const incompatiblePath = path.join(build, relativePath);
      const incompatibleSource = fs.readFileSync(incompatiblePath, 'utf8') + '\n// unexpected source';
      fs.writeFileSync(incompatiblePath, incompatibleSource);
      const result = applyContextModeHotfix({ configDirectory,
        expectedOriginalSha256: sha256(ORIGINAL_SERVER_SOURCE),
        expectedPluginSha256: sha256(ORIGINAL_PLUGIN_SOURCE),
        expectedExecutorSha256: sha256(ORIGINAL_EXECUTOR_SOURCE) });
      expect(result).toMatchObject({ ok: false, code: CONTEXT_MODE_HOTFIX_INCOMPATIBLE });
      expect(fs.readFileSync(path.join(build, 'server.js'), 'utf8')).toBe(ORIGINAL_SERVER_SOURCE);
      expect(fs.readFileSync(incompatiblePath, 'utf8')).toBe(incompatibleSource);
      expect(fs.existsSync(path.join(build, 'devryan-context-mode-worker.js'))).toBe(false);
    }
  });
});

describe('context-mode capability', () => {
  const managedReady = {
    isOpenCodeReady: true,
    isRestartingOpenCode: false,
    isExternalOpenCode: false,
    skipOpenCodeStart: false,
    configuredOpenCodeHost: '',
  };

  it('enables indexing only for a ready provisioned managed runtime', () => {
    expect(resolveContextModeCapability(managedReady)).toBe(true);
    expect(resolveContextModeReadOnlyIndexingCapability(managedReady)).toBe(true);
    for (const override of [
      { isOpenCodeReady: false },
      { isRestartingOpenCode: true },
      { isExternalOpenCode: true },
      { skipOpenCodeStart: true },
      { configuredOpenCodeHost: 'http://external:4096' },
    ]) {
      expect(resolveContextModeCapability({ ...managedReady, ...override })).toBe(false);
    }
  });
});

describe('recovering ContentStore proxy', () => {
  it('reopens the same store generation and retries a synchronous database method once', () => {
    const denyChecker = vi.fn(() => false);
    const stores = [];
    const createStore = vi.fn(() => {
      const store = {
        setDenyChecker: vi.fn(),
        close: vi.fn(),
        search: stores.length === 0
          ? vi.fn(() => { throw new Error('SQLITE_IOERR: disk I/O error'); })
          : vi.fn(() => ['recovered']),
      };
      stores.push(store);
      return store;
    });
    const recovering = createRecoveringContentStore({ createStore });
    recovering.setDenyChecker(denyChecker);

    expect(recovering.search('needle')).toEqual(['recovered']);
    expect(createStore).toHaveBeenCalledTimes(2);
    expect(stores[0].close).toHaveBeenCalledOnce();
    expect(stores[1].setDenyChecker).toHaveBeenCalledWith(denyChecker);
  });

  it('coalesces concurrent failures from one generation into one replacement handle', async () => {
    let generation = 0;
    const createStore = vi.fn(() => {
      const currentGeneration = generation++;
      return {
        close: vi.fn(),
        search: currentGeneration === 0
          ? vi.fn(async () => { throw new Error('disk I/O error'); })
          : vi.fn(async (query) => `recovered:${query}`),
      };
    });
    const recovering = createRecoveringContentStore({ createStore });

    await expect(Promise.all([recovering.search('a'), recovering.search('b')]))
      .resolves.toEqual(['recovered:a', 'recovered:b']);
    expect(createStore).toHaveBeenCalledTimes(2);
  });

  it('propagates a second IOERR and never retries lifecycle methods', () => {
    const createStore = vi.fn(() => ({
      close: vi.fn(() => { throw new Error('disk I/O error'); }),
      cleanup: vi.fn(() => { throw new Error('SQLITE_IOERR'); }),
      index: vi.fn(() => { throw new Error('SQLITE_IOERR'); }),
    }));
    const recovering = createRecoveringContentStore({ createStore });

    expect(() => recovering.index({ content: 'captured output' })).toThrow(/SQLITE_IOERR/);
    expect(createStore).toHaveBeenCalledTimes(2);
    expect(() => recovering.cleanup()).toThrow(/SQLITE_IOERR/);
    expect(createStore).toHaveBeenCalledTimes(2);
    expect(() => recovering.close()).toThrow(/disk I\/O error/);
    expect(createStore).toHaveBeenCalledTimes(2);
  });

  it('does not treat lock contention as a poisoned handle', () => {
    expect(isRecoverableContextModeStoreError(new Error('database is locked'))).toBe(false);
  });
});
