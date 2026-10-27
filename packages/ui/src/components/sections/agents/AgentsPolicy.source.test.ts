import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const pageSource = readFileSync(new URL('./AgentsPage.tsx', import.meta.url), 'utf8');
const sessionDefaultsSource = readFileSync(new URL('./SessionDefaultsPage.tsx', import.meta.url), 'utf8');
const controlledPickerSource = readFileSync(new URL('../../chat/ControlledModelPicker.tsx', import.meta.url), 'utf8');

describe('managed Agent settings presentation', () => {
  test('uses personal defaults for authorized developers and keeps other fields read-only', () => {
    expect(pageSource).toContain('canEditPersonalAgentModels(authPrincipal)');
    expect(pageSource).toContain('await persistAgentModelSelection(');
    expect(pageSource).toContain('await resetAgentModelSelection(selectedAgentName)');
    expect(pageSource).toContain('disabled={isReadOnly}');
    expect(pageSource).toContain('Reset to Host');
  });

  test('summarizes agent models without another per-agent editor beside the shared helper selector', () => {
    expect(sessionDefaultsSource).toContain('resolveAgentDefaultSelection({');
    expect(sessionDefaultsSource).toContain("useUIStore.getState().setSettingsPage('agents');");
    expect(sessionDefaultsSource).toContain("{canReadAgents ? <AgentModelsSummary /> : null}");
    const summarySource = sessionDefaultsSource.slice(sessionDefaultsSource.indexOf('const AgentModelsSummary'), sessionDefaultsSource.indexOf('export const SessionDefaultsPage'));
    expect(summarySource).not.toContain('ModelSelector');
    expect(sessionDefaultsSource).toContain('<HelperModelSettings />');
    expect(sessionDefaultsSource.indexOf('<HelperModelSettings />')).toBeLessThan(sessionDefaultsSource.indexOf("title={t('settings.sessionDefaults.section.cleanup')}"));
    expect(sessionDefaultsSource).not.toContain('persistAgentModelSelection');
    expect(sessionDefaultsSource).not.toContain('resetAgentModelSelection');
  });

  test('the Helper Model uses the chat input picker with its reasoning footer and no explanatory text', () => {
    const helperSource = sessionDefaultsSource.slice(sessionDefaultsSource.indexOf('export const HelperModelSettings'), sessionDefaultsSource.indexOf('type AgentModelRow'));
    expect(helperSource).toContain('<ControlledModelPicker');
    expect(helperSource).not.toContain('ControlledVariantPicker');
    expect(controlledPickerSource).toContain('<ThinkingSlider');
    expect(helperSource).not.toContain('ModelSelector');
    expect(helperSource).not.toContain('settings.sessionDefaults.helper.description');
    expect(helperSource).not.toContain('settings.sessionDefaults.helper.reasoning');
  });

  test('offers a host-only backup model row that personal editors see read-only', () => {
    expect(pageSource).toContain("t('settings.agents.page.field.backupModel')");
    expect(pageSource).toContain("t('settings.agents.page.field.backupModelTooltip')");
    expect(pageSource).toContain("t('settings.agents.page.field.backupModelNone')");
    expect(pageSource).toContain('await saveAgentBackupModel(selectedAgentName, {');
    expect(pageSource).toContain('await resetAgentBackupModel(selectedAgentName)');
    // The backup row uses the chat picker with its own model and level, never the primary's.
    expect(pageSource).toContain([
      '{renderModelPicker({',
      '  modelRef: backupModel,',
      '  value: backupVariant,',
      '  onSelect: (nextBackupModel, nextVariant) => {',
      '    setBackupModel(nextBackupModel);',
      '    setBackupVariant(nextVariant);',
      '  },',
      '})}',
    ].join('\n                        '));
    expect(pageSource).toContain('<ControlledModelPicker');
    expect(pageSource).not.toContain('ModelSelector');
    expect(pageSource).toContain('{!isCouncilAgent && !isPersonalModelEditor ? (');
    expect(pageSource).toContain('disabled={!canEditSelectedModel || isSavingModelOverride || !backupModel.trim() || Boolean(backupModelError)}');
    expect(pageSource).toContain('disabled={!canEditSelectedModel || isSavingModelOverride || !savedBackupModelRef}');
  });
});
