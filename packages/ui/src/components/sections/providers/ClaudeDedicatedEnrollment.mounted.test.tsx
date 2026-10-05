import React, { act } from 'react';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { withDom, type HostElement } from '@/components/bots/chat/botMountedDom';
import { settingsDict } from '@/lib/i18n/messages/en.settings';
const dict: Record<string, string> = settingsDict;
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => dict[key] ?? key }) }));
mock.module('@/components/ui/button', () => ({ Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button onClick={props.onClick} disabled={props.disabled}>{props.children}</button> }));
mock.module('@/components/ui/input', () => ({ Input: ({ onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} onInput={event => onChange?.({ ...event, target: event.currentTarget })} /> }));
const opened: string[] = [];
const actualUrl = await import('@/lib/url');
mock.module('@/lib/url', () => ({ ...actualUrl, openExternalUrl: async (url: string) => { opened.push(url); return true; } }));
const { ClaudeDedicatedEnrollment } = await import('./ClaudeDedicatedEnrollment');
const originalFetch = globalThis.fetch;
const ID = '11111111-1111-4111-8111-111111111111', PROFILE = `devryan-${ID}`;
const URL = 'https://claude.com/cai/oauth/authorize?state=original-state';
let calls: Array<{ path: string; method: string; body: string; csrf: string | null }> = [], enrolled = false, selected = 0;
let beforeComplete = async () => {};
beforeEach(() => {
  calls = []; opened.length = 0; enrolled = false; selected = 0; beforeComplete = async () => {};
  globalThis.fetch = Object.assign(mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? 'GET';
    calls.push({ path, method, body: String(init?.body ?? ''), csrf: new Headers(init?.headers).get('x-devryan-csrf') });
    if (method === 'GET') return Response.json({ accounts: enrolled ? [{ enrollmentID: ID, profileID: PROFILE, status: 'enrolled' }] : [] });
    if (path.includes('/complete')) { await beforeComplete(); enrolled = true; return Response.json({ enrollmentID: ID, profileID: PROFILE, status: 'enrolled' }); }
    if (path.includes('/select')) return Response.json({ enrollmentID: ID, profileID: PROFILE, status: 'selected' });
    return Response.json({ enrollmentID: ID, status: 'pending', url: URL });
  }), { preconnect: () => {} });
});
afterEach(() => { globalThis.fetch = originalFetch; });
const click = async (container: HostElement, text: string) => act(async () => { const node = container.find(element => element.tagName === 'BUTTON' && element.textContent === text); expect(node).not.toBeNull(); node?.click(); });
const enter = async (container: HostElement, code: string) => act(async () => { const input = container.find(element => element.tagName === 'INPUT'); expect(input).not.toBeNull(); if (input) { input.value = code; input.dispatch('input'); } });
const onSelected = async () => { selected++; };

test('fresh sign-in requires user code and separate explicit selection; no automatic profile mutation', async () => withDom(async container => {
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ClaudeDedicatedEnrollment administrator principalID="admin" directory="/owned/project" onSelected={onSelected} />));
    expect(calls).toHaveLength(1); expect(calls[0].method).toBe('GET');
    await click(container, 'Sign in to a Dedicated Profile'); expect(opened).toEqual([URL]);
    await enter(container, 'original-code#foreign-state'); await click(container, 'Complete Sign-In');
    expect(calls.filter(call => call.path.includes('/complete'))).toHaveLength(0);
    await enter(container, 'original-code#original-state'); await click(container, 'Complete Sign-In');
    expect(selected).toBe(0); expect(calls.filter(call => call.path.includes('/select'))).toHaveLength(0);
    expect(container.find(element => element.tagName === 'INPUT')).toBeNull();
    await click(container, 'Use This Profile'); expect(selected).toBe(1);
    expect(calls.filter(call => call.method === 'POST').every(call => call.csrf === '1')).toBe(true);
    expect(calls.every(call => call.path.endsWith('?directory=%2Fowned%2Fproject'))).toBe(true);
  } finally { await act(async () => root.unmount()); }
}));
test('recovers completed receipt metadata on mount without OAuth or automatic selection', async () => withDom(async container => {
  enrolled = true; const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ClaudeDedicatedEnrollment administrator principalID="admin" onSelected={onSelected} />));
    expect(container.textContent).toContain(PROFILE); expect(calls).toHaveLength(1); expect(selected).toBe(0);
    await click(container, 'Use This Profile'); expect(selected).toBe(1); expect(opened).toHaveLength(0);
  } finally { await act(async () => root.unmount()); }
}));
test('principal replacement aborts the old scope and ignores its late completed enrollment', async () => withDom(async container => {
  let release: (() => void) | undefined; beforeComplete = () => new Promise<void>(resolve => { release = resolve; });
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ClaudeDedicatedEnrollment administrator principalID="admin" onSelected={onSelected} />));
    await click(container, 'Sign in to a Dedicated Profile'); await enter(container, 'original-code');
    await click(container, 'Complete Sign-In');
    await act(async () => root.render(<ClaudeDedicatedEnrollment administrator={false} principalID="other" onSelected={onSelected} />));
    await act(async () => { release?.(); }); expect(container.textContent).toBe(''); expect(selected).toBe(0);
  } finally { await act(async () => root.unmount()); }
}));
test('manual code entry rejects a foreign callback URL without issuer submission', async () => withDom(async container => {
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ClaudeDedicatedEnrollment administrator principalID="admin" onSelected={onSelected} />));
    await click(container, 'Sign in to a Dedicated Profile');
    await enter(container, 'https://foreign.invalid/oauth/code/callback?code=code&state=original-state');
    await click(container, 'Complete Sign-In');
    expect(calls.filter(call => call.path.includes('/complete'))).toHaveLength(0);
    expect(container.find(node => node.getAttribute('role') === 'alert')?.textContent).toContain('another sign-in');
  } finally { await act(async () => root.unmount()); }
}));

test('incomplete and unavailable enrollments retain healthy rows and explicit recovery after reload', async () => withDom(async container => {
  const incomplete = '22222222-2222-4222-8222-222222222222', unavailable = '33333333-3333-4333-8333-333333333333';
  const rows = [{ enrollmentID: ID, profileID: PROFILE, status: 'enrolled' },
    { enrollmentID: incomplete, profileID: `devryan-${incomplete}`, status: 'incomplete' },
    { enrollmentID: unavailable, profileID: `devryan-${unavailable}`, status: 'unavailable' }];
  globalThis.fetch = Object.assign(mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? 'GET';
    calls.push({ path, method, body: String(init?.body ?? ''), csrf: new Headers(init?.headers).get('x-devryan-csrf') });
    if (method === 'GET') return Response.json({ accounts: rows });
    expect(path).toContain(`/${incomplete}/select`);
    return Response.json({ enrollmentID: incomplete, profileID: `devryan-${incomplete}`, status: 'selected' });
  }), { preconnect: () => {} });
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ClaudeDedicatedEnrollment administrator principalID="admin" onSelected={onSelected} />));
    expect(container.textContent).toContain(PROFILE);
    expect(container.textContent).toContain(`devryan-${incomplete}`);
    expect(container.textContent).toContain('Unavailable');
    expect(calls).toHaveLength(1); expect(selected).toBe(0); expect(opened).toHaveLength(0);
    await click(container, 'Recover and Use This Profile'); expect(selected).toBe(1);
    expect(calls.filter(call => call.method === 'POST')).toEqual([{ path: `/api/provider/anthropic/enrollment/${incomplete}/select`, method: 'POST', body: '{}', csrf: '1' }]);
    expect(opened).toHaveLength(0);
  } finally { await act(async () => root.unmount()); }
}));
