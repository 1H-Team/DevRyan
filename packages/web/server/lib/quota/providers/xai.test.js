import { describe, expect, test } from 'vitest';

import { fetchQuota } from './xai.js';

const response = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => payload,
  arrayBuffer: async () => {
    const bytes = payload instanceof Uint8Array
      ? payload
      : new TextEncoder().encode(JSON.stringify(payload));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  },
});

describe('xAI web quota provider OAuth refresh', () => {
  test('persists rotated fields into the existing auth entry and retries once', async () => {
    const now = () => Date.parse('2026-08-11T12:00:00.000Z');
    const auth = {
      xai: {
        type: 'oauth',
        access: 'old-access',
        refresh: 'old-refresh',
        custom: 'preserved',
      },
    };
    const writes = [];
    let billingCalls = 0;

    const result = await fetchQuota({
      readAuth: () => auth,
      writeAuth: (next) => writes.push(structuredClone(next)),
      now,
      fetchImpl: async (url) => {
        if (url.includes('/oauth2/token')) {
          return response({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: '3600',
          });
        }
        if (url.includes('ConsumerUiSvc/GetRemainingResets')) {
          return response(new Uint8Array());
        }
        billingCalls += 1;
        return billingCalls === 1
          ? response({}, 401)
          : response({ creditUsagePercent: 15, billingPeriodEnd: '2026-08-18T00:00:00Z' });
      },
    });

    expect(result).toMatchObject({ ok: true, providerId: 'xai' });
    expect(writes).toEqual([{
      xai: {
        type: 'oauth',
        access: 'new-access',
        refresh: 'new-refresh',
        expires: now() + 3_600_000,
        custom: 'preserved',
      },
    }]);
    expect(billingCalls).toBe(2);
  });
});
