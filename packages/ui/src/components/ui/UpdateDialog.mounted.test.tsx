import React, { act } from 'react';
import { afterEach, expect, mock, test } from 'bun:test';
import { withDom, type HostElement } from '@/test/mountedDom';
import { dict } from '@/lib/i18n/messages/en';

const messages: Record<string, string> = dict;
const t = (key: string) => messages[key] ?? key;
const opened: string[] = [];
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t }) }));
mock.module('@/lib/url', () => ({ openExternalUrl: async (url: string) => { opened.push(url); return true; } }));
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
mock.module('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
mock.module('@/components/chat/MarkdownRenderer', () => ({ SimpleMarkdownRenderer: ({ content }: { content: string }) => <span>{content}</span> }));
const { UpdateDialog } = await import('./UpdateDialog');
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; opened.length = 0; });

const LATEST_RELEASE_PAGE = 'https://github.com/1H-Team/DevRyan/releases/latest';

for (const version of ['2.1.0', '2.1.0/../../../../evil.example', '@evil.example/x', '2.1.0?u=https://evil.example#']) test(`web updates point to the fixed release page and never call the server installer (version=${version})`, async () => withDom(async (container: HostElement) => {
  const fetchMock = mock(async () => { throw new Error('Unexpected request'); });
  globalThis.fetch = Object.assign(fetchMock, { preconnect: () => {} });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(<UpdateDialog open onOpenChange={() => {}} info={{ available: true, version, currentVersion: '2.0.0' }}
      downloading={false} downloaded={false} progress={null} error={null} onDownload={() => {}} onRestart={() => {}} runtimeType="web" />);
  });
  try {
    expect(container.textContent).toContain(t('updateDialog.web.installFromDmg'));
    expect(t('updateDialog.web.installFromDmg')).toBe('A newer DevRyan release is available. Install it on the machine that runs this DevRyan server; updating the device you are viewing from does not update that server.');
    expect(container.textContent).not.toContain('devryan update');
    const button = container.find((node) => node.tagName === 'BUTTON' && node.textContent === t('updateDialog.actions.openReleasePage'));
    expect(button).toBeTruthy();
    await act(async () => { button?.click(); });
    expect(opened).toEqual([LATEST_RELEASE_PAGE]);
    const githubLink = container.find((node) => node.tagName === 'A');
    expect(githubLink?.getAttribute('href')).toBe(LATEST_RELEASE_PAGE);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  } finally { await act(async () => root.unmount()); }
}));

for (const version of ['2.1.0', '2.1.0/../../../../evil.example', '@evil.example/x', '2.1.0?u=https://evil.example#', '//evil.example']) test(`desktop footer links to the encoded tag page inside the repository releases (version=${version})`, async () => withDom(async (container: HostElement) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(<UpdateDialog open onOpenChange={() => {}} info={{ available: true, version, currentVersion: '2.0.0' }}
      downloading={false} downloaded={false} progress={null} error={null} onDownload={() => {}} onRestart={() => {}} runtimeType="desktop" />);
  });
  try {
    expect(container.textContent).not.toContain(t('updateDialog.web.installFromDmg'));
    const href = container.find((node) => node.tagName === 'A')?.getAttribute('href') ?? '';
    expect(href).toBe(`https://github.com/1H-Team/DevRyan/releases/tag/v${encodeURIComponent(version)}`);
    const target = new URL(href);
    expect(target.origin).toBe('https://github.com');
    expect(target.search).toBe('');
    expect(target.hash).toBe('');
    const prefix = '/1H-Team/DevRyan/releases/tag/';
    expect(target.pathname.startsWith(prefix)).toBe(true);
    const segment = target.pathname.slice(prefix.length);
    expect(segment.includes('/')).toBe(false);
    expect(decodeURIComponent(segment)).toBe(`v${version}`);
  } finally { await act(async () => root.unmount()); }
}));
