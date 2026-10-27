import React from 'react';
import { RiArrowDownSLine, RiArrowRightSLine, RiInformationLine, RiRefreshLine } from '@remixicon/react';

import { UsageResetCreditsList } from '@/components/layout/usage/UsageResetCreditsList';
import { UsageSourceDetails } from '@/components/layout/usage/UsageSourceDetails';
import { sortUsageEntries } from '@/components/layout/usage/usage-groups';
import { SettingsDetailSection } from '@/components/sections/shared/SettingsDetailSection';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { canEditSettingsPage, useAuthPrincipal } from '@/lib/authSession';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { buildQuotaTrendKey, formatProviderWindowLabel } from '@/lib/quota';
import { getAllModelFamilies, getUsageModelDisplayInfo, groupModelsByFamilyWithGetter, sortModelFamilies } from '@/lib/quota/model-families';
import { SettingsPagePermissionBoundary } from '@/lib/settings/permission-context';
import { cn } from '@/lib/utils';
import {
  getEffectiveQuotaRefreshIntervalMs,
  getQuotaProviderRefreshStatus,
  quotaRefreshCoordinator,
  useQuotaStore,
} from '@/stores/useQuotaStore';
import type { QuotaProviderId, UsageWindows } from '@/types';

import { UsageCard } from './UsageCard';
import { UsageOptionsMenu } from './UsageOptionsMenu';

const CLAUDE_CODE_USAGE_PENDING_CODE = 'claude_code_usage_pending';
const CLAUDE_CODE_SESSION_LIMIT_CODE = 'claude_code_session_limit';

const formatTime = (timestamp: number | null) => {
  if (!timestamp) return '-';
  try {
    return new Date(timestamp).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit'
    });
  } catch {
    return '-';
  }
};

interface ModelInfo {
  name: string;
  windows: UsageWindows;
}

type Notice = { tone: 'error' | 'warning' | 'info'; title: string; body?: React.ReactNode };

const NOTICE_CLASSES: Record<Notice['tone'], { box: string; text: string }> = {
  error: { box: 'border-[var(--status-error-border)] bg-[var(--status-error-background)]', text: 'text-[var(--status-error)]' },
  warning: { box: 'border-[var(--status-warning-border)] bg-[var(--status-warning-background)]', text: 'text-[var(--status-warning)]' },
  info: { box: 'border-[var(--status-info-border)] bg-[var(--status-info-background)]', text: 'text-[var(--status-info)]' },
};

const UsageNotice: React.FC<Notice> = ({ tone, title, body }) => (
  <div className={cn('rounded-lg border px-4 py-3', NOTICE_CLASSES[tone].box)}>
    <p className={cn('typography-ui-label font-medium', NOTICE_CLASSES[tone].text)}>{title}</p>
    {body ? <div className={cn('typography-meta mt-1 opacity-80', NOTICE_CLASSES[tone].text)}>{body}</div> : null}
  </div>
);

/**
 * Keeps personal usage preferences usable inside a read-only Providers page,
 * and blocks them inside an editable one when the usage page is read-only.
 */
const UsagePermissionScope: React.FC<{ canEdit: boolean; children: React.ReactNode }> = ({ canEdit, children }) => (
  canEdit
    ? <div data-settings-readonly-allowed="true">{children}</div>
    : <SettingsPagePermissionBoundary slug="usage">{children}</SettingsPagePermissionBoundary>
);

interface ProviderUsagePanelProps {
  quotaProviderId: QuotaProviderId;
  /**
   * `section` is the inline Usage block on a provider page; `page` is the
   * body of a standalone or usage-only view with the header owned by the caller.
   */
  variant: 'section' | 'page';
  /** Whether the panel sits inside another settings page's permission boundary. */
  embedded?: boolean;
  className?: string;
}

/** One provider's usage: status notices, windows, reset credits, model quotas and header visibility. */
export const ProviderUsagePanel: React.FC<ProviderUsagePanelProps> = ({
  quotaProviderId,
  variant,
  embedded = variant === 'section',
  className,
}) => {
  const { t } = useI18n();
  const principal = useAuthPrincipal();
  const canEditUsage = canEditSettingsPage(principal, 'usage');
  const result = useQuotaStore((state) => state.results.find((entry) => entry.providerId === quotaProviderId) ?? null);
  const refreshState = useQuotaStore((state) => state.providerRefreshState[quotaProviderId]);
  const isLoading = useQuotaStore((state) => state.isLoading);
  const discoveryFinished = useQuotaStore((state) => state.configuredProviderIds !== null);
  const error = useQuotaStore((state) => state.error);
  const autoRefresh = useQuotaStore((state) => state.autoRefresh);
  const refreshIntervalMs = useQuotaStore((state) => state.refreshIntervalMs);
  const dropdownProviderIds = useQuotaStore((state) => state.dropdownProviderIds);
  const setDropdownProviderIds = useQuotaStore((state) => state.setDropdownProviderIds);
  const selectedModels = useQuotaStore((state) => state.selectedModels);
  const trendHistory = useQuotaStore((state) => state.trendHistory);
  const toggleModelSelected = useQuotaStore((state) => state.toggleModelSelected);
  const applyDefaultSelections = useQuotaStore((state) => state.applyDefaultSelections);

  const refreshStatus = getQuotaProviderRefreshStatus(
    refreshState,
    getEffectiveQuotaRefreshIntervalMs({ autoRefresh, refreshIntervalMs }),
  );
  const usage = result?.usage;
  const providerError = refreshStatus.refreshError ?? result?.error ?? null;
  const providerWarnings = result?.warnings ?? [];
  const hasRetainedUsageAfterFailure = Boolean(result?.ok && refreshStatus.refreshError);
  const showProviderError = providerError
    && providerError !== error
    && !hasRetainedUsageAfterFailure;
  const showStaleNotice = Boolean(result?.ok && (
    refreshStatus.isStale || hasRetainedUsageAfterFailure
  ));
  const isClaudeUsagePending = result?.errorCode === CLAUDE_CODE_USAGE_PENDING_CODE;
  const isClaudeSessionLimited = result?.errorCode === CLAUDE_CODE_SESSION_LIMIT_CODE;
  const showInDropdown = dropdownProviderIds.includes(quotaProviderId);

  const handleDropdownToggle = React.useCallback((enabled: boolean) => {
    const next = enabled
      ? Array.from(new Set([...dropdownProviderIds, quotaProviderId]))
      : dropdownProviderIds.filter((id) => id !== quotaProviderId);
    setDropdownProviderIds(next);
    void updateDesktopSettings({ usageDropdownProviders: next });
  }, [dropdownProviderIds, quotaProviderId, setDropdownProviderIds]);

  const providerModels = React.useMemo((): ModelInfo[] => {
    if (!usage?.models) return [];
    return Object.entries(usage.models)
      .map(([name, modelUsage]) => ({ name, windows: modelUsage }))
      .filter((model) => Object.keys(model.windows.windows).length > 0)
      .sort((left, right) => {
        const leftOrder = typeof left.windows.sortOrder === 'number' ? left.windows.sortOrder : Number.MAX_SAFE_INTEGER;
        const rightOrder = typeof right.windows.sortOrder === 'number' ? right.windows.sortOrder : Number.MAX_SAFE_INTEGER;
        return leftOrder - rightOrder || left.name.localeCompare(right.name);
      });
  }, [usage?.models]);

  React.useEffect(() => {
    if (providerModels.length > 0) {
      applyDefaultSelections(quotaProviderId, providerModels.map((m) => m.name));
    }
  }, [quotaProviderId, providerModels, applyDefaultSelections]);

  const modelsByFamily = React.useMemo(() => {
    if (providerModels.length === 0) {
      return new Map<string | null, ModelInfo[]>();
    }
    return groupModelsByFamilyWithGetter(providerModels, (model) => model.name, quotaProviderId);
  }, [providerModels, quotaProviderId]);

  const modelGroups = React.useMemo(() => {
    const families = sortModelFamilies(getAllModelFamilies(quotaProviderId));
    const groups = families
      .map((family) => ({ id: family.id, label: family.label, models: modelsByFamily.get(family.id) ?? [] }))
      .filter((group) => group.models.length > 0);
    const otherModels = modelsByFamily.get(null) ?? [];
    if (otherModels.length > 0) {
      groups.push({ id: 'other', label: t('settings.usage.page.section.otherModels'), models: otherModels });
    }
    return groups;
  }, [modelsByFamily, quotaProviderId, t]);

  // Inline sections start with model quotas folded so the provider page stays scannable.
  const defaultCollapsed = variant === 'section';
  const [collapsedFamilies, setCollapsedFamilies] = React.useState<Record<string, boolean>>({});
  const toggleFamilyCollapsed = React.useCallback((familyId: string) => {
    setCollapsedFamilies((prev) => ({
      ...prev,
      [familyId]: !(prev[familyId] ?? defaultCollapsed),
    }));
  }, [defaultCollapsed]);

  const handleModelToggle = React.useCallback((modelName: string) => {
    toggleModelSelected(quotaProviderId, modelName);
    const currentSelected = selectedModels[quotaProviderId] ?? [];
    const isSelected = currentSelected.includes(modelName);
    const nextSelected = isSelected
      ? currentSelected.filter((m) => m !== modelName)
      : [...currentSelected, modelName];
    const nextSettings: Record<string, string[]> = { ...selectedModels, [quotaProviderId]: nextSelected };
    void updateDesktopSettings({ usageSelectedModels: nextSettings });
  }, [quotaProviderId, selectedModels, toggleModelSelected]);

  const providerSelectedModels = selectedModels[quotaProviderId] ?? [];
  const overallUsageEntries = React.useMemo(() => (
    sortUsageEntries(quotaProviderId, Object.entries(usage?.windows ?? {}))
  ), [quotaProviderId, usage?.windows]);

  const renderModelCard = (model: ModelInfo) => {
    const entries = Object.entries(model.windows.windows);
    if (entries.length === 0) return null;
    const [label, window] = entries[0];
    const modelDisplay = getUsageModelDisplayInfo(model.name, model.windows);

    return (
      <UsageCard
        key={model.name}
        title={label}
        displayTitle={modelDisplay.displayName}
        subtitle={modelDisplay.contextLabel}
        window={window}
        trendHistory={trendHistory}
        trendKey={buildQuotaTrendKey(quotaProviderId, 'model', model.name, label)}
        showToggle
        toggleEnabled={providerSelectedModels.includes(model.name)}
        onToggle={() => handleModelToggle(model.name)}
      />
    );
  };

  const notices: Notice[] = [];
  if (!result) {
    notices.push(discoveryFinished
      ? {
        tone: 'info',
        title: t('settings.usage.page.state.unreadableTitle'),
        body: t('settings.usage.page.state.unreadableDescription'),
      }
      : { tone: 'info', title: t('settings.usage.page.state.noData') });
  }
  if (error) {
    notices.push({ tone: 'error', title: t('settings.usage.page.state.refreshFailedTitle'), body: error });
  }
  if (showStaleNotice) {
    notices.push({
      tone: 'warning',
      title: t('settings.usage.page.state.staleTitle'),
      body: refreshStatus.refreshError ?? t('settings.usage.page.state.staleDescription'),
    });
  }
  if (isClaudeUsagePending && showProviderError) {
    notices.push({
      tone: 'info',
      title: t('settings.usage.page.state.claudeUsagePendingTitle'),
      body: providerError ?? t('settings.usage.page.state.claudeUsagePendingDescription'),
    });
  }
  if (isClaudeSessionLimited && showProviderError) {
    notices.push({ tone: 'warning', title: t('settings.usage.page.state.claudeSessionLimitTitle'), body: providerError });
  }
  if (showProviderError && !isClaudeUsagePending && !isClaudeSessionLimited) {
    notices.push({ tone: 'error', title: t('settings.usage.page.state.providerErrorTitle'), body: providerError });
  }
  if (result && !result.configured) {
    notices.push({
      tone: 'warning',
      title: t('settings.usage.page.state.providerNotConfiguredTitle'),
      body: t(variant === 'section'
        ? 'settings.usage.section.notConfiguredDescription'
        : 'settings.usage.page.state.providerNotConfiguredDescription'),
    });
  }
  if (providerWarnings.length > 0) {
    notices.push({
      tone: 'warning',
      title: t('settings.usage.page.state.providerWarningTitle'),
      body: <div className="space-y-1">{providerWarnings.map((warning, index) => <p key={`${quotaProviderId}-warning-${index}`}>{warning}</p>)}</div>,
    });
  }

  const showNoQuotaWindows = Boolean(result?.configured && !providerError && usage
    && Object.keys(usage.windows ?? {}).length === 0 && providerModels.length === 0);

  const updatedLabel = isLoading
    ? t('settings.usage.page.header.refreshing')
    : t('settings.usage.section.updated', {
      time: formatTime(result?.usageUpdatedAt ?? refreshStatus.lastSuccessAt),
    });

  const headerActions = (
    <>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className="h-6 w-6 px-0 text-muted-foreground hover:text-foreground"
        onClick={() => void quotaRefreshCoordinator.refreshNow({ forceRefresh: true }).catch(() => undefined)}
        disabled={isLoading}
        aria-label={t('settings.usage.sidebar.actions.refreshAria')}
        title={t('settings.usage.sidebar.actions.refreshTitle')}
      >
        <RiRefreshLine className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
      </Button>
      <UsageOptionsMenu canEdit={canEditUsage} />
    </>
  );

  const body = (
    <div className="space-y-4">
      {result ? <UsageSourceDetails source={result.source} account={result.account} /> : null}
      {notices.map((notice) => <UsageNotice key={`${notice.tone}:${notice.title}`} {...notice} />)}

      {overallUsageEntries.length > 0 ? (
        <div className="divide-y divide-[var(--surface-subtle)]">
          {overallUsageEntries.map(([label, window]) => (
            <UsageCard
              key={label}
              title={label}
              displayTitle={formatProviderWindowLabel(quotaProviderId, label)}
              window={window}
              trendHistory={trendHistory}
              trendKey={buildQuotaTrendKey(quotaProviderId, 'window', null, label)}
              progressTone={quotaProviderId === 'opencode' && label === 'credits' ? 'success' : 'adaptive'}
            />
          ))}
        </div>
      ) : null}

      {usage?.resetCredits || result?.source === 'codex-app-server' && usage?.resetCredits === null ? (
        <UsageResetCreditsList resetCredits={usage?.resetCredits ?? null} />
      ) : null}

      {modelGroups.length > 0 ? (
        <div className="space-y-1">
          <div className="typography-ui-label font-medium text-foreground">{t('settings.usage.page.section.modelQuotas')}</div>
          {modelGroups.map((group) => {
            const isCollapsed = collapsedFamilies[group.id] ?? defaultCollapsed;
            return (
              <Collapsible key={group.id} open={!isCollapsed} onOpenChange={() => toggleFamilyCollapsed(group.id)}>
                <CollapsibleTrigger className="group flex w-full items-center justify-between rounded-md py-1 text-left">
                  <span className="flex items-center gap-1.5">
                    <span className="typography-ui-label font-normal text-foreground">{group.label}</span>
                    <span className="typography-micro text-muted-foreground">({group.models.length})</span>
                  </span>
                  {isCollapsed ? (
                    <RiArrowRightSLine className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
                  ) : (
                    <RiArrowDownSLine className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
                  )}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="divide-y divide-[var(--surface-subtle)]">
                    {group.models.map((model) => renderModelCard(model))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>
      ) : null}

      {showNoQuotaWindows ? (
        <div>
          <p className="typography-ui-label text-foreground">{t('settings.usage.page.state.noQuotaWindowsTitle')}</p>
          <p className="typography-meta mt-1 text-muted-foreground">{t('settings.usage.page.state.noQuotaWindowsDescription')}</p>
        </div>
      ) : null}

      <div
        className="group flex w-fit cursor-pointer items-center gap-2 py-1"
        role="button"
        tabIndex={0}
        aria-pressed={showInDropdown}
        onClick={() => handleDropdownToggle(!showInDropdown)}
        onKeyDown={(event) => {
          if (event.key === ' ' || event.key === 'Enter') {
            event.preventDefault();
            handleDropdownToggle(!showInDropdown);
          }
        }}
      >
        <Checkbox
          checked={showInDropdown}
          onChange={handleDropdownToggle}
          ariaLabel={t('settings.usage.page.options.showInHeaderAria')}
        />
        <span className="typography-ui-label text-foreground">{t('settings.usage.page.options.showInHeader')}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <RiInformationLine className="h-3.5 w-3.5 cursor-help text-muted-foreground/60" />
          </TooltipTrigger>
          <TooltipContent sideOffset={8} className="max-w-xs">
            {t('settings.usage.page.options.showInHeaderTooltip')}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );

  const content = (
    <SettingsDetailSection
      className={className}
      title={t('settings.usage.section.title')}
      meta={<span className={cn(isLoading && 'animate-pulse')}>{updatedLabel}</span>}
      actions={headerActions}
    >
      {body}
    </SettingsDetailSection>
  );

  return embedded ? <UsagePermissionScope canEdit={canEditUsage}>{content}</UsagePermissionScope> : content;
};
