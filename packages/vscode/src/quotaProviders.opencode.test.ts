import { describe, expect, it } from 'vitest';

import {
  fetchOpenCodeZenQuota,
  fetchQuotaForProvider,
  listConfiguredQuotaProviders,
  resolveOpenCodeZenCredential,
  validateOpenCodeZenQuotaCredential,
} from './quotaProviders';

const credential = {
  workspaceId: 'wrk_01K46JDFR0E75SG2Q8K172KF3Y',
  authCookie: 'signed-cookie',
};

const billingHtml = `<!doctype html><script>
_$HY.r["billing.get[\\"${credential.workspaceId}\\"]"]=$R[1];
$R[2]={customerID:"cus_safe",paymentMethodID:null,balance:2000000000,monthlyLimit:50,monthlyUsage:500000000,timeMonthlyUsageUpdated:$R[3],reload:!1,reloadAmount:20,reloadAmountMin:10,reloadTrigger:5,reloadTriggerMin:5,subscriptionID:null};
$R[3]=new Date("2026-08-10T00:00:00.000Z");
</script>`;

const fetchImpl = async () => ({
  ok: true,
  status: 200,
  url: `https://opencode.ai/workspace/${credential.workspaceId}/billing`,
  headers: { get: () => null },
  json: async () => ({}),
  text: async () => billingHtml,
});

describe('VS Code OpenCode Zen quota provider', () => {
  it('discovers only the managed dashboard credential', () => {
    const readManagedCredential = (providerId: string) => providerId === 'opencode' ? credential : null;
    expect(resolveOpenCodeZenCredential({ readManagedCredential }))
      .toEqual({ credential, source: 'managed' });
    expect(listConfiguredQuotaProviders({
      readAuth: () => ({ opencode: { key: 'ordinary-api-key' } }),
      readManagedCredential,
      isExternalRuntime: true,
    })).toContain('opencode');
    expect(listConfiguredQuotaProviders({
      readAuth: () => ({ opencode: { key: 'ordinary-api-key' } }),
      readManagedCredential: () => null,
      isExternalRuntime: true,
    })).not.toContain('opencode');
  });

  it('routes canonical and alias requests separately from OpenCode Go', async () => {
    for (const providerId of ['opencode', 'zen', 'opencode-zen']) {
      const result = await fetchQuotaForProvider(providerId, {
        readManagedCredential: () => credential,
        fetchImpl,
        now: () => Date.parse('2026-08-11T12:00:00.000Z'),
      });
      expect(result).toMatchObject({ ok: true, providerId: 'opencode' });
      expect(result.usage?.windows.credits.valueLabel).toBe('$5.00 used / $20.00 available');
    }
  });

  it('uses the same fetch path for explicit validation', async () => {
    await expect(validateOpenCodeZenQuotaCredential(credential, { fetchImpl })).resolves.toEqual(credential);
    const result = await fetchOpenCodeZenQuota({ readManagedCredential: () => credential, fetchImpl });
    expect(result.ok).toBe(true);
  });
});
