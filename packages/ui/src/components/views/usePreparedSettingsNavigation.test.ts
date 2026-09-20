import { describe, expect, test } from 'bun:test';

import { createPreparedSettingsNavigationCoordinator } from './usePreparedSettingsNavigation';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
};

describe('prepared settings navigation', () => {
  test('keeps the current destination until a cold chunk resolves', async () => {
    const load = deferred();
    const pending: Array<string | null> = [];
    const committed: string[] = [];
    const coordinator = createPreparedSettingsNavigationCoordinator({
      isReady: () => false,
      preload: () => load.promise,
      onPendingChange: (slug) => pending.push(slug),
    });

    coordinator.navigate({ currentSlug: 'home', slug: 'notifications', commit: () => committed.push('notifications') });
    expect(committed).toEqual([]);
    expect(pending).toEqual(['notifications']);
    load.resolve();
    await load.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(committed).toEqual(['notifications']);
    expect(pending.at(-1)).toBeNull();
  });

  test('commits only the latest rapid navigation request', async () => {
    const notifications = deferred();
    const providers = deferred();
    const committed: string[] = [];
    const coordinator = createPreparedSettingsNavigationCoordinator({
      isReady: () => false,
      preload: (slug) => slug === 'notifications' ? notifications.promise : providers.promise,
      onPendingChange: () => {},
    });

    coordinator.navigate({ currentSlug: 'home', slug: 'notifications', commit: () => committed.push('notifications') });
    coordinator.navigate({ currentSlug: 'home', slug: 'providers', commit: () => committed.push('providers') });
    notifications.resolve();
    providers.resolve();
    await Promise.all([notifications.promise, providers.promise]);
    await Promise.resolve();
    expect(committed).toEqual(['providers']);
  });

  test('commits after a failed preload so the recovery boundary can retry', async () => {
    const committed: string[] = [];
    const coordinator = createPreparedSettingsNavigationCoordinator({
      isReady: () => false,
      preload: async () => { throw new Error('chunk unavailable'); },
      onPendingChange: () => {},
    });

    coordinator.navigate({ currentSlug: 'home', slug: 'agents', commit: () => committed.push('agents') });
    await Promise.resolve();
    await Promise.resolve();
    expect(committed).toEqual(['agents']);
  });
});

  test('cancellation prevents an unresolved destination from committing', async () => {
    const load = deferred();
    const committed: string[] = [];
    const coordinator = createPreparedSettingsNavigationCoordinator({
      isReady: () => false, preload: () => load.promise, onPendingChange: () => {},
    });
    coordinator.navigate({ currentSlug: 'home', slug: 'agents', commit: () => committed.push('agents') });
    coordinator.cancel();
    load.resolve();
    await load.promise;
    await Promise.resolve();
    expect(committed).toEqual([]);
  });

  test('rechecks permission after loading, and does not start a forbidden import', async () => {
    const load = deferred();
    let allowed = true;
    let imports = 0;
    let commits = 0;
    const coordinator = createPreparedSettingsNavigationCoordinator({
      isReady: () => false, canNavigate: () => allowed,
      preload: () => { imports += 1; return load.promise; }, onPendingChange: () => {},
    });
    coordinator.navigate({ currentSlug: 'home', slug: 'agents', commit: () => { commits += 1; } });
    allowed = false;
    load.resolve();
    await load.promise;
    await Promise.resolve();
    expect(commits).toBe(0);
    coordinator.navigate({ currentSlug: 'home', slug: 'users', commit: () => { commits += 1; } });
    expect(imports).toBe(1);
    expect(commits).toBe(0);
  });
