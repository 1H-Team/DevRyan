import React from 'react';
import { RiLockLine, RiLockUnlockLine, RiLoader4Line, RiMailLine } from '@remixicon/react';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { syncDesktopSettings, initializeAppearancePreferences } from '@/lib/persistence';
import { applyPersistedDirectoryPreferences } from '@/lib/directoryPersistence';
import { DesktopHostSwitcherInline } from '@/components/desktop/DesktopHostSwitcher';
import devRyanLoadLogoUrl from '@/assets/DevRyanLoad.svg';
import { useI18n } from '@/lib/i18n';
import {
  authenticateWithPasskey,
  cancelPasskeyCeremony,
  defaultPasskeyStatus,
  fetchPasskeyStatus,
  isPasskeyCeremonyAbort,
  type PasskeyStatus,
  registerCurrentDevicePasskey,
} from '@/lib/passkeys';
import { installApiFetchSecurity } from '@/lib/apiSecurity';
import { initializeInteractionAnalytics } from '@/lib/interactionAnalytics';
import { startAppearanceAutoSave } from '@/lib/appearanceAutoSave';
import { startModelPrefsAutoSave } from '@/lib/modelPrefsAutoSave';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import {
  hasAuthCapability,
  registerAuthSessionRetry,
  setAuthOfflineGrace,
  setAuthPrincipal,
  type AuthPrincipal,
  useAuthOfflineGrace,
} from '@/lib/authSession';
import { fullSettingsPermissions } from '@/lib/settings/permissions';
import { getDeviceStorage, setStoragePrincipal } from '@/stores/utils/safeStorage';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import {
  buildPrincipalTransitionPath,
  classifySessionResponse,
  localResetSucceeded,
  orderAgentTestIdentities,
  type AgentTestIdentity,
  type AgentTestRole,
  type SessionAuthErrorCode,
} from './sessionAuthState';

installApiFetchSecurity();

const STATUS_CHECK_ENDPOINT = '/auth/session';
const TRUST_DEVICE_STORAGE_KEY = 'openchamber.uiAuth.trustDevice';

const fetchSessionStatus = async (): Promise<Response> => {
  const response = await fetch(STATUS_CHECK_ENDPOINT, {
    method: 'GET',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
    },
  });
  return response;
};

const readStoredTrustDevice = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }
  return getDeviceStorage().getItem(TRUST_DEVICE_STORAGE_KEY) === 'true';
};

const submitPassword = async (
  email: string,
  password: string,
  trustDevice: boolean,
  invitePending: boolean,
): Promise<Response> => {
  const response = await fetch(invitePending ? '/auth/invite' : STATUS_CHECK_ENDPOINT, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-DevRyan-CSRF': '1',
    },
    body: JSON.stringify({ email, password, trustDevice }),
  });
  return response;
};

type AuthMode = 'local' | 'multi-user';

interface AuthStatusPayload {
  authenticated?: boolean;
  mode?: AuthMode;
  claimAvailable?: boolean;
  invitePending?: boolean;
  rememberAvailable?: boolean;
  offlineGrace?: boolean;
  tunnelLocked?: boolean;
  principal?: AuthPrincipal;
  retryAfter?: number;
  code?: SessionAuthErrorCode;
  requiredMigration?: string;
  localResetAvailable?: boolean;
  localSessionCleared?: boolean;
  remoteRevoked?: boolean;
  agentTestIdentities?: AgentTestIdentity[];
}

const AuthShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background text-foreground"
    style={{ fontFamily: '"Inter", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", sans-serif' }}
  >
    <div
      className="pointer-events-none absolute inset-0 opacity-55"
      style={{
        background: 'radial-gradient(120% 140% at 50% -20%, var(--surface-overlay) 0%, transparent 68%)',
      }}
    />
    <div
      className="pointer-events-none absolute inset-0"
      style={{
        backgroundColor: 'var(--surface-subtle)',
        opacity: 0.22,
      }}
    />
    <div className="relative z-10 flex w-full justify-center px-4 py-12 sm:px-6">
      {children}
    </div>
  </div>
);

const LoadingScreen: React.FC = () => (
  <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
    <img src={devRyanLoadLogoUrl} alt="" width={169} height={169} />
  </div>
);

const ErrorScreen: React.FC<ErrorScreenProps> = ({
  onRetry,
  onResetLocal,
  errorType = 'network',
  retryAfter,
  isResetting = false,
}) => {
  const { t } = useI18n();
  const isRateLimit = errorType === 'rate-limit';
  const minutes = retryAfter ? Math.ceil(retryAfter / 60) : 1;
  const content = errorType === 'identity'
    ? {
        title: t('sessionAuth.error.identityTitle'),
        description: t('sessionAuth.error.identityDescription'),
      }
    : errorType === 'schema'
      ? {
          title: t('sessionAuth.error.schemaTitle'),
          description: t('sessionAuth.error.schemaDescription'),
        }
      : errorType === 'server'
        ? {
            title: t('sessionAuth.error.serverTitle'),
            description: t('sessionAuth.error.serverDescription'),
          }
        : {
            title: t('sessionAuth.error.networkTitle'),
            description: t('sessionAuth.error.networkDescription'),
          };

  return (
    <AuthShell>
      <div className="flex flex-col items-center gap-6 text-center">
        <div className="space-y-2">
          <h1 className="typography-ui-header font-semibold text-destructive">
            {isRateLimit ? t('sessionAuth.error.rateLimitTitle') : content.title}
          </h1>
          <p className="typography-meta text-muted-foreground max-w-xs">
            {isRateLimit
              ? (minutes > 1
                ? t('sessionAuth.error.rateLimitDescriptionPlural', { minutes })
                : t('sessionAuth.error.rateLimitDescriptionSingle', { minutes }))
              : content.description}
          </p>
        </div>
        <div className="flex w-full max-w-xs flex-col gap-2">
          <Button type="button" onClick={onRetry} disabled={isResetting} className="w-full">
            {t('sessionAuth.error.retry')}
          </Button>
          {onResetLocal && (
            <Button
              type="button"
              variant="outline"
              onClick={onResetLocal}
              disabled={isResetting}
              className="w-full"
            >
              {isResetting ? t('sessionAuth.error.resettingLocal') : t('sessionAuth.error.resetLocal')}
            </Button>
          )}
        </div>
      </div>
    </AuthShell>
  );
};

interface SessionAuthGateProps {
  children: React.ReactNode;
}

type GateState =
  | 'pending'
  | 'authenticated'
  | 'locked'
  | 'network-error'
  | 'server-error'
  | 'identity-unavailable'
  | 'schema-migration-required'
  | 'rate-limited';

interface ErrorScreenProps {
  onRetry: () => void;
  onResetLocal?: () => void;
  errorType?: 'network' | 'server' | 'identity' | 'schema' | 'rate-limit';
  retryAfter?: number;
  isResetting?: boolean;
}

export const SessionAuthGate: React.FC<SessionAuthGateProps> = ({ children }) => {
  const { t } = useI18n();
  const vscodeRuntime = React.useMemo(() => isVSCodeRuntime(), []);
  const skipAuth = vscodeRuntime;
  const showHostSwitcher = React.useMemo(() => isDesktopShell() && !vscodeRuntime, [vscodeRuntime]);
  const [state, setState] = React.useState<GateState>(() => (skipAuth ? 'authenticated' : 'pending'));
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [displayName, setDisplayName] = React.useState('');
  const [authMode, setAuthMode] = React.useState<AuthMode>('local');
  const [claimAvailable, setClaimAvailable] = React.useState(false);
  const [invitePending, setInvitePending] = React.useState(false);
  const [rememberAvailable, setRememberAvailable] = React.useState(false);
  const [agentTestIdentities, setAgentTestIdentities] = React.useState<AgentTestIdentity[]>([]);
  const [activeAgentTestRole, setActiveAgentTestRole] = React.useState<AgentTestRole | null>(null);
  const [localResetAvailable, setLocalResetAvailable] = React.useState(false);
  const [isResettingLocal, setIsResettingLocal] = React.useState(false);
  const [isClaiming, setIsClaiming] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState('');
  const [retryAfter, setRetryAfter] = React.useState<number | undefined>(undefined);
  const [isTunnelLocked, setIsTunnelLocked] = React.useState(false);
  const [passkeyStatus, setPasskeyStatus] = React.useState<PasskeyStatus>(defaultPasskeyStatus);
  const [supportsPasskeys, setSupportsPasskeys] = React.useState(false);
  const [isPasskeyBusy, setIsPasskeyBusy] = React.useState(false);
  const [trustDevice, setTrustDevice] = React.useState<boolean>(() => readStoredTrustDevice());
  const offlineGrace = useAuthOfflineGrace();
  const [activePasskeyAction, setActivePasskeyAction] = React.useState<'auth' | 'register' | null>(null);
  const passwordInputRef = React.useRef<HTMLInputElement | null>(null);
  const hasResyncedRef = React.useRef(skipAuth);
  const acceptedPrincipalRef = React.useRef<AuthPrincipal | undefined>(undefined);
  const offlineGraceRef = React.useRef(false);

  React.useEffect(() => initializeInteractionAnalytics(), []);

  const acceptPrincipal = React.useCallback((principal: AuthPrincipal | undefined, isOfflineGrace = false): boolean => {
    const nextPrincipal = principal ?? {
      id: 'local-admin',
      email: null,
      displayName: 'Local Administrator',
      role: 'admin' as const,
      scope: 'local-admin' as const,
      policy: {
        settingsPages: ['*'], settingsPermissions: fullSettingsPermissions(),
        files: true, terminal: true, browser: true, createWorktrees: true, createBranches: true, manageProjects: true,
        manageUsers: true, manageGlobalSettings: true, manageGit: true, push: true, github: true,
      },
      assignments: [],
    };
    acceptedPrincipalRef.current = nextPrincipal;
    offlineGraceRef.current = isOfflineGrace;
    setAuthOfflineGrace(isOfflineGrace);
    const changed = setStoragePrincipal(nextPrincipal.id);
    setAuthPrincipal(nextPrincipal);
    if (!hasAuthCapability(nextPrincipal, 'browser')) {
      useUIStore.getState().pruneAllBrowserTabs();
    }
    useProjectsStore.getState().synchronizeManagedAssignments(nextPrincipal);
    if (changed && typeof window !== 'undefined') {
      window.history.replaceState(null, '', buildPrincipalTransitionPath(window.location.href));
      window.location.reload();
      return false;
    }
    applyPersistedDirectoryPreferences(nextPrincipal);
    return true;
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    getDeviceStorage().setItem(TRUST_DEVICE_STORAGE_KEY, trustDevice ? 'true' : 'false');
  }, [trustDevice]);

  const refreshPasskeyStatus = React.useCallback(async () => {
    if (skipAuth) {
      return defaultPasskeyStatus;
    }

    try {
      const nextStatus = await fetchPasskeyStatus();
      setPasskeyStatus(nextStatus);
      return nextStatus;
    } catch {
      setPasskeyStatus(defaultPasskeyStatus);
      return defaultPasskeyStatus;
    }
  }, [skipAuth]);

  React.useEffect(() => {
    let cancelled = false;

    if (skipAuth) {
      return;
    }

    void (async () => {
      try {
        if (!window.isSecureContext || !browserSupportsWebAuthn()) {
          if (!cancelled) {
            setSupportsPasskeys(false);
          }
          return;
        }
        if (!cancelled) {
          setSupportsPasskeys(true);
        }
      } catch {
        if (!cancelled) {
          setSupportsPasskeys(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [skipAuth]);

  const checkStatus = React.useCallback(async () => {
    if (skipAuth) {
      if (acceptPrincipal(undefined)) setState('authenticated');
      return;
    }

    setState((prev) => (prev === 'authenticated' ? prev : 'pending'));
    try {
      const [response, latestPasskeyStatus] = await Promise.all([
        fetchSessionStatus(),
        refreshPasskeyStatus(),
      ]);
      const responseText = await response.text();
      let data: AuthStatusPayload = {};
      try {
        data = JSON.parse(responseText) as AuthStatusPayload;
      } catch {
        data = {};
      }
      if (data.mode) setAuthMode(data.mode);
      setClaimAvailable(data.claimAvailable === true);
      setInvitePending(data.invitePending === true);
      setRememberAvailable(data.rememberAvailable === true);
      setAgentTestIdentities(orderAgentTestIdentities(data.agentTestIdentities));
      setLocalResetAvailable(data.localResetAvailable === true);

      const decision = classifySessionResponse(response.status, response.ok, data);
      if (decision.state === 'authenticated') {
        if (!acceptPrincipal(data.principal, data.offlineGrace === true)) return;
        setState('authenticated');
        setIsTunnelLocked(false);
        setErrorMessage('');
        setRetryAfter(undefined);
        setAgentTestIdentities([]);
        setLocalResetAvailable(false);
        return;
      }
      if (decision.state === 'locked') {
        offlineGraceRef.current = false;
        setAuthOfflineGrace(false);
        setIsTunnelLocked(data.tunnelLocked === true);
        setPasskeyStatus(data.mode === 'multi-user' ? defaultPasskeyStatus : latestPasskeyStatus);
        setState('locked');
        setRetryAfter(undefined);
        return;
      }
      if (decision.state === 'rate-limited') {
        setRetryAfter(decision.retryAfter);
        setIsTunnelLocked(false);
        setState('rate-limited');
        return;
      }
      setState(decision.state);
      offlineGraceRef.current = false;
      setAuthOfflineGrace(false);
      setIsTunnelLocked(false);
    } catch (error) {
      console.warn('Failed to check session status:', error);
      setState('network-error');
      setIsTunnelLocked(false);
      setLocalResetAvailable(false);
    }
  }, [acceptPrincipal, refreshPasskeyStatus, skipAuth]);

  React.useEffect(() => registerAuthSessionRetry(checkStatus), [checkStatus]);

  React.useEffect(() => {
    if (skipAuth || state !== 'authenticated' || !offlineGrace) return;

    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (cancelled) return;
      const delayMs = Math.min(5_000 * (2 ** attempt), 60_000);
      attempt += 1;
      timer = setTimeout(() => {
        void checkStatus().finally(() => {
          if (offlineGraceRef.current) schedule();
        });
      }, delayMs);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      attempt = 0;
      void checkStatus();
    };

    schedule();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [checkStatus, offlineGrace, skipAuth, state]);

  React.useEffect(() => {
    if (skipAuth) {
      void checkStatus();
      return;
    }
    void checkStatus();
  }, [checkStatus, skipAuth]);

  React.useEffect(() => {
    if (skipAuth || state !== 'authenticated' || acceptedPrincipalRef.current?.scope !== 'managed') {
      return;
    }

    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let refreshInFlight = false;
    let refreshQueued = false;
    let retryAttempt = 0;

    const scheduleRefresh = (delayMs = 75) => {
      if (cancelled || refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void refreshPrincipal();
      }, delayMs);
    };

    const refreshPrincipal = async () => {
      if (cancelled) return;
      if (refreshInFlight) {
        refreshQueued = true;
        return;
      }
      refreshInFlight = true;
      try {
        const response = await fetchSessionStatus();
        const data = await response.json().catch(() => null) as AuthStatusPayload | null;
        if (cancelled) return;
        if (!response.ok && response.status !== 401 && response.status !== 403) {
          throw new Error(`Managed project metadata refresh failed (${response.status})`);
        }
        const nextPrincipal = response.ok && data?.authenticated === true ? data.principal : null;
        const currentPrincipal = acceptedPrincipalRef.current;
        if (!nextPrincipal || !currentPrincipal || nextPrincipal.id !== currentPrincipal.id) {
          void checkStatus();
          return;
        }
        acceptedPrincipalRef.current = nextPrincipal;
        const nextOfflineGrace = data?.offlineGrace === true;
        offlineGraceRef.current = nextOfflineGrace;
        setAuthOfflineGrace(nextOfflineGrace);
        setAuthPrincipal(nextPrincipal);
        useProjectsStore.getState().synchronizeManagedAssignments(nextPrincipal);
        retryAttempt = 0;
      } catch (error) {
        retryAttempt += 1;
        if (retryAttempt <= 3) {
          scheduleRefresh(500 * retryAttempt);
        } else {
          console.warn('Failed to refresh managed project metadata:', error);
        }
      } finally {
        refreshInFlight = false;
        if (refreshQueued) {
          refreshQueued = false;
          scheduleRefresh(0);
        }
      }
    };

    const unsubscribe = subscribeOpenchamberEvents((event) => {
      if (event.type === 'stream-ready') {
        scheduleRefresh();
        return;
      }
      if (event.type !== 'project-metadata-changed') return;
      const principal = acceptedPrincipalRef.current;
      if (!principal?.assignments.some((assignment) => assignment.projectId === event.projectId)) return;
      scheduleRefresh();
    });

    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      unsubscribe();
    };
  }, [checkStatus, skipAuth, state]);

  React.useEffect(() => {
    if (!skipAuth && state === 'locked') {
      hasResyncedRef.current = false;
    }
  }, [skipAuth, state]);

  React.useEffect(() => {
    if (state === 'locked' && passwordInputRef.current) {
      passwordInputRef.current.focus();
      passwordInputRef.current.select();
    }
  }, [state]);

  React.useEffect(() => {
    if (skipAuth) {
      return;
    }
    if (state === 'authenticated' && !hasResyncedRef.current) {
      hasResyncedRef.current = true;
      void (async () => {
        try {
          await syncDesktopSettings();
          await initializeAppearancePreferences();
          applyPersistedDirectoryPreferences(acceptedPrincipalRef.current);
        } finally {
          // Autosave baselines must be captured after hydration, otherwise the
          // hydration itself is mistaken for user edits and written back.
          startAppearanceAutoSave();
          startModelPrefsAutoSave();
        }
      })();
    }
  }, [skipAuth, state]);

  const registerPasskeyForCurrentSession = React.useCallback(async () => {
    setActivePasskeyAction('register');
    setIsPasskeyBusy(true);
    try {
      await registerCurrentDevicePasskey();
    } finally {
      setActivePasskeyAction(null);
      setIsPasskeyBusy(false);
    }
    await refreshPasskeyStatus();
  }, [refreshPasskeyStatus]);

  const cancelActivePasskey = React.useCallback(() => {
    cancelPasskeyCeremony();
    setActivePasskeyAction(null);
    setIsPasskeyBusy(false);
  }, []);

  const handlePasswordUnlock = React.useCallback(async (enrollPasskey: boolean) => {
    if (isTunnelLocked) {
      return;
    }
    if (!password || (authMode === 'multi-user' && !email.trim()) || isSubmitting) {
      return;
    }

    if (isPasskeyBusy) {
      cancelActivePasskey();
    }

    setIsSubmitting(true);
    setErrorMessage('');

    try {
      const response = await submitPassword(email.trim(), password, trustDevice, invitePending);
      const data = await response.json().catch(() => ({} as AuthStatusPayload)) as AuthStatusPayload;
      if (response.ok) {
        if (!acceptPrincipal(data.principal)) return;
        setPassword('');
        setIsTunnelLocked(false);
        if (enrollPasskey && supportsPasskeys && authMode === 'local') {
          try {
            await registerPasskeyForCurrentSession();
            toast.success(t('sessionAuth.toast.passkeyAdded'));
            setState('authenticated');
            return;
          } catch (error) {
            if (isPasskeyCeremonyAbort(error)) {
              toast.message(t('sessionAuth.toast.passkeySetupCanceled'));
            } else {
              const message = error instanceof Error ? error.message : t('sessionAuth.error.passkeySetupFailed');
              toast.error(message);
            }
            setState('authenticated');
            return;
          }
        }
        setState('authenticated');
        return;
      }

      if (response.status === 401) {
        setErrorMessage(t('sessionAuth.error.incorrectPassword'));
        setIsTunnelLocked(false);
        setState('locked');
        return;
      }

      if (response.status === 429) {
        setRetryAfter(data.retryAfter);
        setIsTunnelLocked(false);
        setState('rate-limited');
        return;
      }

      const decision = classifySessionResponse(response.status, response.ok, data);
      if (decision.state === 'identity-unavailable' || decision.state === 'schema-migration-required') {
        setLocalResetAvailable(data.localResetAvailable === true);
        setState(decision.state);
        return;
      }

      setErrorMessage(t('sessionAuth.error.unexpectedResponse'));
      setIsTunnelLocked(false);
      setState('server-error');
    } catch (error) {
      console.warn('Failed to submit UI password:', error);
      setErrorMessage(t('sessionAuth.error.networkRetry'));
      setIsTunnelLocked(false);
      setState('network-error');
    } finally {
      setIsSubmitting(false);
    }
  }, [acceptPrincipal, authMode, cancelActivePasskey, email, invitePending, isPasskeyBusy, isSubmitting, isTunnelLocked, password, registerPasskeyForCurrentSession, supportsPasskeys, t, trustDevice]);

  const handleAgentTestLogin = React.useCallback(async (role: AgentTestRole) => {
    if (activeAgentTestRole || isSubmitting) return;
    setActiveAgentTestRole(role);
    setIsSubmitting(true);
    setErrorMessage('');
    try {
      const response = await fetch('/auth/agent-test-session', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-DevRyan-CSRF': '1',
        },
        body: JSON.stringify({ role }),
      });
      const data = await response.json().catch(() => ({} as AuthStatusPayload)) as AuthStatusPayload;
      if (response.ok) {
        if (!acceptPrincipal(data.principal)) return;
        setAgentTestIdentities([]);
        setState('authenticated');
        return;
      }
      const decision = classifySessionResponse(response.status, response.ok, data);
      if (decision.state === 'identity-unavailable' || decision.state === 'schema-migration-required') {
        setLocalResetAvailable(data.localResetAvailable === true);
        setState(decision.state);
        return;
      }
      setErrorMessage(t('sessionAuth.error.agentLoginFailed'));
    } catch (error) {
      console.warn('Failed to start an agent-test session:', error);
      setState('network-error');
    } finally {
      setActiveAgentTestRole(null);
      setIsSubmitting(false);
    }
  }, [acceptPrincipal, activeAgentTestRole, isSubmitting, t]);

  const handleResetLocalSession = React.useCallback(async () => {
    if (isResettingLocal) return;
    setIsResettingLocal(true);
    try {
      const response = await fetch(STATUS_CHECK_ENDPOINT, {
        method: 'DELETE',
        credentials: 'include',
        headers: { Accept: 'application/json', 'X-DevRyan-CSRF': '1' },
      });
      const data = await response.json().catch(() => ({} as AuthStatusPayload)) as AuthStatusPayload;
      if (!localResetSucceeded(response.ok, data)) {
        toast.error(t('sessionAuth.error.resetLocalFailed'));
        return;
      }
      setStoragePrincipal('anonymous');
      setLocalResetAvailable(false);
      if (data.remoteRevoked === false) {
        toast.warning(t('sessionAuth.error.resetLocalPartial'));
      }
      await checkStatus();
    } catch (error) {
      console.warn('Failed to reset the local session:', error);
      toast.error(t('sessionAuth.error.resetLocalFailed'));
    } finally {
      setIsResettingLocal(false);
    }
  }, [checkStatus, isResettingLocal, t]);

  const handleInitialClaim = React.useCallback(async () => {
    if (!claimAvailable || !email.trim() || !displayName.trim() || !password || isSubmitting) return;
    setIsSubmitting(true);
    setErrorMessage('');
    try {
      const response = await fetch('/auth/claim', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-DevRyan-CSRF': '1' },
        body: JSON.stringify({ email: email.trim(), displayName: displayName.trim(), password }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        setErrorMessage(payload.error || 'Failed to create the administrator account.');
        return;
      }
      setIsClaiming(false);
      setClaimAvailable(false);
      setPassword('');
      toast.success('Administrator account created. Sign in to continue.');
    } catch {
      setErrorMessage('Unable to reach the identity service.');
    } finally {
      setIsSubmitting(false);
    }
  }, [claimAvailable, displayName, email, isSubmitting, password]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isClaiming) {
      await handleInitialClaim();
      return;
    }
    await handlePasswordUnlock(false);
  };

  const handlePasskeyUnlock = React.useCallback(async () => {
    if (isSubmitting || !supportsPasskeys) {
      return;
    }

    if (isPasskeyBusy) {
      cancelActivePasskey();
      return;
    }

    setIsPasskeyBusy(true);
    setActivePasskeyAction('auth');
    setErrorMessage('');

    try {
      await authenticateWithPasskey(trustDevice);

      setPassword('');
      setState('authenticated');
    } catch (error) {
      if (isPasskeyCeremonyAbort(error)) {
        setErrorMessage('');
      } else {
        const message = error instanceof Error ? error.message : t('sessionAuth.error.passkeySignInCanceled');
        setErrorMessage(message);
      }
    } finally {
      setActivePasskeyAction(null);
      setIsPasskeyBusy(false);
    }
  }, [cancelActivePasskey, isPasskeyBusy, isSubmitting, supportsPasskeys, t, trustDevice]);

  const handlePasskeySetupOnly = React.useCallback(async () => {
    if (isSubmitting || isTunnelLocked || !supportsPasskeys) {
      return;
    }

    if (isPasskeyBusy) {
      cancelActivePasskey();
      return;
    }

    if (state !== 'authenticated') {
      if (!password) {
        setErrorMessage(t('sessionAuth.error.enterPasswordForPasskey'));
        return;
      }
      await handlePasswordUnlock(true);
      return;
    }

    setErrorMessage('');
    try {
      await registerPasskeyForCurrentSession();
      toast.success(t('sessionAuth.toast.passkeyAdded'));
    } catch (error) {
      if (isPasskeyCeremonyAbort(error)) {
        toast.message(t('sessionAuth.toast.passkeySetupCanceled'));
        return;
      }
      const message = error instanceof Error ? error.message : t('sessionAuth.error.passkeySetupFailed');
      toast.error(message);
    }
  }, [cancelActivePasskey, handlePasswordUnlock, isPasskeyBusy, isSubmitting, isTunnelLocked, password, registerPasskeyForCurrentSession, state, supportsPasskeys, t]);

  const canOfferPasskeySetup = authMode === 'local' && supportsPasskeys && passkeyStatus.enabled;
  const canUsePasskey = canOfferPasskeySetup && passkeyStatus.hasPasskeys;

  if (state === 'pending') {
    return <LoadingScreen />;
  }

  if (state === 'network-error') {
    return <ErrorScreen onRetry={() => void checkStatus()} errorType="network" />;
  }

  if (state === 'server-error') {
    return <ErrorScreen onRetry={() => void checkStatus()} errorType="server" />;
  }

  if (state === 'identity-unavailable' || state === 'schema-migration-required') {
    return (
      <ErrorScreen
        onRetry={() => void checkStatus()}
        onResetLocal={localResetAvailable ? () => void handleResetLocalSession() : undefined}
        errorType={state === 'identity-unavailable' ? 'identity' : 'schema'}
        isResetting={isResettingLocal}
      />
    );
  }

  if (state === 'rate-limited') {
    return <ErrorScreen onRetry={() => void checkStatus()} errorType="rate-limit" retryAfter={retryAfter} />;
  }

  if (state === 'locked') {
    return (
      <AuthShell>
        <div className="flex flex-col items-center gap-6 w-full max-w-xs">
          <div className="flex flex-col items-center gap-1 text-center">
            <h1 className="text-xl font-semibold text-foreground">
              {isTunnelLocked
                ? t('sessionAuth.locked.tunnelTitle')
                : authMode === 'multi-user'
                  ? (isClaiming ? 'Create administrator' : invitePending ? 'Accept your invitation' : 'Sign in to DevRyan')
                  : t('sessionAuth.locked.unlockTitle')}
            </h1>
            <p className="typography-meta text-muted-foreground">
              {isTunnelLocked
                ? t('sessionAuth.locked.tunnelDescription')
                : authMode === 'multi-user'
                  ? (isClaiming
                    ? 'This first account can only be created from the local host.'
                    : invitePending
                      ? 'Sign in with the exact account this link was issued for.'
                      : 'Use the account assigned by your administrator.')
                  : t('sessionAuth.locked.passwordDescription')}
            </p>
          </div>

          {!isTunnelLocked && (
            <div className="w-full space-y-4">
              {authMode === 'multi-user' && agentTestIdentities.length > 0 && !isClaiming && !invitePending && (
                <section className="space-y-2" aria-labelledby="devryan-agent-verification-title">
                  <div className="space-y-1 text-center">
                    <h2 id="devryan-agent-verification-title" className="typography-ui-label font-medium text-foreground">
                      {t('sessionAuth.agentVerification.title')}
                    </h2>
                    <p className="typography-micro text-muted-foreground">
                      {t('sessionAuth.agentVerification.description')}
                    </p>
                  </div>
                  <div className="space-y-2">
                    {agentTestIdentities.map((identity, index) => (
                      <Button
                        key={identity.role}
                        type="button"
                        variant={index === 0 ? 'default' : 'outline'}
                        className="w-full"
                        onClick={() => void handleAgentTestLogin(identity.role)}
                        disabled={activeAgentTestRole !== null || isSubmitting}
                      >
                        {activeAgentTestRole === identity.role && <RiLoader4Line className="h-4 w-4 animate-spin" />}
                        {identity.label}
                      </Button>
                    ))}
                  </div>
                </section>
              )}

              {authMode === 'multi-user' && agentTestIdentities.length > 0 && !isClaiming && !invitePending && (
                <div className="flex items-center gap-3" aria-hidden="true">
                  <span className="h-px flex-1 bg-border" />
                  <span className="typography-micro text-muted-foreground">
                    {t('sessionAuth.agentVerification.humanSignIn')}
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}

              <form onSubmit={handleSubmit} className="w-full space-y-2">
              {canUsePasskey && (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => void handlePasskeyUnlock()}
                  disabled={isSubmitting || (isPasskeyBusy && activePasskeyAction !== 'auth')}
                >
                  {isPasskeyBusy ? (
                    <RiLoader4Line className="h-4 w-4 animate-spin" />
                  ) : (
                    <RiLockUnlockLine className="h-4 w-4" />
                  )}
                  <span>{isPasskeyBusy && activePasskeyAction === 'auth'
                    ? t('sessionAuth.actions.cancelPasskey')
                    : t('sessionAuth.actions.usePasskey')}</span>
                </Button>
              )}
              {authMode === 'multi-user' && (
                <div className="space-y-2">
                  <div className="relative">
                    <RiMailLine className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/60" />
                    <Input
                      id="devryan-user-email"
                      type="email"
                      autoComplete="username"
                      placeholder="Email address"
                      value={email}
                      onChange={(event) => {
                        setEmail(event.target.value);
                        if (errorMessage) setErrorMessage('');
                      }}
                      className="pl-10"
                      disabled={isSubmitting}
                      required
                    />
                  </div>
                  {isClaiming && (
                    <Input
                      id="devryan-user-display-name"
                      type="text"
                      autoComplete="name"
                      placeholder="Display name"
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      disabled={isSubmitting}
                      required
                    />
                  )}
                </div>
              )}
              <div className="space-y-2">
                <div className="relative">
                  <RiLockLine className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/60" />
                  <Input
                    id="openchamber-ui-password"
                    ref={passwordInputRef}
                    type="password"
                    autoComplete={isClaiming ? 'new-password' : 'current-password'}
                    placeholder={t('sessionAuth.password.placeholder')}
                    minLength={isClaiming ? 4 : undefined}
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      if (errorMessage) {
                        setErrorMessage('');
                      }
                    }}
                    className="pl-10"
                    aria-invalid={Boolean(errorMessage) || undefined}
                    aria-describedby={errorMessage ? 'oc-ui-auth-error' : undefined}
                    disabled={isSubmitting}
                  />
                </div>
                <Button
                  type="submit"
                  className="w-full"
                  disabled={!password || (isClaiming && password.length < 4) || (authMode === 'multi-user' && (!email.trim() || (isClaiming && !displayName.trim()))) || isSubmitting}
                >
                  {isSubmitting && <RiLoader4Line className="h-4 w-4 animate-spin" />}
                  <span>{isSubmitting ? t('sessionAuth.actions.connecting') : t('sessionAuth.actions.connect')}</span>
                </Button>
              </div>
              {authMode === 'multi-user' && rememberAvailable && !invitePending && (
                <label className="flex items-center justify-center gap-2 pt-1 text-center typography-micro text-muted-foreground">
                  <Checkbox
                    checked={trustDevice}
                    onChange={setTrustDevice}
                    disabled={isSubmitting}
                    ariaLabel="Remember this loopback administrator"
                    className="size-4"
                    iconClassName="size-4"
                  />
                  <span>Remember Loopback Administrator for 30 Days</span>
                </label>
              )}
              {authMode !== 'multi-user' && (canOfferPasskeySetup ? (
                <div className="flex items-center justify-between pt-1">
                  <label className="flex items-center gap-2 text-center typography-micro text-muted-foreground">
                    <Checkbox
                      checked={trustDevice}
                      onChange={setTrustDevice}
                      disabled={isSubmitting}
                      ariaLabel={t('sessionAuth.actions.trustDeviceAria')}
                      className="size-4"
                      iconClassName="size-4"
                    />
                    <span>{t('sessionAuth.actions.trustDevice')}</span>
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => void handlePasskeySetupOnly()}
                    disabled={isSubmitting}
                  >
                    {isPasskeyBusy && activePasskeyAction === 'register'
                      ? t('sessionAuth.actions.cancelPasskeySetup')
                      : t('sessionAuth.actions.addPasskey')}
                  </Button>
                </div>
              ) : (
                <label className="flex items-center justify-center gap-2 pt-1 text-center typography-micro text-muted-foreground">
                  <Checkbox
                    checked={trustDevice}
                    onChange={setTrustDevice}
                    disabled={isSubmitting}
                    ariaLabel={t('sessionAuth.actions.trustDeviceAria')}
                    className="size-4"
                    iconClassName="size-4"
                  />
                  <span>{t('sessionAuth.actions.trustDevice')}</span>
                </label>
              ))}
              {errorMessage && (
                <p id="oc-ui-auth-error" className="typography-meta text-destructive">
                  {errorMessage}
                </p>
              )}
              {authMode === 'multi-user' && claimAvailable && !invitePending && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full text-muted-foreground"
                  onClick={() => {
                    setIsClaiming((value) => !value);
                    setErrorMessage('');
                  }}
                  disabled={isSubmitting}
                >
                  {isClaiming ? 'Back to Sign In' : 'Create the First Administrator'}
                </Button>
              )}
              </form>
            </div>
          )}

          {showHostSwitcher && (
            <div className="w-full">
              <DesktopHostSwitcherInline />
              <p className="mt-1 text-center typography-micro text-muted-foreground">
                {t('sessionAuth.locked.hostSwitcherHint')}
              </p>
            </div>
          )}
        </div>
      </AuthShell>
    );
  }

  return <>{children}</>;
};
