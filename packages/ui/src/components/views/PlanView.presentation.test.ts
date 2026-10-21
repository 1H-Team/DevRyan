import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const planViewSource = readFileSync(
  fileURLToPath(new URL('./PlanView.tsx', import.meta.url)),
  'utf8',
);

const planCardSource = readFileSync(
  fileURLToPath(new URL('../chat/message/parts/PlanCard.tsx', import.meta.url)),
  'utf8',
);

const messageBodySource = readFileSync(
  fileURLToPath(new URL('../chat/message/MessageBody.tsx', import.meta.url)),
  'utf8',
);

const contextPanelSource = readFileSync(
  fileURLToPath(new URL('../layout/ContextPanel.tsx', import.meta.url)),
  'utf8',
);

const mainLayoutSource = readFileSync(
  fileURLToPath(new URL('../layout/MainLayout.tsx', import.meta.url)),
  'utf8',
);

describe('plan presentation', () => {
  // Autosave, live refresh and draft retention: PlanView.behavior.test.tsx. Alerts: PlanView.presentation.mounted.test.tsx.
  test('saves the plan card against the canonical revision directory', () => {
    expect(planCardSource).toContain('projectDirectory: currentPlanFileRecord?.revisionIdentity?.directory');
  });

  test('hides the saved success label while retaining actionable save states', () => {
    expect(planCardSource).not.toContain('<span>Plan saved</span>');
    expect(planCardSource).toContain('<span>Saving plan…</span>');
    expect(planCardSource).toContain('Couldn’t save plan.');
    expect(planCardSource).toContain('void persistPlan();');
    expect(planCardSource).toContain('if (!shouldPersist || currentPlanFileRecord) return;');
    expect(planCardSource).toContain('void persistPlan(true);');
    expect(planCardSource).toContain('isPlanFileReady');
  });

  test('removes the manual save-as-plan action while retaining automatic plan persistence', () => {
    expect(messageBodySource).not.toContain('SaveProjectPlanDialog');
    expect(messageBodySource).not.toContain('handleSaveAsPlanClick');
    expect(messageBodySource).not.toContain('chat.messageBody.actions.saveAsPlan');
    expect(planCardSource).toContain('void persistPlan();');
    expect(planCardSource).toContain('isPlanFileReady');
  });

  // The action group's contents and mobile/context-panel header: PlanView.presentation.mounted.test.tsx.
  test('portals the context-panel plan actions ahead of the panel controls without changing the standalone view', () => {
    expect(planViewSource).toContain('createPortal(planActions, headerActionsTarget)');
    expect(planViewSource).toContain('data-plan-view-actions="true"');

    const planActionsSlotIndex = contextPanelSource.indexOf('data-context-plan-actions="true"');
    const expandPanelButtonIndex = contextPanelSource.indexOf("t('contextPanel.actions.expandPanel')");
    expect(planActionsSlotIndex).toBeGreaterThan(-1);
    expect(expandPanelButtonIndex).toBeGreaterThan(planActionsSlotIndex);
    expect(contextPanelSource).toContain('presentation="context-panel"');
    expect(contextPanelSource).toContain('headerActionsTarget={planHeaderActionsTarget}');
    expect(mainLayoutSource).toContain('<LazyPlanView />');
  });

  test('removes improve and implement actions from the plan viewer', () => {
    expect(planViewSource).not.toContain('RiLoopRightAiLine');
    expect(planViewSource).not.toContain('RiCodeAiLine');
    expect(planViewSource).not.toContain('TodoSendDialog');
    expect(planViewSource).not.toContain('setPendingPlanSend');
  });
});
