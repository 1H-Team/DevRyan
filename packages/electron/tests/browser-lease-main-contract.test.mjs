import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const mainSource = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');

const readClaimDirectoryNormalizer = () => {
  const start = mainSource.indexOf('const normalizeBrowserLeaseClaimDirectory =');
  const end = mainSource.indexOf('\n\nconst browserLeaseWindowClaimKey', start);
  assert.notEqual(start, -1, 'claim-directory normalizer should exist');
  assert.notEqual(end, -1, 'claim-directory normalizer should end before the claim-key builder');

  const declaration = mainSource.slice(start, end);
  const safeLeaseString = (value, maxLength) => (
    typeof value === 'string' ? value.slice(0, maxLength) : ''
  );
  return Function(
    'safeLeaseString',
    `'use strict'; ${declaration}; return normalizeBrowserLeaseClaimDirectory;`,
  )(safeLeaseString);
};

const readClaimKeyBuilder = () => {
  const start = mainSource.indexOf('const browserLeaseWindowClaimKey =');
  const end = mainSource.indexOf('\n\nconst collectBrowserLeaseWindowClaimKeys', start);
  assert.notEqual(start, -1, 'claim-key builder should exist');
  assert.notEqual(end, -1, 'claim-key builder should end before the batch collector');
  const declaration = mainSource.slice(start, end);
  const safeLeaseString = (value, maxLength) => (
    typeof value === 'string' ? value.slice(0, maxLength) : ''
  );
  return Function(
    'normalizeBrowserLeaseClaimDirectory',
    'safeLeaseString',
    `'use strict'; ${declaration}; return browserLeaseWindowClaimKey;`,
  )(readClaimDirectoryNormalizer(), safeLeaseString);
};

const readClaimKeyCollector = () => {
  const start = mainSource.indexOf('const collectBrowserLeaseWindowClaimKeys =');
  const end = mainSource.indexOf('\n\nconst resolveBrowserLeaseOwnerWindow', start);
  assert.notEqual(start, -1, 'claim-key collector should exist');
  assert.notEqual(end, -1, 'claim-key collector should end before owner resolution');
  const declaration = mainSource.slice(start, end);
  return Function(
    'browserLeaseWindowClaimKey',
    'MAX_BROWSER_LEASE_CONTEXT_CLAIMS_PER_REQUEST',
    `'use strict'; ${declaration}; return collectBrowserLeaseWindowClaimKeys;`,
  )(readClaimKeyBuilder(), 1_000);
};

const readAgentBrowserMutationResultFactory = () => {
  const start = mainSource.indexOf('const createAgentBrowserMutationResult =');
  const end = mainSource.indexOf('\n\nconst mutateAgentBrowserInstallation', start);
  assert.notEqual(start, -1, 'agent-browser mutation result factory should exist');
  assert.notEqual(end, -1, 'agent-browser mutation result factory should end before mutation orchestration');
  const declaration = mainSource.slice(start, end);
  return Function(
    `'use strict'; ${declaration}; return createAgentBrowserMutationResult;`,
  )();
};

describe('Electron browser lease host contract', () => {
  test('uses an authoritative root-and-directory window claim instead of focus heuristics', () => {
    assert.match(mainSource, /const browserLeaseWindowClaims = new Map\(\)/);
    assert.match(mainSource, /desktop_browser_lease_claim_context/);
    assert.match(mainSource, /resolveBrowserLeaseOwnerWindow\(metadata\)/);
    assert.doesNotMatch(
      mainSource,
      /const resolveBrowserLeaseOwnerWindow = \(\) => \{[\s\S]*BrowserWindow\.getFocusedWindow\(\)/,
    );
  });

  test('canonicalizes renderer and OpenCode directory spellings to the same claim key', () => {
    const normalize = readClaimDirectoryNormalizer();

    assert.equal(normalize('/Users/dev/DevRyan/'), '/Users/dev/DevRyan');
    assert.equal(normalize('/'), '/');
    assert.equal(normalize('C:\\Users\\Dev\\DevRyan\\'), 'c:/Users/Dev/DevRyan');
    assert.equal(normalize('c:/Users/Dev/DevRyan'), 'c:/Users/Dev/DevRyan');
    assert.equal(normalize('D:\\'), normalize('d:'));
    assert.equal(normalize('\\\\Server\\Share\\DevRyan\\'), '//Server/Share/DevRyan');
    assert.match(mainSource, /normalizeBrowserLeaseClaimDirectory\(directory\)/);
  });

  test('keeps background roots and worktree descendants as additive exact claims', () => {
    const collect = readClaimKeyCollector();
    const keys = collect([
      { directory: '/repo/main', rootSessionId: 'root-a' },
      { directory: '/repo/.worktrees/feature-a', rootSessionId: 'root-a' },
      { directory: '/repo/background', rootSessionId: 'root-background' },
      { directory: '/repo/.worktrees/feature-a/', rootSessionId: 'root-a' },
    ]);

    assert.equal(keys.length, 3);
    assert.notEqual(keys[0], keys[1]);
    assert.notEqual(keys[0], keys[2]);
    assert.match(mainSource, /desktop_browser_lease_claim_contexts/);
    assert.match(
      mainSource,
      /browserLeaseWindowClaims\.delete\(claimKey\);\s*browserLeaseWindowClaims\.set\(claimKey,/,
    );
    assert.doesNotMatch(mainSource, /browserLeaseWindowClaims\.clear\(\)/);
  });

  test('waits only for the exact claim and retires stale window ownership', () => {
    const resolverStart = mainSource.indexOf('const resolveBrowserLeaseOwnerWindow =');
    const resolverEnd = mainSource.indexOf('\n\nconst safeBrowserLeaseSnapshot', resolverStart);
    const resolverSource = mainSource.slice(resolverStart, resolverEnd);

    assert.match(resolverSource, /browserLeaseWindowClaimKey\(metadata\?\.directory, metadata\?\.rootSessionId\)/);
    assert.match(resolverSource, /browserLeaseWindowClaims\.get\(claimKey\)/);
    assert.match(resolverSource, /browserLeaseWindowClaims\.delete\(claimKey\)/);
    assert.doesNotMatch(resolverSource, /for \(const .*browserLeaseWindowClaims/);
    assert.match(mainSource, /const ownerWindow = await waitForBrowserLeaseOwnerWindow\(metadata\)/);
    assert.match(mainSource, /if \(claim\.ownerWindowId === browserWindow\.id\) browserLeaseWindowClaims\.delete\(claimKey\)/);
  });

  test('single-flights bridge creation and rechecks disablement after async setup', () => {
    assert.match(mainSource, /let browserCdpBridgePromise = null/);
    assert.match(mainSource, /if \(!browserCdpBridgePromise\)/);
    assert.match(mainSource, /if \(!readAgentBrowserControlEnabled\(\) \|\| state\.quitRequested\)/);
  });

  test('replays snapshots and destroys the dedicated guest on release', () => {
    assert.match(mainSource, /desktop_browser_lease_snapshot/);
    assert.match(mainSource, /guest\.close\(\{ waitForBeforeUnload: false \}\)/);
    assert.match(mainSource, /bridge\.updateLeaseMetadata\(leaseId/);
  });

  test('publishes a token-free global count while keeping lease snapshots owner-scoped', () => {
    assert.match(mainSource, /globalActiveLeaseCount: browserLeaseOwners\.size/);
    assert.match(
      mainSource,
      /emitToWindow\(browserWindow, 'browser-agent-lease-total', detail\)/,
    );
    assert.match(mainSource, /const detail = \{ activeLeaseCount: browserLeaseOwners\.size \}/);
    assert.match(mainSource, /if \(owner\.ownerWindowId !== ownerWindowId\) continue/);
  });

  test('distinguishes binary integrity from managed-runtime application failure', () => {
    const createResult = readAgentBrowserMutationResultFactory();
    const ready = { ok: true, state: 'ready', issues: [] };

    assert.deepEqual(
      createResult(ready, { applied: true, restartSucceeded: true }),
      { ...ready, applied: true, restartSucceeded: true },
    );
    assert.deepEqual(
      createResult(ready, { restartFailed: true }),
      {
        ok: true,
        state: 'restart-failed',
        applied: false,
        restartSucceeded: false,
        issues: [{
          code: 'restart-failed',
          message: 'Agent browser is installed, but OpenCode could not restart. Restart DevRyan to apply it.',
        }],
      },
    );
    assert.match(mainSource, /return createAgentBrowserMutationResult\(runtimeStatus, \{ restartFailed: true \}\)/);
  });
});
