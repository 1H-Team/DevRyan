import React, { act } from 'react';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { withDom, HostElement } from '@/components/bots/chat/botMountedDom';
import { settingsDict } from '@/lib/i18n/messages/en.settings';
const dict: Record<string, string> = settingsDict;
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string, values: Record<string, string> = {}) => (dict[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '') }) }));
mock.module('@/components/ui/button', () => ({ Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button onClick={props.onClick} disabled={props.disabled} aria-pressed={props['aria-pressed']}>{props.children}</button> }));
const opened: string[] = [];
let localOrigin = true;
mock.module('@/lib/desktop', () => ({ isDesktopLocalOriginActive: () => localOrigin }));
const actualUrl = await import('@/lib/url');
mock.module('@/lib/url', () => ({ ...actualUrl, openExternalUrl: async (url: string) => { opened.push(url); return true; } }));
const { ChatgptSiwcEnrollment } = await import('./ChatgptSiwcEnrollment');
const originalFetch = globalThis.fetch;
const ID = '11111111-1111-4111-8111-111111111111', REF = '22222222-2222-4222-8222-222222222222';
const signInUrl = 'https://auth.openai.com/api/accounts/authorize?state=fixture';
type Connection = { credentialID: string; methodID: string; email: string; planUsage: boolean; legacy: boolean };
let connected: Connection | null, calls: Array<{ path: string; method: string; body: string; csrf: string | null }>, selected: number;
let beforeComplete = async () => {}, remoteRevocation = 'confirmed', cleanupRequired = false, completedPlanUsage = false;
const onSelected = async () => { selected++; return true; };
beforeEach(() => {
  connected = null; calls = []; selected = 0; opened.length = 0; beforeComplete = async () => {}; remoteRevocation = 'confirmed'; cleanupRequired = false; completedPlanUsage = false; localOrigin = true;
  globalThis.fetch = Object.assign(mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? 'GET';
    calls.push({ path, method, body: String(init?.body ?? ''), csrf: new Headers(init?.headers).get('x-devryan-csrf') });
    if (method === 'GET') return Response.json({ connected, registrations: [{ registrationRef: REF, label: 'Workspace A', email: 'same@example.test', credentialID: connected?.methodID === 'chatgpt-siwc' ? connected.credentialID : null, active: connected?.methodID === 'chatgpt-siwc', cleanupRequired }] });
    if (method === 'DELETE') { connected = null; return Response.json({ success: true, remoteRevocation, localCleanup: 'complete' }); }
    if (path.includes('/complete')) { await beforeComplete(); connected = { credentialID: 'credential-a', methodID: 'chatgpt-siwc', email: 'same@example.test', planUsage: completedPlanUsage, legacy: false }; return Response.json({ enrollmentID: ID, status: 'enrolled', planUsage: completedPlanUsage, credentialID: connected.credentialID, registrationRef: REF }); }
    if (path.includes('/select')) return Response.json({ status: 'selected' });
    return Response.json({ enrollmentID: ID, status: 'pending', url: signInUrl });
  }), { preconnect: () => {} });
});
afterEach(() => { globalThis.fetch = originalFetch; });
const click = async (container: HostElement, text: string) => act(async () => {
  const node = container.find(element => element.tagName === 'BUTTON' && element.textContent === text);
  expect(node).not.toBeNull(); expect(node?.getAttribute('disabled')).toBeNull(); node?.click();
});
const elements = (node: HostElement, predicate: (element: HostElement) => boolean): HostElement[] => [
  ...(predicate(node) ? [node] : []),
  ...node.childNodes.flatMap(child => child instanceof HostElement ? elements(child, predicate) : []),
];

test('healthy account list shows each email once without IDs or success paragraphs and keeps switching', async () => withDom(async container => {
  const secondRef = '33333333-3333-4333-8333-333333333333';
  connected = { credentialID: 'credential-a', methodID: 'chatgpt-siwc', email: 'same@example.test', planUsage: true, legacy: false };
  globalThis.fetch = Object.assign(mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? 'GET';
    calls.push({ path, method, body: String(init?.body ?? ''), csrf: new Headers(init?.headers).get('x-devryan-csrf') });
    if (method === 'GET') return Response.json({ connected, registrations: [
      { registrationRef: REF, label: `same@example.test · ${REF.slice(0, 8)}`, email: 'same@example.test', credentialID: 'credential-a', active: connected?.credentialID === 'credential-a' },
      { registrationRef: secondRef, label: `second@example.test · ${secondRef.slice(0, 8)}`, email: 'second@example.test', credentialID: 'credential-b', active: connected?.credentialID === 'credential-b' },
    ] });
    connected = { credentialID: 'credential-b', methodID: 'chatgpt-siwc', email: 'second@example.test', planUsage: true, legacy: false };
    return Response.json({ success: true, registrationRef: secondRef });
  }), { preconnect: () => {} });
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" catalogReady onSelected={onSelected} />));
    const text = container.textContent;
    expect(text.split('same@example.test')).toHaveLength(2); expect(text.split('second@example.test')).toHaveLength(2);
    for (const removed of ['Connected as', 'plan usage is enabled', 'Selected', REF.slice(0, 8), secondRef.slice(0, 8), 'credential-a']) expect(text).not.toContain(removed);
    expect(elements(container, element => element.getAttribute('role') === 'alert')).toHaveLength(0);
    expect(elements(container, element => element.getAttribute('aria-current') === 'true')).toHaveLength(1);
    expect(elements(container, element => element.tagName === 'BUTTON' && element.textContent === 'Use This Account')).toHaveLength(1);
    const otherAccount = container.find(element => element.tagName === 'BUTTON' && element.textContent === 'Use This Account');
    expect(otherAccount).not.toBeNull();
    await act(async () => otherAccount?.click());
    expect(calls.find(call => call.method === 'POST')).toMatchObject({ path: `/api/provider/openai/siwc/${secondRef}/select`, body: '{"expectedActiveCredentialID":"credential-a"}' });
    expect(container.find(element => element.tagName === 'BUTTON' && element.textContent === 'Disconnect ChatGPT')).not.toBeNull();
    expect(container.textContent).toContain('Add ChatGPT Account'); expect(opened).toHaveLength(0);
  } finally { await act(async () => root.unmount()); }
}));

test('partial active registration and missing catalog collapse into one error and one reconnect action', async () => withDom(async container => {
  connected = { credentialID: 'credential-a', methodID: 'chatgpt-siwc', email: 'same@example.test', planUsage: true, legacy: false }; cleanupRequired = true;
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" catalogReady={false} onSelected={onSelected} />));
    expect(elements(container, element => element.getAttribute('role') === 'alert')).toHaveLength(1);
    expect(elements(container, element => element.tagName === 'BUTTON' && element.textContent === 'Reconnect')).toHaveLength(1);
    expect(container.textContent).toContain('ChatGPT connection is incomplete.');
    expect(container.textContent).not.toContain('OpenAI models are unavailable.');
    expect(container.textContent).not.toContain('Recover Connection'); expect(container.textContent).not.toContain('Retry Loading Models');
    expect(container.textContent).not.toContain('Connection saved.');
    expect(container.textContent).not.toContain('Add ChatGPT Account');
    expect(container.textContent).not.toContain('Use This Account');
  } finally { await act(async () => root.unmount()); }
}));

for (const code of ['native_chatgpt_siwc_reauthorization_required', 'native_chatgpt_siwc_registration_changed']) {
test(`failed staged recovery ${code} makes the next reconnect reauthorize the same registration`, async () => withDom(async container => {
  connected = { credentialID: 'credential-a', methodID: 'chatgpt-siwc', email: 'same@example.test', planUsage: true, legacy: false }; cleanupRequired = true;
  const fetchFixture = globalThis.fetch;
  globalThis.fetch = Object.assign(mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/select')) {
      calls.push({ path: String(input), method: init?.method ?? 'GET', body: String(init?.body ?? ''), csrf: new Headers(init?.headers).get('x-devryan-csrf') });
      return Response.json({ code }, { status: 409 });
    }
    return fetchFixture(input, init);
  }), { preconnect: () => {} });
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" onSelected={onSelected} />));
    await click(container, 'Reconnect');
    expect(container.textContent).toContain('ChatGPT credentials could not be verified.');
    expect(opened).toHaveLength(0);
    await click(container, 'Reconnect');
    const mutations = calls.filter(call => call.method === 'POST');
    expect(mutations[1]).toMatchObject({ path: '/api/provider/openai/siwc', body: JSON.stringify({ registrationRef: REF, expectedActiveCredentialID: 'credential-a' }) });
    expect(opened).toEqual([signInUrl]);
  } finally { await act(async () => root.unmount()); }
}));
}

test('enrollment cleanup failure uses one connection error without claiming sign-out or health', async () => withDom(async container => {
  connected = { credentialID: 'credential-a', methodID: 'chatgpt-siwc', email: 'same@example.test', planUsage: true, legacy: false };
  const fetchFixture = globalThis.fetch;
  globalThis.fetch = Object.assign(mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/complete')) {
      cleanupRequired = true;
      return Response.json({ code: 'native_chatgpt_siwc_cleanup_failed' }, { status: 503 });
    }
    // A cancelled enrollment is not a disconnect of the selected account.
    if (init?.method === 'DELETE' && String(input).includes(ID)) return Response.json({ success: true });
    return fetchFixture(input, init);
  }), { preconnect: () => {} });
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" catalogReady onSelected={onSelected} />));
    await click(container, 'Add ChatGPT Account');
    expect(container.textContent).toContain('ChatGPT connection could not be completed.');
    expect(container.textContent).not.toContain('Local sign-out'); expect(container.textContent).not.toContain('Connection saved.');
    expect(elements(container, element => element.getAttribute('role') === 'alert')).toHaveLength(1);
    expect(elements(container, element => element.tagName === 'BUTTON' && element.textContent === 'Reconnect')).toHaveLength(1);
  } finally { await act(async () => root.unmount()); }
}));

test('reconnect binds refreshed selection and sends inactive cleanup back through existing sign-in', async () => withDom(async container => {
  let reads = 0;
  globalThis.fetch = Object.assign(mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? 'GET';
    calls.push({ path, method, body: String(init?.body ?? ''), csrf: new Headers(init?.headers).get('x-devryan-csrf') });
    if (method === 'GET') return Response.json({ connected: { credentialID: ++reads === 1 ? 'old-selection' : 'new-selection', methodID: '', planUsage: false },
      registrations: [{ registrationRef: REF, label: 'Raw ID · 22222222', email: 'same@example.test', credentialID: null, active: false, cleanupRequired: true }] });
    if (path.includes('/complete')) return Response.json({ code: 'native_chatgpt_siwc_access_denied' }, { status: 403 });
    if (method === 'DELETE') return Response.json({ success: true });
    return Response.json({ enrollmentID: ID, status: 'pending', url: signInUrl });
  }), { preconnect: () => {} });
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" onSelected={onSelected} />));
    await click(container, 'Reconnect');
    expect(calls.find(call => call.method === 'POST')).toMatchObject({ path: '/api/provider/openai/siwc', body: JSON.stringify({ registrationRef: REF, expectedActiveCredentialID: 'new-selection' }) });
    expect(calls.some(call => call.path.includes('/select'))).toBe(false);
    expect(opened).toEqual([signInUrl]); expect(selected).toBe(0);
    expect(elements(container, element => element.getAttribute('role') === 'alert')).toHaveLength(1);
    expect(container.textContent).toContain('ChatGPT sign-in was declined.');
  } finally { await act(async () => root.unmount()); }
}));

test('saved sign-in without plan scope exposes one error and reconnect without billing fallback', async () => withDom(async container => {
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" onSelected={onSelected} />));
    await click(container, 'Continue with ChatGPT');
    expect(container.textContent).toContain('ChatGPT plan usage is not authorized.');
    expect(container.textContent).toContain('Reconnect');
    expect(container.textContent.split('same@example.test')).toHaveLength(2);
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
    await click(container, 'Reconnect');
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
    expect(container.textContent).toContain('same@example.test'); expect(selected).toBe(1);
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
    await click(container, 'Reconnect');
    expect(calls.find(call => call.method === 'POST')?.body).toBe(JSON.stringify({ registrationRef: REF, expectedActiveCredentialID: 'key-a' }));
  } finally { await act(async () => root.unmount()); }
}));

test('explicit API-key changes refresh authoritative status without selecting a saved ChatGPT registration', async () => withDom(async container => {
  connected = { credentialID: 'credential-a', methodID: 'chatgpt-siwc', email: 'same@example.test', planUsage: true, legacy: false };
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" refreshRevision={0} onSelected={onSelected} />));
    expect(container.find(element => element.getAttribute('aria-current') === 'true')).not.toBeNull();
    connected = { credentialID: 'key-a', methodID: '', email: '', planUsage: false, legacy: false };
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" refreshRevision={1} onSelected={onSelected} />));
    expect(container.find(element => element.getAttribute('aria-current') === 'true')).toBeNull();
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
    expect(container.textContent).toContain('same@example.test'); expect(selected).toBe(0);
    expect(container.textContent).not.toContain('Signed in');
  } finally { await act(async () => root.unmount()); }
}));

test('saved sign-in catalog failure reconnects status and models without reenrollment', async () => withDom(async container => {
  completedPlanUsage = true;
  let attempts = 0;
  const discover = async () => { if (++attempts === 1) throw new Error('catalog unavailable'); return true; };
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" onSelected={discover} />));
    await click(container, 'Continue with ChatGPT');
    expect(container.textContent).toContain('same@example.test');
    expect(container.textContent).toContain('OpenAI models are unavailable.');
    expect(container.textContent).not.toContain('could not be completed');
    await click(container, 'Reconnect');
    expect(container.textContent).not.toContain('OpenAI models are unavailable.');
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(2);
    expect(opened).toHaveLength(1); expect(attempts).toBe(2);
  } finally { await act(async () => root.unmount()); }
}));

test('bounded catalog delay remains recoverable after enrollment', async () => withDom(async container => {
  completedPlanUsage = true;
  connected = { credentialID: 'credential-a', methodID: 'chatgpt-siwc', email: 'same@example.test', planUsage: true, legacy: false };
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" onSelected={async () => false} />));
    await click(container, 'Add ChatGPT Account');
    expect(container.textContent).toContain('same@example.test');
    expect(container.textContent).toContain('Reconnect');
    expect(container.textContent).not.toContain('could not be completed');
  } finally { await act(async () => root.unmount()); }
}));

test('active staged registration exposes recovery through its existing opaque reference', async () => withDom(async container => {
  connected = { credentialID: 'credential-a', methodID: 'chatgpt-siwc', email: 'same@example.test', planUsage: true, legacy: false }; cleanupRequired = true;
  const fetchFixture = globalThis.fetch;
  globalThis.fetch = Object.assign(mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/select')) cleanupRequired = false;
    return fetchFixture(input, init);
  }), { preconnect: () => {} });
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" onSelected={onSelected} />));
    expect(container.textContent).toContain('ChatGPT connection is incomplete.');
    await click(container, 'Reconnect');
    expect(calls.find(call => call.method === 'POST')?.body).toBe(JSON.stringify({ expectedActiveCredentialID: 'credential-a' }));
    expect(calls.find(call => call.method === 'POST')?.path).toBe(`/api/provider/openai/siwc/${REF}/select`);
    expect(opened).toHaveLength(0);
    expect(container.textContent).not.toContain('ChatGPT connection is incomplete.');
  } finally { await act(async () => root.unmount()); }
}));

test('remote administrators receive local-enrollment guidance without controls or native status requests', async () => withDom(async container => {
  localOrigin = false;
  Object.defineProperty(window, 'location', { value: { origin: 'https://fixture.example.test' }, configurable: true });
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" onSelected={onSelected} />));
    expect(container.textContent).toContain('Open DevRyan on this computer');
    expect(container.find(element => element.tagName === 'BUTTON')).toBeNull(); expect(calls).toHaveLength(0);
  } finally { await act(async () => root.unmount()); }
}));

test('server local-only denial has a specific recovery message', async () => withDom(async container => {
  globalThis.fetch = Object.assign(mock(async () => Response.json({ code: 'native_chatgpt_siwc_local_required' }, { status: 403 })), { preconnect: () => {} });
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" onSelected={onSelected} />));
    expect(container.textContent).toContain('Open DevRyan on this computer');
    expect(container.textContent).not.toContain('could not be completed');
  } finally { await act(async () => root.unmount()); }
}));

test('local browser origin retains sign-in controls without a desktop bridge', async () => withDom(async container => {
  localOrigin = false;
  Object.defineProperty(window, 'location', { value: { origin: 'http://127.0.0.1:12345' }, configurable: true });
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" onSelected={onSelected} />));
    expect(container.textContent).toContain('Continue with ChatGPT'); expect(calls).toHaveLength(1);
  } finally { await act(async () => root.unmount()); }
}));

test('successful sign-in status refresh failure stays separate from authentication failure', async () => withDom(async container => {
  const fetchFixture = globalThis.fetch;
  globalThis.fetch = Object.assign(mock(async (input: RequestInfo | URL, init?: RequestInit) => connected && (init?.method ?? 'GET') === 'GET'
    ? Response.json({ code: 'fixture_status_unavailable' }, { status: 503 }) : fetchFixture(input, init)), { preconnect: () => {} });
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" onSelected={onSelected} />));
    await click(container, 'Continue with ChatGPT');
    expect(container.textContent).toContain('ChatGPT connection status is unavailable.');
    expect(container.textContent).not.toContain('could not be completed');
    expect(selected).toBe(1); expect(connected?.credentialID).toBe('credential-a');
  } finally { await act(async () => root.unmount()); }
}));

test('catalog refresh receives scope cancellation and cannot update a replacement principal', async () => withDom(async container => {
  completedPlanUsage = true;
  let release: (() => void) | undefined, signal: AbortSignal | undefined;
  const refreshCatalog = async (_connection: { planUsage: boolean } | null | undefined, scopeSignal: AbortSignal) => {
    signal = scopeSignal;
    await new Promise<void>(resolve => { release = resolve; });
    return false;
  };
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" onSelected={refreshCatalog} />));
    await click(container, 'Continue with ChatGPT');
    expect(container.textContent).toContain('same@example.test');
    expect(container.textContent).not.toContain('Connection saved.');
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator={false} principalID="other" onSelected={refreshCatalog} />));
    expect(signal?.aborted).toBe(true);
    await act(async () => { release?.(); });
    expect(container.textContent).toBe('');
  } finally { await act(async () => root.unmount()); }
}));

test('existing plan sign-in exposes reconnect when catalogs are unavailable after remount', async () => withDom(async container => {
  completedPlanUsage = true;
  connected = { credentialID: 'credential-a', methodID: 'chatgpt-siwc', email: 'same@example.test', planUsage: true, legacy: false };
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" catalogReady={false} onSelected={onSelected} />));
    expect(container.textContent).toContain('OpenAI models are unavailable.');
    await act(async () => root.render(<ChatgptSiwcEnrollment administrator principalID="admin" catalogReady onSelected={onSelected} />));
    expect(container.textContent).not.toContain('OpenAI models are unavailable.');
    expect(container.textContent).not.toContain('Reconnect');
    expect(calls.every(call => call.method === 'GET')).toBe(true); expect(opened).toHaveLength(0); expect(selected).toBe(0);
  } finally { await act(async () => root.unmount()); }
}));
