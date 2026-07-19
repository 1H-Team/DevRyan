import { describe, expect, it } from 'vitest';
import { createTunnelAuth } from './tunnel-auth.js';

const requestFor = ({ host, remoteAddress, forwardedFor }) => ({
  headers: {
    host,
    ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
  },
  socket: { remoteAddress },
});

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
