import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const pageSource = readFileSync(new URL('./AgentsPage.tsx', import.meta.url), 'utf8');
const runtimePageSource = readFileSync(new URL('./AgentRuntimePage.tsx', import.meta.url), 'utf8');

describe('agent runtime presentation', () => {
  test('has its own host-editor Runtime view beside Behavior, outside any agent editor', () => {
    expect(pageSource).toContain("if (resolveAgentsGlobalView(selectedGlobalView, authPrincipal) === 'runtime') return <AgentRuntimePage />;");
    expect(pageSource.indexOf('<AgentRuntimePage />'))
      .toBeLessThan(pageSource.indexOf("t('settings.agents.page.section.identityRole')"));
    expect(runtimePageSource.indexOf('<PackagedAgentPrompts />'))
      .toBeLessThan(runtimePageSource.indexOf('<OpenCodeCliSettings />'));
    expect(runtimePageSource.indexOf('<OpenCodeCliSettings />'))
      .toBeLessThan(runtimePageSource.indexOf('<AgentBrowserControlSettings />'));
  });

  test('offers no language-server switch: OpenCode language servers stay off', () => {
    expect(runtimePageSource).not.toContain('AgentRuntimeSection');
    expect(runtimePageSource).not.toContain('lsp');
  });
});
