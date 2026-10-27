import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';
import { withDom } from '@/test/mountedDom';

const shown: Array<{ title: string; id?: string; description?: string; duration?: number }> = [];
const dismissed: string[] = [];
mock.module('@/components/ui', () => ({ toast: {
  warning: (title: string, options: { id?: string; description?: string; duration?: number }) => { shown.push({ title, ...options }); },
  dismiss: (id: string) => { dismissed.push(id); }, success: () => {}, error: () => {},
} }));
mock.module('@/stores/useConfigStore', () => ({ useConfigStore: (select: (state: { isInitialized: boolean }) => unknown) => select({ isInitialized: true }) }));
const { OpenCodeProfileNotices } = await import('./OpenCodeProfileNotices');

test('a startup that continued past a refusal says so until the condition clears', async () => withDom(async container => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element), original = globalThis.fetch;
  let health: unknown = { openCodeProfileNotices: [], startupNotices: [
    { code: 'startup_upgrade_not_applied', count: 1, message: 'Upgrade was not applied (bundle_symlink_source).' },
    { code: 'unknown_code', message: 'ignored' }, { code: 'startup_records_isolated' },
  ] };
  globalThis.fetch = (async () => new Response(JSON.stringify(health), { status: 200 })) as unknown as typeof fetch;
  const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
  try {
    await act(async () => { root.render(<OpenCodeProfileNotices />); });
    await settle();
    expect(shown).toEqual([{ title: 'Runtime upgrade not applied', id: 'startup-notice-startup_upgrade_not_applied',
      description: 'Upgrade was not applied (bundle_symlink_source).', duration: Infinity }]);
    expect(dismissed).toContain('startup-notice-startup_records_isolated');
    await act(async () => { root.unmount(); });
    shown.length = 0; dismissed.length = 0; health = { openCodeProfileNotices: [] };
    const next = createRoot(container as unknown as Element);
    await act(async () => { next.render(<OpenCodeProfileNotices />); });
    await settle();
    expect(shown).toEqual([]);
    expect(dismissed).toContain('startup-notice-startup_upgrade_not_applied');
    await act(async () => { next.unmount(); });
  } finally { globalThis.fetch = original; }
}));
