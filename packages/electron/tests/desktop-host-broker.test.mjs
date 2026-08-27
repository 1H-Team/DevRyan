import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  createDesktopHostBroker,
  createDesktopHostBrokerClient,
} from '../desktop-host-broker.mjs';

const brokers = [];

afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
});

describe('short-lived desktop-host broker', () => {
  test('routes only fixed authenticated browser and native operations over loopback', async () => {
    const calls = [];
    const broker = await createDesktopHostBroker({
      handlers: {
        status: () => ({ focused: true, browser: { state: 'lease_required' } }),
        notify: (payload) => calls.push(['notify', payload]),
        createBrowserLease: (payload) => ({ ok: true, leaseId: payload.leaseId }),
        touchBrowserLease: (payload) => ({ ok: true, leaseId: payload.leaseId }),
        releaseBrowserLease: (payload) => ({ ok: true, leaseId: payload.leaseId }),
      },
    });
    brokers.push(broker);
    const client = createDesktopHostBrokerClient({
      getLease: () => ({
        brokerPort: broker.port,
        brokerToken: broker.token,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      }),
    });
    assert.equal((await client.status()).focused, true);
    assert.equal((await client.createBrowserLease({ leaseId: 'lease-1' })).leaseId, 'lease-1');
    await client.notify({ title: 'Bot finished', body: 'Ready' });
    assert.deepEqual(calls, [['notify', { title: 'Bot finished', body: 'Ready' }]]);

    const rejected = await fetch(`http://127.0.0.1:${broker.port}/v1/status`, {
      headers: {
        Authorization: `Bearer ${'x'.repeat(43)}`,
        'X-DevRyan-Desktop-Host-Version': '1',
      },
    });
    assert.equal(rejected.status, 401);
  });

  test('fails explicitly after the capability lease expires and never falls back', async () => {
    const client = createDesktopHostBrokerClient({
      getLease: () => ({
        brokerPort: 44001,
        brokerToken: 'b'.repeat(43),
        expiresAt: new Date(Date.now() - 1).toISOString(),
      }),
      fetchImpl: async () => {
        throw new Error('must not run');
      },
    });
    await assert.rejects(
      client.status(),
      (error) => error.code === 'desktop_host_unavailable',
    );
  });
});
