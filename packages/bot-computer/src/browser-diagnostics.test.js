import { describe, expect, test } from 'bun:test';

import { createBrowserDiagnostics } from './browser-diagnostics.js';

describe('privacy-safe browser diagnostics', () => {
  test('detects a same-origin navigation loop without retaining URL details', () => {
    let clock = 1_000;
    const diagnostics = createBrowserDiagnostics({ now: () => clock });
    for (let index = 1; index <= 3; index += 1) {
      diagnostics.recordRequest({
        requestId: `request-${index}`,
        url: `https://airtable.com/private/challenge?token=secret-${index}`,
        type: 'Document',
        mainFrame: true,
        redirected: index > 1,
        headers: { cookie: 'must-not-be-retained' },
      });
      diagnostics.recordResponse({
        requestId: `request-${index}`,
        url: `https://airtable.com/private/challenge?token=secret-${index}`,
        statusCode: 200,
      });
      clock += 1_000;
    }

    const snapshot = diagnostics.snapshot();
    expect(snapshot).toMatchObject({
      revision: 3,
      origin: 'https://airtable.com',
      statusCode: 200,
      repetitionCount: 3,
      kind: 'site_rejection',
      reason: 'navigation_loop',
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('/private');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('cookie');
  });

  test('reports only standardized cookie, resource, and egress failures', () => {
    const diagnostics = createBrowserDiagnostics({ now: () => 2_000 });
    diagnostics.recordRequest({
      requestId: 'challenge-script',
      url: 'https://challenge.example/assets/private.js?payload=secret',
      type: 'Script',
    });
    diagnostics.recordCookieBlock({
      requestId: 'challenge-script',
      reasons: ['SameSiteUnspecifiedTreatedAsLax'],
      cookie: { name: 'session', value: 'secret' },
    });
    expect(diagnostics.snapshot()).toBeNull();

    diagnostics.recordRequest({
      requestId: 'challenge-page',
      url: 'https://challenge.example/private/challenge?token=secret',
      type: 'Document',
      mainFrame: true,
    });
    diagnostics.recordCookieBlock({
      requestId: 'challenge-page',
      reasons: ['ThirdPartyPhaseout', 'UserPreferences'],
      cookie: { name: 'session', value: 'secret' },
    });
    expect(diagnostics.snapshot()).toMatchObject({
      origin: 'https://challenge.example',
      kind: 'blocked_cookies',
      reason: 'cookie_UserPreferences',
      blockedHost: null,
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

  test('routine cookie filtering never clobbers a healthy navigation', () => {
    const diagnostics = createBrowserDiagnostics({ now: () => 3_000 });
    diagnostics.recordRequest({
      requestId: 'page',
      url: 'https://site.example/home',
      type: 'Document',
      mainFrame: true,
    });
    diagnostics.recordResponse({ requestId: 'page', url: 'https://site.example/home', statusCode: 200 });
    expect(diagnostics.snapshot()).toMatchObject({ kind: 'healthy', reason: 'navigation_completed' });

    // Engine-default filtering on the main frame is not actionable.
    diagnostics.recordCookieBlock({ requestId: 'page', reasons: ['ThirdPartyPhaseout'] });
    // A settings-driven block on a subresource is not actionable either.
    diagnostics.recordRequest({ requestId: 'tracker', url: 'https://ads.example/pixel', type: 'Image' });
    diagnostics.recordCookieBlock({ requestId: 'tracker', reasons: ['UserPreferences'] });
    expect(diagnostics.snapshot()).toMatchObject({ kind: 'healthy', reason: 'navigation_completed', revision: 1 });
  });
});
