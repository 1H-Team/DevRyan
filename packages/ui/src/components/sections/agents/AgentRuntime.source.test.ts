import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const pageSource = readFileSync(new URL('./AgentsPage.tsx', import.meta.url), 'utf8');
const sectionSource = readFileSync(new URL('./AgentRuntimeSection.tsx', import.meta.url), 'utf8');

describe('agent runtime presentation', () => {
  test('sits with the host-wide policy page right after the sub-agent limits', () => {
    expect(pageSource).toContain('<AgentRuntimeSection canEdit={isHostModelEditor} />');
    expect(pageSource.indexOf('<SubagentLimitsSection'))
      .toBeLessThan(pageSource.indexOf('<AgentRuntimeSection'));
    expect(pageSource.indexOf('<AgentRuntimeSection'))
      .toBeLessThan(pageSource.indexOf("t('settings.agents.page.section.identityRole')"));
  });

  test('offers the language-server switch to host admins and read-only text to others', () => {
    expect(sectionSource).toContain("t('settings.agents.runtime.title')");
    expect(sectionSource).toContain("t('settings.agents.runtime.lsp.label')");
    expect(sectionSource).toContain("t('settings.agents.runtime.lsp.description')");
    expect(sectionSource).toContain('checked={settings.lsp}');
    expect(sectionSource).toContain('void save({ lsp: checked })');
    expect(sectionSource.match(/\{canEdit \? \(/g)).toHaveLength(1);
    expect(sectionSource).toContain("t('settings.agents.runtime.readOnly.on')");
    expect(sectionSource).toContain("t('settings.agents.runtime.readOnly.off')");
    expect(sectionSource).toContain('if (!settings) return null;');
  });

  test('saves through the agents store, reports failures, and hides on hosts without the route', () => {
    expect(sectionSource).toContain('saveAgentRuntimeSettings(input).catch(');
    expect(sectionSource).toContain("t('settings.agents.runtime.toast.saveFailed')");
    expect(sectionSource).toContain('getAgentRuntimeSettings().catch(');
    expect(sectionSource).toContain("t('settings.agents.runtime.toast.loadFailed')");
  });

  test('shows the restart note after a change and a Restart Runtime button only where the host can restart', () => {
    expect(sectionSource).toContain('settings.restartRequired ? (');
    expect(sectionSource).toContain("t('settings.agents.runtime.restart.note')");
    expect(sectionSource).toContain('apis.settings.restartOpenCode');
    expect(sectionSource).toContain('{canEdit && restartOpenCode ? (');
    expect(sectionSource).toContain("t('settings.agents.runtime.actions.restart')");
    expect(sectionSource).toContain('await restartOpenCode();');
    expect(sectionSource).toContain('markAgentRuntimeRestarted();');
    expect(sectionSource).toContain("t('settings.agents.runtime.toast.restartRequested')");
    expect(sectionSource).toContain("t('settings.agents.runtime.toast.restartFailed')");
  });
});
