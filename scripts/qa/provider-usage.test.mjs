import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { providerUsageFixture, setupProviderUsageQa } from './provider-usage.mjs';

test('quota renderer fixtures distinguish unknown and zero without inventing reset rows', () => {
  const unknown = providerUsageFixture('unknown', 1000), zero = providerUsageFixture('zero', 1000);
  assert.equal(unknown.usage.resetCredits.availableCount, null);
  assert.equal(unknown.usage.resetCredits.detailsAvailable, false);
  assert.equal(zero.usage.resetCredits.availableCount, 0);
  assert.deepEqual(zero.usage.resetCredits.credits, []);
  const available = providerUsageFixture('available', 1000);
  assert.equal(available.usage.windows.weekly.windowSeconds, 604800);
  assert.equal(available.usage.resetCredits.availableCount, 3);
  assert.equal(available.usage.resetCredits.credits.length, 1);
});

test('quota transport installs before page load and handles Request inputs and inventory transitions', async () => {
  const commands = [], passthrough = [];
  const location = new URL('http://127.0.0.1:1234/');
  const window = { fetch: async (...args) => { passthrough.push(args); return new Response('original'); } };
  const context = vm.createContext({ window, location, URL, Request, Response, DOMException, Promise });
  const cdp = { send: async (name, input) => {
    commands.push({ name, input });
    if (name === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'fixture-script' };
    if (name === 'Runtime.evaluate') return { result: { value: await vm.runInContext(input.expression, context) } };
    return {};
  } };
  const fixture = await setupProviderUsageQa(cdp);
  assert.equal(commands[0].name, 'Page.addScriptToEvaluateOnNewDocument');
  vm.runInContext(commands[0].input.source, context);
  const fetch = pathname => window.fetch(new Request(new URL(pathname, location)));
  assert.deepEqual(await (await fetch('/api/quota/providers')).json(), { providers: ['codex'] });
  assert.equal((await (await fetch('/api/quota/codex')).json()).usage.resetCredits.availableCount, 3);
  await fixture.setMode('unknown');
  assert.equal((await (await fetch('/api/quota/codex?refresh=true')).json()).usage.resetCredits.availableCount, null);
  await fixture.setMode('zero');
  assert.equal((await (await fetch('/api/quota/codex')).json()).usage.resetCredits.availableCount, 0);
  assert.equal((await (await fetch('/api/quota/codex/connection')).json()).source, 'codex-app-server');
  await fixture.collect();
  assert.equal(fixture.requests.length, 5);
  assert.deepEqual(fixture.modes, ['available', 'unknown', 'zero']);
  assert.deepEqual(fixture.failures, []);
  await window.fetch('/assets/main.js');
  await window.fetch('/api/quota/fixture');
  await window.fetch('http://127.0.0.1:9876/api/quota/codex');
  await window.fetch('/api/quota/codex', { method: 'POST' });
  assert.equal(passthrough.length, 4);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(window.fetch('/api/quota/codex', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(passthrough.length, 4);
  await fixture.close();
  assert.deepEqual(commands.at(-1), { name: 'Page.removeScriptToEvaluateOnNewDocument', input: { identifier: 'fixture-script' } });
  await window.fetch('/api/quota/codex');
  assert.equal(passthrough.length, 5, 'Closing restores ordinary quota requests');
});

test('quota transport does not touch unsupported origins', async () => {
  let source;
  await setupProviderUsageQa({ send: async (_name, input) => { source = input.source; return { identifier: 'fixture' }; } });
  const originalFetch = () => {};
  const window = { fetch: originalFetch };
  vm.runInNewContext(source, { window, location: new URL('about:blank') });
  assert.equal(window.fetch, originalFetch);
});
