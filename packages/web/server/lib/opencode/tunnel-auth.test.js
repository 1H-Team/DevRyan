import http from 'node:http';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { createTunnelAuth } from './tunnel-auth.js';

const requestFor = ({ host, remoteAddress, forwardedFor }) => ({
  headers: {
    host,
    ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
  },
  socket: { remoteAddress },
});

// The server runs behind `app.set('trust proxy', true)`, so Express derives
// `req.hostname` from the client-supplied X-Forwarded-Host header rather than
// from the authority the request was actually addressed to. This helper models
// that derivation; `mirrors real Express trust-proxy hostname derivation` below
// pins it against the framework so the model cannot silently drift.
const trustProxyRequestFor = ({
  host,
  forwardedHost,
  forwardedFor,
  cfConnectingIp,
  remoteAddress,
}) => {
  const authority = forwardedHost === undefined
    ? host
    : String(forwardedHost).split(',')[0];

  return {
    headers: {
      host,
      ...(forwardedHost === undefined ? {} : { 'x-forwarded-host': forwardedHost }),
      ...(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }),
      ...(cfConnectingIp === undefined ? {} : { 'cf-connecting-ip': cfConnectingIp }),
    },
    hostname: String(authority).trim().toLowerCase().replace(/:\d+$/, ''),
    // `trust proxy` derives req.ip from X-Forwarded-For the same way.
    ip: forwardedFor === undefined
      ? remoteAddress
      : String(forwardedFor).split(',')[0].trim(),
    socket: { remoteAddress },
  };
};

const expressHostnamesFor = async (headerSets) => {
  const app = express();
  app.set('trust proxy', true);
  const observed = [];
  app.get('/probe', (req, res) => {
    observed.push(req.hostname);
    res.end('ok');
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    for (const headers of headerSets) {
      await new Promise((resolve, reject) => {
        const request = http.request(
          { host: '127.0.0.1', port, path: '/probe', headers },
          (response) => {
            response.resume();
            response.on('end', resolve);
          },
        );
        request.on('error', reject);
        request.end();
      });
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  return observed;
};

describe('tunnel request scope classification', () => {
  const createActiveTunnel = () => {
    const controller = createTunnelAuth();
    controller.setActiveTunnel({
      tunnelId: 'tunnel-1',
      publicUrl: 'https://tunnel.example.com',
    });
    return controller;
  };

  it.each([
    ['localhost:57123', '127.0.0.1'],
    ['127.0.0.1:57123', '::ffff:127.0.0.1'],
    ['192.168.1.5:57123', '192.168.1.20'],
    ['10.0.0.4:57123', 'fd00::1'],
    ['[::1]:57123', '::1'],
    ['host.docker.internal:57123', '172.20.0.2'],
  ])('accepts local host %s from private socket peer %s', (host, remoteAddress) => {
    const controller = createActiveTunnel();
    expect(controller.classifyRequestScope(requestFor({ host, remoteAddress }))).toBe('local');
  });

  it.each([
    'localhost:57123',
    '127.0.0.1:57123',
    '192.168.1.5:57123',
    '[::1]:57123',
    'host.docker.internal:57123',
  ])('rejects spoofed local Host %s from a public socket peer', (host) => {
    const controller = createActiveTunnel();
    expect(controller.classifyRequestScope(requestFor({
      host,
      remoteAddress: '203.0.113.10',
      forwardedFor: '127.0.0.1',
    }))).toBe('unknown-public');
  });

  it('keeps the configured tunnel hostname in tunnel scope', () => {
    const controller = createActiveTunnel();
    expect(controller.classifyRequestScope(requestFor({
      host: 'tunnel.example.com',
      remoteAddress: '203.0.113.10',
    }))).toBe('tunnel');
  });

  it('preserves the no-tunnel local fallback', () => {
    const controller = createTunnelAuth();
    expect(controller.classifyRequestScope(requestFor({
      host: 'example.test',
      remoteAddress: '203.0.113.10',
    }))).toBe('local');
  });
});

describe('tunnel bootstrap recognition', () => {
  it('recognizes only the current bootstrap token, including after it is consumed', async () => {
    const controller = createTunnelAuth();
    controller.setActiveTunnel({
      tunnelId: 'tunnel-1',
      publicUrl: 'https://tunnel.example.com',
      mode: 'managed-remote',
    });
    const { token } = controller.issueBootstrapToken({ ttlMs: 60_000 });
    const req = requestFor({ host: 'tunnel.example.com', remoteAddress: '203.0.113.10' });
    const res = { setHeader: () => {} };

    expect(controller.recognizesBootstrapToken(token)).toBe(true);
    expect(controller.recognizesBootstrapToken('different-token')).toBe(false);

    const exchange = await controller.exchangeBootstrapToken({ req, res, token, sessionTtlMs: 60_000 });

    expect(exchange.ok).toBe(true);
    expect(controller.recognizesBootstrapToken(token)).toBe(true);
  });

  it('keeps the token unconsumed when the asynchronous pre-commit hook fails', async () => {
    const controller = createTunnelAuth();
    controller.setActiveTunnel({
      tunnelId: 'tunnel-1',
      publicUrl: 'https://tunnel.example.com',
      mode: 'managed-remote',
    });
    const { token } = controller.issueBootstrapToken({ ttlMs: 60_000 });
    const req = requestFor({ host: 'tunnel.example.com', remoteAddress: '203.0.113.10' });
    const res = { setHeader: () => {} };

    const failed = await controller.exchangeBootstrapToken({
      req,
      res,
      token,
      sessionTtlMs: 60_000,
      beforeCommit: async () => {
        throw Object.assign(new Error('not ready'), { code: 'runtime_not_ready' });
      },
    });

    expect(failed).toEqual({ ok: false, reason: 'precondition-failed', code: 'runtime_not_ready' });
    expect(controller.getBootstrapStatus().hasBootstrapToken).toBe(true);
    await expect(controller.exchangeBootstrapToken({ req, res, token, sessionTtlMs: 60_000 }))
      .resolves.toMatchObject({ ok: true });
  });
});

describe('tunnel request scope classification behind a trusted proxy', () => {
  const createActiveTunnel = () => {
    const controller = createTunnelAuth();
    controller.setActiveTunnel({
      tunnelId: 'tunnel-1',
      publicUrl: 'https://tunnel.example.com',
    });
    return controller;
  };

  it('mirrors real Express trust-proxy hostname derivation', async () => {
    const headerSets = [
      { host: 'tunnel.example.com', 'x-forwarded-host': 'localhost' },
      { host: 'tunnel.example.com', 'x-forwarded-host': '127.0.0.1' },
      { host: 'tunnel.example.com', 'x-forwarded-host': 'localhost:1234' },
      { host: '192.168.1.10:3000', 'x-forwarded-host': 'tunnel.example.com' },
      { host: 'localhost:57123' },
    ];

    const modelled = headerSets.map((headers) => trustProxyRequestFor({
      host: headers.host,
      forwardedHost: headers['x-forwarded-host'],
      remoteAddress: '127.0.0.1',
    }).hostname);

    await expect(expressHostnamesFor(headerSets)).resolves.toEqual(modelled);
  });

  it('ignores a forwarded-host spoof that claims a remote tunnel request is local', () => {
    const controller = createActiveTunnel();

    // Every request through cloudflared reaches the origin over a loopback
    // socket, so the socket peer is not evidence of a local client.
    expect(controller.classifyRequestScope(trustProxyRequestFor({
      host: 'tunnel.example.com',
      forwardedHost: 'localhost',
      remoteAddress: '127.0.0.1',
    }))).toBe('tunnel');
  });

  it('ignores a forwarded-host spoof even when the request admits a public client', () => {
    const controller = createActiveTunnel();

    expect(controller.classifyRequestScope(trustProxyRequestFor({
      host: 'tunnel.example.com',
      forwardedHost: '127.0.0.1',
      forwardedFor: '203.0.113.9',
      cfConnectingIp: '203.0.113.9',
      remoteAddress: '127.0.0.1',
    }))).toBe('tunnel');
  });

  it('refuses local scope for a loopback request whose Host header was rewritten by a proxy', () => {
    const controller = createActiveTunnel();

    // cloudflared's `httpHostHeader` ingress option rewrites Host at the origin,
    // so the raw authority alone cannot prove a request is local. The forwarding
    // headers the edge attaches are the tell.
    expect(controller.classifyRequestScope(trustProxyRequestFor({
      host: 'localhost',
      forwardedFor: '203.0.113.9',
      cfConnectingIp: '203.0.113.9',
      remoteAddress: '127.0.0.1',
    }))).toBe('unknown-public');
  });

  it('ignores a forwarded-host spoof that promotes a LAN request to tunnel scope', () => {
    const controller = createActiveTunnel();

    expect(controller.classifyRequestScope(trustProxyRequestFor({
      host: '192.168.1.10:3000',
      forwardedHost: 'tunnel.example.com',
      remoteAddress: '192.168.1.20',
    }))).not.toBe('tunnel');
  });

  it('keeps direct local requests local when no forwarding headers are present', () => {
    const controller = createActiveTunnel();

    expect(controller.classifyRequestScope(trustProxyRequestFor({
      host: 'localhost:57123',
      remoteAddress: '127.0.0.1',
    }))).toBe('local');
  });
});

describe('tunnel connect rate limiting', () => {
  const createExchangeableTunnel = () => {
    const controller = createTunnelAuth();
    controller.setActiveTunnel({
      tunnelId: 'tunnel-1',
      publicUrl: 'https://tunnel.example.com',
      mode: 'managed-remote',
    });
    controller.issueBootstrapToken({ ttlMs: 60_000 });
    return controller;
  };

  const exhaust = async (controller, attempts, headersForAttempt) => {
    const res = { setHeader: () => {} };
    let last = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      last = await controller.exchangeBootstrapToken({
        req: trustProxyRequestFor(headersForAttempt(attempt)),
        res,
        token: 'not-the-bootstrap-token',
        sessionTtlMs: 60_000,
      });
      if (last.reason === 'rate-limited') break;
    }
    return last;
  };

  it('does not let a client-chosen X-Forwarded-For shard the connect rate limit', async () => {
    const controller = createExchangeableTunnel();

    const last = await exhaust(controller, 60, (attempt) => ({
      host: 'tunnel.example.com',
      forwardedFor: `198.51.100.${attempt % 256}`,
      remoteAddress: '127.0.0.1',
    }));

    expect(last.reason).toBe('rate-limited');
  });

  it('caps total connect failures even across distinct edge-reported client IPs', async () => {
    const controller = createExchangeableTunnel();

    const last = await exhaust(controller, 600, (attempt) => ({
      host: 'tunnel.example.com',
      cfConnectingIp: `198.51.100.${attempt % 256}`,
      remoteAddress: '127.0.0.1',
    }));

    expect(last.reason).toBe('rate-limited');
  });
});
