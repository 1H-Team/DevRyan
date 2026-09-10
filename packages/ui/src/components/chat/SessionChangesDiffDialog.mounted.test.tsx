import React, { act } from 'react';
import { expect, mock, spyOn, test } from 'bun:test';
import { withDom } from '../bots/chat/botMountedDom';
import { opencodeClient, type SessionChangesDiffPage } from '@/lib/opencode/client';
import { I18nProvider } from '@/lib/i18n';

// Exercise the dialog's asynchronous state in the deterministic mounted DOM;
// the separate browser fixture exercises the real Base UI primitives.
//
// `mock.module` is process-wide in bun, so this stub reaches every test file
// that loads after this one. Spread the real module first: replacing it wholesale
// dropped exports this file does not name (`DialogFooter`), which crashed
// unrelated suites with "Export named ... not found" depending on file order.
// The real `Button` renders fine here, so it is deliberately NOT stubbed —
// stubbing it stripped classNames from other suites' markup assertions.
const dialogModule = { ...(await import('@/components/ui/dialog')) };
mock.module('@/components/ui/dialog', () => ({
  ...dialogModule,
  Dialog: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
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

test('segment navigation resets patch pagination and session switching fences late edits', async () => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  const pending: Array<{ session: string; cursor: string | null | undefined; segment: number | null | undefined; resolve: (page: SessionChangesDiffPage) => void }> = [];
  const fetch = spyOn(opencodeClient, 'getSessionChangesDiffPage').mockImplementation((session, _directory, _revision, _file, cursor, _signal, segment) =>
    new Promise(resolve => pending.push({ session, cursor, segment, resolve })));
  const page = (segmentIndex: number, patch: string, pageIndex = 0): SessionChangesDiffPage => ({ patch, pageIndex, nextCursor: pageIndex ? null : 'next', previousCursor: null, totalBytes: 90000,
    reviewMode: 'segments', segmentIndex, segmentCount: 2 });
  const render = (session: string) => root.render(<I18nProvider><SessionChangesDiffDialog rootSessionID={session} directory="/fixture" revision="revision" file="shared.txt" onClose={() => {}} /></I18nProvider>);
  const click = async (text: string) => {
    const button = container.find(button => button.tagName === 'BUTTON' && button.textContent === text);
    expect(button).toBeDefined();
    await act(async () => { button!.click(); await flush(); });
  };
  try {
    await act(async () => { render('A'); await flush(); });
    await act(async () => { pending[0].resolve(page(0, 'first edit')); await flush(); });
    await click('Next');
    expect(pending[1].cursor).toBe('next');
    await act(async () => { pending[1].resolve(page(0, 'first tail', 1)); await flush(); });
    await click('Next Edit');
    expect(pending[2]).toMatchObject({ cursor: null, segment: 1 });
    expect(container.textContent).not.toContain('first tail');
    await act(async () => { render('B'); await flush(); });
    await act(async () => { pending[3].resolve(page(0, 'B edit')); pending[2].resolve(page(1, 'A late edit')); await flush(); });
    expect(container.textContent).toContain('B edit');
    expect(container.textContent).not.toContain('A late edit');
  } finally { await act(async () => root.unmount()); fetch.mockRestore(); }
}));
