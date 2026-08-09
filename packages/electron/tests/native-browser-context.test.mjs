import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MANUAL_BROWSER_PARTITION_PREFIX,
  createManualBrowserContext,
  readAuthorizedBrowserPrincipal,
} from '../native-browser-context.mjs';

test('native Browser authorization requires an authenticated browser-capable principal', () => {
  assert.deepEqual(readAuthorizedBrowserPrincipal({
    authenticated: true,
    principal: { id: 'developer-1', policy: { browser: true } },
  }), { id: 'developer-1' });
  assert.equal(readAuthorizedBrowserPrincipal({
    authenticated: true,
    principal: { id: 'developer-1', policy: { browser: false } },
  }), null);
  assert.equal(readAuthorizedBrowserPrincipal({ authenticated: false }), null);
  assert.equal(readAuthorizedBrowserPrincipal({ authenticated: true, principal: { policy: { browser: true } } }), null);
});

test('manual Browser partitions are stable per canonical host and user', () => {
  const first = createManualBrowserContext({ origin: 'https://devryan.example/path', principalId: 'developer-1' });
  const same = createManualBrowserContext({ origin: 'https://devryan.example/other', principalId: 'developer-1' });
  const otherUser = createManualBrowserContext({ origin: 'https://devryan.example', principalId: 'developer-2' });
  const otherHost = createManualBrowserContext({ origin: 'https://other.example', principalId: 'developer-1' });

  assert.equal(first.contextKey, same.contextKey);
  assert.equal(first.partition, same.partition);
  assert.ok(first.partition.startsWith(MANUAL_BROWSER_PARTITION_PREFIX));
  assert.notEqual(first.partition, otherUser.partition);
  assert.notEqual(first.partition, otherHost.partition);
  assert.doesNotMatch(first.partition, /developer|example/);
});

test('manual Browser context rejects invalid origins and missing principals', () => {
  assert.throws(() => createManualBrowserContext({ origin: 'file:///tmp/app', principalId: 'user-1' }));
  assert.throws(() => createManualBrowserContext({ origin: 'https://devryan.example', principalId: '' }));
});
