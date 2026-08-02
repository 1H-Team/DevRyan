import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./NotificationSettings.tsx', import.meta.url), 'utf8');
const messages = readFileSync(new URL('../../../lib/i18n/messages/en.settings.ts', import.meta.url), 'utf8');
const autoSave = readFileSync(new URL('../../../lib/appearanceAutoSave.ts', import.meta.url), 'utf8');

describe('NotificationSettings Plan Ready controls', () => {
  test('places Plan Ready immediately after Session Completion', () => {
    const completionControl = source.indexOf('aria-pressed={notifyOnCompletion}');
    const planReadyControl = source.indexOf('aria-pressed={notifyOnPlanReady}');
    const subtaskControl = source.indexOf('aria-pressed={notifyOnSubtasks}');

    expect(completionControl).toBeGreaterThan(-1);
    expect(planReadyControl).toBeGreaterThan(completionControl);
    expect(subtaskControl).toBeGreaterThan(planReadyControl);
    expect(source).toContain("ariaLabel={t('settings.notifications.page.events.planReadyAria')}");
    expect(source).toContain('onChange={setNotifyOnPlanReady}');
  });

  test('renders the Plan Ready template after Completion in the responsive grid', () => {
    expect(source).toContain("(['completion', 'planReady', 'subtask', 'error', 'question'] as const)");
    expect(source).toContain('grid grid-cols-1 gap-2 md:grid-cols-2 md:gap-3');
    expect(source).toContain("planReady: 'settings.notifications.page.template.event.planReady'");
  });

  test('uses the exact default title and message copy', () => {
    expect(messages).toContain("'settings.notifications.page.events.completionLabel': 'Session Completion'");
    expect(messages).toContain("'settings.notifications.page.template.event.completion': 'Session Completion'");
    expect(messages).toContain("'settings.notifications.page.template.defaults.completion.title': 'Session complete'");
    expect(messages).toContain("'settings.notifications.page.template.defaults.completion.message': '{session_name} is ready to review'");
    expect(messages).toContain("'settings.notifications.page.template.defaults.planReady.title': 'Plan ready'");
    expect(messages).toContain("'settings.notifications.page.template.defaults.planReady.message': 'A plan is ready for review'");
  });

  test('includes the Plan Ready toggle and template in settings autosave', () => {
    expect(autoSave).toContain('notifyOnPlanReady: state.notifyOnPlanReady');
    expect(autoSave).toContain('diff.notifyOnPlanReady = current.notifyOnPlanReady');
    expect(autoSave).toContain('diff.notificationTemplates = current.notificationTemplates');
  });
});
