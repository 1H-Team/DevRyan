import { afterEach, describe, expect, mock, test } from 'bun:test';
import { getAuthPrincipal, setAuthPrincipal } from '@/lib/authSession';
import { withDom } from '@/components/bots/chat/botMountedDom';
import { isSettingsSectionReady, preloadSettingsSection, preloadSettingsSectionsWhenIdle } from './settingsSectionLoaders';

mock.module('@/components/sections/openchamber/KeyboardShortcutsSettings', () => ({ KeyboardShortcutsSettings: () => null }));
const admin = getAuthPrincipal();
afterEach(() => setAuthPrincipal(admin));
const managed = () => ({ ...admin, id: 'idle-preload-test', scope: 'managed' as const, role: 'developer' as const,
  policy: { ...admin.policy, settingsPermissions: undefined, settingsPages: ['shortcuts'] } });

async function withIdle(run: (queue: Map<number, IdleRequestCallback>) => Promise<void>) {
  await withDom(async () => {
    let id = 0;
    const queue = new Map<number, IdleRequestCallback>();
    window.requestIdleCallback = (callback) => { queue.set(++id, callback); return id; };
    window.cancelIdleCallback = (key) => { queue.delete(key); };
    await run(queue);
  });
}
const advance = async (queue: Map<number, IdleRequestCallback>) => {
  const next = queue.entries().next().value;
  if (!next) throw new Error('Expected queued idle work');
  const [id, run] = next;
  queue.delete(id);
  run({ didTimeout: false, timeRemaining: () => 10 });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
};

describe('Settings idle preparation', () => {
  test('cancels queued imports when the owner unmounts', async () => withIdle(async (queue) => {
    const cancel = preloadSettingsSectionsWhenIdle(['users']);
    expect(queue.size).toBe(1);
    cancel();
    expect(queue.size).toBe(0);
    expect(isSettingsSectionReady('users')).toBe(false);
  }));
  test('stops an old authorization queue before it can import a section', async () => withIdle(async (queue) => {
    preloadSettingsSectionsWhenIdle(['users', 'commands']);
    setAuthPrincipal(managed());
    await advance(queue);
    expect(queue.size).toBe(0);
    expect(isSettingsSectionReady('users')).toBe(false);
    expect(isSettingsSectionReady('commands')).toBe(false);
  }));
  test('does not import forbidden sections even when an intent handler requests them', async () => {
    setAuthPrincipal(managed());
    await Promise.all([preloadSettingsSection('users'), preloadSettingsSection('commands'), preloadSettingsSection('voice')]);
    expect(isSettingsSectionReady('users')).toBe(false);
    expect(isSettingsSectionReady('commands')).toBe(false);
    expect(isSettingsSectionReady('voice')).toBe(false);
  });
  test('preparing Shortcuts does not prepare Voice, Tunnel, Sessions, or administrator resources', async () => {
    setAuthPrincipal(managed());
    await preloadSettingsSection('shortcuts');
    expect(isSettingsSectionReady('shortcuts')).toBe(true);
    for (const slug of ['voice', 'tunnel', 'sessions', 'users'] as const) expect(isSettingsSectionReady(slug)).toBe(false);
  });
});
