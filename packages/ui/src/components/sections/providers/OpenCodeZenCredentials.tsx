import React from 'react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { cn } from '@/lib/utils';
import { useQuotaStore } from '@/stores/useQuotaStore';

import {
  type CredentialStatus,
  parseResponseError,
  refreshQuotaAfterCredentialChange,
} from './managedQuotaCredentialSupport';

const CREDENTIAL_URL = '/api/quota/credentials/opencode';

type DeviceFlow = {
  flowId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

type PollResult =
  | { status: 'pending' | 'denied' | 'expired' }
  | { status: 'approved'; credential: CredentialStatus };

const isDeviceFlow = (value: unknown): value is DeviceFlow => {
  if (!value || typeof value !== 'object') return false;
  const flow = value as Record<string, unknown>;
  return typeof flow.flowId === 'string'
    && typeof flow.userCode === 'string'
    && typeof flow.verificationUri === 'string'
    && typeof flow.verificationUriComplete === 'string'
    && typeof flow.interval === 'number';
};

const isPollResult = (value: unknown): value is PollResult => {
  if (!value || typeof value !== 'object') return false;
  const status = (value as Record<string, unknown>).status;
  return status === 'pending' || status === 'denied' || status === 'expired' || status === 'approved';
};

const postJson = (url: string, body?: unknown) => fetch(url, {
  method: 'POST',
  headers: {
    Accept: 'application/json',
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const OpenCodeZenCredentials = function OpenCodeZenCredentials() {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<CredentialStatus>({ configured: false });
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState<'connect' | 'delete' | 'validate' | null>(null);
  const [flow, setFlow] = React.useState<DeviceFlow | null>(null);
  const [operationError, setOperationError] = React.useState<string | null>(null);
  const [operationMessage, setOperationMessage] = React.useState<string | null>(null);
  const refreshError = useQuotaStore((state) => state.providerRefreshState.opencode?.refreshError);
  const flowIdRef = React.useRef<string | null>(null);

  const loadStatus = React.useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const response = await fetch(CREDENTIAL_URL, { headers: { Accept: 'application/json' }, signal });
      const payload = await response.json().catch(() => null) as CredentialStatus | null;
      if (!response.ok || !payload) {
        throw new Error(parseResponseError(payload, t('settings.providers.page.toast.managedQuotaStatusFailed')));
      }
      setStatus(payload);
    } catch (error) {
      if (signal?.aborted) return;
      console.error('Failed to load OpenCode Zen credential status:', error);
      setStatus({ configured: false });
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [t]);

  React.useEffect(() => {
    const controller = new AbortController();
    void loadStatus(controller.signal);
    return () => controller.abort();
  }, [loadStatus]);

  const reportRefresh = React.useCallback(async (expectResult: boolean) => {
    const detail = await refreshQuotaAfterCredentialChange('opencode', {
      expectResult,
      fallbackError: t('settings.providers.page.toast.managedQuotaRefreshFailed'),
    });
    if (detail) {
      setOperationError(detail);
      toast.error(detail);
    }
  }, [t]);

  const endFlow = React.useCallback((cancelOnServer: boolean) => {
    const flowId = flowIdRef.current;
    flowIdRef.current = null;
    setFlow(null);
    if (cancelOnServer && flowId) void postJson(`${CREDENTIAL_URL}/device/cancel`, { flowId }).catch(() => undefined);
  }, []);

  // Abandoning the page abandons the sign-in; the server forgets the device code.
  React.useEffect(() => () => {
    const flowId = flowIdRef.current;
    if (flowId) void postJson(`${CREDENTIAL_URL}/device/cancel`, { flowId }).catch(() => undefined);
  }, []);

  const connect = async () => {
    setBusy('connect');
    setOperationError(null);
    setOperationMessage(null);
    try {
      const response = await postJson(`${CREDENTIAL_URL}/device/start`);
      const payload = await response.json().catch(() => null);
      if (!response.ok || !isDeviceFlow(payload)) {
        throw new Error(parseResponseError(payload, t('settings.providers.page.toast.openCodeZenStartFailed')));
      }
      flowIdRef.current = payload.flowId;
      setFlow(payload);
      void openExternalUrl(payload.verificationUriComplete);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('settings.providers.page.toast.openCodeZenStartFailed');
      setOperationError(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  };

  React.useEffect(() => {
    if (!flow) return;
    let stopped = false;
    let timer: number | null = null;
    const schedule = () => {
      if (!stopped) timer = window.setTimeout(() => void poll(), Math.max(2, flow.interval) * 1000);
    };
    const poll = async () => {
      try {
        const response = await postJson(`${CREDENTIAL_URL}/device/poll`, { flowId: flow.flowId });
        const payload = await response.json().catch(() => null);
        if (stopped) return;
        if (!response.ok || !isPollResult(payload)) {
          const message = parseResponseError(payload, t('settings.providers.page.toast.managedQuotaMutationFailed'));
          setOperationError(message);
          // Console outages are transient; a rejected approval or unknown flow is final.
          if (response.status >= 500) schedule();
          else endFlow(false);
          return;
        }
        if (payload.status === 'pending') {
          schedule();
          return;
        }
        endFlow(false);
        if (payload.status === 'approved') {
          setOperationError(null);
          setStatus(payload.credential);
          const message = t('settings.providers.page.toast.openCodeZenConnected');
          setOperationMessage(message);
          toast.success(message);
          await reportRefresh(true);
          return;
        }
        setOperationError(t(payload.status === 'denied'
          ? 'settings.providers.page.auth.openCodeZenDenied'
          : 'settings.providers.page.auth.openCodeZenExpired'));
      } catch {
        if (!stopped) schedule();
      }
    };
    schedule();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [endFlow, flow, reportRefresh, t]);

  const mutate = async (action: 'delete' | 'validate') => {
    setBusy(action);
    setOperationError(null);
    setOperationMessage(null);
    try {
      const response = await fetch(`${CREDENTIAL_URL}${action === 'validate' ? '/validate' : ''}`, {
        method: action === 'delete' ? 'DELETE' : 'POST',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(parseResponseError(payload, t('settings.providers.page.toast.managedQuotaMutationFailed')));
      }
      if (action === 'delete') {
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) setStatus(payload as CredentialStatus);
        else await loadStatus();
      }
      const message = t(action === 'delete'
        ? 'settings.providers.page.toast.managedQuotaCleared'
        : 'settings.providers.page.toast.managedQuotaValidationSucceeded');
      setOperationMessage(message);
      toast.success(message);
      await reportRefresh(action !== 'delete');
    } catch (error) {
      const message = error instanceof Error ? error.message : t('settings.providers.page.toast.managedQuotaMutationFailed');
      setOperationError(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  };

  const statusLabel = loading
    ? t('settings.providers.page.auth.managedQuotaChecking')
    : status.configured
      ? t('settings.providers.page.auth.openCodeZenConnected')
      : t('settings.providers.page.auth.openCodeZenNotConnected');
  const locked = busy !== null || flow !== null;

  return (
    <div className="space-y-2 border-t border-[var(--surface-subtle)] pt-3" data-managed-quota-provider="opencode">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="typography-ui-label text-foreground">{t('settings.providers.page.auth.openCodeZenUsageTitle')}</div>
          <div className="typography-meta text-muted-foreground">{t('settings.providers.page.auth.openCodeZenUsageDescription')}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className={cn(
            'typography-micro',
            status.configured ? 'text-[var(--status-success)]' : 'text-muted-foreground',
          )}>
            {statusLabel}
          </div>
          {status.configured && status.workspaceId ? (
            <div className="typography-micro font-mono text-muted-foreground" data-opencode-zen-workspace>
              {status.workspaceId}
            </div>
          ) : null}
        </div>
      </div>

      {!status.configured && status.reconnectRequired && !flow ? (
        <p className="typography-meta text-[var(--status-warning)]">
          {t('settings.providers.page.auth.openCodeZenReconnectRequired')}
        </p>
      ) : null}
      {operationMessage ? <p role="status" className="typography-meta text-muted-foreground">{operationMessage}</p> : null}
      {operationError || (status.configured && refreshError) ? (
        <p role="alert" className="typography-meta text-[var(--status-error)]">{operationError || refreshError}</p>
      ) : null}

      {flow ? (
        <div className="space-y-1 rounded-md border border-[var(--surface-subtle)] p-2" data-opencode-zen-device-flow>
          <div className="typography-meta text-muted-foreground">
            {t('settings.providers.page.auth.openCodeZenAwaitingApproval')}
          </div>
          <div className="typography-ui-label font-mono text-foreground">{flow.userCode}</div>
          <div className="flex flex-wrap gap-1">
            <Button
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => void openExternalUrl(flow.verificationUriComplete)}
            >
              {t('settings.providers.page.actions.open')}
            </Button>
            <Button variant="outline" size="xs" className="!font-normal" onClick={() => endFlow(true)}>
              {t('settings.common.actions.cancel')}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1">
        <Button size="xs" className="!font-normal" onClick={() => void connect()} disabled={locked}>
          {status.configured || status.reconnectRequired
            ? t('settings.providers.page.actions.reconnect')
            : t('settings.providers.page.actions.connect')}
        </Button>
        <Button
          variant="outline"
          size="xs"
          className="!font-normal"
          onClick={() => void mutate('delete')}
          disabled={locked || !(status.configured || status.reconnectRequired)}
        >
          {busy === 'delete' ? t('settings.providers.page.actions.disconnecting') : t('settings.providers.page.actions.disconnect')}
        </Button>
        <Button
          variant="outline"
          size="xs"
          className="!font-normal"
          onClick={() => void mutate('validate')}
          disabled={locked || !status.configured}
        >
          {busy === 'validate'
            ? t('settings.providers.page.actions.refreshing')
            : t('settings.providers.page.actions.refreshUsage')}
        </Button>
      </div>
    </div>
  );
};
