import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { quotaRefreshCoordinator } from '@/stores/useQuotaStore';

export type ManagedQuotaProviderId = 'opencode-go' | 'ollama-cloud' | 'cursor-acp';

type CredentialStatus = {
  configured: boolean;
  workspaceId?: string;
  credentialKind?: 'dashboard' | 'oauth' | 'cookie';
  hasRefreshToken?: boolean;
  effectiveSource?: 'environment' | 'token-file' | 'managed' | 'legacy' | null;
  secretMasked?: string;
};

const parseResponseError = (payload: unknown, fallback: string) => {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const error = (payload as Record<string, unknown>).error;
    if (typeof error === 'string' && error.trim()) return error;
  }
  return fallback;
};

export const ManagedQuotaCredentials = React.memo(function ManagedQuotaCredentials({
  providerId,
}: {
  providerId: ManagedQuotaProviderId;
}) {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<CredentialStatus>({ configured: false });
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState<'save' | 'delete' | 'validate' | 'import' | null>(null);
  const [workspaceId, setWorkspaceId] = React.useState('');
  const [authCookie, setAuthCookie] = React.useState('');
  const [cookie, setCookie] = React.useState('');
  const [cursorMode, setCursorMode] = React.useState<'dashboard' | 'oauth'>('dashboard');
  const [sessionToken, setSessionToken] = React.useState('');
  const [accessToken, setAccessToken] = React.useState('');
  const [refreshToken, setRefreshToken] = React.useState('');

  const title = providerId === 'cursor-acp'
    ? t('settings.providers.page.auth.cursorUsageTitle')
    : providerId === 'opencode-go'
      ? t('settings.providers.page.auth.openCodeGoUsageTitle')
      : t('settings.providers.page.auth.ollamaCloudUsageTitle');
  const description = providerId === 'cursor-acp'
    ? cursorMode === 'dashboard'
      ? t('settings.providers.page.auth.cursorUsageDescription')
      : t('settings.providers.page.auth.cursorOAuthDescription')
    : providerId === 'opencode-go'
      ? t('settings.providers.page.auth.openCodeGoUsageDescription')
      : t('settings.providers.page.auth.ollamaCloudUsageDescription');

  const clearSecrets = React.useCallback(() => {
    setAuthCookie('');
    setCookie('');
    setSessionToken('');
    setAccessToken('');
    setRefreshToken('');
  }, []);

  const loadStatus = React.useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/quota/credentials/${encodeURIComponent(providerId)}`, {
        headers: { Accept: 'application/json' },
        signal,
      });
      const payload = await response.json().catch(() => null) as CredentialStatus | null;
      if (!response.ok || !payload) {
        throw new Error(parseResponseError(payload, t('settings.providers.page.toast.managedQuotaStatusFailed')));
      }
      setStatus(payload);
      setWorkspaceId(typeof payload.workspaceId === 'string' ? payload.workspaceId : '');
      if (payload.credentialKind === 'oauth' || payload.credentialKind === 'dashboard') {
        setCursorMode(payload.credentialKind);
      }
    } catch (error) {
      if (signal?.aborted) return;
      console.error('Failed to load managed quota credential status:', error);
      setStatus({ configured: false });
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [providerId, t]);

  React.useEffect(() => {
    const controller = new AbortController();
    clearSecrets();
    void loadStatus(controller.signal);
    return () => controller.abort();
  }, [clearSecrets, loadStatus]);

  const buildCredential = () => {
    if (providerId === 'opencode-go') {
      return { workspaceId: workspaceId.trim(), authCookie: authCookie.trim() };
    }
    if (providerId === 'ollama-cloud') return { cookie: cookie.trim() };
    if (cursorMode === 'dashboard') return { sessionToken: sessionToken.trim() };
    return {
      ...(accessToken.trim() ? { accessToken: accessToken.trim() } : {}),
      ...(refreshToken.trim() ? { refreshToken: refreshToken.trim() } : {}),
    };
  };

  const mutate = async (action: 'save' | 'delete' | 'validate' | 'import') => {
    setBusy(action);
    try {
      const suffix = action === 'validate' || action === 'import' ? `/${action}` : '';
      const response = await fetch(`/api/quota/credentials/${encodeURIComponent(providerId)}${suffix}`, {
        method: action === 'save' ? 'PUT' : action === 'delete' ? 'DELETE' : 'POST',
        headers: {
          Accept: 'application/json',
          ...(action === 'save' ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(action === 'save' ? { body: JSON.stringify(buildCredential()) } : {}),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(parseResponseError(payload, t('settings.providers.page.toast.managedQuotaMutationFailed')));
      }

      if (action === 'validate') {
        await quotaRefreshCoordinator.refreshNow({ forceRefresh: true });
        toast.success(t('settings.providers.page.toast.managedQuotaValidated'));
        return;
      }

      clearSecrets();
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const nextStatus = payload as CredentialStatus;
        setStatus(nextStatus);
        setWorkspaceId(typeof nextStatus.workspaceId === 'string' ? nextStatus.workspaceId : '');
        if (nextStatus.credentialKind === 'oauth' || nextStatus.credentialKind === 'dashboard') {
          setCursorMode(nextStatus.credentialKind);
        }
      } else {
        await loadStatus();
      }
      await quotaRefreshCoordinator.refreshNow({ forceRefresh: true, rediscover: true });
      toast.success(action === 'delete'
        ? t('settings.providers.page.toast.managedQuotaCleared')
        : action === 'import'
          ? t('settings.providers.page.toast.cursorUsageImported')
          : t('settings.providers.page.toast.managedQuotaSaved'));
    } catch (error) {
      console.error('Failed to update managed quota credential:', error);
      toast.error(error instanceof Error
        ? error.message
        : t('settings.providers.page.toast.managedQuotaMutationFailed'));
    } finally {
      setBusy(null);
    }
  };

  const statusLabel = loading
    ? t('settings.providers.page.auth.managedQuotaChecking')
    : status.configured
      ? t('settings.providers.page.auth.managedQuotaConfigured')
      : t('settings.providers.page.auth.managedQuotaNotConfigured');
  const hasFallback = !status.configured && Boolean(status.effectiveSource);

  return (
    <div className="space-y-2 border-t border-[var(--surface-subtle)] pt-3" data-managed-quota-provider={providerId}>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="typography-ui-label text-foreground">{title}</div>
          <div className="typography-meta whitespace-pre-line text-muted-foreground">{description}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className={cn(
            'typography-micro',
            status.configured ? 'text-[var(--status-success)]' : 'text-muted-foreground',
          )}>
            {statusLabel}
          </div>
          {status.effectiveSource ? (
            <div className="typography-micro text-muted-foreground">
              {t('settings.providers.page.auth.managedQuotaEffectiveSource', { source: status.effectiveSource })}
            </div>
          ) : null}
        </div>
      </div>

      {providerId === 'cursor-acp' ? (
        <div className="flex gap-1" role="group" aria-label={t('settings.providers.page.auth.cursorCredentialMode')}>
          <Button
            type="button"
            size="xs"
            variant={cursorMode === 'dashboard' ? 'default' : 'outline'}
            aria-pressed={cursorMode === 'dashboard'}
            onClick={() => setCursorMode('dashboard')}
          >
            {t('settings.providers.page.auth.cursorDashboardMode')}
          </Button>
          <Button
            type="button"
            size="xs"
            variant={cursorMode === 'oauth' ? 'default' : 'outline'}
            aria-pressed={cursorMode === 'oauth'}
            onClick={() => setCursorMode('oauth')}
          >
            {t('settings.providers.page.auth.cursorOAuthMode')}
          </Button>
        </div>
      ) : null}

      {providerId === 'opencode-go' ? (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,0.45fr)_minmax(0,0.55fr)]">
          <Input
            id="opencode-go-usage-workspace-id"
            value={workspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
            placeholder={t('settings.providers.page.auth.openCodeGoWorkspacePlaceholder')}
            className="font-mono text-xs"
            autoComplete="off"
            maxLength={16_384}
          />
          <Input
            id="opencode-go-usage-auth-cookie"
            type="password"
            value={authCookie}
            onChange={(event) => setAuthCookie(event.target.value)}
            placeholder={t('settings.providers.page.auth.openCodeGoAuthCookiePlaceholder')}
            className="font-mono text-xs"
            autoComplete="off"
            maxLength={16_384}
          />
        </div>
      ) : providerId === 'ollama-cloud' ? (
        <Input
          id="ollama-cloud-cookie"
          type="password"
          value={cookie}
          onChange={(event) => setCookie(event.target.value)}
          placeholder={t('settings.providers.page.auth.ollamaCloudCookiePlaceholder')}
          className="font-mono text-xs"
          autoComplete="off"
          maxLength={16_384}
        />
      ) : cursorMode === 'dashboard' ? (
        <Input
          id="cursor-usage-session-token"
          type="password"
          value={sessionToken}
          onChange={(event) => setSessionToken(event.target.value)}
          placeholder={t('settings.providers.page.auth.cursorUsageTokenPlaceholder')}
          className="font-mono text-xs"
          autoComplete="off"
          maxLength={16_384}
        />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            id="cursor-oauth-access-token"
            type="password"
            value={accessToken}
            onChange={(event) => setAccessToken(event.target.value)}
            placeholder={t('settings.providers.page.auth.cursorAccessTokenPlaceholder')}
            className="font-mono text-xs"
            autoComplete="off"
            maxLength={16_384}
          />
          <Input
            id="cursor-oauth-refresh-token"
            type="password"
            value={refreshToken}
            onChange={(event) => setRefreshToken(event.target.value)}
            placeholder={t('settings.providers.page.auth.cursorRefreshTokenPlaceholder')}
            className="font-mono text-xs"
            autoComplete="off"
            maxLength={16_384}
          />
        </div>
      )}

      {hasFallback ? (
        <div className="typography-meta text-muted-foreground">
          {t('settings.providers.page.auth.managedQuotaFallbackPreserved')}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1">
        <Button size="xs" className="!font-normal" onClick={() => void mutate('save')} disabled={busy !== null}>
          {busy === 'save' ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.save')}
        </Button>
        <Button
          variant="outline"
          size="xs"
          className="!font-normal"
          onClick={() => void mutate('delete')}
          disabled={busy !== null || !status.configured}
        >
          {busy === 'delete' ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.clear')}
        </Button>
        <Button
          variant="outline"
          size="xs"
          className="!font-normal"
          onClick={() => void mutate('validate')}
          disabled={busy !== null || !status.configured}
        >
          {busy === 'validate'
            ? t('settings.providers.page.actions.refreshing')
            : t('settings.providers.page.actions.refreshUsage')}
        </Button>
        {providerId === 'cursor-acp' ? (
          <Button
            variant="outline"
            size="xs"
            className="!font-normal"
            onClick={() => void mutate('import')}
            disabled={busy !== null}
          >
            {busy === 'import'
              ? t('settings.providers.page.actions.importing')
              : t('settings.providers.page.actions.importFromCursor')}
          </Button>
        ) : null}
      </div>
    </div>
  );
});
