import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_PREVIEW_PARTITION_PREFIX,
  createAgentPreviewPartition,
  injectBranchPreviewHeaders,
  normalizeAgentPreviewCredential,
} from '../branch-preview-browser.mjs';

test('agent preview partitions are stable per owner and exact origin', () => {
  const first = createAgentPreviewPartition({
    ownerUserId: 'user-1',
    previewOrigin: 'https://dev1.1health.ae',
  });
  assert.ok(first.startsWith(AGENT_PREVIEW_PARTITION_PREFIX));
  assert.equal(first, createAgentPreviewPartition({
    ownerUserId: 'user-1',
    previewOrigin: 'https://dev1.1health.ae',
  }));
  assert.notEqual(first, createAgentPreviewPartition({
    ownerUserId: 'user-2',
    previewOrigin: 'https://dev1.1health.ae',
  }));
  assert.notEqual(first, createAgentPreviewPartition({
    ownerUserId: 'user-1',
    previewOrigin: 'https://other.example',
  }));
});

test('Cloudflare headers are injected only for matching HTTPS and WSS origins', () => {
  const credential = normalizeAgentPreviewCredential({
    origin: 'https://dev1.1health.ae',
    clientId: 'client.access',
    clientSecret: 'secret',
  }, 'https://dev1.1health.ae');
  const matching = injectBranchPreviewHeaders({
    url: 'https://dev1.1health.ae/assets/app.js',
    requestHeaders: { Accept: '*/*' },
  }, credential);
  assert.equal(matching['CF-Access-Client-Id'], 'client.access');
  assert.equal(matching['CF-Access-Client-Secret'], 'secret');

  const websocket = injectBranchPreviewHeaders({
    url: 'wss://dev1.1health.ae/@vite/client',
    requestHeaders: {},
  }, credential);
  assert.equal(websocket['CF-Access-Client-Id'], 'client.access');

  const foreign = injectBranchPreviewHeaders({
    url: 'https://assets.example/app.js',
    requestHeaders: { Accept: '*/*' },
  }, credential);
  assert.deepEqual(foreign, { Accept: '*/*' });
});

test('credential origin must match the authoritative preview origin', () => {
  assert.throws(() => normalizeAgentPreviewCredential({
    origin: 'https://other.example',
    clientId: 'client.access',
    clientSecret: 'secret',
  }, 'https://dev1.1health.ae'), /branch_preview_credential_invalid/);
});
