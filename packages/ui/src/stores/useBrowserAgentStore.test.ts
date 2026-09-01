import { beforeEach, describe, expect, test } from 'bun:test';

import {
  browserAgentLeaseSelectors,
  collectBrowserAgentWindowContexts,
  sanitizeBrowserAgentLeaseSnapshot,
  useBrowserAgentStore,
} from './useBrowserAgentStore';

const lease = (leaseId: string, rootSessionId = 'root') => ({
  leaseId,
  rootSessionId,
  opencodeSessionID: `${rootSessionId}-child`,
  directory: '/repo/project',
  agent: 'browser-checker',
  title: 'Preview',
  hostname: 'localhost',
  url: 'http://localhost:3000/',
  lastActivityAt: 100,
  clientAttached: true,
});

describe('browser agent lease store', () => {
  beforeEach(() => {
    useBrowserAgentStore.setState({
      revision: -1,
      leasesById: new Map(),
      leaseIds: [],
      leaseIdsByRoot: new Map(),
      activeLeaseCount: 0,
      observedLeaseId: null,
    });
  });

  test('sanitizes the safe projection without retaining credentials', () => {
    const snapshot = sanitizeBrowserAgentLeaseSnapshot({
      revision: 1,
      leases: [{ ...lease('lease-1'), wsUrl: 'ws://secret', token: 'secret' }],
    });

    expect(snapshot?.leases).toHaveLength(1);
    expect(snapshot?.leases[0]?.url).toBe('http://localhost:3000/');
    expect(Object.hasOwn(snapshot?.leases[0] ?? {}, 'wsUrl')).toBe(false);
    expect(Object.hasOwn(snapshot?.leases[0] ?? {}, 'token')).toBe(false);
    expect(snapshot?.leases[0]?.transport).toBe('native');
  });

  test('accepts the reduced tunneled projection without inventing native identifiers', () => {
    const snapshot = sanitizeBrowserAgentLeaseSnapshot({
      revision: 2,
      leases: [{
        leaseId: 'remote-lease',
        rootSessionId: 'root-remote',
        agent: 'Builder',
        title: 'Live preview',
        hostname: 'preview.example.test',
        lastActivityAt: 200,
        clientAttached: true,
      }],
    });
    expect(snapshot?.leases[0]).toEqual({
      transport: 'stream',
      leaseId: 'remote-lease',
      rootSessionId: 'root-remote',
      opencodeSessionID: '',
      directory: '',
      surfaceId: '',
      url: '',
      agent: 'Builder',
      title: 'Live preview',
      hostname: 'preview.example.test',
      lastActivityAt: 200,
      clientAttached: true,
    });
  });

  test('rejects stale revisions and preserves root index references when membership is unchanged', () => {
    useBrowserAgentStore.getState().applySnapshot({ revision: 4, leases: [lease('lease-1')] });
    const firstRootIds = browserAgentLeaseSelectors.leaseIdsForRoot('root')(useBrowserAgentStore.getState());

    useBrowserAgentStore.getState().applySnapshot({
      revision: 5,
      leases: [{ ...lease('lease-1'), title: 'Updated title', lastActivityAt: 200 }],
    });
    const secondRootIds = browserAgentLeaseSelectors.leaseIdsForRoot('root')(useBrowserAgentStore.getState());
    expect(secondRootIds).toBe(firstRootIds);
    expect(useBrowserAgentStore.getState().leasesById.get('lease-1')?.title).toBe('Updated title');

    useBrowserAgentStore.getState().applySnapshot({ revision: 3, leases: [] });
    expect(useBrowserAgentStore.getState().revision).toBe(5);
    expect(useBrowserAgentStore.getState().activeLeaseCount).toBe(1);
  });

  test('keeps unrelated root selectors stable and clears a removed observation', () => {
    useBrowserAgentStore.getState().applySnapshot({
      revision: 1,
      leases: [lease('lease-a', 'root-a'), lease('lease-b', 'root-b')],
    });
    const rootBIds = browserAgentLeaseSelectors.leaseIdsForRoot('root-b')(useBrowserAgentStore.getState());
    useBrowserAgentStore.setState({ observedLeaseId: 'lease-a' });

    useBrowserAgentStore.getState().applySnapshot({
      revision: 2,
      leases: [{ ...lease('lease-b', 'root-b'), title: 'New page' }],
    });

    expect(browserAgentLeaseSelectors.leaseIdsForRoot('root-b')(useBrowserAgentStore.getState())).toBe(rootBIds);
    expect(useBrowserAgentStore.getState().observedLeaseId).toBeNull();
    expect(browserAgentLeaseSelectors.activeCountForRoot('root-a')(useBrowserAgentStore.getState())).toBe(0);
    expect(browserAgentLeaseSelectors.activeCountForRoot('root-b')(useBrowserAgentStore.getState())).toBe(1);
  });

  test('drops malformed identities and unsafe URLs', () => {
    useBrowserAgentStore.getState().applySnapshot({
      revision: 1,
      leases: [
        { ...lease(''), url: 'file:///etc/passwd' },
        { ...lease('lease-safe'), url: 'file:///etc/passwd' },
      ],
    });

    expect(useBrowserAgentStore.getState().leaseIds).toEqual(['lease-safe']);
    expect(useBrowserAgentStore.getState().leasesById.get('lease-safe')?.url).toBe('');
  });

  test('claims exact roots for background sessions and each known worktree directory', () => {
    const contexts = collectBrowserAgentWindowContexts({
      sessions: [
        { id: 'root-a', directory: '/repo/main' },
        { id: 'child-a', parentID: 'root-a', directory: '/repo/.worktrees/feature-a' },
        { id: 'root-background', directory: '/repo/background' },
        { id: 'child-a', parentID: 'root-a', directory: '/repo/.worktrees/feature-a' },
      ],
      managedTasks: [
        {
          rootSessionId: 'root-builder',
          directory: '/repo/.worktrees/builder',
          status: 'running',
        },
        {
          rootSessionId: 'root-complete',
          directory: '/repo/.worktrees/complete',
          status: 'completed',
        },
      ],
    });

    expect(contexts).toEqual([
      { rootSessionId: 'root-a', directory: '/repo/main' },
      { rootSessionId: 'root-a', directory: '/repo/.worktrees/feature-a' },
      { rootSessionId: 'root-background', directory: '/repo/background' },
      { rootSessionId: 'root-builder', directory: '/repo/.worktrees/builder' },
    ]);
  });
});
