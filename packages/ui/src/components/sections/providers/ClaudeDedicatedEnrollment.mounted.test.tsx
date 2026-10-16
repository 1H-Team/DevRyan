import React, { act } from 'react';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { withDom, HostElement } from '@/components/bots/chat/botMountedDom';
import { settingsDict } from '@/lib/i18n/messages/en.settings';
const dict: Record<string, string> = settingsDict;
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string, values: Record<string, string> = {}) => (dict[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match) }) }));
mock.module('@/components/ui/button', () => ({ Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button onClick={props.onClick} disabled={props.disabled}>{props.children}</button> }));
mock.module('@/components/ui/input', () => ({ Input: ({ onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} onInput={event => onChange?.({ ...event, target: event.currentTarget })} /> }));
const actualDialog = await import('@/components/ui/dialog');
const wrapper = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
mock.module('@/components/ui/dialog', () => ({ ...actualDialog,
  Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: wrapper, DialogHeader: wrapper, DialogFooter: wrapper,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
}));
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
    expect(container.textContent).toContain('Dedicated profile');
    expect(container.textContent).toContain('Sign in to Claude here, then choose Use This Profile to connect it. The selected profile renews automatically.');
    expect(container.textContent).not.toContain('Optional.');
    expect(calls).toHaveLength(1); expect(calls[0].method).toBe('GET');
    await click(container, 'Add Dedicated Profile'); expect(opened).toEqual([URL]);
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
    await click(container, 'Add Dedicated Profile'); await enter(container, 'original-code');
    await click(container, 'Complete Sign-In');
    await act(async () => root.render(<ClaudeDedicatedEnrollment administrator={false} principalID="other" onSelected={onSelected} />));
    await act(async () => { release?.(); }); expect(container.textContent).toBe(''); expect(selected).toBe(0);
  } finally { await act(async () => root.unmount()); }
}));
test('manual code entry rejects a foreign callback URL without issuer submission', async () => withDom(async container => {
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ClaudeDedicatedEnrollment administrator principalID="admin" onSelected={onSelected} />));
    await click(container, 'Add Dedicated Profile');
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

test('list, start and completion failures each say what failed instead of one recovery hint', async () => withDom(async container => {
  let fail: 'list' | 'start' | 'complete' | 'update' = 'list';
  globalThis.fetch = Object.assign(mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? 'GET';
    if (method === 'GET') return fail === 'list' ? Response.json({ code: 'native_claude_enrollment_location_unreviewed' }, { status: 503 }) : Response.json({ accounts: [] });
    if (path.includes('/complete')) return Response.json({ code: 'native_claude_enrollment_failed' }, { status: 409 });
    if (fail === 'start') return Response.json({ code: 'native_claude_enrollment_refused' }, { status: 409 });
    if (fail === 'update') return Response.json({ code: 'native_claude_enrollment_update_required' }, { status: 409 });
    return Response.json({ enrollmentID: ID, status: 'pending', url: URL });
  }), { preconnect: () => {} });
  const alert = () => container.find(node => node.getAttribute('role') === 'alert')?.textContent;
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ClaudeDedicatedEnrollment administrator principalID="admin" onSelected={onSelected} />));
    expect(alert()).toBe('Dedicated profiles couldn’t be loaded.');
    fail = 'start'; await click(container, 'Add Dedicated Profile');
    expect(alert()).toBe('Sign-in couldn’t start. Try again.'); expect(opened).toHaveLength(0);
    fail = 'update'; await click(container, 'Add Dedicated Profile');
    expect(alert()).toBe('Apply the bundled runtime update first.');
    fail = 'complete'; await click(container, 'Add Dedicated Profile'); expect(opened).toEqual([URL]);
    await enter(container, 'original-code'); await click(container, 'Complete Sign-In');
    expect(alert()).toBe('Sign-in couldn’t be confirmed. Start again.');
  } finally { await act(async () => root.unmount()); }
}));

const FAILED = '22222222-2222-4222-8222-222222222222', UNAVAILABLE = '33333333-3333-4333-8333-333333333333';
const deletionRows = [
  { enrollmentID: ID, profileID: PROFILE, status: 'enrolled' },
  { enrollmentID: FAILED, profileID: `devryan-${FAILED}`, status: 'incomplete' },
  { enrollmentID: UNAVAILABLE, profileID: `devryan-${UNAVAILABLE}`, status: 'unavailable' },
];
const requestDelete = async (container: HostElement, enrollmentID: string) => act(async () => {
  const row = container.find(node => node.tagName === 'DIV' && node.childNodes.some(child => child instanceof HostElement && child.tagName === 'SPAN' && child.textContent === `devryan-${enrollmentID}`));
  expect(row).not.toBeNull(); row?.find(node => node.tagName === 'BUTTON' && node.textContent === 'Delete')?.click();
});
const deleteFetch = (response: (enrollmentID: string) => Promise<Response>) => {
  globalThis.fetch = Object.assign(mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? 'GET';
    calls.push({ path, method, body: String(init?.body ?? ''), csrf: new Headers(init?.headers).get('x-devryan-csrf') });
    if (method === 'GET') return Response.json({ accounts: deletionRows });
    expect(method).toBe('DELETE');
    return response(path.split('?')[0].split('/').at(-1) ?? '');
  }), { preconnect: () => {} });
};
test('delete requires named confirmation, removes failed rows only, and refreshes configuration', async () => withDom(async container => {
  deleteFetch(async enrollmentID => Response.json({ enrollmentID, profileID: `devryan-${enrollmentID}`, status: 'deleted' }));
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ClaudeDedicatedEnrollment administrator principalID="admin" directory="/owned/project" onSelected={onSelected} />));
    await requestDelete(container, FAILED);
    expect(container.find(node => node.getAttribute('role') === 'dialog')?.textContent).toContain(`Delete devryan-${FAILED}`);
    expect(calls).toHaveLength(1);
    await click(container, 'Cancel'); expect(calls).toHaveLength(1); expect(container.textContent).toContain(`devryan-${FAILED}`);
    for (const enrollmentID of [FAILED, UNAVAILABLE]) {
      await requestDelete(container, enrollmentID); await click(container, 'Delete Profile');
      expect(container.textContent).not.toContain(`devryan-${enrollmentID}`);
      expect(container.textContent).toContain(PROFILE);
    }
    expect(selected).toBe(2); expect(opened).toEqual([]);
    expect(calls.filter(call => call.method === 'DELETE')).toEqual([FAILED, UNAVAILABLE].map(enrollmentID => ({ path: `/api/provider/anthropic/enrollment/${enrollmentID}?directory=%2Fowned%2Fproject`, method: 'DELETE', body: '{}', csrf: '1' })));
  } finally { await act(async () => root.unmount()); }
}));
test('selected refusal and partial deletion keep rows and allow retry without silently selecting another profile', async () => withDom(async container => {
  let failure = true;
  deleteFetch(async enrollmentID => failure ? Response.json({ code: enrollmentID === ID ? 'native_claude_enrollment_selected' : 'native_claude_enrollment_persistence_failed' }, { status: 409 }) : Response.json({ enrollmentID, profileID: `devryan-${enrollmentID}`, status: 'deleted' }));
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ClaudeDedicatedEnrollment administrator principalID="admin" onSelected={onSelected} />));
    await requestDelete(container, ID); await click(container, 'Delete Profile');
    expect(container.find(node => node.getAttribute('role') === 'alert')?.textContent).toBe('Use another profile before deleting this one.');
    expect(selected).toBe(0); await click(container, 'Cancel');
    await requestDelete(container, FAILED); await click(container, 'Delete Profile');
    expect(container.textContent).toContain(`devryan-${FAILED}`);
    expect(container.find(node => node.getAttribute('role') === 'alert')?.textContent).toContain('retry');
    failure = false; await click(container, 'Delete Profile');
    expect(container.textContent).not.toContain(`devryan-${FAILED}`); expect(container.textContent).toContain(PROFILE); expect(selected).toBe(1);
  } finally { await act(async () => root.unmount()); }
}));
test('partial-cleanup rows expose Delete retry but never selection', async () => withDom(async container => {
  globalThis.fetch = Object.assign(mock(async () => Response.json({ accounts: [{ ...deletionRows[1], status: 'deleting' }] })), { preconnect: () => {} });
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ClaudeDedicatedEnrollment administrator principalID="admin" onSelected={onSelected} />));
    expect(container.textContent).toContain('Deletion incomplete. Retry Delete to finish.');
    expect(container.find(element => element.tagName === 'BUTTON' && element.textContent === 'Use This Profile')).toBeNull();
    await requestDelete(container, FAILED); expect(container.find(node => node.getAttribute('role') === 'dialog')).not.toBeNull();
  } finally { await act(async () => root.unmount()); }
}));
test('late deletion after directory replacement cannot remove the new scope row or refresh its settings', async () => withDom(async container => {
  let release: (() => void) | undefined;
  deleteFetch(async enrollmentID => { await new Promise<void>(resolve => { release = resolve; }); return Response.json({ enrollmentID, profileID: `devryan-${enrollmentID}`, status: 'deleted' }); });
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    const render = (directory: string) => root.render(<ClaudeDedicatedEnrollment administrator principalID="admin" directory={directory} onSelected={onSelected} />);
    await act(async () => render('/first')); await requestDelete(container, FAILED); await click(container, 'Delete Profile');
    await act(async () => render('/replacement')); await act(async () => release?.());
    expect(container.textContent).toContain(`devryan-${FAILED}`); expect(selected).toBe(0);
    expect(container.find(node => node.getAttribute('role') === 'dialog')).toBeNull();
    expect(container.find(node => node.getAttribute('role') === 'alert')).toBeNull();
  } finally { await act(async () => root.unmount()); }
}));
test('deletion validates exact response identity and distinguishes a subsequent refresh failure', async () => withDom(async container => {
  let valid = false;
  deleteFetch(async enrollmentID => Response.json({ enrollmentID: valid ? enrollmentID : ID, profileID: `devryan-${enrollmentID}`, status: 'deleted' }));
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ClaudeDedicatedEnrollment administrator principalID="admin" onSelected={async () => { selected++; throw new Error('refresh'); }} />));
    await requestDelete(container, FAILED); await click(container, 'Delete Profile');
    expect(container.textContent).toContain(`devryan-${FAILED}`); expect(selected).toBe(0);
    valid = true; await click(container, 'Delete Profile');
    expect(container.textContent).not.toContain(`devryan-${FAILED}`); expect(selected).toBe(1);
    expect(container.find(node => node.getAttribute('role') === 'alert')?.textContent).toBe('Profile deleted, but settings couldn’t refresh. Refresh the page.');
  } finally { await act(async () => root.unmount()); }
}));
