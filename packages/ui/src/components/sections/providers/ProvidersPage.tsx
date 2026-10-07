import { assertRuntimeFeatureAvailable, useRuntimeFeature } from '@/lib/opencode/runtime-capabilities';
import React from 'react';
import { useProviderConnectionStore, waitForProviderCatalogReady } from './providerCatalogConnection';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { quotaRefreshCoordinator } from '@/stores/useQuotaStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui';
import { RiStackLine, RiToolsLine, RiBrainAi3Line, RiFileImageLine, RiArrowDownSLine, RiCheckLine, RiSearchLine, RiInformationLine, RiEyeLine, RiEyeOffLine, RiErrorWarningLine, RiLoader4Line } from '@remixicon/react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { recordConfigMutationResponse, useConfigApplyStore } from '@/stores/useConfigApplyStore';
import { cn } from '@/lib/utils';
import { copyTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/url';
import { CURSOR_ACP_PROVIDER_ID } from '@/lib/providers/cursorAcp';
import { getProviderDisplayName, isAnthropicOAuthProviderId } from '@/lib/providers/display';
import {
  getHiddenModelRefsForProviderModel,
  isHiddenProviderModelRef,
} from '@/lib/providers/modelVisibility';
import { mergeProviderConnectionOptions, parseProvidersPayload, type ProviderOption } from './providerOptions';
import { isRetiredProviderId, withRetiredProviderEntries } from './retiredProviders';
import { getProviderModelsForDisplay } from './providerSorting';
import {
  getProviderOAuthErrorMessage,
  parseProviderOAuthAuthorization,
  providerCatalogHasModels,
  requestPostAuthConfigReload,
  requestProviderOAuthCallback,
  resolveProviderOAuthPhase,
  type ProviderOAuthPhase,
  type ProviderOAuthAuthorization,
  type ProviderOAuthMethod,
} from './providerOAuth';
import {
  ManagedQuotaCredentials,
  type ManagedQuotaProviderId,
} from './ManagedQuotaCredentials';
import type { ModelMetadata } from '@/types';
import { parseUsageOnlyProviderSelection } from '@/lib/quota';
import { ProviderUsageSection, UsageOnlyProviderView } from './ProviderUsage';
import { useUsageOnlySelectionAvailable } from './useProviderUsage';
import { useI18n } from '@/lib/i18n';
import { useAuthPrincipal } from '@/lib/authSession';
import { ClaudeDedicatedEnrollment } from './ClaudeDedicatedEnrollment';
import { ChatgptSiwcEnrollment } from './ChatgptSiwcEnrollment';
import { getProviderModelUnavailableMessage } from '@/lib/providers/modelAvailability';
import { BundledRuntimeUpdate } from './BundledRuntimeUpdate';
import {
  getClaudePromptMode,
  setClaudeCompatibilityMode,
  type ClaudePromptModeState,
} from '@/lib/claudePromptModeApi';
import {
  disconnectProvider,
  getProviderDisconnectOutcome,
  getProviderConnectionState,
  hasActiveProviderSource,
  shouldShowConnectedProvider,
  useProviderDisconnectStore,
  type ProviderSources,
  type ProviderConnectionState,
} from './providerConnectionState';

const ADD_PROVIDER_ID = '__add_provider__';
const OLLAMA_CLOUD_PROVIDER_ID = 'ollama-cloud';
const OPENCODE_ZEN_PROVIDER_ID = 'opencode';

interface AuthMethod {
  type?: string;
  name?: string;
  label?: string;
  description?: string;
  help?: string;
  method?: number;
  [key: string]: unknown;
}

interface ClaudeCliStatus {
  installed: boolean;
  path?: string | null;
  loggedIn?: boolean;
  authStatus?: 'authenticated' | 'signed_out' | 'unavailable' | 'error';
  authMethod?: string;
  subscriptionType?: string;
  error?: string;
}

type ClaudeAuthenticationState = 'loading' | 'unavailable' | 'account_unavailable' | 'error' | 'authenticated' | 'signed_out';

const getClaudeAuthenticationState = (status: ClaudeCliStatus | null, loading: boolean): ClaudeAuthenticationState => {
  if (loading || !status) return 'loading';
  if (status.authStatus === 'error') return 'error';
  if (!status.installed) return 'unavailable';
  if (status.authStatus === 'unavailable') return 'account_unavailable';
  if (status.authStatus === 'authenticated' && status.loggedIn) return 'authenticated';
  return 'signed_out';
};

const claudeAuthenticationTitleKeys = {
  loading: 'settings.providers.page.auth.checkingClaudeCliTitle',
  unavailable: 'settings.providers.page.auth.claudeCliMissingTitle',
  account_unavailable: 'settings.providers.page.auth.claudeStatusErrorTitle',
  error: 'settings.providers.page.auth.claudeStatusErrorTitle',
  authenticated: 'settings.providers.page.auth.claudeAuthenticatedTitle',
  signed_out: 'settings.providers.page.auth.claudeLoginTitle',
} as const;

const claudeAuthenticationDescriptionKeys = {
  loading: 'settings.providers.page.auth.checkingClaudeCliDescription',
  unavailable: 'settings.providers.page.auth.claudeCliMissingDescription',
  account_unavailable: 'settings.providers.page.auth.claudeStatusErrorDescription',
  error: 'settings.providers.page.auth.claudeStatusErrorDescription',
  authenticated: 'settings.providers.page.auth.claudeAuthenticatedDescription',
  signed_out: 'settings.providers.page.auth.claudeLoginDescription',
} as const;

export function ProviderAuthenticationSummary({ providerId, connectionState, cursorConfigured, cursorUnavailable = false, claudeStatus, claudeLoading }: {
  providerId: string;
  connectionState: ProviderConnectionState;
  cursorConfigured: boolean;
  cursorUnavailable?: boolean;
  claudeStatus: ClaudeCliStatus | null;
  claudeLoading: boolean;
}) {
  const { t } = useI18n();
  const providerOAuth = useRuntimeFeature('providerOAuth');
  if (providerId === CURSOR_ACP_PROVIDER_ID && cursorUnavailable && connectionState !== 'disconnect_pending') {
    return <div className="py-1.5 typography-ui-label text-muted-foreground" data-cursor-capability="unsupported">
      {t('settings.providers.page.auth.cursorUnavailable')}
    </div>;
  }
  if (providerOAuth && isAnthropicOAuthProviderId(providerId) && connectionState !== 'disconnect_pending' && connectionState !== 'not_connected') {
    const status = getClaudeAuthenticationState(claudeStatus, claudeLoading);
    return (
      <div className="flex items-center gap-1.5 py-1.5" data-claude-auth-state={status}>
        {status === 'loading' ? <RiLoader4Line className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
          : status === 'authenticated' ? <RiCheckLine className="w-4 h-4 text-[var(--status-success)] shrink-0" /> : null}
        <span className="typography-ui-label text-foreground">{t(claudeAuthenticationTitleKeys[status])}</span>
        <span className="typography-meta text-muted-foreground ml-1">
          {(status === 'error' || status === 'account_unavailable') && claudeStatus?.error
            ? claudeStatus.error : t(claudeAuthenticationDescriptionKeys[status])}
        </span>
      </div>
    );
  }
  const cursorSetupRequired = providerId === CURSOR_ACP_PROVIDER_ID && !cursorConfigured;
  return (
    <div className="flex items-center gap-1.5 py-1.5">
      {connectionState === 'disconnect_pending' ? (
        <RiLoader4Line className="h-4 w-4 shrink-0 animate-spin text-[var(--status-warning)]" aria-hidden="true" />
      ) : connectionState === 'not_connected' || cursorSetupRequired ? null : (
        <RiCheckLine className="w-4 h-4 text-[var(--status-success)] shrink-0" />
      )}
      <span className="typography-ui-label text-foreground">
        {connectionState === 'disconnect_pending' ? t('settings.providers.page.state.disconnectPending')
          : connectionState === 'not_connected' ? t('settings.providers.page.auth.notConnected')
            : cursorSetupRequired ? t('settings.providers.page.auth.cursorSetupRequired') : t('settings.providers.page.auth.connected')}
      </span>
      <span className="typography-meta text-muted-foreground ml-1">
        {connectionState === 'disconnect_pending' ? t('settings.providers.page.state.disconnectPendingHint')
          : connectionState === 'not_connected' ? t('settings.providers.page.auth.connectToUse')
            : cursorSetupRequired ? t('settings.providers.page.auth.cursorSetupRequiredHint') : t('settings.providers.page.auth.useReconnectHint')}
      </span>
    </div>
  );
}

interface CursorAcpRuntimeStatus {
  sdkAuthConfigured: boolean;
  platformUnavailable: boolean;
  lastError: string | null;
}


interface PendingProviderOAuth {
  providerId: string;
  methodIndex: number;
  method: ProviderOAuthMethod;
  phase: ProviderOAuthPhase;
  error?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const normalizeAuthType = (method: AuthMethod) => {
  const raw = typeof method.type === 'string' ? method.type : '';
  const label = `${method.name ?? ''} ${method.label ?? ''}`.toLowerCase();
  const merged = `${raw} ${label}`.toLowerCase();
  if (merged.includes('oauth')) return 'oauth';
  if (merged.includes('api')) return 'api';
  return raw.toLowerCase();
};

const isCursorAcpProviderId = (providerId: string | null | undefined) => providerId === CURSOR_ACP_PROVIDER_ID;

const parseAuthPayload = (payload: unknown): Record<string, AuthMethod[]> => {
  if (!isRecord(payload)) {
    return {};
  }
  const result: Record<string, AuthMethod[]> = {};
  for (const [providerId, value] of Object.entries(payload)) {
    if (Array.isArray(value)) {
      result[providerId] = value.filter((entry) => isRecord(entry)) as AuthMethod[];
    }
  }
  return result;
};

const providerSupportsApiKey = (providerId: string, nativeOAuth = true) => (
  !isRetiredProviderId(providerId)
  && (!nativeOAuth || !isAnthropicOAuthProviderId(providerId))
);

const ProvidersPageContent: React.FC = () => {
  const { t } = useI18n();
  const principal = useAuthPrincipal();
  const providerOAuth = useRuntimeFeature('providerOAuth');
  const rawProviders = useConfigStore((state) => state.directoryScoped.__global__?.providers ?? state.providers);
  const discoveredProviders = React.useMemo(
    () => withRetiredProviderEntries(rawProviders),
    [rawProviders]
  );
  const selectedProviderId = useConfigStore((state) => state.selectedProviderId);
  const setSelectedProvider = useConfigStore((state) => state.setSelectedProvider);
  const loadProviders = useConfigStore((state) => state.loadProviders);
  const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const activeProviderCatalog = useConfigStore((state) => currentDirectory
    ? state.directoryScoped[currentDirectory.trim()]?.providers
    : state.directoryScoped.__global__?.providers);
  const hiddenModels = useUIStore((state) => state.hiddenModels);
  const hideModelRefs = useUIStore((state) => state.hideModelRefs);
  const showModelRefs = useUIStore((state) => state.showModelRefs);
  const toggleHiddenModelRefs = useUIStore((state) => state.toggleHiddenModelRefs);

  const [authMethodsByProvider, setAuthMethodsByProvider] = React.useState<Record<string, AuthMethod[]>>({});
  const [authLoading, setAuthLoading] = React.useState(false);
  const [apiKeyInputs, setApiKeyInputs] = React.useState<Record<string, string>>({});
  const [authBusyKey, setAuthBusyKey] = React.useState<string | null>(null);
  const [openAiAuthRevision, setOpenAiAuthRevision] = React.useState(0);
  const [modelQuery, setModelQuery] = React.useState('');
  const pendingConnections = useProviderConnectionStore((state) => state.pending);
  const [pendingOAuth, setPendingOAuth] = React.useState<PendingProviderOAuth | null>(null);
  const [oauthCodes, setOauthCodes] = React.useState<Record<string, string>>({});
  const [oauthDetails, setOauthDetails] = React.useState<Record<string, ProviderOAuthAuthorization>>({});
  const [availableProviders, setAvailableProviders] = React.useState<ProviderOption[]>([]);
  const [availableLoading, setAvailableLoading] = React.useState(false);
  const [availableError, setAvailableError] = React.useState<string | null>(null);
  const [candidateProviderId, setCandidateProviderId] = React.useState('');
  const [providerSearchQuery, setProviderSearchQuery] = React.useState('');
  const [providerDropdownOpen, setProviderDropdownOpen] = React.useState(false);
  const [providerSources, setProviderSources] = React.useState<Record<string, ProviderSources>>({});
  const [showAuthPanel, setShowAuthPanel] = React.useState(false);
  const [claudeCliStatus, setClaudeCliStatus] = React.useState<ClaudeCliStatus | null>(null);
  const [claudeCliStatusLoading, setClaudeCliStatusLoading] = React.useState(false);
  const [claudePromptMode, setClaudePromptMode] = React.useState<ClaudePromptModeState | null>(null);
  const [claudePromptModeLoading, setClaudePromptModeLoading] = React.useState(false);
  const [claudePromptModeUpdating, setClaudePromptModeUpdating] = React.useState(false);
  const [claudePromptModeError, setClaudePromptModeError] = React.useState<string | null>(null);
  const [cursorRuntimeStatus, setCursorRuntimeStatus] = React.useState<CursorAcpRuntimeStatus | null>(null);
  const appliedRevision = useConfigApplyStore((state) => state.status?.appliedRevision ?? 0);
  const pendingRevisionByProvider = useProviderDisconnectStore((state) => state.pendingRevisionByProvider);
  const sourceRefreshRevision = useProviderDisconnectStore((state) => state.sourceRefreshRevision);
  const markDisconnectRequested = useProviderDisconnectStore((state) => state.markRequested);
  const reconcileAppliedRevision = useProviderDisconnectStore((state) => state.reconcileAppliedRevision);
  const providers = React.useMemo(
    () => discoveredProviders.filter((provider) => shouldShowConnectedProvider(
      provider.id,
      providerSources[provider.id],
      Object.prototype.hasOwnProperty.call(pendingRevisionByProvider, provider.id),
    )),
    [discoveredProviders, pendingRevisionByProvider, providerSources],
  );

  React.useEffect(() => {
    void loadProviders({ directory: null });
  }, [loadProviders]);

  React.useEffect(() => {
    reconcileAppliedRevision(appliedRevision);
  }, [appliedRevision, reconcileAppliedRevision]);

  const usageOnlyQuotaProviderId = parseUsageOnlyProviderSelection(selectedProviderId);
  const usageOnlySelectionAvailable = useUsageOnlySelectionAvailable(usageOnlyQuotaProviderId);

  React.useEffect(() => {
    if (selectedProviderId === ADD_PROVIDER_ID) return;
    if (usageOnlySelectionAvailable) return;
    if (pendingConnections[selectedProviderId]) return;
    if (providers.some((provider) => provider.id === selectedProviderId)) return;
    setSelectedProvider(providers[0]?.id ?? ADD_PROVIDER_ID);
  }, [providers, pendingConnections, selectedProviderId, setSelectedProvider, usageOnlySelectionAvailable]);

  React.useEffect(() => {
    let isMounted = true;

    const loadAuthMethods = async () => {
      setAuthLoading(true);
      try {
        const response = await fetch('/api/provider/auth', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });

        if (!response.ok) {
          throw new Error(`Auth methods request failed (${response.status})`);
        }

        const payload = await response.json().catch(() => ({}));
        if (!isMounted) return;
        setAuthMethodsByProvider(parseAuthPayload(payload));
      } catch (error) {
        if (!isMounted) return;
        console.error('Failed to load provider auth methods:', error);
        toast.error(t('settings.providers.page.toast.authMethodsLoadFailed'));
      } finally {
        if (isMounted) {
          setAuthLoading(false);
        }
      }
    };

    loadAuthMethods();

    return () => {
      isMounted = false;
    };
  }, [t]);

  React.useEffect(() => {
    let isMounted = true;

    const loadAvailableProviders = async () => {
      setAvailableLoading(true);
      setAvailableError(null);
      try {
        const response = await fetch('/api/provider', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });

        if (!response.ok) {
          throw new Error(`Provider list request failed (${response.status})`);
        }

        const payload = await response.json().catch(() => ({}));
        if (!isMounted) return;
        setAvailableProviders(parseProvidersPayload(payload));
      } catch (error) {
        if (!isMounted) return;
        console.error('Failed to load available providers:', error);
        setAvailableError(t('settings.providers.page.state.unableToLoadProviderList'));
      } finally {
        if (isMounted) {
          setAvailableLoading(false);
        }
      }
    };

    loadAvailableProviders();

    return () => {
      isMounted = false;
    };
  }, [t]);

  const connectedProviderIds = React.useMemo(
    () => new Set([...providers.map((provider) => provider.id), ...Object.keys(pendingConnections)]),
    [providers, pendingConnections]
  );

  const connectionProviderOptions = React.useMemo(
    () => mergeProviderConnectionOptions(availableProviders, authMethodsByProvider),
    [availableProviders, authMethodsByProvider]
  );

  const unconnectedProviders = React.useMemo(
    () =>
      connectionProviderOptions
        .filter((provider) => !connectedProviderIds.has(provider.id))
        .sort((a, b) => {
          const labelA = (a.name || a.id).toLowerCase();
          const labelB = (b.name || b.id).toLowerCase();
          return labelA.localeCompare(labelB);
        }),
    [connectionProviderOptions, connectedProviderIds]
  );

  React.useEffect(() => {
    if (selectedProviderId !== ADD_PROVIDER_ID) {
      return;
    }

    if (candidateProviderId && !unconnectedProviders.some((provider) => provider.id === candidateProviderId)) {
      setCandidateProviderId('');
    }
  }, [selectedProviderId, candidateProviderId, unconnectedProviders]);

  const activeAnthropicProviderId = React.useMemo(() => {
    if (!providerOAuth) return null;
    if (selectedProviderId === ADD_PROVIDER_ID) {
      return isAnthropicOAuthProviderId(candidateProviderId) ? candidateProviderId : null;
    }
    return isAnthropicOAuthProviderId(selectedProviderId) ? selectedProviderId : null;
  }, [candidateProviderId, selectedProviderId, providerOAuth]);
  const activeCursorAcpProviderId = React.useMemo(() => {
    if (!providerOAuth) return null;
    if (selectedProviderId === ADD_PROVIDER_ID) {
      return candidateProviderId === CURSOR_ACP_PROVIDER_ID ? candidateProviderId : null;
    }
    return selectedProviderId === CURSOR_ACP_PROVIDER_ID ? selectedProviderId : null;
  }, [candidateProviderId, selectedProviderId, providerOAuth]);
  const activeManagedQuotaProviderId = React.useMemo<ManagedQuotaProviderId | null>(() => {
    if (!providerOAuth) return null;
    const providerId = selectedProviderId === ADD_PROVIDER_ID ? candidateProviderId : selectedProviderId;
    return providerId === CURSOR_ACP_PROVIDER_ID
      || providerId === OLLAMA_CLOUD_PROVIDER_ID
      || providerId === OPENCODE_ZEN_PROVIDER_ID
      ? providerId
      : null;
  }, [candidateProviderId, selectedProviderId, providerOAuth]);

  const refreshClaudeCliStatus = React.useCallback(async () => {
    if (!activeAnthropicProviderId) {
      setClaudeCliStatus(null);
      setClaudeCliStatusLoading(false);
      return;
    }

    setClaudeCliStatusLoading(true);
    try {
      const response = await fetch('/api/provider/anthropic/claude-cli', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || t('settings.providers.page.toast.claudeCliCheckFailed'));
      }
      setClaudeCliStatus({
        installed: Boolean(payload?.installed),
        path: typeof payload?.path === 'string' ? payload.path : null,
        loggedIn: payload?.loggedIn === true,
        authStatus: typeof payload?.authStatus === 'string' ? payload.authStatus : undefined,
        authMethod: typeof payload?.authMethod === 'string' ? payload.authMethod : undefined,
        subscriptionType: typeof payload?.subscriptionType === 'string' ? payload.subscriptionType : undefined,
        error: typeof payload?.error === 'string' ? payload.error : undefined,
      });
    } catch (error) {
      console.error('Failed to check Claude Code availability:', error);
      setClaudeCliStatus({ installed: false, path: null, loggedIn: false, authStatus: 'error' });
      toast.error(t('settings.providers.page.toast.claudeCliCheckFailed'));
    } finally {
      setClaudeCliStatusLoading(false);
    }
  }, [activeAnthropicProviderId, t]);

  React.useEffect(() => {
    void refreshClaudeCliStatus();
  }, [refreshClaudeCliStatus]);

  const refreshClaudePromptMode = React.useCallback(async () => {
    if (!activeAnthropicProviderId) {
      setClaudePromptMode(null);
      setClaudePromptModeError(null);
      setClaudePromptModeLoading(false);
      return;
    }
    setClaudePromptModeLoading(true);
    setClaudePromptModeError(null);
    try {
      setClaudePromptMode(await getClaudePromptMode());
    } catch (error) {
      setClaudePromptModeError(
        error instanceof Error ? error.message : t('settings.providers.page.claudeCompatibility.loadFailed'),
      );
    } finally {
      setClaudePromptModeLoading(false);
    }
  }, [activeAnthropicProviderId, t]);

  React.useEffect(() => {
    void refreshClaudePromptMode();
  }, [refreshClaudePromptMode]);

  const refreshCursorRuntimeStatus = React.useCallback(async () => {
    if (!activeCursorAcpProviderId) {
      setCursorRuntimeStatus(null);
      return;
    }

    try {
      const response = await fetch('/api/provider/cursor-acp/runtime-status', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || 'Cursor runtime status request failed');
      }
      if (!isRecord(payload)) { setCursorRuntimeStatus(null); return; }
      const capability = payload.capabilities;
      const unavailable = isRecord(capability) && capability.supported === false && capability.code === 'cursor_platform_unsupported';
      const supported = isRecord(capability) && capability.supported === true && capability.code === null;
      if (capability !== undefined && !unavailable && !supported) { setCursorRuntimeStatus(null); return; }
      setCursorRuntimeStatus({
        sdkAuthConfigured: !unavailable && payload.sdkAuthConfigured === true,
        platformUnavailable: unavailable,
        lastError: typeof payload.lastError === 'string' ? payload.lastError : null,
      });
    } catch (error) {
      console.error('Failed to load Cursor runtime status:', error);
      setCursorRuntimeStatus(null);
    }
  }, [activeCursorAcpProviderId]);

  React.useEffect(() => {
    void refreshCursorRuntimeStatus();
  }, [refreshCursorRuntimeStatus]);

  React.useEffect(() => {
    if (selectedProviderId === ADD_PROVIDER_ID) {
      setShowAuthPanel(true);
      return;
    }

    setShowAuthPanel(false);
  }, [selectedProviderId, t]);

  const loadProviderSources = React.useCallback(
    async (providerId: string, options: { cancelled?: () => boolean } = {}) => {
      try {
        const directory = currentDirectory?.trim();
        const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
        const response = await fetch(`/api/provider/${encodeURIComponent(providerId)}/source${query}`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error || t('settings.providers.page.toast.providerSourcesLoadFailed'));
        }

        const sources = (payload?.sources ?? payload?.data?.sources) as ProviderSources | undefined;
        if (!options.cancelled?.() && sources) {
          setProviderSources((prev) => ({
            ...prev,
            [providerId]: sources,
          }));
        }
      } catch (error) {
        if (!options.cancelled?.()) {
          console.error('Failed to load provider sources:', error);
        }
      }
    },
    [currentDirectory, t]
  );

  React.useEffect(() => {
    if (discoveredProviders.length === 0) {
      setProviderSources({});
      return;
    }

    let cancelled = false;
    for (const provider of discoveredProviders) {
      void loadProviderSources(provider.id, { cancelled: () => cancelled });
    }

    return () => {
      cancelled = true;
    };
  }, [discoveredProviders, loadProviderSources, sourceRefreshRevision]);

  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);
  const selectedSources = selectedProviderId ? providerSources[selectedProviderId] : undefined;
  const selectedProviderName = selectedProvider ? getProviderDisplayName(selectedProvider, selectedSources) : '';
  const selectedProviderSupportsApiKey = selectedProvider ? providerSupportsApiKey(selectedProvider.id, providerOAuth) : false;
  const selectedProviderIsCursor = isCursorAcpProviderId(selectedProvider?.id);
  const selectedCursorUnavailable = selectedProviderIsCursor && cursorRuntimeStatus?.platformUnavailable === true;
  const cursorSdkConfigured = cursorRuntimeStatus?.sdkAuthConfigured === true;
  const selectedDisconnectPending = selectedProvider
    ? Object.prototype.hasOwnProperty.call(pendingRevisionByProvider, selectedProvider.id)
    : false;
  const selectedConnectionState = selectedProvider
    ? getProviderConnectionState(selectedProvider.id, selectedSources, selectedDisconnectPending)
    : 'loading';

  const waitForProviderCatalog = React.useCallback(async (
    providerId: string,
    options?: { onStalled?: () => Promise<boolean> },
  ) => {
    const activeDirectory = currentDirectory?.trim() || null;
    const directories = activeDirectory ? [null, activeDirectory] : [null];

    return waitForProviderCatalogReady({
      onStalled: options?.onStalled,
      refresh: async () => {
        await Promise.all(directories.map((directory) => loadProviders({ directory, force: true })));
      },
      isReady: () => {
        const state = useConfigStore.getState();
        const globalProviders = state.directoryScoped.__global__?.providers ?? [];
        const activeProviders = activeDirectory
          ? state.directoryScoped[activeDirectory]?.providers
          : globalProviders;
        return providerCatalogHasModels(globalProviders, providerId)
          && providerCatalogHasModels(activeProviders, providerId);
      },
    });
  }, [currentDirectory, loadProviders]);

  // Returns whether the model catalog caught up. A `false` result is NOT a failure — the
  // credentials are already saved by this point; only the catalog is lagging.
  const finalizeProviderConnection = React.useCallback(async (
    providerId: string,
    options?: { onStalled?: () => Promise<boolean> },
  ) => {
    const providerReady = await waitForProviderCatalog(providerId, options);

    setSelectedProvider(providerId);
    quotaRefreshCoordinator.settingsChanged();

    return providerReady;
  }, [setSelectedProvider, waitForProviderCatalog]);

  const retryApiKeyConnection = React.useCallback(async (providerId: string, allowReload = true) => {
    const pending = useProviderConnectionStore.getState().pending[providerId];
    if (!pending) return;
    const attempt = {
      ...pending,
      lastAttemptRevision: useConfigApplyStore.getState().status?.appliedRevision ?? 0,
    };
    useProviderConnectionStore.getState().markPending(attempt);
    const ready = await waitForProviderCatalog(providerId, allowReload ? {
      onStalled: async () => {
        const reload = await requestPostAuthConfigReload();
        await useConfigApplyStore.getState().refresh();
        return !reload.deferred;
      },
    } : undefined);
    if (ready && useProviderConnectionStore.getState().pending[providerId] === attempt) {
      useProviderConnectionStore.getState().clear(providerId);
    }
    quotaRefreshCoordinator.settingsChanged();
  }, [waitForProviderCatalog]);

  React.useEffect(() => {
    if (authBusyKey) return;
    for (const pending of Object.values(pendingConnections)) {
      if (appliedRevision > pending.lastAttemptRevision) {
        void retryApiKeyConnection(pending.id, false);
      }
    }
  }, [appliedRevision, authBusyKey, pendingConnections, retryApiKeyConnection]);

  React.useEffect(() => {
    for (const pending of Object.values(pendingConnections)) {
      if (providerCatalogHasModels(rawProviders, pending.id)
        && providerCatalogHasModels(activeProviderCatalog, pending.id)) {
        useProviderConnectionStore.getState().clear(pending.id);
      }
    }
  }, [rawProviders, activeProviderCatalog, pendingConnections]);

  const handleSaveApiKey = async (providerId: string) => {
    const apiKey = apiKeyInputs[providerId]?.trim() ?? '';
    if (!apiKey) {
      toast.error(t('settings.providers.page.toast.apiKeyRequired'));
      return;
    }

    const busyKey = `api:${providerId}`;
    setAuthBusyKey(busyKey);

    try {
      const response = await fetch(`/api/auth/${encodeURIComponent(providerId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'api', key: apiKey }),
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload?.error || t('settings.providers.page.toast.apiKeySaveFailed');
        throw new Error(message);
      }

      if (providerId === 'openai') setOpenAiAuthRevision(value => value + 1);
      toast.success(t('settings.providers.page.toast.apiKeySaved'));
      setApiKeyInputs((prev) => ({ ...prev, [providerId]: '' }));
      recordConfigMutationResponse(payload);
      useProviderConnectionStore.getState().markPending({
        id: providerId,
        name: availableProviders.find((provider) => provider.id === providerId)?.name || providerId,
        lastAttemptRevision: useConfigApplyStore.getState().status?.appliedRevision ?? 0,
      });
      setSelectedProvider(providerId);
      if (providerId === CURSOR_ACP_PROVIDER_ID) {
        await refreshCursorRuntimeStatus();
      }
      await retryApiKeyConnection(providerId);
    } catch (error) {
      console.error('Failed to save API key:', error);
      toast.error(t('settings.providers.page.toast.apiKeySaveFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };

  const completeOAuthConnection = async (
    providerId: string,
    methodIndex: number,
    code?: string,
  ) => {
    const codeKey = `${providerId}:${methodIndex}`;
    const busyKey = `oauth-complete:${providerId}:${methodIndex}`;
    setAuthBusyKey(busyKey);

    // Only the callback itself can fail the sign-in. Once it resolves the credentials are
    // persisted upstream, so nothing after this point may report failure to the user.
    try {
      await requestProviderOAuthCallback({
        providerId,
        methodIndex,
        code,
        fallbackError: t('settings.providers.page.toast.oauthCompleteFailed'),
      });
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : t('settings.providers.page.toast.oauthCompleteFailed');
      console.error('Failed to complete OAuth flow:', error);
      const outcome = resolveProviderOAuthPhase({ callbackError: message });
      setPendingOAuth((current) => current?.providerId === providerId && current.methodIndex === methodIndex
        ? { ...current, phase: outcome.phase ?? 'error', error: outcome.error }
        : current);
      toast.error(`${t('settings.providers.page.toast.oauthCompleteFailed')}: ${message}`);
      setAuthBusyKey(null);
      return;
    }

    setOauthCodes((prev) => ({ ...prev, [codeKey]: '' }));
    setOauthDetails((prev) => {
      const next = { ...prev };
      delete next[codeKey];
      return next;
    });
    toast.success(t('settings.providers.page.toast.oauthCompleted'));
    setPendingOAuth((current) => current?.providerId === providerId && current.methodIndex === methodIndex
      ? { ...current, phase: 'loading-models', error: undefined }
      : current);

    try {
      const providerReady = await finalizeProviderConnection(providerId, {
        // Only reached when polling alone did not surface the provider. Ask the server to
        // re-apply config so OpenCode loads the new credential; if that apply is deferred until
        // active chats finish, stop waiting — models cannot appear before then.
        onStalled: async () => {
          const reload = await requestPostAuthConfigReload();
          return !reload.deferred;
        },
      });

      const outcome = resolveProviderOAuthPhase({ providerReady });
      setPendingOAuth((current) => {
        if (current?.providerId !== providerId || current.methodIndex !== methodIndex) return current;
        return outcome.phase === null ? null : { ...current, phase: outcome.phase, error: undefined };
      });
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleOAuthStart = async (providerId: string, methodIndex: number) => {
    assertRuntimeFeatureAvailable('providerOAuth');
    const busyKey = `oauth:${providerId}:${methodIndex}`;
    setAuthBusyKey(busyKey);

    try {
      const response = await fetch(`/api/provider/${encodeURIComponent(providerId)}/oauth/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: methodIndex }),
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = getProviderOAuthErrorMessage(
          payload,
          t('settings.providers.page.toast.oauthStartFailed'),
        );
        throw new Error(message);
      }

      const authorization = parseProviderOAuthAuthorization(payload);
      if (!authorization) {
        throw new Error(t('settings.providers.page.toast.oauthDetailsMissing'));
      }

      const detailsKey = `${providerId}:${methodIndex}`;
      setOauthDetails((prev) => ({
        ...prev,
        [detailsKey]: authorization,
      }));

      setPendingOAuth({
        providerId,
        methodIndex,
        method: authorization.method,
        phase: 'waiting',
      });
      if (authorization.url) {
        void openExternalUrl(authorization.url);
      }
      toast.message(t('settings.providers.page.toast.completeOAuthInBrowser'));

      if (authorization.method === 'auto') {
        await completeOAuthConnection(providerId, methodIndex);
      }
    } catch (error) {
      console.error('Failed to start OAuth flow:', error);
      const message = error instanceof Error ? error.message : '';
      toast.error(message
        ? `${t('settings.providers.page.toast.oauthStartFailed')}: ${message}`
        : t('settings.providers.page.toast.oauthStartFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleOAuthComplete = async (providerId: string, methodIndex: number) => {
    assertRuntimeFeatureAvailable('providerOAuth');
    const codeKey = `${providerId}:${methodIndex}`;
    const code = oauthCodes[codeKey]?.trim();
    if (!code) {
      toast.error(t('settings.providers.page.toast.oauthCodeRequired'));
      return;
    }

    await completeOAuthConnection(providerId, methodIndex, code);
  };

  const handleCopyOAuthLink = async (url: string) => {
    const result = await copyTextToClipboard(url);
    if (result.ok) {
      toast.success(t('settings.providers.page.toast.oauthLinkCopied'));
      return;
    }
    console.error('Failed to copy OAuth link:', result.error);
    toast.error(t('settings.providers.page.toast.oauthLinkCopyFailed'));
  };

  const handleCopyOAuthCode = async (code: string) => {
    const result = await copyTextToClipboard(code);
    if (result.ok) {
      toast.success(t('settings.providers.page.toast.deviceCodeCopied'));
      return;
    }
    console.error('Failed to copy device code:', result.error);
    toast.error(t('settings.providers.page.toast.deviceCodeCopyFailed'));
  };

  const renderOAuthAttemptStatus = (providerId: string, methodIndex: number) => {
    if (
      pendingOAuth?.providerId !== providerId
      || pendingOAuth.methodIndex !== methodIndex
      || (pendingOAuth.method === 'code' && pendingOAuth.phase === 'waiting')
    ) {
      return null;
    }

    const isError = pendingOAuth.phase === 'error';
    const title = pendingOAuth.phase === 'waiting'
      ? t('settings.providers.page.auth.oauthWaitingTitle')
      : pendingOAuth.phase === 'loading-models'
        ? t('settings.providers.page.auth.oauthLoadingModelsTitle')
        : pendingOAuth.phase === 'models-pending'
          ? t('settings.providers.page.auth.modelsPendingTitle')
          : t('settings.providers.page.auth.oauthErrorTitle');
    const description = pendingOAuth.phase === 'waiting'
      ? t('settings.providers.page.auth.oauthWaitingDescription')
      : pendingOAuth.phase === 'loading-models'
        ? t('settings.providers.page.auth.oauthLoadingModelsDescription')
        : pendingOAuth.phase === 'models-pending'
          ? t('settings.providers.page.auth.modelsPendingDescription', { provider: providerId })
          : pendingOAuth.error || t('settings.providers.page.toast.oauthCompleteFailed');

    return (
      <div
        role={isError ? 'alert' : 'status'}
        aria-live="polite"
        className={cn(
          'flex items-start gap-2.5 rounded-md border px-3 py-2',
          isError
            ? 'border-[var(--status-error-border)] bg-[var(--status-error-background)] text-[var(--status-error)]'
            : 'border-[color-mix(in_srgb,var(--primary-base)_22%,transparent)] bg-[color-mix(in_srgb,var(--primary-base)_7%,transparent)] text-foreground',
        )}
      >
        {isError
          ? <RiErrorWarningLine className="mt-0.5 h-4 w-4 shrink-0" />
          : <RiLoader4Line className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[var(--primary-base)]" />}
        <div className="min-w-0">
          <p className="typography-ui-label font-medium">{title}</p>
          <p className={cn('typography-meta break-words', isError ? 'text-inherit/80' : 'text-muted-foreground')}>
            {description}
            {isError ? ` ${t('settings.providers.page.auth.oauthRetryHint')}` : ''}
          </p>
        </div>
      </div>
    );
  };

  const handleClaudeCompatibilityChange = async (compatibilityMode: boolean) => {
    if (claudePromptModeUpdating || claudePromptMode?.editable === false) return;
    setClaudePromptModeUpdating(true);
    setClaudePromptModeError(null);
    try {
      const next = await setClaudeCompatibilityMode(compatibilityMode);
      setClaudePromptMode(next);
      toast.success(compatibilityMode
        ? t('settings.providers.page.claudeCompatibility.enabled')
        : t('settings.providers.page.claudeCompatibility.disabled'));
    } catch (error) {
      setClaudePromptModeError(
        error instanceof Error ? error.message : t('settings.providers.page.claudeCompatibility.updateFailed'),
      );
    } finally {
      setClaudePromptModeUpdating(false);
    }
  };

  const handleConfigureCursorAcp = async () => {
    const busyKey = 'cursor-configure';
    setAuthBusyKey(busyKey);
    try {
      const response = await fetch('/api/provider/cursor-acp/configure', {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || t('settings.providers.page.toast.cursorConfigureFailed'));
      }

      toast.success(t('settings.providers.page.toast.cursorConfigured'));
      recordConfigMutationResponse(payload);
      await loadProviders({ directory: null });
      setSelectedProvider(CURSOR_ACP_PROVIDER_ID);
      await loadProviderSources(CURSOR_ACP_PROVIDER_ID);
      await refreshCursorRuntimeStatus();
      quotaRefreshCoordinator.settingsChanged();
    } catch (error) {
      console.error('Failed to configure Cursor:', error);
      toast.error(error instanceof Error ? error.message : t('settings.providers.page.toast.cursorConfigureFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleDisconnectProvider = async (providerId: string) => {
    const busyKey = `disconnect:${providerId}`;
    setAuthBusyKey(busyKey);

    try {
      const payload = await disconnectProvider(providerId, currentDirectory);
      if (providerId === 'openai') setOpenAiAuthRevision(value => value + 1);
      const applyStatus = recordConfigMutationResponse(payload);
      markDisconnectRequested(providerId, payload);
      useProviderConnectionStore.getState().clear(providerId);
      const outcome = getProviderDisconnectOutcome(payload);
      if (outcome.kind === 'still_provided') {
        toast.error(t('settings.providers.page.toast.providerStillProvided', { sources: outcome.sources.join(', ') }));
      } else {
        toast.success(applyStatus?.pending
          ? t('settings.providers.page.toast.providerDisconnectQueued')
          : t('settings.providers.page.toast.providerDisconnected'));
      }
      if (!applyStatus?.pending) await loadProviders({ directory: null, force: true });
      quotaRefreshCoordinator.settingsChanged();
    } catch (error) {
      console.error('Failed to disconnect provider:', error);
      toast.error(error instanceof Error ? error.message : t('settings.providers.page.toast.providerDisconnectFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };

  const isAddMode = selectedProviderId === ADD_PROVIDER_ID;
  const renderCursorRuntimeNotice = () => {
    const sdkConfigured = cursorRuntimeStatus?.sdkAuthConfigured === true;

    return (
      <div className="rounded-md border border-[var(--surface-subtle)] bg-[var(--surface-subtle)]/40 p-3">
        <div className="flex gap-2">
          <RiInformationLine className={cn(
            'mt-0.5 h-4 w-4 shrink-0',
            sdkConfigured ? 'text-[var(--status-success)]' : 'text-muted-foreground',
          )} />
          <div className="min-w-0 space-y-1">
            <div className="typography-ui-label text-foreground">{t('settings.providers.page.auth.cursorSdkTitle')}</div>
            <div className="typography-meta text-muted-foreground">
              {sdkConfigured
                ? t('settings.providers.page.auth.cursorSdkConfigured')
                : t('settings.providers.page.auth.cursorSdkNotConfigured')}
            </div>
            {cursorRuntimeStatus?.lastError ? (
              <div className="typography-meta text-[var(--status-warning)]">{cursorRuntimeStatus.lastError}</div>
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  const renderClaudeCodeAuth = () => {
    const status = getClaudeAuthenticationState(claudeCliStatus, claudeCliStatusLoading);
    return <>
      <div className="flex items-center justify-between gap-3 py-1.5">
        <div>
          <div className="typography-ui-label text-foreground">{t(claudeAuthenticationTitleKeys[status])}</div>
          <div className="typography-meta text-muted-foreground">
            {(status === 'error' || status === 'account_unavailable') && claudeCliStatus?.error ? claudeCliStatus.error : t(claudeAuthenticationDescriptionKeys[status])}
          </div>
        </div>
        {status !== 'loading' ? <Button variant="ghost" size="xs" className="!font-normal" onClick={refreshClaudeCliStatus}>
          {t('settings.providers.page.actions.refresh')}
        </Button> : null}
      </div>
      <ClaudeDedicatedEnrollment
        administrator={principal.role === 'admin' && principal.scope !== 'tunnel-bot'}
        principalID={principal.id}
        directory={currentDirectory}
        onSelected={async () => {
          const result = await requestPostAuthConfigReload();
          if (!result.ok) throw new Error('reload');
          await loadProviders({ directory: null });
          await refreshClaudeCliStatus();
        }}
      />
    </>;
  };

  const renderChatgptSiwcAuth = () => (
    <ChatgptSiwcEnrollment
      refreshRevision={openAiAuthRevision}
      administrator={principal.role === 'admin' && principal.scope !== 'tunnel-bot'}
      principalID={principal.id}
      directory={currentDirectory}
      onSelected={async () => {
        const result = await requestPostAuthConfigReload();
        if (!result.ok) throw new Error('reload');
        await loadProviders({ directory: null });
      }}
    />
  );

  const renderClaudeCompatibilityMode = () => (
    <div className="flex min-w-0 flex-col gap-2 py-1.5 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <div className="typography-ui-label text-foreground">
          {t('settings.providers.page.claudeCompatibility.title')}
        </div>
        <div className="typography-meta text-muted-foreground">
          {claudePromptMode?.editable === false
            ? t('settings.providers.page.claudeCompatibility.externalReadOnly')
            : t('settings.providers.page.claudeCompatibility.description')}
        </div>
        {claudePromptModeError ? (
          <div role="alert" className="typography-meta mt-1 text-[var(--status-error)]">
            {claudePromptModeError}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        {claudePromptModeLoading ? (
          <RiLoader4Line className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
        ) : null}
        <Switch
          aria-label={t('settings.providers.page.claudeCompatibility.title')}
          checked={claudePromptMode?.compatibilityMode === true}
          disabled={
            claudePromptModeLoading
            || claudePromptModeUpdating
            || !claudePromptMode
            || claudePromptMode.editable === false
          }
          onCheckedChange={(checked) => void handleClaudeCompatibilityChange(checked)}
        />
      </div>
    </div>
  );

  const pendingConnection = pendingConnections[selectedProviderId];
  const connectionStatus = pendingConnection ? (
    <div role="status" className="mb-4 space-y-2 rounded-md border p-3">
      <p className="typography-ui-label">{t('settings.providers.page.auth.modelsPendingTitle')}</p>
      <p className="typography-meta text-muted-foreground">
        {t('settings.providers.page.auth.modelsPendingDescription', { provider: pendingConnection.name })}
      </p>
      <Button size="xs" variant="outline" disabled={Boolean(authBusyKey)} onClick={async () => {
        setAuthBusyKey(`catalog:${pendingConnection.id}`);
        try { await retryApiKeyConnection(pendingConnection.id); }
        finally { setAuthBusyKey(null); }
      }}>
        {t('settings.providers.page.actions.retry')}
      </Button>
    </div>
  ) : null;

  if (pendingConnection && !selectedProvider) {
    return <div className="mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">{connectionStatus}</div>;
  }

  if (usageOnlyQuotaProviderId && usageOnlySelectionAvailable) {
    return <UsageOnlyProviderView quotaProviderId={usageOnlyQuotaProviderId} />;
  }

  if (!isAddMode && providers.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <RiStackLine className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="typography-body">{t('settings.providers.page.empty.noProvidersDetected')}</p>
          <p className="typography-meta mt-1 opacity-75">{t('settings.providers.page.empty.checkOpenCodeConfiguration')}</p>
        </div>
      </div>
    );
  }

  if (isAddMode) {
    return (
      <ScrollableOverlay outerClassName="h-full" className="w-full">
        <div className="mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">
          <div className="mb-4">
            <h1 className="typography-ui-header font-semibold text-foreground">{t('settings.providers.page.connect.title')}</h1>
          </div>

          <div className="mb-8">
            <div className="mb-1 px-1">
              <h2 className="typography-ui-header font-medium text-foreground">{t('settings.providers.page.connect.selectProviderTitle')}</h2>
            </div>

            <section className="px-2 pb-2 pt-0">
              <div className="flex flex-wrap items-center gap-2 py-1.5">
                <span className="typography-ui-label text-foreground">{t('settings.providers.page.connect.providerField')}</span>
                  {availableLoading ? (
                    <p className="typography-meta text-muted-foreground">{t('settings.providers.page.state.loading')}</p>
                  ) : availableError ? (
                    <p className="typography-meta text-muted-foreground">{availableError}</p>
                  ) : unconnectedProviders.length === 0 ? (
                    <p className="typography-meta text-muted-foreground">{t('settings.providers.page.connect.allProvidersConnected')}</p>
                  ) : (
                    <DropdownMenu open={providerDropdownOpen} onOpenChange={(open) => {
                      setProviderDropdownOpen(open);
                      if (!open) setProviderSearchQuery('');
                    }}>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className={cn(
                            "flex items-center justify-between gap-2 rounded-lg border border-input bg-transparent px-2 py-2 typography-ui-label whitespace-nowrap shadow-none outline-none hover:bg-interactive-hover h-6 w-fit",
                          )}
                        >
                          <span className="flex items-center gap-2 min-w-0">
                            {candidateProviderId ? <ProviderLogo providerId={candidateProviderId} className="h-3.5 w-3.5 flex-shrink-0" /> : null}
                            <span className={cn("truncate typography-ui-label font-normal", candidateProviderId ? "text-foreground" : "text-muted-foreground")}>
                              {candidateProviderId
                                ? (unconnectedProviders.find(p => p.id === candidateProviderId)?.name || candidateProviderId)
                                : t('settings.providers.page.connect.selectProviderPlaceholder')}
                            </span>
                          </span>
                          <RiArrowDownSLine className="h-4 w-4 flex-shrink-0 text-muted-foreground/50" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="start"
                        className="w-[280px] p-0"
                        onCloseAutoFocus={(e) => e.preventDefault()}
                      >
                        <div
                          className="flex items-center gap-2 border-b border-[var(--surface-subtle)] px-3 py-2"
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          <RiSearchLine className="h-4 w-4 text-muted-foreground" />
                          <input
                            type="search"
                            value={providerSearchQuery}
                            onChange={(e) => setProviderSearchQuery(e.target.value)}
                            onKeyDown={(e) => e.stopPropagation()}
                            placeholder={t('settings.providers.page.connect.searchProvidersPlaceholder')}
                            className="flex-1 bg-transparent typography-meta outline-none placeholder:text-muted-foreground"
                            autoFocus
                          />
                        </div>
                        <ScrollableOverlay outerClassName="max-h-[240px]" className="p-1">
                          {(() => {
                            const filtered = unconnectedProviders.filter(p => {
                              const query = providerSearchQuery.toLowerCase();
                              return getProviderDisplayName(p).toLowerCase().includes(query)
                                || p.id.toLowerCase().includes(query);
                            });
                            if (filtered.length === 0) {
                              return <p className="py-4 text-center typography-meta text-muted-foreground">{t('settings.providers.page.connect.noProvidersFound')}</p>;
                            }
                            return filtered.map((provider) => (
                              <DropdownMenuItem
                                key={provider.id}
                                onSelect={() => {
                                  setCandidateProviderId(provider.id);
                                  setProviderDropdownOpen(false);
                                  setProviderSearchQuery('');
                                }}
                                className="flex items-center justify-between"
                              >
                                <span className="flex items-center gap-2 min-w-0">
                                  <ProviderLogo providerId={provider.id} className="h-4 w-4 flex-shrink-0" />
                                  <span className="truncate">{getProviderDisplayName(provider)}</span>
                                </span>
                                {candidateProviderId === provider.id && (
                                  <RiCheckLine className="h-4 w-4 text-[var(--primary-base)]" />
                                )}
                              </DropdownMenuItem>
                            ));
                          })()}
                        </ScrollableOverlay>
                      </DropdownMenuContent>
                    </DropdownMenu>
                   )}
              </div>
            </section>
          </div>

          {candidateProviderId && (
            <div className="mb-8">
              <div className="mb-1 px-1">
                <h2 className="typography-ui-header font-medium text-foreground">{t('settings.providers.page.auth.title')}</h2>
              </div>

              {authLoading ? (
                <p className="typography-meta text-muted-foreground px-2">{t('settings.providers.page.auth.loadingMethods')}</p>
              ) : (
                <section className="px-2 pb-2 pt-0 space-y-4">
                  {providerSupportsApiKey(candidateProviderId, providerOAuth) && (
                  <div className="py-1.5">
                    <label className="typography-ui-label text-foreground flex items-center gap-1.5">
                      {t('settings.providers.page.auth.apiKeyLabel')}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent sideOffset={8} className="max-w-xs">
                          {t('settings.providers.page.auth.apiKeyTooltip')}
                        </TooltipContent>
                      </Tooltip>
                    </label>
                    <div className="flex flex-col sm:flex-row sm:items-center gap-2 mt-1.5">
                      <Input
                        type="password"
                        value={apiKeyInputs[candidateProviderId] ?? ''}
                        onChange={(event) =>
                          setApiKeyInputs((prev) => ({
                            ...prev,
                            [candidateProviderId]: event.target.value,
                          }))
                        }
                        placeholder={t('settings.providers.page.auth.apiKeyPlaceholder')}
                        className="flex-1 font-mono text-xs"
                      />
                      <Button
                        size="xs"
                        className="!font-normal shrink-0"
                        onClick={() => handleSaveApiKey(candidateProviderId)}
                        disabled={authBusyKey === `api:${candidateProviderId}`}
                      >
                        {authBusyKey === `api:${candidateProviderId}` ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.saveKey')}
                      </Button>
                    </div>
                  </div>
                  )}

                  {providerOAuth && isAnthropicOAuthProviderId(candidateProviderId) && (
                    <>
                      {renderClaudeCodeAuth()}
                      {renderClaudeCompatibilityMode()}
                    </>
                  )}

                  {providerOAuth && candidateProviderId === 'openai' && renderChatgptSiwcAuth()}

                  {activeCursorAcpProviderId === candidateProviderId && (
                    <div className="flex items-center justify-between gap-3 py-1.5">
                      <div>
                        <div className="typography-ui-label text-foreground">{t('settings.providers.page.auth.cursorSetupTitle')}</div>
                        <div className="typography-meta text-muted-foreground">{t('settings.providers.page.auth.cursorSetupDescription')}</div>
                      </div>
                      <div className="flex shrink-0 flex-wrap justify-end gap-1">
                        <Button variant="outline" size="xs" className="!font-normal" onClick={handleConfigureCursorAcp} disabled={authBusyKey === 'cursor-configure'}>
                          {authBusyKey === 'cursor-configure' ? t('settings.providers.page.actions.checkingOAuth') : t('settings.providers.page.actions.verify')}
                        </Button>
                      </div>
                    </div>
                  )}

                  {activeCursorAcpProviderId === candidateProviderId && renderCursorRuntimeNotice()}

                  {activeManagedQuotaProviderId === candidateProviderId && (
                    <ManagedQuotaCredentials key={activeManagedQuotaProviderId} providerId={activeManagedQuotaProviderId} />
                  )}

                  {(() => {
                    const candidateSupportsApiKey = providerSupportsApiKey(candidateProviderId, providerOAuth);
                    const candidateAuthMethods = authMethodsByProvider[candidateProviderId] ?? [];
                    const candidateOAuthMethods = !providerOAuth || isCursorAcpProviderId(candidateProviderId)
                      ? []
                      : candidateAuthMethods.filter((method) => normalizeAuthType(method) === 'oauth');

                    if (candidateOAuthMethods.length === 0) {
                      return null;
                    }

                    return (
                      <div className={cn('space-y-4', candidateSupportsApiKey && 'border-t border-[var(--surface-subtle)] pt-2')}>
                        {candidateOAuthMethods.map((method, index) => {
                          const methodLabel = method.label || method.name || t('settings.providers.page.auth.oauthMethodFallback', { index: String(index + 1) });
                          const codeKey = `${candidateProviderId}:${index}`;
                          const activeAttempt = pendingOAuth?.providerId === candidateProviderId
                            && pendingOAuth.methodIndex === index
                            ? pendingOAuth
                            : null;
                          const isAttemptInProgress = activeAttempt && activeAttempt.phase !== 'error';

                          return (
                            <div key={`${candidateProviderId}-${methodLabel}`} className="space-y-3">
                              <div className="flex items-center justify-between gap-2">
                                <div>
                                  <div className="typography-ui-label text-foreground">{methodLabel}</div>
                                  {(method.description || method.help) && (
                                    <div className="typography-meta text-muted-foreground">
                                      {String(method.description || method.help)}
                                    </div>
                                  )}
                                </div>
                                <Button
                                  variant="outline"
                                  size="xs"
                                  className="!font-normal"
                                  onClick={() => handleOAuthStart(candidateProviderId, index)}
                                  disabled={authBusyKey !== null || Boolean(isAttemptInProgress)}
                                >
                                  {activeAttempt?.phase === 'error'
                                    ? t('settings.providers.page.actions.retry')
                                    : t('settings.providers.page.actions.connect')}
                                </Button>
                              </div>

                              {oauthDetails[codeKey]?.instructions && (
                                <p className="typography-meta text-[var(--primary-base)] bg-[var(--primary-base)]/10 px-2 py-1.5 rounded">
                                  {oauthDetails[codeKey]?.instructions}
                                </p>
                              )}

                              {oauthDetails[codeKey]?.userCode && (
                                <div className="flex items-center gap-2 mt-2">
                                  <Input value={oauthDetails[codeKey]?.userCode} readOnly className="font-mono text-center tracking-widest" />
                                  <Button variant="outline" size="xs" className="!font-normal" onClick={() => handleCopyOAuthCode(oauthDetails[codeKey]?.userCode ?? '')}>{t('settings.providers.page.actions.copyCode')}</Button>
                                </div>
                              )}

                              {oauthDetails[codeKey]?.url && (
                                <div className="flex items-center gap-2 mt-2">
                                  <Input value={oauthDetails[codeKey]?.url} readOnly className="text-xs text-muted-foreground" />
                                  <div className="flex gap-1 shrink-0">
                                    <Button variant="outline" size="xs" className="!font-normal" onClick={() => openExternalUrl(oauthDetails[codeKey]?.url ?? '')}>{t('settings.providers.page.actions.open')}</Button>
                                    <Button variant="outline" size="xs" className="!font-normal" onClick={() => handleCopyOAuthLink(oauthDetails[codeKey]?.url ?? '')}>{t('settings.providers.page.actions.copy')}</Button>
                                  </div>
                                </div>
                              )}

                              {renderOAuthAttemptStatus(candidateProviderId, index)}

                              {activeAttempt?.method === 'code' && activeAttempt.phase === 'waiting' && (
                                <div className="flex items-center gap-2 mt-2">
                                  <Input
                                    value={oauthCodes[codeKey] ?? ''}
                                    onChange={(event) =>
                                      setOauthCodes((prev) => ({
                                        ...prev,
                                        [codeKey]: event.target.value,
                                      }))
                                    }
                                    placeholder={t('settings.providers.page.auth.pasteAuthorizationCodePlaceholder')}
                                    className="font-mono text-xs"
                                  />
                                  <Button
                                    size="xs"
                                    className="!font-normal"
                                    onClick={() => handleOAuthComplete(candidateProviderId, index)}
                                    disabled={authBusyKey === `oauth-complete:${candidateProviderId}:${index}`}
                                  >
                                    {authBusyKey === `oauth-complete:${candidateProviderId}:${index}` ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.complete')}
                                  </Button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                </section>
              )}
            </div>
          )}
        </div>
      </ScrollableOverlay>
    );
  }

  if (!selectedProvider) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <RiStackLine className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="typography-body">{t('settings.providers.page.empty.selectProviderFromSidebar')}</p>
          <p className="typography-meta mt-1 opacity-75">{t('settings.providers.page.empty.reviewDetailsAndConfigureAuth')}</p>
        </div>
      </div>
    );
  }

  const providerModels = getProviderModelsForDisplay(selectedProvider, {
    hidePairedFastModels: true,
  });
  const providerAuthMethods = authMethodsByProvider[selectedProvider.id] ?? [];
  const oauthAuthMethods = providerAuthMethods.filter((method) => normalizeAuthType(method) === 'oauth');
  const visibleOAuthAuthMethods = !providerOAuth || selectedProviderIsCursor ? [] : oauthAuthMethods;

  const filteredModels = providerModels.filter((model) => {
    const name = typeof model?.name === 'string' ? model.name : '';
    const id = typeof model?.id === 'string' ? model.id : '';
    const query = modelQuery.trim().toLowerCase();
    if (!query) return true;
    return name.toLowerCase().includes(query) || id.toLowerCase().includes(query);
  });

  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full">
      <div className="mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">

        {connectionStatus}
        {/* Header */}
        <div className="mb-4 flex items-center gap-3">
          <ProviderLogo providerId={selectedProvider.id} className="h-5 w-5 shrink-0" />
          <div className="min-w-0">
            <h2 className="typography-ui-header font-semibold text-foreground truncate">
              {selectedProviderName}
            </h2>
            <p className="typography-meta text-muted-foreground truncate">
              <span className="font-mono">{selectedProvider.id}</span>
            </p>
          </div>
        </div>

        <ProviderUsageSection providerId={selectedProvider.id} />

        {/* Authentication */}
        <div className="mb-8">
          <div className="mb-1 px-1 flex items-center justify-between gap-2">
            <h3 className="typography-ui-header font-medium text-foreground">{t('settings.providers.page.auth.title')}</h3>
            <Button
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => setShowAuthPanel((prev) => !prev)}
              disabled={selectedDisconnectPending || selectedCursorUnavailable}
            >
              {showAuthPanel
                ? t('settings.providers.page.actions.hide')
                : selectedProviderIsCursor
                  ? t('settings.providers.page.actions.setup')
                  : t('settings.providers.page.actions.reconnect')}
            </Button>
          </div>

          <section className="px-2 pb-2 pt-0">
            {!showAuthPanel || selectedCursorUnavailable ? (
              <ProviderAuthenticationSummary
                providerId={selectedProvider.id}
                connectionState={selectedConnectionState}
                cursorConfigured={cursorSdkConfigured}
                cursorUnavailable={selectedCursorUnavailable}
                claudeStatus={claudeCliStatus}
                claudeLoading={claudeCliStatusLoading}
              />
            ) : authLoading ? (
              <div className="py-1.5 typography-meta text-muted-foreground">{t('settings.providers.page.auth.loadingMethods')}</div>
            ) : (
              <div className="space-y-4">
                {selectedProviderSupportsApiKey && (
                <div className="py-1.5">
                  <label className="typography-ui-label text-foreground flex items-center gap-1.5">
                    {t('settings.providers.page.auth.apiKeyLabel')}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent sideOffset={8} className="max-w-xs">
                        {t('settings.providers.page.auth.apiKeyTooltip')}
                      </TooltipContent>
                    </Tooltip>
                  </label>
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2 mt-1.5">
                    <Input
                      type="password"
                      value={apiKeyInputs[selectedProvider.id] ?? ''}
                      onChange={(event) =>
                        setApiKeyInputs((prev) => ({
                          ...prev,
                          [selectedProvider.id]: event.target.value,
                        }))
                      }
                      placeholder={t('settings.providers.page.auth.apiKeyPlaceholder')}
                      className="flex-1 font-mono text-xs"
                    />
                    <Button
                      size="xs"
                      className="!font-normal shrink-0"
                      onClick={() => handleSaveApiKey(selectedProvider.id)}
                      disabled={authBusyKey === `api:${selectedProvider.id}`}
                    >
                      {authBusyKey === `api:${selectedProvider.id}` ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.saveKey')}
                    </Button>
                  </div>
                </div>
                )}

                {providerOAuth && isAnthropicOAuthProviderId(selectedProvider.id) && (
                  renderClaudeCodeAuth()
                )}

                {providerOAuth && selectedProvider.id === 'openai' && renderChatgptSiwcAuth()}

                {activeCursorAcpProviderId === selectedProvider.id && (
                  <div className="flex items-center justify-between gap-3 py-1.5">
                    <div>
                      <div className="typography-ui-label text-foreground">{t('settings.providers.page.auth.cursorSetupTitle')}</div>
                      <div className="typography-meta text-muted-foreground">{t('settings.providers.page.auth.cursorSetupDescription')}</div>
                    </div>
                    <div className="flex shrink-0 flex-wrap justify-end gap-1">
                      <Button variant="outline" size="xs" className="!font-normal" onClick={handleConfigureCursorAcp} disabled={authBusyKey === 'cursor-configure'}>
                        {authBusyKey === 'cursor-configure' ? t('settings.providers.page.actions.checkingOAuth') : t('settings.providers.page.actions.verify')}
                      </Button>
                    </div>
                  </div>
                )}

                {activeCursorAcpProviderId === selectedProvider.id && renderCursorRuntimeNotice()}

                {activeManagedQuotaProviderId === selectedProvider.id && (
                  <ManagedQuotaCredentials key={activeManagedQuotaProviderId} providerId={activeManagedQuotaProviderId} />
                )}

                {visibleOAuthAuthMethods.length > 0 && (
                  <div className={cn('space-y-4', selectedProviderSupportsApiKey && 'border-t border-[var(--surface-subtle)] pt-2')}>
                    {visibleOAuthAuthMethods.map((method, index) => {
                      const methodLabel = method.label || method.name || t('settings.providers.page.auth.oauthMethodFallback', { index: String(index + 1) });
                      const codeKey = `${selectedProvider.id}:${index}`;
                      const activeAttempt = pendingOAuth?.providerId === selectedProvider.id
                        && pendingOAuth.methodIndex === index
                        ? pendingOAuth
                        : null;
                      const isAttemptInProgress = activeAttempt && activeAttempt.phase !== 'error';

                      return (
                        <div key={`${selectedProvider.id}-${methodLabel}`} className="space-y-3">
                          <div className="flex items-center justify-between gap-2">
                            <div>
                              <div className="typography-ui-label text-foreground">{methodLabel}</div>
                              {(method.description || method.help) && (
                                <div className="typography-meta text-muted-foreground">
                                  {String(method.description || method.help)}
                                </div>
                              )}
                            </div>
                            <Button
                              variant="outline"
                              size="xs"
                              className="!font-normal"
                              onClick={() => handleOAuthStart(selectedProvider.id, index)}
                              disabled={authBusyKey !== null || Boolean(isAttemptInProgress)}
                            >
                              {activeAttempt?.phase === 'error'
                                ? t('settings.providers.page.actions.retry')
                                : t('settings.providers.page.actions.connect')}
                            </Button>
                          </div>

                          {oauthDetails[codeKey]?.instructions && (
                            <p className="typography-meta text-[var(--primary-base)] bg-[var(--primary-base)]/10 px-2 py-1.5 rounded">
                              {oauthDetails[codeKey]?.instructions}
                            </p>
                          )}

                          {oauthDetails[codeKey]?.userCode && (
                            <div className="flex items-center gap-2 mt-2">
                              <Input value={oauthDetails[codeKey]?.userCode} readOnly className="font-mono text-center tracking-widest" />
                              <Button variant="outline" size="xs" className="!font-normal" onClick={() => handleCopyOAuthCode(oauthDetails[codeKey]?.userCode ?? '')}>{t('settings.providers.page.actions.copyCode')}</Button>
                            </div>
                          )}

                          {oauthDetails[codeKey]?.url && (
                            <div className="flex items-center gap-2 mt-2">
                              <Input value={oauthDetails[codeKey]?.url} readOnly className="text-xs text-muted-foreground" />
                              <div className="flex gap-1 shrink-0">
                                <Button variant="outline" size="xs" className="!font-normal" onClick={() => openExternalUrl(oauthDetails[codeKey]?.url ?? '')}>{t('settings.providers.page.actions.open')}</Button>
                                <Button variant="outline" size="xs" className="!font-normal" onClick={() => handleCopyOAuthLink(oauthDetails[codeKey]?.url ?? '')}>{t('settings.providers.page.actions.copy')}</Button>
                              </div>
                            </div>
                          )}

                          {renderOAuthAttemptStatus(selectedProvider.id, index)}

                          {activeAttempt?.method === 'code' && activeAttempt.phase === 'waiting' && (
                            <div className="flex items-center gap-2 mt-2">
                              <Input
                                value={oauthCodes[codeKey] ?? ''}
                                onChange={(event) =>
                                  setOauthCodes((prev) => ({
                                    ...prev,
                                    [codeKey]: event.target.value,
                                  }))
                                }
                                placeholder={t('settings.providers.page.auth.pasteAuthorizationCodePlaceholder')}
                                className="font-mono text-xs"
                              />
                              <Button
                                size="xs"
                                className="!font-normal"
                                onClick={() => handleOAuthComplete(selectedProvider.id, index)}
                                disabled={authBusyKey === `oauth-complete:${selectedProvider.id}:${index}`}
                              >
                                {authBusyKey === `oauth-complete:${selectedProvider.id}:${index}` ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.complete')}
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

        {providerOAuth && isAnthropicOAuthProviderId(selectedProvider.id) ? (
          <div className="mb-8">
            <div className="mb-1 px-1">
              <h3 className="typography-ui-header font-medium text-foreground">
                {t('settings.providers.page.claudeCompatibility.sectionTitle')}
              </h3>
            </div>
            <section className="px-2 pb-2 pt-0">
              {renderClaudeCompatibilityMode()}
            </section>
          </div>
        ) : null}

        {/* Connection Details */}
        <div className="mb-8">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">{t('settings.providers.page.connectionDetails.title')}</h3>
          </div>

          <section className="px-2 pb-2 pt-0">
            <div className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
              <div className="flex min-w-0 flex-col">
                {selectedDisconnectPending ? (
                  <span className="typography-meta text-[var(--status-warning)]">
                    {t('settings.providers.page.state.disconnectPendingHint')}
                  </span>
                ) : selectedSources && hasActiveProviderSource(selectedSources) ? (
                  <span className="typography-meta text-muted-foreground">
                    {t('settings.providers.page.connectionDetails.configuredIn')}{' '}
                    {[
                      selectedSources.auth.exists ? t('settings.providers.page.connectionDetails.source.authCredentials') : null,
                      selectedSources.user.exists ? t('settings.providers.page.connectionDetails.source.userConfig') : null,
                      selectedSources.project.exists ? t('settings.providers.page.connectionDetails.source.projectConfig') : null,
                      selectedSources.custom?.exists ? t('settings.providers.page.connectionDetails.source.customConfig') : null,
                    ].filter(Boolean).join(', ')}
                  </span>
                ) : (
                  <span className="typography-meta text-muted-foreground">{t('settings.providers.page.connectionDetails.noActiveSource')}</span>
                )}
              </div>

              {(hasActiveProviderSource(selectedSources) || selectedDisconnectPending) ? (
                <Button
                  variant="ghost"
                  size="xs"
                  className="!font-normal text-[var(--status-error)] hover:text-[var(--status-error)]"
                  onClick={() => handleDisconnectProvider(selectedProvider.id)}
                  disabled={selectedDisconnectPending || authBusyKey === `disconnect:${selectedProvider.id}`}
                >
                  {selectedDisconnectPending
                    ? t('settings.providers.page.actions.disconnectPending')
                    : authBusyKey === `disconnect:${selectedProvider.id}`
                      ? t('settings.providers.page.actions.disconnecting')
                      : t('settings.providers.page.actions.disconnect')}
                </Button>
              ) : null}
            </div>
          </section>
        </div>

        {/* Models */}
        <div className="mb-8">
          <div className="mb-1 px-1 flex items-center justify-between gap-2">
            <h3 className="typography-ui-header font-medium text-foreground">
              {t('settings.providers.page.models.title')}
              {providerModels.length > 0 && (
                <span className="ml-1.5 typography-micro text-muted-foreground font-normal">
                  ({providerModels.length})
                </span>
              )}
            </h3>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={() => {
                  const refSets = providerModels.map((model) => (
                    getHiddenModelRefsForProviderModel(selectedProvider.id, model)
                  ));
                  hideModelRefs(
                    refSets.flatMap((refs) => (refs.canonical ? [refs.canonical] : [])),
                    refSets.flatMap((refs) => refs.aliases),
                  );
                }}
              >
                {t('settings.providers.page.actions.hideAll')}
              </Button>
              <Button
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={() => {
                  const refs = providerModels.flatMap((model) => (
                    getHiddenModelRefsForProviderModel(selectedProvider.id, model).aliases
                  ));
                  showModelRefs(refs);
                }}
              >
                {t('settings.providers.page.actions.showAll')}
              </Button>
            </div>
          </div>

          <section className="px-2 pb-2 pt-0">
            <div className="relative mb-2">
              <RiSearchLine className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                type="search"
                value={modelQuery}
                onChange={(event) => setModelQuery(event.target.value)}
                placeholder={t('settings.providers.page.models.filterPlaceholder')}
                className="h-7 pl-8 w-full"
              />
            </div>

            {filteredModels.length === 0 ? (
              <p className="typography-meta text-muted-foreground py-4 text-center">{t('settings.providers.page.models.noModelsMatchFilter')}</p>
            ) : (
              <div className="divide-y divide-[var(--surface-subtle)]">
                {filteredModels.map((model) => {
                  const modelId = typeof model?.id === 'string' ? model.id : '';
                  const modelName = typeof model?.name === 'string' ? model.name : modelId;
                  const unavailableMessage = getProviderModelUnavailableMessage(model);
                  const metadata = modelId ? getModelMetadata(selectedProvider.id, modelId) as ModelMetadata | undefined : undefined;
                  const hiddenRefs = getHiddenModelRefsForProviderModel(selectedProvider.id, model);
                  const isHidden = isHiddenProviderModelRef(hiddenModels, selectedProvider.id, model);

                  const capabilityIcons: Array<{ key: string; icon: typeof RiToolsLine; label: string }> = [];
                  if (metadata?.tool_call) capabilityIcons.push({ key: 'tools', icon: RiToolsLine, label: t('settings.providers.page.models.capability.toolCalling') });
                  if (metadata?.reasoning) capabilityIcons.push({ key: 'reasoning', icon: RiBrainAi3Line, label: t('settings.providers.page.models.capability.reasoning') });
                  if (metadata?.attachment) capabilityIcons.push({ key: 'image', icon: RiFileImageLine, label: t('settings.providers.page.models.capability.imageInput') });

                  return (
                    <div key={modelId} className="py-1.5">
                      <div
                        className={cn(
                          "flex items-center gap-3",
                          isHidden && 'opacity-50',
                        )}
                      >
                      <span className="typography-meta font-medium text-foreground truncate flex-1 min-w-0">
                        {modelName}
                      </span>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {capabilityIcons.length > 0 && (
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {capabilityIcons.map(({ key, icon: Icon, label }) => (
                              <span
                                key={key}
                                className="flex h-5 w-5 rounded items-center justify-center text-muted-foreground bg-[var(--surface-muted)]"
                                title={label}
                                aria-label={label}
                              >
                                <Icon className="h-3 w-3" />
                              </span>
                            ))}
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => toggleHiddenModelRefs(
                            hiddenRefs.canonical ? [hiddenRefs.canonical] : [],
                            hiddenRefs.aliases,
                          )}
                          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]/50"
                          title={isHidden ? t('settings.providers.page.models.actions.showModelInSelectors') : t('settings.providers.page.models.actions.hideModelFromSelectors')}
                          aria-label={isHidden ? t('settings.providers.page.models.actions.showModel') : t('settings.providers.page.models.actions.hideModel')}
                        >
                          {isHidden ? <RiEyeOffLine className="h-3.5 w-3.5" /> : <RiEyeLine className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                      </div>
                      {unavailableMessage ? <p className="typography-meta text-muted-foreground">{unavailableMessage}</p> : null}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </ScrollableOverlay>
  );
};

export const ProvidersPage: React.FC = () => <div className="flex h-full min-h-0 flex-col">
  <BundledRuntimeUpdate />
  <div className="min-h-0 flex-1"><ProvidersPageContent /></div>
</div>;
