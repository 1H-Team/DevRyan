import { expect, test } from 'vitest';
import { fetchQuota, parseOpenRouterKey } from './openrouter.js';

test('inference-key quota uses its remaining allowance rather than lifetime usage or account credits', async () => {
  const requests = [];
  const quota = await fetchQuota({ readAuth: () => ({ openrouter: { type: 'api', key: 'fixture-key' } }),
    fetchImpl: async (url) => { requests.push(url); return { ok: true, json: async () => ({ data: { limit: 100, limit_remaining: 75, usage: 400 } }) }; } });
  expect(requests).toEqual(['https://openrouter.ai/api/v1/key']);
  expect(quota.ok).toBe(true);
  expect(quota.usage.windows.credits.usedPercent).toBe(25);
  expect(quota.usage.windows.credits.valueLabel).toContain('$75.00 key budget left');
});

test('only an explicit null key limit means unlimited; missing or invalid fields stay unknown', () => {
  expect(parseOpenRouterKey({ limit: null, usage: 10 }).credits.valueLabel).toContain('No key spending limit');
  expect(parseOpenRouterKey({ usage: 0 }).credits.valueLabel).toBe('$0.00 spent');
  expect(parseOpenRouterKey({ limit: 0, limit_remaining: 0 }).credits.usedPercent).toBe(100);
  for (const value of [undefined, '', NaN, Infinity]) expect(() => parseOpenRouterKey({ limit: value, usage: value })).toThrow('unavailable');
});
