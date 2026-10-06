import React, { act } from 'react';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { withDom, type HostElement } from '@/components/bots/chat/botMountedDom';
import { settingsDict } from '@/lib/i18n/messages/en.settings';
const dict: Record<string, string> = settingsDict;
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string, values: Record<string, string> = {}) => (dict[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '') }) }));
mock.module('@/components/ui/button', () => ({ Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button onClick={props.onClick} disabled={props.disabled}>{props.children}</button> }));
const opened: string[] = [];
const actualUrl = await import('@/lib/url');
mock.module('@/lib/url', () => ({ ...actualUrl, openExternalUrl: async (url: string) => { opened.push(url); return true; } }));
const { ChatgptSiwcEnrollment } = await import('./ChatgptSiwcEnrollment');
const originalFetch = globalThis.fetch;
const ID = '11111111-1111-4111-8111-111111111111', REF = '22222222-2222-4222-8222-222222222222';
const signInUrl = 'https://auth.openai.com/api/accounts/authorize?state=fixture';
type Connection = { credentialID: string; methodID: string; email: string; planUsage: boolean; legacy: boolean };
let connected: Connection | null, calls: Array<{ path: string; method: string; body: string; csrf: string | null }>, selected: number;
let beforeComplete = async () => {}, remoteRevocation = 'confirmed';
const onSelected = async () => { selected++; };
beforeEach(() => {
  connected = null; calls = []; selected = 0; opened.length = 0; beforeComplete = async () => {}; remoteRevocation = 'confirmed';
  globalThis.fetch = Object.assign(mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? 'GET';
    calls.push({ path, method, body: String(init?.body ?? ''), csrf: new Headers(init?.headers).get('x-devryan-csrf') });
    if (method === 'GET') return Response.json({ connected, registrations: [{ registrationRef: REF, label: 'Workspace A', email: 'same@example.test', credentialID: connected?.methodID === 'chatgpt-siwc' ? connected.credentialID : null, active: connected?.methodID === 'chatgpt-siwc' }] });
    if (method === 'DELETE') { connected = null; return Response.json({ success: true, remoteRevocation, localCleanup: 'complete' }); }
    if (path.includes('/complete')) { await beforeComplete(); connected = { credentialID: 'credential-a', methodID: 'chatgpt-siwc', email: 'same@example.test', planUsage: false, legacy: false }; return Response.json({ enrollmentID: ID, status: 'enrolled', planUsage: false, credentialID: connected.credentialID, registrationRef: REF }); }
    if (path.includes('/select')) return Response.json({ status: 'selected' });
    return Response.json({ enrollmentID: ID, status: 'pending', url: signInUrl });
  }), { preconnect: () => {} });
});
afterEach(() => { globalThis.fetch = originalFetch; });
const click = async (container: HostElement, text: string) => act(async () => {
  const node = container.find(element => element.tagName === 'BUTTON' && element.textContent === text);
  expect(node).not.toBeNull(); expect(node?.getAttribute('disabled')).toBeNull(); node?.click();
});

test('successful sign-in without plan scope stays signed in with explicit reauthorization and no billing fallback', async () => withDom(async container => {
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" onSelected={onSelected} />));
    await click(container, 'Continue with ChatGPT');
    expect(container.textContent).toContain('ChatGPT plan usage is not enabled');
    expect(container.textContent).toContain('Authorize Plan Usage');
    expect(calls.find(call => call.method === 'POST')?.body).toBe('{}');
    expect(selected).toBe(1); expect(opened).toEqual([signInUrl]);
    expect(calls.filter(call => call.method !== 'GET').every(call => call.csrf === '1')).toBe(true);
    expect(calls.every(call => call.path.startsWith('/api/provider/openai/siwc'))).toBe(true);
  } finally { await act(async () => root.unmount()); }
}));

test('returning registration sends only opaque reference and expected active identity', async () => withDom(async container => {
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" directory="/owned/project" onSelected={onSelected} />));
    await click(container, 'Sign In Again');
    expect(calls.find(call => call.method === 'POST')?.body).toBe(JSON.stringify({ registrationRef: REF, expectedActiveCredentialID: null }));
    expect(calls.every(call => call.path.endsWith('?directory=%2Fowned%2Fproject'))).toBe(true);
  } finally { await act(async () => root.unmount()); }
}));

test('cancel is usable during pending browser consent and ignores a late completion', async () => withDom(async container => {
  let release: (() => void) | undefined; beforeComplete = () => new Promise<void>(resolve => { release = resolve; });
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" onSelected={onSelected} />));
    await click(container, 'Continue with ChatGPT'); await click(container, 'Cancel Sign-In');
    await act(async () => { release?.(); });
    expect(calls.some(call => call.path === `/api/provider/openai/siwc/${ID}` && call.method === 'DELETE')).toBe(true);
    expect(selected).toBe(0); expect(container.textContent).not.toContain('Connected as');
  } finally { await act(async () => root.unmount()); }
}));

test('disconnect binds selected identity and reports unconfirmed revocation while preserving registration', async () => withDom(async container => {
  connected = { credentialID: 'credential-a', methodID: 'chatgpt-siwc', email: 'same@example.test', planUsage: true, legacy: false }; remoteRevocation = 'unconfirmed';
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" onSelected={onSelected} />));
    await click(container, 'Disconnect ChatGPT');
    expect(calls.find(call => call.method === 'DELETE')?.body).toBe(JSON.stringify({ expectedActiveCredentialID: 'credential-a' }));
    expect(container.textContent).toContain('Remote revocation could not be confirmed');
    expect(container.textContent).toContain('Workspace A'); expect(selected).toBe(1);
  } finally { await act(async () => root.unmount()); }
}));

test('principal replacement aborts pending consent and ignores its late completion', async () => withDom(async container => {
  let release: (() => void) | undefined; beforeComplete = () => new Promise<void>(resolve => { release = resolve; });
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" onSelected={onSelected} />));
    await click(container, 'Continue with ChatGPT');
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator={false} principalID="other" onSelected={onSelected} />));
    await act(async () => { release?.(); });
    expect(container.textContent).toBe(''); expect(selected).toBe(0);
  } finally { await act(async () => root.unmount()); }
}));

test('saved account selection uses native credential reference without sending account metadata', async () => withDom(async container => {
  globalThis.fetch = Object.assign(mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? 'GET';
    calls.push({ path, method, body: String(init?.body ?? ''), csrf: new Headers(init?.headers).get('x-devryan-csrf') });
    if (method === 'GET') return Response.json({ connected: null, registrations: [{ registrationRef: REF, label: 'Workspace B', email: 'same@example.test', credentialID: 'credential-b', active: false }] });
    return Response.json({ status: 'selected' });
  }), { preconnect: () => {} });
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" onSelected={onSelected} />));
    await click(container, 'Use This Account');
    expect(calls.find(call => call.method === 'POST')).toEqual({ path: `/api/provider/openai/siwc/${REF}/select`, method: 'POST', body: '{"expectedActiveCredentialID":null}', csrf: '1' });
    expect(opened).toHaveLength(0); expect(selected).toBe(1);
  } finally { await act(async () => root.unmount()); }
}));

test('API-key selection is never presented as a ChatGPT sign-in and remains the CAS expectation', async () => withDom(async container => {
  connected = { credentialID: 'key-a', methodID: '', email: '', planUsage: false, legacy: false };
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" onSelected={onSelected} />));
    expect(container.textContent).not.toContain('Signed in with ChatGPT.');
    expect(container.find(element => element.tagName === 'BUTTON' && element.textContent === 'Disconnect ChatGPT')).toBeNull();
    await click(container, 'Sign In Again');
    expect(calls.find(call => call.method === 'POST')?.body).toBe(JSON.stringify({ registrationRef: REF, expectedActiveCredentialID: 'key-a' }));
  } finally { await act(async () => root.unmount()); }
}));

test('explicit API-key changes refresh authoritative status without selecting a saved ChatGPT registration', async () => withDom(async container => {
  connected = { credentialID: 'credential-a', methodID: 'chatgpt-siwc', email: 'same@example.test', planUsage: true, legacy: false };
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" refreshRevision={0} onSelected={onSelected} />));
    expect(container.textContent).toContain('Connected as');
    connected = { credentialID: 'key-a', methodID: '', email: '', planUsage: false, legacy: false };
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" refreshRevision={1} onSelected={onSelected} />));
    expect(container.textContent).not.toContain('Connected as');
    expect(calls).toHaveLength(2); expect(calls.every(call => call.method === 'GET')).toBe(true); expect(selected).toBe(0);
  } finally { await act(async () => root.unmount()); }
}));

test('failed local cleanup and unconfirmed remote revocation remain visible without claiming sign-out', async () => withDom(async container => {
  connected = { credentialID: 'credential-a', methodID: 'chatgpt-siwc', email: 'same@example.test', planUsage: true, legacy: false };
  const fetchStatus = globalThis.fetch;
  globalThis.fetch = Object.assign(mock(async (input: RequestInfo | URL, init?: RequestInit) => init?.method === 'DELETE'
    ? Response.json({ code: 'native_chatgpt_siwc_cleanup_failed', remoteRevocation: 'unconfirmed', localCleanup: 'failed' }, { status: 503 })
    : fetchStatus(input, init)), { preconnect: () => {} });
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" onSelected={onSelected} />));
    await click(container, 'Disconnect ChatGPT');
    expect(container.textContent).toContain('Local sign-out failed and remote revocation could not be confirmed');
    expect(container.textContent).toContain('Connected as'); expect(selected).toBe(0);
  } finally { await act(async () => root.unmount()); }
}));
