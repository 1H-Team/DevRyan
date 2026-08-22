import { describe, expect, it, vi } from 'vitest';

import {
  fetchQuota,
  isConfigured,
  resolveOpenCodeZenCredential,
  validateOpenCodeZenCredential,
} from './opencode.js';

const credential = {
  workspaceId: 'wrk_01K46JDFR0E75SG2Q8K172KF3Y',
  authCookie: 'signed-cookie',
};

const billingHtml = `<!doctype html><script>
_$HY.r["billing.get[\\"${credential.workspaceId}\\"]"]=$R[1];
$R[2]={customerID:"cus_safe",paymentMethodID:null,balance:2000000000,monthlyLimit:null,monthlyUsage:0,timeMonthlyUsageUpdated:null,reload:!1,reloadAmount:20,reloadAmountMin:10,reloadTrigger:5,reloadTriggerMin:5,subscriptionID:null};
</script>`;

describe('OpenCode Zen quota provider', () => {
  it('discovers only the separate managed dashboard credential', () => {
    expect(resolveOpenCodeZenCredential({ readManagedCredential: () => credential }))
      .toEqual({ credential, source: 'managed' });
    expect(isConfigured({ readManagedCredential: () => credential })).toBe(true);
    expect(isConfigured({ readManagedCredential: () => null })).toBe(false);
    expect(isConfigured({
      auth: { opencode: { key: 'ordinary-zen-api-key' } },
      readManagedCredential: () => null,
    })).toBe(false);
  });

  it('fetches and validates through the shared billing adapter', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      url: `https://opencode.ai/workspace/${credential.workspaceId}/billing`,
      headers: { get: () => null },
      text: async () => billingHtml,
    }));
    const result = await fetchQuota({ readManagedCredential: () => credential, fetchImpl });
    expect(result).toMatchObject({ ok: true, providerId: 'opencode' });
    await expect(validateOpenCodeZenCredential(credential, { fetchImpl })).resolves.toEqual(credential);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps configured failures visible and validation generic', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 403,
      headers: { get: () => null },
      text: async () => '',
    });
    const result = await fetchQuota({ readManagedCredential: () => credential, fetchImpl });
    expect(result).toMatchObject({ configured: true, errorCode: 'AUTHENTICATION_FAILED' });
    await expect(validateOpenCodeZenCredential(credential, { fetchImpl }))
      .rejects.toThrow('OpenCode Zen dashboard credential could not be validated.');
  });
});
