import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const pageSource = readFileSync(new URL('./AgentsPage.tsx', import.meta.url), 'utf8');
const entriesSource = readFileSync(new URL('./useAgentsSettingsEntries.ts', import.meta.url), 'utf8');
const sessionDefaultsSource = readFileSync(new URL('./SessionDefaultsPage.tsx', import.meta.url), 'utf8');

describe('managed Agent settings presentation', () => {
  test('removes Global Behavior and falls back to an individual agent when hidden', () => {
    expect(entriesSource).toContain('isGlobalAgentBehaviorUiHidden(principal)');
    expect(entriesSource).toContain('if (canReadAgents && !behaviorHidden) {');
    expect(entriesSource).toContain('setSelectedAgent(fallback.name)');
    expect(pageSource).toContain('if (behaviorUiHidden) return null;');
  });

  test('offers Runtime only to host editors and Session Defaults to anyone who may read sessions', () => {
    expect(entriesSource).toContain("principal.scope === 'local-admin' || principal.role === 'admin'");
    expect(entriesSource).toContain('const runtimeVisible = canReadAgents && canViewAgentRuntime(principal);');
    expect(entriesSource).toContain("view === 'runtime' && canViewAgentRuntime(principal) ? 'runtime' : 'behavior'");
    expect(entriesSource).toContain("const canReadSessions = canAccessSettingsPage(principal, 'sessions');");
    expect(entriesSource).toContain("const targetSlug = entry.kind === 'session-defaults' ? 'sessions' : 'agents';");
  });

  test('uses personal defaults for authorized developers and keeps other fields read-only', () => {
    expect(pageSource).toContain('canEditPersonalAgentModels(authPrincipal)');
    expect(pageSource).toContain('await persistAgentModelSelection(');
    expect(pageSource).toContain('await resetAgentModelSelection(selectedAgentName)');
    expect(pageSource).toContain('disabled={isReadOnly}');
    expect(pageSource).toContain('Reset to Host');
  });

  test('summarizes agent models on Session Defaults without a second model editor', () => {
    expect(sessionDefaultsSource).toContain('resolveAgentDefaultSelection({');
    expect(sessionDefaultsSource).toContain("useUIStore.getState().setSettingsPage('agents');");
    expect(sessionDefaultsSource).toContain("{canReadAgents ? <AgentModelsSummary /> : null}");
    expect(sessionDefaultsSource).not.toContain('ModelSelector');
    expect(sessionDefaultsSource).not.toContain('persistAgentModelSelection');
    expect(sessionDefaultsSource).not.toContain('resetAgentModelSelection');
  });

  test('offers a host-only backup model row that personal editors see read-only', () => {
    expect(pageSource).toContain("t('settings.agents.page.field.backupModel')");
    expect(pageSource).toContain("t('settings.agents.page.field.backupModelTooltip')");
    expect(pageSource).toContain("t('settings.agents.page.field.backupModelNone')");
    expect(pageSource).toContain('await saveAgentBackupModel(selectedAgentName, {');
    expect(pageSource).toContain('await resetAgentBackupModel(selectedAgentName)');
    expect(pageSource).toContain("renderThinkingLevelRow('backup-thinking', true, backupModel, backupVariant, setBackupVariant, setBackupModel)");
    expect(pageSource).toContain('{!isCouncilAgent && !isPersonalModelEditor ? (');
    expect(pageSource).toContain('disabled={!canEditSelectedModel || isSavingModelOverride || !backupModel.trim()}');
    expect(pageSource).toContain('disabled={!canEditSelectedModel || isSavingModelOverride || !savedBackupModelRef}');
  });
});
