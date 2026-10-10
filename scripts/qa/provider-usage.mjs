import assert from 'node:assert/strict';
import { evaluate } from './cdp.mjs';
import { createQaUiDriver } from './ui-driver.mjs';

export function providerUsageFixture(mode = 'available', now = Date.now()) {
  const window = { usedPercent: 37, remainingPercent: 63, windowSeconds: 604800,
    resetAfterSeconds: 86400, resetAt: now + 86400000, resetAtFormatted: 'Tomorrow', resetAfterFormatted: '1d' };
  return { providerId: 'codex', providerName: 'ChatGPT', ok: true, configured: true, fetchedAt: now,
    source: 'codex-app-server', connectionId: 'fixture-usage-account', account: { email: 'usage@example.invalid', planType: 'plus' },
    usage: { windows: { weekly: window }, resetCredits: { availableCount: mode === 'unknown' ? null : mode === 'zero' ? 0 : 3,
      totalEarnedCount: null, source: 'usage', detailsAvailable: mode !== 'unknown',
      credits: mode === 'available' ? [{ id: 'fixture-reset', status: 'available', resetType: 'weekly',
        grantedAt: null, grantedAtFormatted: null, expiresAt: now + 604800000, expiresAtFormatted: 'Fixture expiry' }] : [] } } };
}

// Install before modules mount so initial quota discovery sees the synthetic source.
// Keep Chromium request interception disabled: it disrupts module loads in this QA shell.
export async function setupProviderUsageQa(cdp) {
  const modes = Object.fromEntries(['available', 'unknown', 'zero'].map(mode => [mode, providerUsageFixture(mode)]));
  const key = '__DEVRYAN_QA_PROVIDER_USAGE__';
  const source = `(() => {
    if (location.protocol !== 'http:' || location.hostname !== '127.0.0.1') return;
    const modes = ${JSON.stringify(modes)};
    const state = { mode: 'available', requests: [], modes: ['available'], closed: false };
    window[${JSON.stringify(key)}] = state;
    const originalFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
      if (state.closed) return originalFetch(input, init);
      const request = input instanceof Request ? input : null;
      const url = new URL(request ? request.url : String(input), location.href);
      const method = String(init?.method ?? request?.method ?? 'GET').toUpperCase();
      if (url.origin !== location.origin || method !== 'GET') return originalFetch(input, init);
      const result = modes[state.mode];
      const payload = url.pathname === '/api/quota/providers' ? { providers: ['codex'] }
        : url.pathname === '/api/quota/codex/connection' ? { available: true, configured: true,
          source: result.source, connectionId: result.connectionId, account: result.account, login: null }
        : url.pathname === '/api/quota/codex' ? result : undefined;
      if (!payload) return originalFetch(input, init);
      const signal = init?.signal ?? request?.signal;
      if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      if (state.requests.length < 500) state.requests.push(url.pathname);
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200,
        headers: { 'Content-Type': 'application/json' } }));
    };
  })()`;
  const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
  const requests = [];
  const observedModes = [];
  return { requests, failures: [], modes: observedModes,
    setMode: async mode => {
      assert.ok(Object.hasOwn(modes, mode));
      await evaluate(cdp, `(() => { const state = window[${JSON.stringify(key)}];
        if (!state) throw new Error('Quota fixture not installed');
        state.mode = ${JSON.stringify(mode)}; state.modes.push(${JSON.stringify(mode)}); })()`);
    },
    collect: async () => {
      const state = await evaluate(cdp, `window[${JSON.stringify(key)}]`);
      if (state) { requests.splice(0, requests.length, ...state.requests); observedModes.splice(0, observedModes.length, ...state.modes); }
    },
    close: async () => {
      await evaluate(cdp, `if (window[${JSON.stringify(key)}]) window[${JSON.stringify(key)}].closed = true`);
      await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    },
  };
}

export async function runProviderUsageQa({ cdp, check, screenshot, fixture }) {
  const ui = createQaUiDriver(cdp);
  await ui.key(',', { code: 'Comma', modifiers: process.platform === 'darwin' ? 4 : 2, windowsVirtualKeyCode: 188 });
  await ui.click({ text: 'Providers', exact: false, selector: 'button' });
  await ui.waitExpression('usage-only ChatGPT provider', `document.body.innerText.includes('ChatGPT')`);
  await ui.click({ text: 'ChatGPT', exact: false, selector: 'button' });
  await check('weekly usage, source identity and reset expiry render', async () => {
    await ui.waitExpression('weekly reset bank', `document.body.innerText.includes('Reset Bank') && document.body.innerText.includes('3 available')`);
    const text = await evaluate(cdp, 'document.body.innerText');
    assert.match(text, /usage@example\.invalid/);
    assert.match(text, /Weekly/i);
    assert.match(text, /Fixture expiry/);
    assert.equal(await evaluate(cdp, 'document.documentElement.scrollWidth > innerWidth + 1'), false);
    await screenshot('provider-usage-available');
  });
  for (const next of ['unknown', 'zero']) {
    await fixture.setMode(next);
    await check(`reset inventory ${next} renders distinctly`, async () => {
      await ui.click({ label: 'Refresh Usage', selector: 'button' });
      await ui.waitExpression(`reset ${next}`, next === 'unknown'
        ? `document.body.innerText.includes('Unavailable') && !document.body.innerText.includes('3 available')`
        : `document.body.innerText.includes('0 available') && !document.body.innerText.includes('Expiry details unavailable.')`);
      await screenshot(`provider-usage-${next}`);
    });
  }
  await fixture.collect();
  assert.deepEqual(fixture.failures, []);
  assert.deepEqual(fixture.modes, ['available', 'unknown', 'zero']);
  assert.ok(fixture.requests.includes('/api/quota/providers') && fixture.requests.includes('/api/quota/codex'));
  await ui.click({ text: 'Back', selector: 'button' });
  return { source: 'synthetic quota transport with built product UI', requests: fixture.requests.length, modes: fixture.modes, liveProvider: false };
}
