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
        browserLeaseObservationSnapshot: ({ leaseIds }) => ({ leases: leaseIds.map((leaseId) => ({ leaseId })) }),
        openBrowserLeaseObservationStream: async () => ({
          contentType: 'multipart/x-mixed-replace; boundary=test-frame',
          body: (async function* stream() {
            yield Buffer.from('--test-frame\r\nContent-Type: image/jpeg\r\n\r\nframe\r\n');
          })(),
        }),
      },
    });
    brokers.push(broker);
    assert.equal(broker.capabilities.includes('browser_observation'), true);
    const client = createDesktopHostBrokerClient({
      getLease: () => ({
        brokerPort: broker.port,
        brokerToken: broker.token,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        capabilities: broker.capabilities,
      }),
    });
    assert.equal((await client.status()).focused, true);
    assert.equal((await client.createBrowserLease({ leaseId: 'lease-1' })).leaseId, 'lease-1');
    assert.deepEqual(await client.browserLeaseObservationSnapshot({ leaseIds: ['lease-1'] }), {
      leases: [{ leaseId: 'lease-1' }],
    });
    const observed = await client.openBrowserLeaseObservationStream({ leaseId: 'lease-1' });
    const chunks = [];
    for await (const chunk of observed.body) chunks.push(Buffer.from(chunk));
    assert.match(Buffer.concat(chunks).toString(), /frame/);
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

  test('fails observation only when an older host did not negotiate the capability', async () => {
    const client = createDesktopHostBrokerClient({
      getLease: () => ({
        brokerPort: 44001,
        brokerToken: 'b'.repeat(43),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        capabilities: ['browser_cdp'],
      }),
      fetchImpl: async () => {
        throw new Error('must not run');
      },
    });
    assert.throws(
      () => client.browserLeaseObservationSnapshot({ leaseIds: ['lease-1'] }),
      (error) => error.code === 'desktop_host_unavailable',
    );
    await assert.rejects(
      client.openBrowserLeaseObservationStream({ leaseId: 'lease-1' }),
      (error) => error.code === 'desktop_host_unavailable',
    );
  });
});
