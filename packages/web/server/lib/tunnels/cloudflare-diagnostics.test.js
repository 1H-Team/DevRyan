import { describe, expect, it } from 'vitest';

import {
  CloudflareTunnelStartupError,
  createCloudflaredOutputBuffer,
  redactCloudflaredLogLine,
} from '../cloudflare-tunnel.js';
import { createCloudflareTunnelProvider } from './providers/cloudflare.js';

describe('Cloudflare tunnel diagnostics', () => {
  it('redacts sensitive token-like values from cloudflared output excerpts', () => {
    const buffer = createCloudflaredOutputBuffer({ maxLines: 3 });

    buffer.append('INFO connected\nERR token=super-secret-token\nAuthorization: Bearer abc.def.ghi\n');

    expect(buffer.excerpt()).toEqual([
      'INFO connected',
      'ERR token=[redacted]',
      'Authorization: [redacted]',
    ]);
    expect(redactCloudflaredLogLine('token-file /tmp/private-token')).toBe('token-file [redacted]');
  });

  it('keeps quick tunnel startup failures structured and user-safe', () => {
    const error = new CloudflareTunnelStartupError(
      'quick_url_timeout',
      'Cloudflare Quick Tunnel did not return a public URL within 30 seconds',
      {
        startupLogExcerpt: ['ERR failed to reach edge'],
        hint: 'Cloudflare Quick Tunnel can fail if WARP or a Zero Trust egress policy blocks api.trycloudflare.com or cloudflared edge connections.',
      }
    );

    expect(error.code).toBe('quick_url_timeout');
    expect(error.details.startupLogExcerpt).toEqual(['ERR failed to reach edge']);
    expect(error.details.hint).toContain('Zero Trust egress');
  });

  it('includes managed remote origin diagnostics in provider metadata', () => {
    const provider = createCloudflareTunnelProvider();

    const metadata = provider.getMetadata({
      getDiagnostics: () => ({
        expectedHostname: 'devryan.1health.ae',
        originPort: 3000,
        cloudflareOriginUrl: 'http://127.0.0.1:3000',
        activeOriginUrl: 'http://127.0.0.1:55676',
        originRelayActive: true,
        publicReachabilityVerified: true,
        localOriginUrl: 'http://127.0.0.1:55676',
        cloudflareConfigRequiresManualOriginMatch: false,
        startupLogExcerpt: ['INF registered tunnel connection'],
      }),
    });

    expect(metadata).toMatchObject({
      configPath: null,
      resolvedHostname: null,
      expectedHostname: 'devryan.1health.ae',
      originPort: 3000,
      cloudflareOriginUrl: 'http://127.0.0.1:3000',
      activeOriginUrl: 'http://127.0.0.1:55676',
      originRelayActive: true,
      publicReachabilityVerified: true,
      localOriginUrl: 'http://127.0.0.1:55676',
      cloudflareConfigRequiresManualOriginMatch: false,
      startupLogExcerpt: ['INF registered tunnel connection'],
    });
  });
});
