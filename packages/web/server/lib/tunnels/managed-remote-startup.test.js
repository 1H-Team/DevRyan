import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { startCloudflareManagedRemoteTunnel } from '../cloudflare-tunnel.js';
import { ManagedRemoteOriginRelayError } from './origin-relay.js';
import { ManagedRemotePublicReachabilityError } from './public-reachability.js';

const TOKEN = `eyJ${'a'.repeat(80)}`;

const createChild = (order) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 1234;
  child.kill = vi.fn((signal) => {
    order.push(`connector-${signal}`);
    child.exitCode = 0;
    queueMicrotask(() => child.emit('exit', 0));
    return true;
  });
  return child;
};

const createOptions = ({ order, relay, verifyPublicReachability }) => {
  const child = createChild(order);
  const spawnManagedConnector = vi.fn(() => {
    order.push('connector-start');
    queueMicrotask(() => child.stderr.emit('data', Buffer.from('INF Registered tunnel connection\n')));
    return child;
  });
  return {
    child,
    options: {
      token: TOKEN,
      hostname: 'app.example.com',
      activePort: 57123,
      originPort: 3000,
      runtimeInstanceId: 'instance-id',
      checkAvailability: vi.fn(async () => ({ available: true, path: '/bin/cloudflared' })),
      startOriginRelay: vi.fn(async () => {
        order.push('relay-start');
        return relay;
      }),
      spawnManagedConnector,
      verifyPublicReachability,
    },
    spawnManagedConnector,
  };
};

describe('managed remote Cloudflare startup lifecycle', () => {
  it('starts the relay first, verifies publicly, and stops the relay after connector exit', async () => {
    const order = [];
    const relay = {
      active: true,
      stop: vi.fn(async () => { order.push('relay-stop'); return true; }),
    };
    const verify = vi.fn(async () => { order.push('public-verified'); return { verified: true }; });
    const harness = createOptions({ order, relay, verifyPublicReachability: verify });

    const controller = await startCloudflareManagedRemoteTunnel(harness.options);

    expect(order.slice(0, 3)).toEqual(['relay-start', 'connector-start', 'public-verified']);
    expect(controller.getDiagnostics()).toMatchObject({
      cloudflareOriginUrl: 'http://127.0.0.1:3000',
      activeOriginUrl: 'http://127.0.0.1:57123',
      originRelayActive: true,
      publicReachabilityVerified: true,
    });

    await controller.stop();
    expect(order.indexOf('connector-SIGINT')).toBeLessThan(order.indexOf('relay-stop'));
  });

  it('cleans up both connector and relay when public verification fails', async () => {
    const order = [];
    const relay = {
      active: true,
      stop: vi.fn(async () => { order.push('relay-stop'); return true; }),
    };
    const verificationError = new ManagedRemotePublicReachabilityError('unreachable', {
      cloudflareOriginUrl: 'http://127.0.0.1:3000',
      activeOriginUrl: 'http://127.0.0.1:57123',
    });
    const harness = createOptions({
      order,
      relay,
      verifyPublicReachability: vi.fn(async () => { throw verificationError; }),
    });

    await expect(startCloudflareManagedRemoteTunnel(harness.options)).rejects.toBe(verificationError);
    expect(harness.child.kill).toHaveBeenCalledWith('SIGINT');
    expect(relay.stop).toHaveBeenCalled();
    expect(JSON.stringify(verificationError)).not.toContain(TOKEN);
  });

  it('does not launch cloudflared when the fixed origin port is occupied', async () => {
    const order = [];
    const relayError = new ManagedRemoteOriginRelayError(
      'managed_remote_origin_port_in_use',
      'origin occupied',
      { cloudflareOriginUrl: 'http://127.0.0.1:3000' },
    );
    const harness = createOptions({
      order,
      relay: null,
      verifyPublicReachability: vi.fn(),
    });
    harness.options.startOriginRelay = vi.fn(async () => { throw relayError; });

    await expect(startCloudflareManagedRemoteTunnel(harness.options)).rejects.toBe(relayError);
    expect(harness.spawnManagedConnector).not.toHaveBeenCalled();
  });

  it('retries once over HTTP/2 when QUIC cannot reach the Cloudflare edge', async () => {
    const order = [];
    const relay = {
      active: true,
      stop: vi.fn(async () => { order.push('relay-stop'); return true; }),
    };
    const autoChild = createChild(order);
    const http2Child = createChild(order);
    const spawnManagedConnector = vi.fn((args) => {
      const child = spawnManagedConnector.mock.calls.length === 1 ? autoChild : http2Child;
      queueMicrotask(() => child.stderr.emit('data', Buffer.from(
        child === autoChild
          ? 'ERR failed to dial edge with quic: timeout: no recent network activity\nINF Registered tunnel connection\n'
          : 'INF Registered tunnel connection\n',
      )));
      return child;
    });
    const verifyPublicReachability = vi.fn()
      .mockRejectedValueOnce(new ManagedRemotePublicReachabilityError('unreachable', {
        reason: 'cloudflare_error',
        lastStatus: 530,
      }))
      .mockResolvedValueOnce({ verified: true, status: 200 });

    const controller = await startCloudflareManagedRemoteTunnel({
      token: TOKEN,
      hostname: 'app.example.com',
      activePort: 57123,
      originPort: 3000,
      runtimeInstanceId: 'instance-id',
      checkAvailability: vi.fn(async () => ({ available: true, path: '/bin/cloudflared' })),
      startOriginRelay: vi.fn(async () => relay),
      spawnManagedConnector,
      verifyPublicReachability,
    });

    expect(spawnManagedConnector).toHaveBeenNthCalledWith(
      1,
      ['tunnel', 'run', '--token-file', expect.any(String)],
      {},
      '/bin/cloudflared',
    );
    expect(spawnManagedConnector).toHaveBeenNthCalledWith(
      2,
      ['tunnel', '--protocol', 'http2', 'run', '--token-file', expect.any(String)],
      {},
      '/bin/cloudflared',
    );
    expect(controller.getDiagnostics()).toMatchObject({
      connectorState: 'healthy',
      effectiveTransportProtocol: 'http2',
      publicReachabilityVerified: true,
    });
    expect(JSON.stringify(controller.getDiagnostics())).not.toContain(TOKEN);

    await controller.stop();
  });

  it('reports a degraded connector after a cached status health probe fails', async () => {
    const order = [];
    const relay = {
      active: true,
      stop: vi.fn(async () => { order.push('relay-stop'); return true; }),
    };
    const healthError = new ManagedRemotePublicReachabilityError('unreachable', {
      reason: 'cloudflare_error',
      lastStatus: 530,
    });
    const verify = vi.fn()
      .mockResolvedValueOnce({ verified: true, status: 200 })
      .mockRejectedValueOnce(healthError);
    const harness = createOptions({ order, relay, verifyPublicReachability: verify });
    const controller = await startCloudflareManagedRemoteTunnel(harness.options);

    await expect(controller.refreshHealth({ maxAgeMs: 0 })).resolves.toBe(false);

    expect(controller.getDiagnostics()).toMatchObject({
      connectorState: 'degraded',
      publicReachabilityVerified: false,
      publicReachabilityReason: 'cloudflare_error',
      lastPublicStatus: 530,
    });
    await controller.stop();
  });

  it('notifies lifecycle observers and cleans the relay on unexpected connector exit', async () => {
    const order = [];
    const relay = {
      active: true,
      stop: vi.fn(async () => { order.push('relay-stop'); return true; }),
    };
    const harness = createOptions({
      order,
      relay,
      verifyPublicReachability: vi.fn(async () => ({ verified: true, status: 200 })),
    });
    const controller = await startCloudflareManagedRemoteTunnel(harness.options);
    const onTerminated = vi.fn();
    controller.onTerminated(onTerminated);

    harness.child.exitCode = 1;
    harness.child.emit('exit', 1);
    await Promise.resolve();

    expect(onTerminated).toHaveBeenCalledTimes(1);
    expect(relay.stop).toHaveBeenCalledTimes(1);
    expect(controller.getDiagnostics()).toMatchObject({
      connectorState: 'stopped',
      publicReachabilityVerified: false,
      publicReachabilityReason: 'connector_stopped',
    });
  });
});
