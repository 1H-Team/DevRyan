import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { quotaRefreshCoordinator } from '@/stores/useQuotaStore';
import { RiAddLine, RiDeleteBinLine, RiStackLine } from '@remixicon/react';
import { cn } from '@/lib/utils';
import { recordConfigMutationResponse, useConfigApplyStore } from '@/stores/useConfigApplyStore';
import { useI18n } from '@/lib/i18n';
import { splitAntigravityProviderForDisplay } from '@/lib/providers/antigravity';
import { getProviderDisplayName } from '@/lib/providers/display';
import { getProviderModelsForDisplay, sortProvidersByDisplayName } from './providerSorting';
import {
  disconnectProvider,
  hasActiveProviderSource,
  shouldShowConnectedProvider,
  useProviderDisconnectStore,
  type ProviderSources,
} from './providerConnectionState';

const ADD_PROVIDER_ID = '__add_provider__';

interface ProvidersSidebarProps {
  onItemSelect?: () => void;
}

export const ProvidersSidebar: React.FC<ProvidersSidebarProps> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const rawProviders = useConfigStore((state) => state.directoryScoped.__global__?.providers ?? state.providers);
  const discoveredProviders = React.useMemo(
    () => splitAntigravityProviderForDisplay(rawProviders),
    [rawProviders]
  );
  const selectedProviderId = useConfigStore((state) => state.selectedProviderId);
  const setSelectedProvider = useConfigStore((state) => state.setSelectedProvider);
  const loadProviders = useConfigStore((state) => state.loadProviders);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const appliedRevision = useConfigApplyStore((state) => state.status?.appliedRevision ?? 0);
  const pendingRevisionByProvider = useProviderDisconnectStore((state) => state.pendingRevisionByProvider);
  const sourceRefreshRevision = useProviderDisconnectStore((state) => state.sourceRefreshRevision);
  const markDisconnectRequested = useProviderDisconnectStore((state) => state.markRequested);
  const reconcileAppliedRevision = useProviderDisconnectStore((state) => state.reconcileAppliedRevision);
  const [sourcesByProvider, setSourcesByProvider] = React.useState<Record<string, ProviderSources>>({});
  const [disconnectingProviderId, setDisconnectingProviderId] = React.useState<string | null>(null);
  const providers = React.useMemo(
    () => discoveredProviders.filter((provider) => shouldShowConnectedProvider(
      provider.id,
      sourcesByProvider[provider.id],
      Object.prototype.hasOwnProperty.call(pendingRevisionByProvider, provider.id),
    )),
    [discoveredProviders, pendingRevisionByProvider, sourcesByProvider],
  );
  const sortedProviders = React.useMemo(
    () => sortProvidersByDisplayName(providers, sourcesByProvider),
    [providers, sourcesByProvider]
  );

  React.useEffect(() => {
    void loadProviders({ directory: null });
  }, [loadProviders]);

  React.useEffect(() => {
    reconcileAppliedRevision(appliedRevision);
  }, [appliedRevision, reconcileAppliedRevision]);

  React.useEffect(() => {
    if (discoveredProviders.length === 0) {
      setSourcesByProvider({});
      return;
    }

    let cancelled = false;
    setSourcesByProvider({});

    const loadAllSources = async () => {
      const tasks = discoveredProviders.map(async (provider) => {
        try {
          const query = currentDirectory?.trim()
            ? `?directory=${encodeURIComponent(currentDirectory.trim())}`
            : '';
          const response = await fetch(`/api/provider/${encodeURIComponent(provider.id)}/source${query}`, {
            method: 'GET',
            headers: { Accept: 'application/json' },
          });
          if (!response.ok) {
            return;
          }
          const payload = await response.json().catch(() => null);
          const sources = (payload?.sources ?? payload?.data?.sources) as ProviderSources | undefined;
          if (!sources) {
            return;
          }
          if (cancelled) {
            return;
          }
          setSourcesByProvider((prev) => ({
            ...prev,
            [provider.id]: sources,
          }));
        } catch {
          // ignore
        }
      });

      await Promise.all(tasks);
    };

    void loadAllSources();

    return () => {
      cancelled = true;
    };
  }, [currentDirectory, discoveredProviders, sourceRefreshRevision]);

  const bgClass = 'bg-background';

  const handleDisconnectProvider = React.useCallback(
    async (providerId: string) => {
      setDisconnectingProviderId(providerId);

      try {
        const payload = await disconnectProvider(providerId, currentDirectory);
        const applyStatus = recordConfigMutationResponse(payload);
        markDisconnectRequested(providerId, payload);
        toast.success(applyStatus?.pending
          ? t('settings.providers.page.toast.providerDisconnectQueued')
          : t('settings.providers.page.toast.providerDisconnected'));
        if (!applyStatus?.pending) await loadProviders({ directory: null, force: true });
        quotaRefreshCoordinator.settingsChanged();
      } catch (error) {
        console.error('Failed to disconnect provider:', error);
        toast.error(t('settings.providers.page.toast.providerDisconnectFailed'));
      } finally {
        setDisconnectingProviderId(null);
      }
    },
    [currentDirectory, loadProviders, markDisconnectRequested, t]
  );

  return (
    <div className={cn('flex h-full flex-col', bgClass)}>
      <div className="border-b px-3 pt-4 pb-3">
        <h2 className="text-base font-semibold text-foreground mb-3">{t('settings.providers.sidebar.title')}</h2>
        <div className="flex items-center justify-between gap-2">
          <span className="typography-meta text-muted-foreground">{t('settings.providers.sidebar.total', { count: providers.length })}</span>
          <Button size="sm"
            variant="ghost"
            className="h-7 w-7 px-0 -my-1 text-muted-foreground"
            onClick={() => {
              setSelectedProvider(ADD_PROVIDER_ID);
              onItemSelect?.();
            }}
            aria-label={t('settings.providers.sidebar.actions.connectProviderAria')}
            title={t('settings.providers.sidebar.actions.connectProviderTitle')}
          >
            <RiAddLine className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="space-y-1 px-3 py-2 overflow-x-hidden">
        {providers.length === 0 ? (
          <div className="py-12 px-4 text-center text-muted-foreground">
            <RiStackLine className="mx-auto mb-3 h-10 w-10 opacity-50" />
            <p className="typography-ui-label font-medium">{t('settings.providers.sidebar.empty.title')}</p>
            <p className="typography-meta mt-1 opacity-75">{t('settings.providers.sidebar.empty.description')}</p>
          </div>
        ) : (
          <>
            {sortedProviders.map((provider) => {
              const sources = sourcesByProvider[provider.id];
              const isDisconnectPending = Object.prototype.hasOwnProperty.call(
                pendingRevisionByProvider,
                provider.id,
              );
              const canDisconnect = hasActiveProviderSource(sources) && !isDisconnectPending;

              return (
                <ProviderListItem
                  key={provider.id}
                  provider={provider}
                  selectedProviderId={selectedProviderId}
                  canDisconnect={canDisconnect}
                  sources={sources}
                  isDisconnecting={disconnectingProviderId === provider.id}
                  isDisconnectPending={isDisconnectPending}
                  onSelect={() => {
                    setSelectedProvider(provider.id);
                    onItemSelect?.();
                  }}
                  onDisconnect={() => handleDisconnectProvider(provider.id)}
                />
              );
            })}
          </>
        )}
      </ScrollableOverlay>
    </div>
  );
};

const ProviderListItem: React.FC<{
  provider: { id: string; name?: string; models?: unknown[] };
  selectedProviderId: string;
  sources?: ProviderSources;
  canDisconnect?: boolean;
  isDisconnecting?: boolean;
  isDisconnectPending?: boolean;
  onSelect: () => void;
  onDisconnect?: () => void;
}> = ({ provider, selectedProviderId, sources, canDisconnect = false, isDisconnecting = false, isDisconnectPending = false, onSelect, onDisconnect }) => {
  const { t } = useI18n();
  const modelCount = getProviderModelsForDisplay(
    provider as { id?: string; models?: Array<{ id?: string; name?: string }> },
    { hidePairedFastModels: true },
  ).length;
  const isSelected = provider.id === selectedProviderId;
  const providerName = getProviderDisplayName(provider, sources);

  return (
    <div
      key={provider.id}
      className={cn(
        'group relative flex items-center gap-1 rounded-md px-1.5 py-1 transition-all duration-200',
        isSelected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover'
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        tabIndex={0}
      >
        <ProviderLogo providerId={provider.id} className="h-4 w-4 flex-shrink-0" />
        <span className="typography-ui-label font-normal truncate flex-1 min-w-0 text-foreground">
          {providerName}
        </span>
        <span className={cn(
          'typography-micro flex-shrink-0 text-right tabular-nums text-muted-foreground/60',
          isDisconnectPending ? 'w-auto' : 'w-7',
        )}>
          {isDisconnectPending ? t('settings.providers.page.state.disconnectPendingShort') : modelCount}
        </span>
      </button>
      <div className="h-6 w-6 flex-shrink-0">
        {canDisconnect && onDisconnect ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="h-6 w-6 px-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:text-destructive focus-visible:opacity-100"
            disabled={isDisconnecting}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onDisconnect();
            }}
            aria-label={t('settings.providers.page.actions.disconnect')}
            title={t('settings.providers.page.actions.disconnect')}
          >
            <RiDeleteBinLine className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  );
};
