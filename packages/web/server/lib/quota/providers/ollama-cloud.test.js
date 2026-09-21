import { describe, expect, it, vi } from 'vitest';

import {
  fetchOllamaCloudUsage,
  resolveOllamaCloudCredential,
  parseOllamaSettingsHtml,
} from './ollama-cloud.js';

describe('Ollama Cloud quota provider', () => {
  it('recognizes labeled finite cost and balance without inventing missing allowances', () => {
    const windows = parseOllamaSettingsHtml('<p>$37.20 <span>used</span></p><p>Usage credit balance <b>$0.00</b></p>');
    expect(windows.cost.valueLabel).toBe('$37.20 used');
    expect(windows.balance.valueLabel).toBe('$0.00 credit balance');
    expect(windows.cost.usedPercent).toBeNull();
    expect(parseOllamaSettingsHtml('Credit balance unavailable · Total cost null')).toEqual({});
    expect(parseOllamaSettingsHtml('<script>balance $100</script>Plan $20 / month')).toEqual({});
    expect(parseOllamaSettingsHtml('Cost $Infinity · Balance $NaN')).toEqual({});
  });
  it('prefers managed credentials and preserves the legacy cookie fallback', () => {
    expect(resolveOllamaCloudCredential({
      readManagedCredential: () => ({ cookie: 'managed' }),
      readLegacyCookie: () => 'legacy',
    })).toEqual({ credential: { cookie: 'managed' }, source: 'managed' });
    expect(resolveOllamaCloudCredential({
      readManagedCredential: () => null,
      readLegacyCookie: () => 'legacy',
    })).toEqual({ credential: { cookie: 'legacy' }, source: 'legacy' });
  });

  it('rejects redirects and successful pages without recognizable usage', async () => {
    const redirectFetch = vi.fn(async () => ({ ok: false, status: 302 }));
    await expect(fetchOllamaCloudUsage({ cookie: 'secret' }, redirectFetch))
      .rejects.toThrow('authentication failed');
    expect(redirectFetch).toHaveBeenCalledWith('https://ollama.com/settings', expect.objectContaining({
      redirect: 'manual',
      headers: expect.objectContaining({ Cookie: 'secret' }),
    }));

    await expect(fetchOllamaCloudUsage({ cookie: 'secret' }, async () => ({
      ok: true,
      status: 200,
      text: async () => '<html>settings</html>',
    }))).rejects.toThrow('could not be parsed');
  });
});
