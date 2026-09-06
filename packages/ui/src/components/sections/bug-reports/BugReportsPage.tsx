import React from 'react';
import { Tabs } from '@base-ui/react/tabs';

import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { useAuthPrincipal } from '@/lib/authSession';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { useI18n } from '@/lib/i18n';
import { useSettingsPagePermission } from '@/lib/settings/permission-state';

const LazySubmitBugReportPanel = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('./SubmitBugReportPanel').then((module) => ({
    default: module.SubmitBugReportPanel,
  })),
);
const LazyBugReportReviewPanel = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('./BugReportReviewPanel').then((module) => ({
    default: module.BugReportReviewPanel,
  })),
);
const LazyErrorLogsPanel = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('./ErrorLogsPanel').then((module) => ({
    default: module.ErrorLogsPanel,
  })),
);
const LazyBotAuditPanel = /* @__PURE__ */ lazyWithChunkRecovery(() =>
  import('./BotAuditPanel').then((module) => ({
    default: module.BotAuditPanel,
  })),
);

type BugReportsTab = 'submit' | 'reports' | 'agent-audit' | 'bot-audit';

const tabClassName =
  'relative shrink-0 rounded-lg px-3 py-2 typography-ui-label font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] data-[active]:bg-[var(--surface-elevated)] data-[active]:text-foreground data-[active]:shadow-sm';

const PanelBoundary: React.FC<React.PropsWithChildren> = ({ children }) => (
  <ErrorBoundary>
    <React.Suspense fallback={<div className="min-h-40" aria-busy="true" />}>{children}</React.Suspense>
  </ErrorBoundary>
);

export const BugReportsPage: React.FC = () => {
  const { t } = useI18n();
  const principal = useAuthPrincipal();
  const { canEdit } = useSettingsPagePermission();
  const isAdmin = principal.scope === 'managed' && principal.role === 'admin';
  const initialTab: BugReportsTab = canEdit ? 'submit' : 'reports';
  const [activeTab, setActiveTab] = React.useState<BugReportsTab>(initialTab);
  const [visitedTabs, setVisitedTabs] = React.useState<ReadonlySet<BugReportsTab>>(() => new Set([initialTab]));

  if (principal.scope !== 'managed') return null;

  const selectTab = (value: string): void => {
    const tab = value as BugReportsTab;
    setActiveTab(tab);
    setVisitedTabs((current) => {
      if (current.has(tab)) return current;
      const next = new Set(current);
      next.add(tab);
      return next;
    });
  };

  return (
    <SettingsPageLayout className="max-w-5xl">
      <div className="space-y-1">
        <h1 className="typography-ui-header font-semibold text-foreground">{t('settings.page.bugReports.title')}</h1>
        <p className="typography-ui text-muted-foreground">{t('settings.page.bugReports.description')}</p>
      </div>

      {!canEdit && !isAdmin ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center typography-meta text-muted-foreground">
          {t('settings.bugReports.submit.editRequired')}
        </div>
      ) : (
        <Tabs.Root value={activeTab} onValueChange={selectTab} className="space-y-6">
          <div className="flex justify-center">
            <div className="inline-flex max-w-full overflow-x-auto rounded-xl border border-border/60 bg-[var(--surface-subtle)]/35 p-1">
              <Tabs.List className="flex items-center gap-1" aria-label={t('settings.page.bugReports.title')}>
                {canEdit ? (
                  <Tabs.Tab className={tabClassName} value="submit">
                    {t('settings.bugReports.tabs.submit')}
                  </Tabs.Tab>
                ) : null}
                {isAdmin ? (
                  <Tabs.Tab className={tabClassName} value="reports">
                    {t('settings.bugReports.tabs.reports')}
                  </Tabs.Tab>
                ) : null}
                {isAdmin ? (
                  <Tabs.Tab className={tabClassName} value="agent-audit">
                    {t('settings.bugReports.tabs.agentAudit')}
                  </Tabs.Tab>
                ) : null}
                {isAdmin ? (
                  <Tabs.Tab className={tabClassName} value="bot-audit">
                    {t('settings.bugReports.tabs.botAudit')}
                  </Tabs.Tab>
                ) : null}
              </Tabs.List>
            </div>
          </div>

          {canEdit ? (
            <Tabs.Panel value="submit" keepMounted className="[[hidden]]:hidden">
              {visitedTabs.has('submit') ? (
                <PanelBoundary>
                  <LazySubmitBugReportPanel />
                </PanelBoundary>
              ) : null}
            </Tabs.Panel>
          ) : null}
          {isAdmin ? (
            <Tabs.Panel value="reports" keepMounted className="[[hidden]]:hidden">
              {visitedTabs.has('reports') ? (
                <PanelBoundary>
                  <LazyBugReportReviewPanel />
                </PanelBoundary>
              ) : null}
            </Tabs.Panel>
          ) : null}
          {isAdmin ? (
            <Tabs.Panel value="agent-audit" keepMounted className="[[hidden]]:hidden">
              {visitedTabs.has('agent-audit') ? (
                <PanelBoundary>
                  <LazyErrorLogsPanel />
                </PanelBoundary>
              ) : null}
            </Tabs.Panel>
          ) : null}
          {isAdmin ? (
            <Tabs.Panel value="bot-audit" keepMounted className="[[hidden]]:hidden">
              {visitedTabs.has('bot-audit') ? (
                <PanelBoundary>
                  <LazyBotAuditPanel />
                </PanelBoundary>
              ) : null}
            </Tabs.Panel>
          ) : null}
        </Tabs.Root>
      )}
    </SettingsPageLayout>
  );
};
