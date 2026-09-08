import React, { act } from 'react';
import { expect, mock, spyOn, test } from 'bun:test';
import { withDom } from '../bots/chat/botMountedDom';
import { opencodeClient, type SessionChangesDiffPage } from '@/lib/opencode/client';
import { I18nProvider } from '@/lib/i18n';

// Exercise the dialog's asynchronous state in the deterministic mounted DOM;
// the separate browser fixture exercises the real Base UI primitives.
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
}));
mock.module('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled }: React.PropsWithChildren<{ onClick?: () => void; disabled?: boolean }>) => <button onClick={onClick} disabled={disabled}>{children}</button>,
}));
const { SessionChangesDiffDialog } = await import('./SessionChangesDiffDialog');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('a late previous-file response cannot replace the current recorded diff', async () => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  const pending = new Map<string, (value: SessionChangesDiffPage) => void>();
  const signals: AbortSignal[] = [];
  const fetch = spyOn(opencodeClient, 'getSessionChangesDiffPage').mockImplementation((_session, _directory, _revision, file, _cursor, signal) => {
    if (signal) signals.push(signal);
    return new Promise((resolve) => pending.set(file, resolve));
  });
  const page = (patch: string): SessionChangesDiffPage => ({ patch, pageIndex: 0, nextCursor: null, previousCursor: null, totalBytes: patch.length });
  const render = (file: string) => root.render(<I18nProvider><SessionChangesDiffDialog rootSessionID="root" directory="/fixture" revision="revision" file={file} onClose={() => {}} /></I18nProvider>);
  try {
    await act(async () => { render('first'); await flush(); });
    await act(async () => { render('second'); await flush(); });
    expect(signals[0].aborted).toBe(true);
    await act(async () => { pending.get('second')?.(page('current recorded diff')); await flush(); });
    await act(async () => { pending.get('first')?.(page('stale diff')); await flush(); });
    expect(container.textContent).toContain('current recorded diff');
    expect(container.textContent).not.toContain('stale diff');
    await act(async () => { render('third'); await flush(); });
    expect(container.textContent).not.toContain('current recorded diff');
  } finally { await act(async () => root.unmount()); fetch.mockRestore(); }
}));
