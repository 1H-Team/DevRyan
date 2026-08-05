import { describe, expect, it, vi } from 'vitest';

import { verifyManagedRemotePublicReachability } from './public-reachability.js';

const response = (status, instanceId = '') => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (name) => (name.toLowerCase() === 'x-devryan-instance-id' ? instanceId : null) },
});

const createClock = () => {
  let value = 0;
  return {
    now: () => value,
    wait: async (durationMs) => { value += durationMs; },
  };
};

const baseOptions = (clock, fetchImpl) => ({
  publicUrl: 'https://devryan.example.com',
  expectedInstanceId: 'expected-instance',
  cloudflareOriginUrl: 'http://127.0.0.1:3000',
  activeOriginUrl: 'http://127.0.0.1:57123',
  timeoutMs: 1000,
  intervalMs: 500,
  requestTimeoutMs: 50,
  fetchImpl,
  now: clock.now,
  wait: clock.wait,
});

describe('managed remote public reachability verification', () => {
  it('accepts only the matching DevRyan instance header', async () => {
    const clock = createClock();
    const fetchImpl = vi.fn(async () => response(200, 'expected-instance'));

    await expect(verifyManagedRemotePublicReachability(baseOptions(clock, fetchImpl)))
      .resolves.toMatchObject({ verified: true, status: 200, attempts: 1 });
  });

  it('retries mismatches and succeeds when the expected instance becomes public', async () => {
    const clock = createClock();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(200, 'other-instance'))
      .mockResolvedValueOnce(response(200, 'expected-instance'));

    await expect(verifyManagedRemotePublicReachability(baseOptions(clock, fetchImpl)))
      .resolves.toMatchObject({ verified: true, attempts: 2 });
  });

  it.each([
    [502, 'cloudflare_error'],
    [530, 'cloudflare_error'],
    [200, 'instance_mismatch'],
  ])('returns a safe failure for HTTP %s', async (status, reason) => {
    const clock = createClock();
    const secret = 'secret-cloudflare-token';
    const fetchImpl = vi.fn(async () => response(status, status === 200 ? 'wrong-instance' : ''));

    const error = await verifyManagedRemotePublicReachability(baseOptions(clock, fetchImpl)).catch((caught) => caught);

    expect(error).toMatchObject({
      code: 'managed_remote_public_unreachable',
      details: { reason, lastStatus: status },
    });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(error.details).not.toHaveProperty('expectedInstanceId');
  });

  it('classifies DNS failures without exposing fetch error details', async () => {
    const clock = createClock();
    const fetchImpl = vi.fn(async () => {
      const error = new Error('getaddrinfo ENOTFOUND secret-token.example');
      error.cause = { code: 'ENOTFOUND' };
      throw error;
    });

    const error = await verifyManagedRemotePublicReachability(baseOptions(clock, fetchImpl)).catch((caught) => caught);

    expect(error).toMatchObject({
      code: 'managed_remote_public_unreachable',
      details: { reason: 'dns_failure', lastStatus: null },
    });
    expect(JSON.stringify(error)).not.toContain('secret-token.example');
  });

  it('supports a single-attempt health probe without entering the retry wait loop', async () => {
    const clock = createClock();
    const wait = vi.fn(clock.wait);
    const fetchImpl = vi.fn(async () => response(530));

    const error = await verifyManagedRemotePublicReachability({
      ...baseOptions(clock, fetchImpl),
      maxAttempts: 1,
      wait,
    }).catch((caught) => caught);

    expect(error).toMatchObject({
      code: 'managed_remote_public_unreachable',
      details: { reason: 'cloudflare_error', lastStatus: 530 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });
});
