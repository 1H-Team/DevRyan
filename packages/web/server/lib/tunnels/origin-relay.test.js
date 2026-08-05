import { EventEmitter } from 'node:events';
import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';

import {
  ManagedRemoteOriginRelayError,
  startLoopbackOriginRelay,
} from './origin-relay.js';

const listen = (server, port = 0) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    resolve(address.port);
  });
});

const close = (server) => new Promise((resolve) => server.close(resolve));

const exchange = (port, payload) => new Promise((resolve, reject) => {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  const chunks = [];
  socket.once('error', reject);
  socket.on('data', (chunk) => {
    chunks.push(chunk);
    const received = Buffer.concat(chunks);
    if (received.length >= payload.length) {
      socket.end();
      resolve(received);
    }
  });
  socket.once('connect', () => socket.write(payload));
});

describe('managed remote origin relay', () => {
  it('binds only to IPv4 loopback', async () => {
    const server = new EventEmitter();
    server.listening = false;
    server.unref = vi.fn();
    server.listen = vi.fn((options) => {
      server.listening = true;
      queueMicrotask(() => server.emit('listening'));
    });
    server.close = vi.fn((callback) => {
      server.listening = false;
      callback();
    });
    const netImpl = {
      createServer: vi.fn(() => server),
      createConnection: vi.fn(),
    };

    const relay = await startLoopbackOriginRelay({ originPort: 3000, targetPort: 57123, netImpl });

    expect(server.listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: 3000, exclusive: true });
    await relay.stop();
  });

  it('forwards HTTP and WebSocket-compatible bytes without interpreting them', async () => {
    const target = net.createServer({ allowHalfOpen: true }, (socket) => {
      socket.on('data', (chunk) => socket.write(chunk));
      socket.on('end', () => socket.end());
    });
    const targetPort = await listen(target);
    const relayPortServer = net.createServer();
    const relayPort = await listen(relayPortServer);
    await close(relayPortServer);
    const relay = await startLoopbackOriginRelay({ originPort: relayPort, targetPort });
    const payload = Buffer.concat([
      Buffer.from('GET /socket HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'),
      Buffer.from([0x82, 0x04, 0xde, 0xad, 0xbe, 0xef]),
    ]);

    await expect(exchange(relayPort, payload)).resolves.toEqual(payload);

    await relay.stop();
    await close(target);
  });

  it('reports an occupied fixed origin port with a stable error code', async () => {
    const occupant = net.createServer();
    const occupiedPort = await listen(occupant);

    await expect(startLoopbackOriginRelay({ originPort: occupiedPort, targetPort: occupiedPort + 1 }))
      .rejects.toMatchObject({
        code: 'managed_remote_origin_port_in_use',
        details: { cloudflareOriginUrl: `http://127.0.0.1:${occupiedPort}` },
      });

    await close(occupant);
  });

  it('cleans up idempotently and bypasses the relay when ports match', async () => {
    const bypass = await startLoopbackOriginRelay({ originPort: 3000, targetPort: 3000 });
    expect(bypass.active).toBe(false);
    await expect(bypass.stop()).resolves.toBe(true);
    await expect(bypass.stop()).resolves.toBe(true);

    const target = net.createServer();
    const targetPort = await listen(target);
    const relayPortServer = net.createServer();
    const relayPort = await listen(relayPortServer);
    await close(relayPortServer);
    const relay = await startLoopbackOriginRelay({ originPort: relayPort, targetPort });
    await expect(relay.stop()).resolves.toBe(true);
    await expect(relay.stop()).resolves.toBe(true);
    await close(target);
  });

  it('uses a structured relay error type', () => {
    const error = new ManagedRemoteOriginRelayError('code', 'message');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('code');
  });
});
