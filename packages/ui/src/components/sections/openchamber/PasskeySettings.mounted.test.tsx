import React, { act } from 'react';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { withDom, type HostElement } from '@/components/bots/chat/botMountedDom';

type Status = { enabled: boolean; hasPasskeys: boolean; passkeyCount: number; rpID: string | null };
const disabled: Status = { enabled: false, hasPasskeys: false, passkeyCount: 0, rpID: null };
const passkey = { id: 'pk-1', label: 'Work Laptop', createdAt: 1_700_000_000_000, lastUsedAt: null, deviceType: 'multiDevice', backedUp: true };
let status: Status = disabled;
let listCalls = 0;
let revoked: string[] = [];
let resetCalls = 0;

// Stable like the real translator, so memoized loaders keep their identity.
const translate = { t: (key: string) => key };
mock.module('@/lib/i18n', () => ({ useI18n: () => translate }));
mock.module('@/components/ui', () => ({ toast: { message() {}, success() {}, error() {} } }));
mock.module('@/lib/passkeys', () => ({
  defaultPasskeyStatus: disabled,
  cancelPasskeyCeremony: () => {},
  getPasskeySupportState: () => ({ supported: true, reason: '' }),
  isPasskeyCeremonyAbort: () => false,
  fetchPasskeyStatus: async () => status,
  fetchStoredPasskeys: async () => { listCalls += 1; return [passkey]; },
  registerCurrentDevicePasskey: async () => null,
  revokeStoredPasskey: async (id: string) => { revoked.push(id); return null; },
  resetAllAuth: async () => { resetCalls += 1; return null; },
}));

const { PasskeySettings } = await import('./PasskeySettings');

beforeEach(() => {
  status = disabled;
  listCalls = 0;
  revoked = [];
  resetCalls = 0;
});

const flush = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); }); };
const button = (container: HostElement, text: string) => container.find((node) => node.tagName === 'BUTTON' && node.textContent.includes(text));

const mount = async (run: (container: HostElement) => Promise<void>) => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => { root.render(<PasskeySettings />); });
    await flush();
    await run(container);
  } finally { await act(async () => root.unmount()); }
});

describe('Passkey settings', () => {
  test('renders nothing where the host has no UI password lock', async () => {
    await mount(async (container) => {
      expect(container.textContent).toBe('');
      expect(listCalls).toBe(0);
    });
  });

  test('lists saved passkeys and revokes one when the lock is enabled', async () => {
    status = { enabled: true, hasPasskeys: true, passkeyCount: 1, rpID: 'localhost' };
    await mount(async (container) => {
      expect(container.textContent).toContain('settings.openchamber.passkeys.title');
      expect(container.textContent).toContain('Work Laptop');
      await act(async () => button(container, 'settings.common.actions.delete')?.click());
      await flush();
      expect(revoked).toEqual(['pk-1']);
    });
  });

  test('signs out everywhere only after confirming that every passkey is deleted', async () => {
    status = { enabled: true, hasPasskeys: true, passkeyCount: 1, rpID: 'localhost' };
    await mount(async (container) => {
      const prompts: string[] = [];
      let answer = false;
      let reloads = 0;
      Object.assign(globalThis.window, {
        confirm: (message: string) => { prompts.push(message); return answer; },
        location: { reload: () => { reloads += 1; } },
      });
      const signOut = () => button(container, 'settings.openchamber.passkeys.actions.signOutEverywhere');

      await act(async () => signOut()?.click());
      await flush();
      expect(prompts).toEqual(['settings.openchamber.passkeys.confirm.signOutEverywhere']);
      expect(resetCalls).toBe(0);

      answer = true;
      await act(async () => signOut()?.click());
      await flush();
      expect(resetCalls).toBe(1);
      expect(reloads).toBe(1);
    });
  });

  test('lives on the local User Management page, where passkey sign-in exists', () => {
    const page = readFileSync(new URL('../users/UserManagementPage.tsx', import.meta.url), 'utf8');
    const local = page.slice(page.indexOf('const LocalUserManagementPage'), page.indexOf('const ManagedUserManagementPage'));
    expect(local).toContain('<PasskeySettings />');
    expect(page.split('<PasskeySettings />')).toHaveLength(2);
  });
});
