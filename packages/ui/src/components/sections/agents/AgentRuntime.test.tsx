import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { withDom } from '@/test/mountedDom';
import { I18nProvider } from '@/lib/i18n';
import { getAuthPrincipal, setAuthPrincipal, type AuthPrincipal } from '@/lib/authSession';

const marker = (name: string) => () => <span>{`[${name}]`}</span>;
mock.module('./PackagedAgentPrompts', () => ({ PackagedAgentPrompts: marker('prompts') }));
mock.module('@/components/sections/devryan/OpenCodeCliSettings', () => ({ OpenCodeCliSettings: marker('opencode-cli') }));
mock.module('@/components/sections/devryan/AgentBrowserControlSettings', () => ({ AgentBrowserControlSettings: marker('browser-control') }));

const { AgentRuntimePage } = await import('./AgentRuntimePage');

const base = getAuthPrincipal();
beforeEach(() => { setAuthPrincipal({ ...base, scope: 'local-admin', role: 'admin' }); });
afterEach(() => { setAuthPrincipal(base); });

const renderText = async (principal?: AuthPrincipal): Promise<string> => {
  if (principal) setAuthPrincipal(principal);
  let text = '';
  await withDom(async (container) => {
    Object.assign(globalThis.window, { location: { search: '' } });
    Object.assign(globalThis.document.documentElement, { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } });
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => { root.render(<I18nProvider><AgentRuntimePage /></I18nProvider>); });
      text = container.textContent;
    } finally { await act(async () => root.unmount()); }
  });
  return text;
};

describe('agent runtime presentation', () => {
  test('lists packaged prompts, then the OpenCode binary, then browser control', async () => {
    const text = await renderText();
    const order = ['[prompts]', '[opencode-cli]', '[browser-control]'].map((name) => text.indexOf(name));
    for (const index of order) expect(index).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('hides the packaged prompt editor from principals who cannot edit the host', async () => {
    const managedDeveloper: AuthPrincipal = { ...base, scope: 'managed', role: 'developer' };
    const text = await renderText(managedDeveloper);
    expect(text).not.toContain('[prompts]');
    expect(text).toContain('[opencode-cli]');
  });

  test('offers no language-server switch: OpenCode language servers stay off', async () => {
    const text = (await renderText()).toLowerCase();
    expect(text).not.toContain('language server');
    expect(text).not.toContain('lsp');
  });
});
