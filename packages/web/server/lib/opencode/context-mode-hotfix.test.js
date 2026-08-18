import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONTEXT_MODE_HOTFIX_INCOMPATIBLE,
  applyContextModeHotfix,
  transformContextModeServerSource,
} from './context-mode-hotfix.js';
import {
  createRecoveringContentStore,
  isRecoverableContextModeStoreError,
} from './context-mode-content-store-recovery.js';

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
    return root;
  };

  it('validates the exact version/hash, removes live file sweeps, and applies idempotently', async () => {
    const configDirectory = createFixture();
    const options = {
      configDirectory,
      expectedOriginalSha256: sha256(ORIGINAL_SERVER_SOURCE),
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
    expect(recoverySource).toContain('export const createRecoveringContentStore');
    expect(recoverySource).toContain('isRecoverableContextModeStoreError');
    expect(recoveryModule.isRecoverableContextModeStoreError(new Error('disk I/O error'))).toBe(true);
    expect(transformContextModeServerSource(ORIGINAL_SERVER_SOURCE)).toBe(patched);
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
