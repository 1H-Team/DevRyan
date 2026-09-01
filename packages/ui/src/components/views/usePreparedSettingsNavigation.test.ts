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
