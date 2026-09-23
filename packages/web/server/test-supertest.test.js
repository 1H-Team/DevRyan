import http from 'node:http';
import { once } from 'node:events';

import { describe, expect, it } from 'vitest';

import request from './test-supertest.js';

const closeServer = (server) => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});

describe('Supertest loopback requests', () => {
  it('targets the address family of the test server', async () => {
    const ipv4Server = http.createServer((_request, response) => {
      response.statusCode = 503;
      response.end('wrong server');
    });
    ipv4Server.listen(0, '127.0.0.1');
    await once(ipv4Server, 'listening');

    const ipv4Address = ipv4Server.address();
    if (!ipv4Address || typeof ipv4Address === 'string') {
      throw new Error('IPv4 test server did not expose a TCP address');
    }

    const ipv6Server = http.createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
    });
    ipv6Server.listen({
      host: '::1',
      ipv6Only: true,
      port: ipv4Address.port,
    });
    await once(ipv6Server, 'listening');

    try {
      const response = await request(ipv6Server).get('/health');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });
    } finally {
      await Promise.all([
        closeServer(ipv4Server),
        closeServer(ipv6Server),
      ]);
    }
  });

  it('serves an unbound app from an explicit IPv4 loopback listener', async () => {
    const response = await request((incoming, outgoing) => {
      outgoing.setHeader('content-type', 'application/json');
      outgoing.end(JSON.stringify({ localAddress: incoming.socket.localAddress }));
    }).get('/health');

    expect(response.status).toBe(200);
    // A dual-stack wildcard listener reports ::ffff:127.0.0.1 or ::1 instead.
    expect(response.body).toEqual({ localAddress: '127.0.0.1' });
  });

  it('shares one loopback listener between concurrent requests and closes it', async () => {
    const server = http.createServer((incoming, response) => {
      response.setHeader('content-type', 'application/json');
      const { localAddress, localPort } = incoming.socket;
      response.end(JSON.stringify({ localAddress, localPort }));
    });

    const responses = await Promise.all([
      request(server).get('/first'),
      request(server).get('/second'),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body.localAddress).toBe('127.0.0.1');
    }
    expect(responses[0].body.localPort).toBe(responses[1].body.localPort);
    expect(server.listening).toBe(false);
  });
});
