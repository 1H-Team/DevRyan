import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui';
import { RiStackLine, RiToolsLine, RiBrainAi3Line, RiFileImageLine, RiArrowDownSLine, RiCheckLine, RiSearchLine, RiInformationLine, RiEyeLine, RiEyeOffLine } from '@remixicon/react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { reloadOpenCodeConfiguration } from '@/stores/useAgentsStore';
import { cn } from '@/lib/utils';
import { copyTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/url';
import { splitAntigravityProviderForDisplay } from '@/lib/providers/antigravity';
import { CURSOR_ACP_PROVIDER_ID } from '@/lib/providers/cursorAcp';
import { getProviderDisplayName, isAnthropicOAuthProviderId } from '@/lib/providers/display';
import {
  getHiddenModelRefsForProviderModel,
  isHiddenProviderModelRef,
} from '@/lib/providers/modelVisibility';
import { parseProvidersPayload, type ProviderOption } from './providerOptions';
import { getProviderModelsForDisplay } from './providerSorting';
import type { ModelMetadata } from '@/types';
import { useI18n } from '@/lib/i18n';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';

const ADD_PROVIDER_ID = '__add_provider__';
const ANTIGRAVITY_PROVIDER_ID = 'antigravity';
const GOOGLE_PROVIDER_ID = 'google';
const OPENCODE_GO_PROVIDER_ID = 'opencode-go';
const CURSOR_USAGE_TOKEN_INPUT_ID = 'cursor-usage-session-token';
const OPENCODE_GO_WORKSPACE_INPUT_ID = 'opencode-go-usage-workspace-id';
const OPENCODE_GO_AUTH_COOKIE_INPUT_ID = 'opencode-go-usage-auth-cookie';
const AUTH_PROVIDER_ID_KEY = '__authProviderId';
const AUTH_METHOD_INDEX_KEY = '__authMethodIndex';

interface AuthMethod {
  type?: string;
  name?: string;
  label?: string;
  description?: string;
  help?: string;
  method?: number;
  [key: string]: unknown;
}

interface ProviderSourceInfo {
  exists: boolean;
  path?: string | null;
}

interface ProviderSources {
  auth: ProviderSourceInfo;
  user: ProviderSourceInfo;
  project: ProviderSourceInfo;
  custom?: ProviderSourceInfo;
  anthropicOAuth?: ProviderSourceInfo;
}

interface ClaudeCliStatus {
  installed: boolean;
  path?: string | null;
}

interface CursorAcpRuntimeStatus {
  sdkAuthConfigured?: boolean;
  usageAuthConfigured?: boolean;
  activeRuns?: number;
  modelCount?: number;
  modelsSource?: string;
  lastError?: string | null;
  bridge?: {
    kind?: string;
  };
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
  const googleMethods = result[GOOGLE_PROVIDER_ID] ?? [];
  const antigravityMethods = googleMethods
    .map((method, index) => ({ method, index }))
    .filter(({ method }) => {
      const label = `${method.label ?? ''} ${method.name ?? ''}`.toLowerCase();
      return normalizeAuthType(method) === 'oauth' && label.includes('antigravity');
    })
    .map(({ method, index }) => ({
      ...method,
      label: 'Login with Antigravity',
      [AUTH_PROVIDER_ID_KEY]: GOOGLE_PROVIDER_ID,
      [AUTH_METHOD_INDEX_KEY]: index,
    }));
  if (antigravityMethods.length > 0) {
    result[ANTIGRAVITY_PROVIDER_ID] = antigravityMethods;
  }
  return result;
};

const providerSupportsApiKey = (providerId: string) => (
  providerId !== ANTIGRAVITY_PROVIDER_ID
  && !isAnthropicOAuthProviderId(providerId)
);

export const ProvidersPage: React.FC = () => {
  const { t } = useI18n();
  const { terminal } = useRuntimeAPIs();
  const rawProviders = useConfigStore((state) => state.directoryScoped.__global__?.providers ?? state.providers);
  const providers = React.useMemo(
    () => splitAntigravityProviderForDisplay(rawProviders),
    [rawProviders]
  );
  const selectedProviderId = useConfigStore((state) => state.selectedProviderId);
  const setSelectedProvider = useConfigStore((state) => state.setSelectedProvider);
  const loadProviders = useConfigStore((state) => state.loadProviders);
  const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const hiddenModels = useUIStore((state) => state.hiddenModels);
  const hideModelRefs = useUIStore((state) => state.hideModelRefs);
  const showModelRefs = useUIStore((state) => state.showModelRefs);
  const toggleHiddenModelRefs = useUIStore((state) => state.toggleHiddenModelRefs);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const setBottomTerminalOpen = useUIStore((state) => state.setBottomTerminalOpen);
  const fetchProviderQuota = useQuotaStore((state) => state.fetchProviderQuota);

  const [authMethodsByProvider, setAuthMethodsByProvider] = React.useState<Record<string, AuthMethod[]>>({});
  const [authLoading, setAuthLoading] = React.useState(false);
  const [apiKeyInputs, setApiKeyInputs] = React.useState<Record<string, string>>({});
  const [authBusyKey, setAuthBusyKey] = React.useState<string | null>(null);
  const [modelQuery, setModelQuery] = React.useState('');
  const [pendingOAuth, setPendingOAuth] = React.useState<{ providerId: string; methodIndex: number } | null>(null);
  const [oauthCodes, setOauthCodes] = React.useState<Record<string, string>>({});
  const [oauthDetails, setOauthDetails] = React.useState<Record<string, { url?: string; instructions?: string; userCode?: string }>>({});
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
  const [cursorUsageTokenInput, setCursorUsageTokenInput] = React.useState('');
  const [cursorUsageAuthConfigured, setCursorUsageAuthConfigured] = React.useState(false);
  const [cursorUsageAuthLoading, setCursorUsageAuthLoading] = React.useState(false);
  const [openCodeGoWorkspaceIdInput, setOpenCodeGoWorkspaceIdInput] = React.useState('');
  const [openCodeGoAuthCookieInput, setOpenCodeGoAuthCookieInput] = React.useState('');
  const [openCodeGoUsageAuthConfigured, setOpenCodeGoUsageAuthConfigured] = React.useState(false);
  const [openCodeGoUsageAuthLoading, setOpenCodeGoUsageAuthLoading] = React.useState(false);
  const [cursorRuntimeStatus, setCursorRuntimeStatus] = React.useState<CursorAcpRuntimeStatus | null>(null);
  const cursorUsageTokenInputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    void loadProviders({ directory: null });
  }, [loadProviders]);

  React.useEffect(() => {
    if (!selectedProviderId && providers.length > 0) {
      setSelectedProvider(providers[0].id);
    }
  }, [providers, selectedProviderId, setSelectedProvider]);

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
    () => new Set(providers.map((provider) => provider.id)),
    [providers]
  );

  const unconnectedProviders = React.useMemo(
    () =>
      availableProviders
        .filter((provider) => !connectedProviderIds.has(provider.id))
        .sort((a, b) => {
          const labelA = (a.name || a.id).toLowerCase();
          const labelB = (b.name || b.id).toLowerCase();
          return labelA.localeCompare(labelB);
        }),
    [availableProviders, connectedProviderIds]
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
    if (selectedProviderId === ADD_PROVIDER_ID) {
      return isAnthropicOAuthProviderId(candidateProviderId) ? candidateProviderId : null;
    }
    return isAnthropicOAuthProviderId(selectedProviderId) ? selectedProviderId : null;
  }, [candidateProviderId, selectedProviderId]);
  const activeCursorAcpProviderId = React.useMemo(() => {
    if (selectedProviderId === ADD_PROVIDER_ID) {
      return candidateProviderId === CURSOR_ACP_PROVIDER_ID ? candidateProviderId : null;
    }
    return selectedProviderId === CURSOR_ACP_PROVIDER_ID ? selectedProviderId : null;
  }, [candidateProviderId, selectedProviderId]);
  const activeOpenCodeGoProviderId = React.useMemo(() => {
    if (selectedProviderId === ADD_PROVIDER_ID) {
      return candidateProviderId === OPENCODE_GO_PROVIDER_ID ? candidateProviderId : null;
    }
    return selectedProviderId === OPENCODE_GO_PROVIDER_ID ? selectedProviderId : null;
  }, [candidateProviderId, selectedProviderId]);

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
      });
    } catch (error) {
      console.error('Failed to check Claude CLI availability:', error);
      setClaudeCliStatus({ installed: false, path: null });
      toast.error(t('settings.providers.page.toast.claudeCliCheckFailed'));
    } finally {
      setClaudeCliStatusLoading(false);
    }
  }, [activeAnthropicProviderId, t]);

  React.useEffect(() => {
    void refreshClaudeCliStatus();
  }, [refreshClaudeCliStatus]);

  const refreshCursorUsageAuthStatus = React.useCallback(async () => {
    if (!activeCursorAcpProviderId) {
      setCursorUsageAuthConfigured(false);
      setCursorUsageAuthLoading(false);
      return;
    }

    setCursorUsageAuthLoading(true);
    try {
      const response = await fetch('/api/provider/cursor-acp/usage-auth/status', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || t('settings.providers.page.toast.cursorUsageStatusFailed'));
      }
      setCursorUsageAuthConfigured(Boolean(payload?.configured));
    } catch (error) {
      console.error('Failed to load Cursor usage auth status:', error);
      setCursorUsageAuthConfigured(false);
    } finally {
      setCursorUsageAuthLoading(false);
    }
  }, [activeCursorAcpProviderId, t]);

  React.useEffect(() => {
    void refreshCursorUsageAuthStatus();
  }, [refreshCursorUsageAuthStatus]);

  const refreshOpenCodeGoUsageAuthStatus = React.useCallback(async () => {
    if (!activeOpenCodeGoProviderId) {
      setOpenCodeGoUsageAuthConfigured(false);
      setOpenCodeGoUsageAuthLoading(false);
      setOpenCodeGoWorkspaceIdInput('');
      return;
    }

    setOpenCodeGoUsageAuthLoading(true);
    try {
      const response = await fetch('/api/provider/opencode-go/usage-auth/status', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || t('settings.providers.page.toast.openCodeGoUsageStatusFailed'));
      }
      setOpenCodeGoUsageAuthConfigured(Boolean(payload?.configured));
      setOpenCodeGoWorkspaceIdInput(typeof payload?.workspaceId === 'string' ? payload.workspaceId : '');
    } catch (error) {
      console.error('Failed to load OpenCode Go usage auth status:', error);
      setOpenCodeGoUsageAuthConfigured(false);
    } finally {
      setOpenCodeGoUsageAuthLoading(false);
    }
  }, [activeOpenCodeGoProviderId, t]);

  React.useEffect(() => {
    void refreshOpenCodeGoUsageAuthStatus();
  }, [refreshOpenCodeGoUsageAuthStatus]);

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
      setCursorRuntimeStatus(isRecord(payload) ? payload as CursorAcpRuntimeStatus : null);
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
    if (!selectedProviderId || selectedProviderId === ADD_PROVIDER_ID) {
      return;
    }

    let cancelled = false;

    void loadProviderSources(selectedProviderId, { cancelled: () => cancelled });

    return () => {
      cancelled = true;
    };
  }, [loadProviderSources, selectedProviderId]);

  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);
  const selectedSources = selectedProviderId ? providerSources[selectedProviderId] : undefined;
  const selectedProviderName = selectedProvider ? getProviderDisplayName(selectedProvider, selectedSources) : '';
  const selectedProviderSupportsApiKey = selectedProvider ? providerSupportsApiKey(selectedProvider.id) : false;
  const selectedProviderIsCursor = isCursorAcpProviderId(selectedProvider?.id);
  const cursorSdkConfigured = cursorRuntimeStatus?.sdkAuthConfigured === true;

  const resolveAuthMethodTarget = React.useCallback((providerId: string, methodIndex: number) => {
    const method = authMethodsByProvider[providerId]?.[methodIndex];
    const authProviderId = typeof method?.[AUTH_PROVIDER_ID_KEY] === 'string'
      ? method[AUTH_PROVIDER_ID_KEY]
      : providerId;
    const authMethodIndex = typeof method?.[AUTH_METHOD_INDEX_KEY] === 'number'
      ? method[AUTH_METHOD_INDEX_KEY]
      : methodIndex;
    return {
      providerId: authProviderId,
      methodIndex: authMethodIndex,
    };
  }, [authMethodsByProvider]);

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

      toast.success(t('settings.providers.page.toast.apiKeySaved'));
      setApiKeyInputs((prev) => ({ ...prev, [providerId]: '' }));
      await reloadOpenCodeConfiguration({ scopes: ["providers"], mode: "active" });
      await loadProviders({ directory: null });
      setSelectedProvider(providerId);
      if (providerId === CURSOR_ACP_PROVIDER_ID) {
        await refreshCursorRuntimeStatus();
      }
    } catch (error) {
      console.error('Failed to save API key:', error);
      toast.error(t('settings.providers.page.toast.apiKeySaveFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleOAuthStart = async (providerId: string, methodIndex: number) => {
    const busyKey = `oauth:${providerId}:${methodIndex}`;
    setAuthBusyKey(busyKey);

    try {
      const target = resolveAuthMethodTarget(providerId, methodIndex);
      const response = await fetch(`/api/provider/${encodeURIComponent(target.providerId)}/oauth/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: target.methodIndex }),
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload?.error || t('settings.providers.page.toast.oauthStartFailed');
        throw new Error(message);
      }

      const payloadRecord = isRecord(payload) ? payload : {};
      const dataRecord = isRecord(payloadRecord.data) ? payloadRecord.data : payloadRecord;
      const urlCandidate =
        (typeof dataRecord.url === 'string' && dataRecord.url) ||
        (typeof dataRecord.verification_uri_complete === 'string' && dataRecord.verification_uri_complete) ||
        (typeof dataRecord.verification_uri === 'string' && dataRecord.verification_uri) ||
        undefined;
      const instructions =
        (typeof dataRecord.instructions === 'string' && dataRecord.instructions) ||
        (typeof dataRecord.message === 'string' && dataRecord.message) ||
        undefined;
      const userCode =
        (typeof dataRecord.user_code === 'string' && dataRecord.user_code) ||
        (typeof dataRecord.code === 'string' && dataRecord.code) ||
        (typeof dataRecord.userCode === 'string' && dataRecord.userCode) ||
        undefined;

      if (!urlCandidate && !instructions && !userCode) {
        throw new Error(t('settings.providers.page.toast.oauthDetailsMissing'));
      }

      const detailsKey = `${providerId}:${methodIndex}`;
      setOauthDetails((prev) => ({
        ...prev,
        [detailsKey]: {
          url: urlCandidate,
          instructions,
          userCode,
        },
      }));

      if (urlCandidate) {
        void openExternalUrl(urlCandidate);
      }
      setPendingOAuth({ providerId, methodIndex });
      toast.message(t('settings.providers.page.toast.completeOAuthInBrowser'));
    } catch (error) {
      console.error('Failed to start OAuth flow:', error);
      toast.error(t('settings.providers.page.toast.oauthStartFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleOAuthComplete = async (providerId: string, methodIndex: number) => {
    const codeKey = `${providerId}:${methodIndex}`;
    const code = oauthCodes[codeKey]?.trim();

    const busyKey = `oauth-complete:${providerId}:${methodIndex}`;
    setAuthBusyKey(busyKey);

    try {
      const target = resolveAuthMethodTarget(providerId, methodIndex);
      const requestBody: { method: number; code?: string } = { method: target.methodIndex };
      if (code) {
        requestBody.code = code;
      }

      const response = await fetch(`/api/provider/${encodeURIComponent(target.providerId)}/oauth/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const responsePayload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = responsePayload?.error || t('settings.providers.page.toast.oauthCompleteFailed');
        throw new Error(message);
      }

      toast.success(t('settings.providers.page.toast.oauthCompleted'));
      setOauthCodes((prev) => ({ ...prev, [codeKey]: '' }));
      setPendingOAuth(null);
      await reloadOpenCodeConfiguration({ scopes: ["providers"], mode: "active" });
      await loadProviders({ directory: null });
      setSelectedProvider(providerId);
    } catch (error) {
      console.error('Failed to complete OAuth flow:', error);
      toast.error(t('settings.providers.page.toast.oauthCompleteFailed'));
    } finally {
      setAuthBusyKey(null);
    }
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

  const runCommandInTerminal = async ({
    label,
    command,
    startedToast,
    failedToast,
  }: {
    label: string;
    command: string;
    startedToast: string;
    failedToast: string;
  }) => {
    const directory = currentDirectory?.trim();
    if (!directory) {
      toast.error(t('settings.providers.page.toast.terminalDirectoryUnavailable'));
      return;
    }

    let createdSessionId: string | null = null;
    let createdTabId: string | null = null;
    try {
      const terminalStore = useTerminalStore.getState();
      terminalStore.ensureDirectory(directory);
      const tabId = terminalStore.createTab(directory);
      createdTabId = tabId;
      terminalStore.setTabLabel(directory, tabId, label);
      terminalStore.setActiveTab(directory, tabId);
      setBottomTerminalOpen(true);
      setActiveMainTab('terminal');

      terminalStore.setConnecting(directory, tabId, true);
      const session = await terminal.createSession({ cwd: directory });
      createdSessionId = session.sessionId;
      terminalStore.setTabSessionId(directory, tabId, createdSessionId);
      terminalStore.setTabLifecycle(directory, tabId, 'running');
      terminalStore.setConnecting(directory, tabId, false);

      await new Promise((resolve) => window.setTimeout(resolve, 350));
      await terminal.sendInput(createdSessionId, `${command}\r`);
      toast.message(startedToast);
    } catch (error) {
      console.error('Failed to run provider terminal command:', error);
      if (createdTabId) {
        const terminalStore = useTerminalStore.getState();
        terminalStore.setConnecting(directory, createdTabId, false);
        terminalStore.setTabLifecycle(directory, createdTabId, 'exited');
      }
      if (createdSessionId) {
        try {
          await terminal.close(createdSessionId);
        } catch {
          // ignore cleanup failures
        }
      }
      toast.error(failedToast);
    }
  };

  const handleLaunchClaudeLogin = async () => {
    const busyKey = 'claude-login';
    setAuthBusyKey(busyKey);
    try {
      await runCommandInTerminal({
        label: t('settings.providers.page.auth.claudeLoginTerminalLabel'),
        command: 'claude /login',
        startedToast: t('settings.providers.page.toast.claudeLoginStarted'),
        failedToast: t('settings.providers.page.toast.claudeLoginFailed'),
      });
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleCheckClaudeOAuth = async () => {
    const busyKey = 'claude-check-oauth';
    setAuthBusyKey(busyKey);
    try {
      const directory = currentDirectory?.trim();
      const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
      const response = await fetch(`/api/provider/anthropic/check-oauth${query}`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload?.error || t('settings.providers.page.toast.claudeOAuthCheckFailed');
        throw new Error(message);
      }

      toast.success(t('settings.providers.page.toast.claudeOAuthChecked'));
      await reloadOpenCodeConfiguration({ scopes: ["providers"], mode: "active" });
      await loadProviders({ directory: null });
      const resolvedProviderId = 'anthropic';
      setSelectedProvider(resolvedProviderId);
      await loadProviderSources(resolvedProviderId);
      await fetchProviderQuota('claude', { forceRefresh: true });
    } catch (error) {
      console.error('Failed to check Claude OAuth:', error);
      toast.error(error instanceof Error ? error.message : t('settings.providers.page.toast.claudeOAuthCheckFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleInstallClaudeCli = async () => {
    const busyKey = 'claude-install';
    setAuthBusyKey(busyKey);
    try {
      await runCommandInTerminal({
        label: t('settings.providers.page.auth.claudeInstallTerminalLabel'),
        command: 'npm install -g @anthropic-ai/claude-code',
        startedToast: t('settings.providers.page.toast.claudeInstallStarted'),
        failedToast: t('settings.providers.page.toast.claudeInstallFailed'),
      });
    } finally {
      setAuthBusyKey(null);
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
      await reloadOpenCodeConfiguration({ scopes: ["providers"], mode: "active" });
      await loadProviders({ directory: null });
      setSelectedProvider(CURSOR_ACP_PROVIDER_ID);
      await loadProviderSources(CURSOR_ACP_PROVIDER_ID);
      await refreshCursorRuntimeStatus();
    } catch (error) {
      console.error('Failed to configure Cursor:', error);
      toast.error(error instanceof Error ? error.message : t('settings.providers.page.toast.cursorConfigureFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleSaveCursorUsageAuth = async () => {
    const domTokenInput = typeof document === 'undefined'
      ? null
      : document.getElementById(CURSOR_USAGE_TOKEN_INPUT_ID);
    const domTokenValue = domTokenInput instanceof HTMLInputElement ? domTokenInput.value : '';
    const sessionToken = (cursorUsageTokenInput || cursorUsageTokenInputRef.current?.value || domTokenValue).trim();
    if (!sessionToken) {
      toast.error(t('settings.providers.page.toast.cursorUsageTokenRequired'));
      return;
    }

    const busyKey = 'cursor-usage-save';
    setAuthBusyKey(busyKey);
    try {
      const response = await fetch('/api/provider/cursor-acp/usage-auth', {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sessionToken }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || t('settings.providers.page.toast.cursorUsageSaveFailed'));
      }
      setCursorUsageTokenInput('');
      setCursorUsageAuthConfigured(true);
      toast.success(t('settings.providers.page.toast.cursorUsageSaved'));
      await fetchProviderQuota(CURSOR_ACP_PROVIDER_ID, { forceRefresh: true });
    } catch (error) {
      console.error('Failed to save Cursor usage token:', error);
      toast.error(error instanceof Error ? error.message : t('settings.providers.page.toast.cursorUsageSaveFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleClearCursorUsageAuth = async () => {
    const busyKey = 'cursor-usage-clear';
    setAuthBusyKey(busyKey);
    try {
      const response = await fetch('/api/provider/cursor-acp/usage-auth', {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || t('settings.providers.page.toast.cursorUsageClearFailed'));
      }
      setCursorUsageTokenInput('');
      setCursorUsageAuthConfigured(false);
      toast.success(t('settings.providers.page.toast.cursorUsageCleared'));
      await fetchProviderQuota(CURSOR_ACP_PROVIDER_ID, { forceRefresh: true });
    } catch (error) {
      console.error('Failed to clear Cursor usage token:', error);
      toast.error(error instanceof Error ? error.message : t('settings.providers.page.toast.cursorUsageClearFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleRefreshCursorUsage = async () => {
    if (!cursorUsageAuthConfigured) {
      toast.error(t('settings.providers.page.toast.cursorUsageTokenRequired'));
      return;
    }

    const busyKey = 'cursor-usage-refresh';
    setAuthBusyKey(busyKey);
    try {
      await fetchProviderQuota(CURSOR_ACP_PROVIDER_ID, { forceRefresh: true });
      const result = useQuotaStore.getState().results.find((entry) => entry.providerId === CURSOR_ACP_PROVIDER_ID);
      if (result && !result.ok) {
        throw new Error(result.error || t('settings.providers.page.toast.cursorUsageRefreshFailed'));
      }
      toast.success(t('settings.providers.page.toast.cursorUsageRefreshed'));
    } catch (error) {
      console.error('Failed to refresh Cursor usage:', error);
      toast.error(error instanceof Error ? error.message : t('settings.providers.page.toast.cursorUsageRefreshFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleSaveOpenCodeGoUsageAuth = async () => {
    const workspaceId = openCodeGoWorkspaceIdInput.trim();
    const authCookie = openCodeGoAuthCookieInput.trim();
    if (!workspaceId) {
      toast.error(t('settings.providers.page.toast.openCodeGoWorkspaceRequired'));
      return;
    }
    if (!authCookie) {
      toast.error(t('settings.providers.page.toast.openCodeGoAuthCookieRequired'));
      return;
    }

    const busyKey = 'opencode-go-usage-save';
    setAuthBusyKey(busyKey);
    try {
      const response = await fetch('/api/provider/opencode-go/usage-auth', {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ workspaceId, authCookie }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || t('settings.providers.page.toast.openCodeGoUsageSaveFailed'));
      }
      setOpenCodeGoAuthCookieInput('');
      setOpenCodeGoUsageAuthConfigured(true);
      toast.success(t('settings.providers.page.toast.openCodeGoUsageSaved'));
      await fetchProviderQuota(OPENCODE_GO_PROVIDER_ID, { forceRefresh: true });
    } catch (error) {
      console.error('Failed to save OpenCode Go usage auth:', error);
      toast.error(error instanceof Error ? error.message : t('settings.providers.page.toast.openCodeGoUsageSaveFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleClearOpenCodeGoUsageAuth = async () => {
    const busyKey = 'opencode-go-usage-clear';
    setAuthBusyKey(busyKey);
    try {
      const response = await fetch('/api/provider/opencode-go/usage-auth', {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || t('settings.providers.page.toast.openCodeGoUsageClearFailed'));
      }
      setOpenCodeGoWorkspaceIdInput('');
      setOpenCodeGoAuthCookieInput('');
      setOpenCodeGoUsageAuthConfigured(false);
      toast.success(t('settings.providers.page.toast.openCodeGoUsageCleared'));
      await fetchProviderQuota(OPENCODE_GO_PROVIDER_ID, { forceRefresh: true });
    } catch (error) {
      console.error('Failed to clear OpenCode Go usage auth:', error);
      toast.error(error instanceof Error ? error.message : t('settings.providers.page.toast.openCodeGoUsageClearFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleRefreshOpenCodeGoUsage = async () => {
    if (!openCodeGoUsageAuthConfigured) {
      toast.error(t('settings.providers.page.toast.openCodeGoUsageAuthRequired'));
      return;
    }

    const busyKey = 'opencode-go-usage-refresh';
    setAuthBusyKey(busyKey);
    try {
      await fetchProviderQuota(OPENCODE_GO_PROVIDER_ID, { forceRefresh: true });
      const result = useQuotaStore.getState().results.find((entry) => entry.providerId === OPENCODE_GO_PROVIDER_ID);
      if (result && !result.ok) {
        throw new Error(result.error || t('settings.providers.page.toast.openCodeGoUsageRefreshFailed'));
      }
      toast.success(t('settings.providers.page.toast.openCodeGoUsageRefreshed'));
    } catch (error) {
      console.error('Failed to refresh OpenCode Go usage:', error);
      toast.error(error instanceof Error ? error.message : t('settings.providers.page.toast.openCodeGoUsageRefreshFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleDisconnectProvider = async (providerId: string) => {
    const busyKey = `disconnect:${providerId}`;
    setAuthBusyKey(busyKey);

    try {
      const response = await fetch(`/api/provider/${encodeURIComponent(providerId)}/auth?scope=all`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload?.error || t('settings.providers.page.toast.providerDisconnectFailed');
        throw new Error(message);
      }

      toast.success(t('settings.providers.page.toast.providerDisconnected'));
      await reloadOpenCodeConfiguration({ scopes: ["providers"], mode: "active" });
      await loadProviders({ directory: null });
    } catch (error) {
      console.error('Failed to disconnect provider:', error);
      toast.error(t('settings.providers.page.toast.providerDisconnectFailed'));
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

  const renderCursorUsageTracking = () => (
    <div className="space-y-2 border-t border-[var(--surface-subtle)] pt-3">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="typography-ui-label text-foreground">{t('settings.providers.page.auth.cursorUsageTitle')}</div>
          <div className="typography-meta whitespace-pre-line text-muted-foreground">{t('settings.providers.page.auth.cursorUsageDescription')}</div>
        </div>
        <span className={cn(
          'typography-micro shrink-0',
          cursorUsageAuthConfigured ? 'text-[var(--status-success)]' : 'text-muted-foreground',
        )}>
          {cursorUsageAuthLoading
            ? t('settings.providers.page.auth.cursorUsageChecking')
            : cursorUsageAuthConfigured
              ? t('settings.providers.page.auth.cursorUsageConfigured')
              : t('settings.providers.page.auth.cursorUsageNotConfigured')}
        </span>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          id={CURSOR_USAGE_TOKEN_INPUT_ID}
          ref={cursorUsageTokenInputRef}
          type="password"
          value={cursorUsageTokenInput}
          onChange={(event) => setCursorUsageTokenInput(event.target.value)}
          onInput={(event) => setCursorUsageTokenInput(event.currentTarget.value)}
          placeholder={t('settings.providers.page.auth.cursorUsageTokenPlaceholder')}
          className="flex-1 font-mono text-xs"
          autoComplete="off"
        />
        <div className="flex shrink-0 flex-wrap gap-1">
          <Button
            size="xs"
            className="!font-normal"
            onClick={handleSaveCursorUsageAuth}
            disabled={authBusyKey === 'cursor-usage-save'}
          >
            {authBusyKey === 'cursor-usage-save' ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.save')}
          </Button>
          <Button
            variant="outline"
            size="xs"
            className="!font-normal"
            onClick={handleClearCursorUsageAuth}
            disabled={authBusyKey === 'cursor-usage-clear' || (!cursorUsageAuthConfigured && !cursorUsageTokenInput)}
          >
            {authBusyKey === 'cursor-usage-clear' ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.clear')}
          </Button>
          <Button
            variant="outline"
            size="xs"
            className="!font-normal"
            onClick={handleRefreshCursorUsage}
            disabled={authBusyKey === 'cursor-usage-refresh' || !cursorUsageAuthConfigured}
          >
            {authBusyKey === 'cursor-usage-refresh'
              ? t('settings.providers.page.actions.refreshing')
              : t('settings.providers.page.actions.refreshUsage')}
          </Button>
        </div>
      </div>
    </div>
  );

  const renderOpenCodeGoUsageTracking = () => (
    <div className="space-y-2 border-t border-[var(--surface-subtle)] pt-3">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="typography-ui-label text-foreground">{t('settings.providers.page.auth.openCodeGoUsageTitle')}</div>
          <div className="typography-meta whitespace-pre-line text-muted-foreground">{t('settings.providers.page.auth.openCodeGoUsageDescription')}</div>
        </div>
        <span className={cn(
          'typography-micro shrink-0',
          openCodeGoUsageAuthConfigured ? 'text-[var(--status-success)]' : 'text-muted-foreground',
        )}>
          {openCodeGoUsageAuthLoading
            ? t('settings.providers.page.auth.openCodeGoUsageChecking')
            : openCodeGoUsageAuthConfigured
              ? t('settings.providers.page.auth.openCodeGoUsageConfigured')
              : t('settings.providers.page.auth.openCodeGoUsageNotConfigured')}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,0.45fr)_minmax(0,0.55fr)]">
        <Input
          id={OPENCODE_GO_WORKSPACE_INPUT_ID}
          value={openCodeGoWorkspaceIdInput}
          onChange={(event) => setOpenCodeGoWorkspaceIdInput(event.target.value)}
          placeholder={t('settings.providers.page.auth.openCodeGoWorkspacePlaceholder')}
          className="font-mono text-xs"
          autoComplete="off"
        />
        <Input
          id={OPENCODE_GO_AUTH_COOKIE_INPUT_ID}
          type="password"
          value={openCodeGoAuthCookieInput}
          onChange={(event) => setOpenCodeGoAuthCookieInput(event.target.value)}
          placeholder={t('settings.providers.page.auth.openCodeGoAuthCookiePlaceholder')}
          className="font-mono text-xs"
          autoComplete="off"
        />
      </div>
      <div className="flex flex-wrap gap-1">
        <Button size="xs" className="!font-normal" onClick={handleSaveOpenCodeGoUsageAuth} disabled={authBusyKey === 'opencode-go-usage-save'}>
          {authBusyKey === 'opencode-go-usage-save' ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.save')}
        </Button>
        <Button variant="outline" size="xs" className="!font-normal" onClick={handleClearOpenCodeGoUsageAuth} disabled={authBusyKey === 'opencode-go-usage-clear' || (!openCodeGoUsageAuthConfigured && !openCodeGoWorkspaceIdInput && !openCodeGoAuthCookieInput)}>
          {authBusyKey === 'opencode-go-usage-clear' ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.clear')}
        </Button>
        <Button variant="outline" size="xs" className="!font-normal" onClick={handleRefreshOpenCodeGoUsage} disabled={authBusyKey === 'opencode-go-usage-refresh' || !openCodeGoUsageAuthConfigured}>
          {authBusyKey === 'opencode-go-usage-refresh' ? t('settings.providers.page.actions.refreshing') : t('settings.providers.page.actions.refreshUsage')}
        </Button>
      </div>
    </div>
  );

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
                            type="text"
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
                              return (p.name || p.id).toLowerCase().includes(query) || p.id.toLowerCase().includes(query);
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
                                  <span className="truncate">{provider.name || provider.id}</span>
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
                  {providerSupportsApiKey(candidateProviderId) && (
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

                  {isAnthropicOAuthProviderId(candidateProviderId) && (
                    <div className="flex items-center justify-between gap-3 py-1.5">
                      <div>
                        <div className="typography-ui-label text-foreground">
                          {claudeCliStatusLoading
                            ? t('settings.providers.page.auth.checkingClaudeCliTitle')
                            : claudeCliStatus?.installed
                              ? t('settings.providers.page.auth.claudeLoginTitle')
                              : t('settings.providers.page.auth.claudeCliMissingTitle')}
                        </div>
                        <div className="typography-meta text-muted-foreground">
                          {claudeCliStatusLoading
                            ? t('settings.providers.page.auth.checkingClaudeCliDescription')
                            : claudeCliStatus?.installed
                              ? t('settings.providers.page.auth.claudeLoginDescription')
                              : t('settings.providers.page.auth.claudeCliMissingDescription')}
                        </div>
                      </div>
                      {claudeCliStatusLoading ? null : claudeCliStatus?.installed ? (
                        <div className="flex shrink-0 gap-1">
                          <Button
                            variant="outline"
                            size="xs"
                            className="!font-normal"
                            onClick={handleLaunchClaudeLogin}
                            disabled={authBusyKey === 'claude-login'}
                          >
                            {authBusyKey === 'claude-login' ? t('settings.providers.page.actions.openingTerminal') : t('settings.providers.page.actions.authenticate')}
                          </Button>
                          <Button
                            variant="outline"
                            size="xs"
                            className="!font-normal"
                            onClick={handleCheckClaudeOAuth}
                            disabled={authBusyKey === 'claude-check-oauth'}
                          >
                            {authBusyKey === 'claude-check-oauth' ? t('settings.providers.page.actions.checkingOAuth') : t('settings.providers.page.actions.checkOAuth')}
                          </Button>
                        </div>
                      ) : (
                        <div className="flex shrink-0 gap-1">
                          <Button
                            variant="outline"
                            size="xs"
                            className="!font-normal"
                            onClick={handleInstallClaudeCli}
                            disabled={authBusyKey === 'claude-install'}
                          >
                            {authBusyKey === 'claude-install' ? t('settings.providers.page.actions.openingTerminal') : t('settings.providers.page.actions.installClaudeCli')}
                          </Button>
                          <Button variant="ghost" size="xs" className="!font-normal" onClick={refreshClaudeCliStatus}>
                            {t('settings.providers.page.actions.refresh')}
                          </Button>
                        </div>
                      )}
                    </div>
                  )}

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

                  {activeCursorAcpProviderId === candidateProviderId && renderCursorUsageTracking()}

                  {activeOpenCodeGoProviderId === candidateProviderId && renderOpenCodeGoUsageTracking()}

                  {(() => {
                    const candidateSupportsApiKey = providerSupportsApiKey(candidateProviderId);
                    const candidateAuthMethods = authMethodsByProvider[candidateProviderId] ?? [];
                    const candidateOAuthMethods = isCursorAcpProviderId(candidateProviderId)
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
                          const isPending =
                            pendingOAuth?.providerId === candidateProviderId && pendingOAuth?.methodIndex === index;

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
                                  disabled={authBusyKey === `oauth:${candidateProviderId}:${index}`}
                                >
                                  {t('settings.providers.page.actions.connect')}
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

                              {isPending && (
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
  const visibleOAuthAuthMethods = selectedProviderIsCursor ? [] : oauthAuthMethods;

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

        {/* Authentication */}
        <div className="mb-8">
          <div className="mb-1 px-1 flex items-center justify-between gap-2">
            <h3 className="typography-ui-header font-medium text-foreground">{t('settings.providers.page.auth.title')}</h3>
            <Button
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => setShowAuthPanel((prev) => !prev)}
            >
              {showAuthPanel
                ? t('settings.providers.page.actions.hide')
                : selectedProviderIsCursor
                  ? t('settings.providers.page.actions.setup')
                  : t('settings.providers.page.actions.reconnect')}
            </Button>
          </div>

          <section className="px-2 pb-2 pt-0">
            {!showAuthPanel ? (
              <div className="flex items-center gap-1.5 py-1.5">
                {selectedProviderIsCursor && !cursorSdkConfigured ? null : <RiCheckLine className="w-4 h-4 text-[var(--status-success)] shrink-0" />}
                <span className="typography-ui-label text-foreground">
                  {selectedProviderIsCursor && !cursorSdkConfigured
                    ? t('settings.providers.page.auth.cursorSetupRequired')
                    : t('settings.providers.page.auth.connected')}
                </span>
                <span className="typography-meta text-muted-foreground ml-1">
                  {selectedProviderIsCursor && !cursorSdkConfigured
                    ? t('settings.providers.page.auth.cursorSetupRequiredHint')
                    : t('settings.providers.page.auth.useReconnectHint')}
                </span>
              </div>
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

                {isAnthropicOAuthProviderId(selectedProvider.id) && (
                  <div className="flex items-center justify-between gap-3 py-1.5">
                    <div>
                      <div className="typography-ui-label text-foreground">
                        {claudeCliStatusLoading
                          ? t('settings.providers.page.auth.checkingClaudeCliTitle')
                          : claudeCliStatus?.installed
                            ? t('settings.providers.page.auth.claudeLoginTitle')
                            : t('settings.providers.page.auth.claudeCliMissingTitle')}
                      </div>
                      <div className="typography-meta text-muted-foreground">
                        {claudeCliStatusLoading
                          ? t('settings.providers.page.auth.checkingClaudeCliDescription')
                          : claudeCliStatus?.installed
                            ? t('settings.providers.page.auth.claudeLoginDescription')
                            : t('settings.providers.page.auth.claudeCliMissingDescription')}
                      </div>
                    </div>
                    {claudeCliStatusLoading ? null : claudeCliStatus?.installed ? (
                      <div className="flex shrink-0 gap-1">
                        <Button
                          variant="outline"
                          size="xs"
                          className="!font-normal"
                          onClick={handleLaunchClaudeLogin}
                          disabled={authBusyKey === 'claude-login'}
                        >
                          {authBusyKey === 'claude-login' ? t('settings.providers.page.actions.openingTerminal') : t('settings.providers.page.actions.authenticate')}
                        </Button>
                        <Button
                          variant="outline"
                          size="xs"
                          className="!font-normal"
                          onClick={handleCheckClaudeOAuth}
                          disabled={authBusyKey === 'claude-check-oauth'}
                        >
                          {authBusyKey === 'claude-check-oauth' ? t('settings.providers.page.actions.checkingOAuth') : t('settings.providers.page.actions.checkOAuth')}
                        </Button>
                      </div>
                    ) : (
                      <div className="flex shrink-0 gap-1">
                        <Button
                          variant="outline"
                          size="xs"
                          className="!font-normal"
                          onClick={handleInstallClaudeCli}
                          disabled={authBusyKey === 'claude-install'}
                        >
                          {authBusyKey === 'claude-install' ? t('settings.providers.page.actions.openingTerminal') : t('settings.providers.page.actions.installClaudeCli')}
                        </Button>
                        <Button variant="ghost" size="xs" className="!font-normal" onClick={refreshClaudeCliStatus}>
                          {t('settings.providers.page.actions.refresh')}
                        </Button>
                      </div>
                    )}
                  </div>
                )}

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

                {activeCursorAcpProviderId === selectedProvider.id && renderCursorUsageTracking()}

                {activeOpenCodeGoProviderId === selectedProvider.id && renderOpenCodeGoUsageTracking()}

                {visibleOAuthAuthMethods.length > 0 && (
                  <div className={cn('space-y-4', selectedProviderSupportsApiKey && 'border-t border-[var(--surface-subtle)] pt-2')}>
                    {visibleOAuthAuthMethods.map((method, index) => {
                      const methodLabel = method.label || method.name || t('settings.providers.page.auth.oauthMethodFallback', { index: String(index + 1) });
                      const codeKey = `${selectedProvider.id}:${index}`;
                      const isPending =
                        pendingOAuth?.providerId === selectedProvider.id && pendingOAuth?.methodIndex === index;

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
                              disabled={authBusyKey === `oauth:${selectedProvider.id}:${index}`}
                            >
                              {t('settings.providers.page.actions.connect')}
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

                          {isPending && (
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

        {/* Connection Details */}
        <div className="mb-8">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">{t('settings.providers.page.connectionDetails.title')}</h3>
          </div>

          <section className="px-2 pb-2 pt-0">
            <div className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
              <div className="flex min-w-0 flex-col">
                {selectedSources && (selectedSources.auth.exists || selectedSources.user.exists || selectedSources.custom?.exists) ? (
                  <span className="typography-meta text-muted-foreground">
                    {t('settings.providers.page.connectionDetails.configuredIn')}{' '}
                    {[
                      selectedSources.auth.exists ? t('settings.providers.page.connectionDetails.source.authCredentials') : null,
                      selectedSources.user.exists ? t('settings.providers.page.connectionDetails.source.userConfig') : null,
                      selectedSources.custom?.exists ? t('settings.providers.page.connectionDetails.source.customConfig') : null,
                    ].filter(Boolean).join(', ')}
                  </span>
                ) : (
                  <span className="typography-meta text-muted-foreground">{t('settings.providers.page.connectionDetails.noActiveSource')}</span>
                )}
              </div>

              <Button
                variant="ghost"
                size="xs"
                className="!font-normal text-[var(--status-error)] hover:text-[var(--status-error)]"
                onClick={() => handleDisconnectProvider(selectedProvider.id)}
                disabled={authBusyKey === `disconnect:${selectedProvider.id}`}
              >
                {authBusyKey === `disconnect:${selectedProvider.id}` ? t('settings.providers.page.actions.disconnecting') : t('settings.providers.page.actions.disconnect')}
              </Button>
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
