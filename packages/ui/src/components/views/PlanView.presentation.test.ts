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
  test('opens each plan as rendered Markdown while keeping editing temporary', () => {
    expect(planViewSource).toContain("useState<'preview' | 'edit'>('preview')");
    expect(planViewSource).toContain("setMdViewMode('preview')");
    expect(planViewSource).toContain('[currentSessionId, sessionPlanPath, targetPath]');
    expect(planViewSource).not.toContain('openchamber:plan:md-viewer-mode');
    expect(planViewSource).toContain("mdViewMode === 'preview'");
    expect(planViewSource).toContain('<SimpleMarkdownRenderer content={content}');
    expect(planViewSource).toContain('<PreviewToggleButton');
    expect(planViewSource).toContain("setMdViewMode(mdViewMode === 'preview' ? 'edit' : 'preview')");
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

  test('moves context-panel plan actions ahead of the panel controls without changing the standalone view', () => {
    expect(planViewSource).toContain("presentation?: 'standalone' | 'context-panel'");
    expect(planViewSource).toContain("presentation === 'context-panel'");
    expect(planViewSource).toContain('createPortal(planActions, headerActionsTarget)');
    expect(planViewSource).toContain('data-plan-view-actions="true"');
    expect(planViewSource).toContain("t('planView.actions.improvePlanAria')");
    expect(planViewSource).toContain("t('planView.actions.implementPlanAria')");
    expect(planViewSource).toContain('<PreviewToggleButton');
    expect(planViewSource).toContain("t('planView.actions.copyPlanContents')");

    const planActionsSlotIndex = contextPanelSource.indexOf('data-context-plan-actions="true"');
    const expandPanelButtonIndex = contextPanelSource.indexOf("t('contextPanel.actions.expandPanel')");
    expect(planActionsSlotIndex).toBeGreaterThan(-1);
    expect(expandPanelButtonIndex).toBeGreaterThan(planActionsSlotIndex);
    expect(contextPanelSource).toContain('presentation="context-panel"');
    expect(contextPanelSource).toContain('headerActionsTarget={planHeaderActionsTarget}');

    expect(planViewSource).toContain("presentation === 'standalone'");
    expect(planViewSource).toContain(": parsedTitle}");
    expect(mainLayoutSource).toContain('<LazyPlanView />');
  });

  test('keeps save failures visible when the context-panel title row is suppressed', () => {
    expect(planViewSource).toContain("presentation === 'standalone' ? (");
    expect(planViewSource.match(/t\('planView\.error\.saveFailed'\)/g)?.length ?? 0).toBeGreaterThan(1);
    expect(planViewSource).toContain('flex-shrink-0 truncate border-b border-border/40 px-3 py-1');
  });

  test('uses the compact mobile Plan header with Close immediately before the action group', () => {
    const standaloneHeader = planViewSource.slice(planViewSource.indexOf("presentation === 'standalone' ? ("));
    const closeIndex = standaloneHeader.indexOf('data-plan-view-close="true"');
    const actionIndex = standaloneHeader.indexOf('{planActions}');

    expect(planViewSource).toContain('RiCloseLine');
    expect(planViewSource).toContain("isMobile ? t('layout.mainTab.plan') : parsedTitle");
    expect(planViewSource).toContain("t('planView.actions.closePlanAria')");
    expect(planViewSource).toContain('onClick={routeToChat}');
    expect(closeIndex).toBeGreaterThan(-1);
    expect(actionIndex).toBeGreaterThan(closeIndex);
  });

  test('wires mobile implementation handoff to the exact saved source revision only after send succeeds', () => {
    expect(planViewSource).toContain('const sessionPlanFileRecord = useSessionPlanFileStore');
    expect(planViewSource).toContain('const sourcePlanMessageId = sessionPlanFileRecord?.status === \'saved\'');
    expect(planViewSource).toContain("pendingPlanSend.action === 'implement' && isMobile && currentSessionId && sourcePlanMessageId");
    expect(planViewSource).toContain('markPlanImplementationHandedOff(');
    expect(planViewSource).not.toContain('markPlanImplementationRequested(');
    expect(planViewSource).toContain('setPlanModeSelection(currentSessionId, false)');
    expect(planViewSource).toContain('clearHandedOffPlanIndicator(currentSessionId, sourcePlanMessageId)');
  });
});
