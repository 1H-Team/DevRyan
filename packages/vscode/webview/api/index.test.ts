import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let createVSCodeAPIs: typeof import('./index').createVSCodeAPIs;
const originalWindow = globalThis.window;

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

describe('VS Code RuntimeAPIs adapter contract', () => {
  beforeAll(async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { addEventListener: vi.fn() },
    });
    ({ createVSCodeAPIs } = await import('./index'));
  });

  afterAll(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: Window }).window;
      return;
    }
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
  });

  it('exposes every shared capability plus editor and host actions', async () => {
    const apis = createVSCodeAPIs();

    expect(apis.runtime).toEqual({
      platform: 'vscode',
      isDesktop: false,
      isVSCode: true,
      label: 'VS Code Extension',
    });
    for (const capability of REQUIRED_RUNTIME_APIS) {
      expect(apis[capability]).toBeDefined();
    }
    expect(apis.editor).toBeDefined();
    expect(apis.vscode).toBeDefined();
    expect(apis.github).toBeDefined();
    expect(apis.diagnostics).toBeDefined();
    expect(apis.evidence).toBeDefined();
    expect(apis.push).toBeUndefined();

    await expect(apis.terminal.createSession({ cwd: '/workspace' })).resolves.toEqual({
      sessionId: '',
      cols: 80,
      rows: 24,
    });
    await expect(apis.terminal.keepAlive?.('missing')).resolves.toBe(false);
  });
});
