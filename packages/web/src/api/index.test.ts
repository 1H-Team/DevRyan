import { describe, expect, it } from 'vitest';

import { createWebAPIs } from './index';

const REQUIRED_RUNTIME_APIS = [
  'files',
  'git',
  'notifications',
  'permissions',
  'runtime',
  'settings',
  'terminal',
  'tools',
] as const;

describe('web RuntimeAPIs adapter contract', () => {
  it('exposes every shared capability plus web-only push support', () => {
    const apis = createWebAPIs();

    expect(apis.runtime).toEqual({
      platform: 'web',
      isDesktop: false,

      label: 'web',
    });
    for (const capability of REQUIRED_RUNTIME_APIS) {
      expect(apis[capability]).toBeDefined();
    }
    expect(apis.push).toBeDefined();
    expect(apis.github).toBeDefined();
    expect(apis.diagnostics).toBeDefined();
    expect(apis.evidence).toBeDefined();
    expect(apis.contextUsage).toBeDefined();
    expect(apis.editor).toBeUndefined();
  });
});
