import { describe, expect, test } from 'bun:test';

import { createBrowserDiagnostics } from './browser-diagnostics.js';

const navigate = (diagnostics, requestId, url, statusCode = 200, redirected = false) => {
  diagnostics.recordRequest({
    requestId,
    url,
    type: 'Document',
    mainFrame: true,
    redirected,
  });
  diagnostics.recordResponse({ requestId, url, statusCode });
};

describe('privacy-safe browser diagnostics', () => {
  test('keeps a single-origin login journey healthy', () => {
    let clock = 1_000;
    const diagnostics = createBrowserDiagnostics({ now: () => clock });
    navigate(diagnostics, 'login', 'https://app.hubspot.com/login?token=secret-login');
    clock += 1_000;
    navigate(diagnostics, 'home', 'https://app.hubspot.com/?session=secret-home');
    clock += 1_000;
    navigate(diagnostics, 'contacts', 'https://app.hubspot.com/contacts?access_token=secret-contact');

    const snapshot = diagnostics.snapshot();
    expect(snapshot).toMatchObject({
      revision: 3,
      origin: 'https://app.hubspot.com',
      statusCode: 200,
      repetitionCount: 1,
      kind: 'healthy',
      reason: 'navigation_completed',
      trail: [
        { kind: 'navigation', path: '/login' },
        { kind: 'navigation', path: '/' },
        { kind: 'navigation', path: '/contacts' },
      ],
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('?');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('access_token');
  });

  test('detects a same-path bounce as a navigation loop and masks opaque path segments', () => {
    let clock = 1_000;
    const diagnostics = createBrowserDiagnostics({ now: () => clock });
    const paths = [
      '/login?token=secret-1',
      '/app/550e8400-e29b-41d4-a716-446655440000',
      '/login?token=secret-2',
      '/app/account-123456789',
      '/login?token=secret-3',
    ];
    paths.forEach((path, index) => {
      navigate(diagnostics, `request-${index}`, `https://airtable.com${path}`);
      clock += 1_000;
    });

    const snapshot = diagnostics.snapshot();
    expect(snapshot).toMatchObject({
      revision: 5,
      origin: 'https://airtable.com',
      repetitionCount: 3,
      kind: 'site_rejection',
      reason: 'navigation_loop',
    });
    expect(snapshot.trail.map((entry) => entry.path)).toEqual([
      '/login', '/app/*', '/login', '/app/*', '/login',
    ]);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('550e8400');
    expect(serialized).not.toContain('123456789');
    expect(serialized).not.toContain('secret');
  });

  test('detects a redirect chain that returns to an earlier path', () => {
    const diagnostics = createBrowserDiagnostics({ now: () => 2_000 });
    diagnostics.recordRequest({
      requestId: 'redirect', url: 'https://site.example/login', type: 'Document', mainFrame: true,
    });
    diagnostics.recordRequest({
      requestId: 'redirect', url: 'https://site.example/app', type: 'Document', mainFrame: true, redirected: true,
    });
    diagnostics.recordRequest({
      requestId: 'redirect', url: 'https://site.example/login', type: 'Document', mainFrame: true, redirected: true,
    });
    diagnostics.recordResponse({ requestId: 'redirect', url: 'https://site.example/login', statusCode: 302 });

    expect(diagnostics.snapshot()).toMatchObject({
      kind: 'site_rejection',
      reason: 'navigation_loop',
      redirectCount: 2,
    });
  });

  test('ignores routine aborted main-frame loads', () => {
    const diagnostics = createBrowserDiagnostics({ now: () => 3_000 });
    navigate(diagnostics, 'complete', 'https://site.example/home');
    const before = diagnostics.snapshot();
    diagnostics.recordRequest({
      requestId: 'superseded',
      url: 'https://site.example/submit',
      type: 'Document',
      mainFrame: true,
    });
    diagnostics.recordFailure({ requestId: 'superseded', errorText: 'net::ERR_ABORTED' });
    expect(diagnostics.snapshot()).toEqual(before);

    diagnostics.recordFailure({
      requestId: 'superseded', errorText: 'net::ERR_ABORTED', blockedReason: 'inspector',
    });
    expect(diagnostics.snapshot()).toMatchObject({ kind: 'site_rejection', reason: 'blocked_inspector' });
  });

  test('keeps main-frame identity outside the subresource request LRU', () => {
    const diagnostics = createBrowserDiagnostics({ now: () => 4_000 });
    diagnostics.recordRequest({
      requestId: 'main',
      url: 'https://dashboard.example/home',
      type: 'Document',
      mainFrame: true,
    });
    for (let index = 0; index < 200; index += 1) {
      diagnostics.recordRequest({
        requestId: `asset-${index}`,
        url: `https://cdn.example/assets/${index}.js`,
        type: 'Script',
      });
    }
    diagnostics.recordResponse({ requestId: 'main', statusCode: 200 });
    expect(diagnostics.snapshot()).toMatchObject({
      kind: 'healthy',
      origin: 'https://dashboard.example',
      trail: [{ path: '/home' }],
    });
  });

  test('retains non-actionable main-frame cookie blocks as data without revising the verdict', () => {
    const diagnostics = createBrowserDiagnostics({ now: () => 5_000 });
    navigate(diagnostics, 'page', 'https://site.example/home');
    diagnostics.recordCookieBlock({
      requestId: 'page',
      reasons: ['SameSiteUnspecifiedTreatedAsLax', 'ThirdPartyPhaseout'],
      cookie: { name: 'session', value: 'secret' },
    });
    expect(diagnostics.snapshot()).toMatchObject({
      revision: 1,
      kind: 'healthy',
      cookieBlocks: [
        { path: '/home', reason: 'SameSiteUnspecifiedTreatedAsLax' },
        { path: '/home', reason: 'ThirdPartyPhaseout' },
      ],
    });

    diagnostics.recordCookieBlock({ requestId: 'page', reasons: ['UserPreferences'] });
    expect(diagnostics.snapshot()).toMatchObject({
      revision: 2,
      kind: 'blocked_cookies',
      reason: 'cookie_UserPreferences',
    });
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain('secret');
  });

  test('records bounded dialogs without replacing the navigation verdict', () => {
    const diagnostics = createBrowserDiagnostics({ now: () => 6_000 });
    navigate(diagnostics, 'page', 'https://site.example/account/abcdefghijklmnop?secret=yes');
    diagnostics.recordDialog({
      url: 'https://site.example/account/abcdefghijklmnop?secret=yes',
      type: 'confirm',
      message: `${'Review this action. '.repeat(20)}\n`,
    });
    const snapshot = diagnostics.snapshot();
    expect(snapshot).toMatchObject({
      revision: 2,
      kind: 'healthy',
      dialogs: [{ kind: 'dialog', path: '/account/*', type: 'confirm' }],
    });
    expect(snapshot.dialogs[0].message.length).toBeLessThanOrEqual(160);
    expect(snapshot.trail.at(-1)).toMatchObject({ kind: 'dialog', type: 'confirm' });
  });

  test('reset clears sticky state and keeps revisions monotonic', () => {
    const diagnostics = createBrowserDiagnostics({ now: () => 7_000 });
    navigate(diagnostics, 'first', 'https://site.example/login');
    expect(diagnostics.snapshot()?.revision).toBe(1);
    diagnostics.reset('navigate');
    expect(diagnostics.snapshot()).toBeNull();
    navigate(diagnostics, 'second', 'https://site.example/home');
    expect(diagnostics.snapshot()).toMatchObject({ revision: 3, kind: 'healthy' });
  });

  test('decays a loop only after a newer healthy navigation remains stable', () => {
    let clock = 10_000;
    const diagnostics = createBrowserDiagnostics({ now: () => clock });
    for (const [index, path] of ['/login', '/app', '/login', '/app', '/login'].entries()) {
      navigate(diagnostics, `loop-${index}`, `https://site.example${path}`);
      clock += 1_000;
    }
    expect(diagnostics.snapshot()).toMatchObject({ kind: 'site_rejection', reason: 'navigation_loop' });
    navigate(diagnostics, 'recovered', 'https://site.example/contacts');
    expect(diagnostics.snapshot()).toMatchObject({ kind: 'site_rejection', reason: 'navigation_loop' });
    clock += 60_000;
    expect(diagnostics.snapshot()).toMatchObject({
      kind: 'healthy',
      reason: 'navigation_loop_cleared',
      origin: 'https://site.example',
    });
  });

  test('reports only standardized resource and egress failures', () => {
    const diagnostics = createBrowserDiagnostics({ now: () => 8_000 });
    diagnostics.recordRequest({
      requestId: 'challenge-script',
      url: 'https://challenge.example/assets/private.js?payload=secret',
      type: 'Script',
    });
    diagnostics.recordFailure({
      requestId: 'challenge-script',
      errorText: 'net::ERR_TUNNEL_CONNECTION_FAILED',
      pageText: 'private challenge text',
      coordinates: { x: 1, y: 2 },
    });
    expect(diagnostics.snapshot()).toMatchObject({
      kind: 'subresource_failure',
      reason: 'network_net::ERR_TUNNEL_CONNECTION_FAILED',
      blockedHost: 'challenge.example',
    });

    diagnostics.recordEgressDenied({ host: 'NEEDED.example', statusCode: 403 });
    expect(diagnostics.snapshot()).toMatchObject({
      origin: null,
      statusCode: 403,
      kind: 'egress_denied',
      reason: 'egress_policy_denied',
      blockedHost: 'needed.example',
    });
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain('private challenge text');
  });
});
