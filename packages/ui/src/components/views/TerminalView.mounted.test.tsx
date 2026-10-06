import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';
import { withDom } from '@/components/bots/chat/botMountedDom';
import type { TerminalAPI, TerminalCapabilities } from '@/lib/api/types';

let terminal: Pick<TerminalAPI, 'getCapabilities'>;
const ownerMounted = mock(() => { throw new Error('Unavailable terminal mounted its owners'); });
mock.module('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ terminal }) }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/contexts/useThemeSystem', () => ({ useThemeSystem: ownerMounted }));
mock.module('@/components/terminal/TerminalViewport', () => ({ TerminalViewport: () => null }));
mock.module('@/components/views/ProcessesPanel', () => ({ ProcessesPanel: () => null }));
const { TerminalView } = await import('./TerminalView');

test('unsupported, failed and superseded capability reads cannot mount terminal owners', async () => withDom(async container => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  let finish!: (value: TerminalCapabilities) => void;
  terminal = { getCapabilities: () => new Promise(resolve => { finish = resolve; }) };
  try {
    await act(async () => root.render(<TerminalView />));
    expect(container.textContent).toBe('common.loading');
    terminal = { getCapabilities: async () => ({ available: false, code: 'terminal_platform_unsupported' }) };
    await act(async () => root.render(<TerminalView />));
    expect(container.textContent).toBe('common.unavailable');
    await act(async () => finish({ available: true, code: null }));
    expect(container.textContent).toBe('common.unavailable');
    terminal = { getCapabilities: async () => { throw new Error('Disconnected'); } };
    await act(async () => root.render(<TerminalView />));
    expect(container.textContent).toBe('common.unavailable');
    expect(ownerMounted).toHaveBeenCalledTimes(0);
  } finally { await act(async () => root.unmount()); }
}));
