import { afterEach, describe, expect, test } from 'bun:test';

import {
  resetManagedAgentDefault,
  resetManagedSettingOverride,
  saveManagedAgentDefault,
} from './managedAgentDefaultsApi';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('managed agent defaults API', () => {
  test('uses service routes with CSRF for explicit save and reset operations', async () => {
    const requests: Array<[string, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push([String(input), init]);
      return new Response(JSON.stringify({ settings: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await saveManagedAgentDefault('Orchestrator', {
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      variant: 'medium',
    });
    await resetManagedAgentDefault('Orchestrator');
    await resetManagedSettingOverride('defaultAgent');

    expect(requests.map(([path, init]) => ({
      path,
      method: init?.method,
      csrf: (init?.headers as Record<string, string> | undefined)?.['X-DevRyan-CSRF'],
      body: init?.body,
    }))).toEqual([
      {
        path: '/api/config/settings/agent-defaults/Orchestrator',
        method: 'PUT',
        csrf: '1',
        body: JSON.stringify({ providerId: 'openai', modelId: 'gpt-5.6-sol', variant: 'medium' }),
      },
      {
        path: '/api/config/settings/agent-defaults/Orchestrator',
        method: 'DELETE',
        csrf: '1',
        body: undefined,
      },
      {
        path: '/api/config/settings/overrides/defaultAgent',
        method: 'DELETE',
        csrf: '1',
        body: undefined,
      },
    ]);
  });
});
