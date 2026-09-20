import React, { act } from 'react';
import { describe, expect, test } from 'bun:test';
import { withDom, type HostElement } from '@/components/bots/chat/botMountedDom';
import type { SupabaseConnectionAPI, SupabaseConnectionStatus } from '@/lib/api/types';
import { SupabaseConnectionError, type SupabaseConnectionFailure } from '@/lib/api/supabaseConnection';
import { SupabaseConnectionPanel } from './SupabaseConnectionSettings';

const off: SupabaseConnectionStatus = { configured: true, desiredEnabled: false, effectiveEnabled: false,
  state: 'disconnected', errorCode: null, restartRequired: false, restartAvailable: true, blockers: [] };
const toggle = (container: HostElement) => container.find((node) => node.getAttribute('role') === 'switch');
const mount = async (api: SupabaseConnectionAPI | undefined, run: (container: HostElement) => Promise<void>) => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => { root.render(<SupabaseConnectionPanel api={api} />); });
    await run(container);
  } finally { await act(async () => root.unmount()); }
});

describe('mounted Supabase About control', () => {
  test('stays visible while loading and enables only after configured status arrives', async () => {
    let resolve!: (status: SupabaseConnectionStatus) => void;
    const pending = new Promise<SupabaseConnectionStatus>((done) => { resolve = done; });
    let changes = 0;
    await mount({ getStatus: () => pending, setEnabled: async () => { changes += 1; return off; } }, async (container) => {
      expect(container.textContent).toContain('Loading connection status');
      expect((toggle(container)?.getAttribute('aria-disabled') === 'true')).toBe(true);
      await act(async () => resolve(off));
      expect(container.textContent).toContain('Disconnected');
      expect((toggle(container)?.getAttribute('aria-disabled') === 'true')).toBe(false);
      expect(changes).toBe(0);
    });
  });
  test('shows Not configured without offering to enable an incomplete configuration', async () => {
    await mount({ getStatus: async () => ({ ...off, configured: false }), setEnabled: async () => { throw new Error('must not change'); } }, async (container) => {
      expect(container.textContent).toContain('Not configured');
      expect((toggle(container)?.getAttribute('aria-disabled') === 'true')).toBe(true);
    });
  });
  const failures: Array<[SupabaseConnectionFailure, number | null, string]> = [
    ['unauthenticated', 401, 'Sign in'], ['forbidden', 403, 'authenticated local owner'],
    ['unsupported', 404, 'Update the runtime'], ['temporary', 503, 'temporarily unavailable'],
    ['temporary', null, 'temporarily unavailable'],
  ];
  for (const [kind, code, message] of failures) test(`shows ${kind} (${code}) errors, prevents writes and recovers through Retry`, async () => {
    let reads = 0;
    await mount({ getStatus: async () => { if (++reads === 1) throw new SupabaseConnectionError(kind, code); return off; }, setEnabled: async () => off }, async (container) => {
      expect(container.textContent).toContain(message);
      expect((toggle(container)?.getAttribute('aria-disabled') === 'true')).toBe(true);
      await act(async () => { container.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Retry')?.click(); });
      expect(container.textContent).toContain('Disconnected');
      expect((toggle(container)?.getAttribute('aria-disabled') === 'true')).toBe(false);
    });
  });
  test('supports older shared UI hosts with no capability or a null status', async () => {
    for (const api of [undefined, { getStatus: async () => null, setEnabled: async () => off }]) {
      await mount(api, async (container) => {
        expect(container.textContent).toContain('Update the runtime');
        expect((toggle(container)?.getAttribute('aria-disabled') === 'true')).toBe(true);
      });
    }
  });
});
