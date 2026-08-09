import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const gateSource = readFileSync(new URL('./SessionAuthGate.tsx', import.meta.url), 'utf8');

describe('SessionAuthGate offline-grace recovery source contract', () => {
  test('retains session availability and retries with bounded backoff and tab visibility', () => {
    expect(gateSource).toContain('data.offlineGrace === true');
    expect(gateSource).toContain('useAuthOfflineGrace()');
    expect(gateSource).toContain('registerAuthSessionRetry(checkStatus)');
    expect(gateSource).toContain("Math.min(5_000 * (2 ** attempt), 60_000)");
    expect(gateSource).toContain("document.addEventListener('visibilitychange'");
    expect(gateSource).toContain('if (offlineGraceRef.current) schedule()');
  });
});
