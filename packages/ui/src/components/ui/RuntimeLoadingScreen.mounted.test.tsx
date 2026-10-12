import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';
import { withDom } from '@/components/bots/chat/botMountedDom';
let copied = '';
mock.module('@/lib/clipboard', () => ({ copyTextToClipboard: async (text: string) => { copied = text; return { ok: true }; } }));
const { RuntimeLoadingScreen } = await import('./RuntimeLoadingScreen');

test('copies the bounded diagnostic and disables Retry while a replacement is starting', async () => withDom(async container => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  let retries = 0;
  const diagnostics = '{"code":"native_runtime_artifacts_unverified"}';
  try {
    await act(async () => { root.render(<RuntimeLoadingScreen state="error" message="Runtime file mismatch" diagnostics={diagnostics} onRetry={() => { retries++; }} />); });
    const copy = container.find(node => node.tagName === 'BUTTON' && node.textContent === 'Copy Diagnostics');
    expect(copy).not.toBeNull();
    await act(async () => { copy?.click(); });
    expect(copied).toBe(diagnostics); expect(container.textContent).toContain('Copied');
    await act(async () => { container.find(node => node.tagName === 'BUTTON' && node.textContent === 'Retry')?.click(); });
    expect(retries).toBe(1);
    await act(async () => { root.render(<RuntimeLoadingScreen state="error" message="Runtime file mismatch" onRetry={() => { retries++; }} isRetrying />); });
    const retry = container.find(node => node.tagName === 'BUTTON' && node.textContent === 'Retrying…');
    expect(retry?.hasAttribute('disabled')).toBe(true);
  } finally { await act(async () => { root.unmount(); }); }
}));
