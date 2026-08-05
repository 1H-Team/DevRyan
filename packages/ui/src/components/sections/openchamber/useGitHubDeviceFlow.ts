import * as React from 'react';

import { toast } from '@/components/ui';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { GitHubDeviceFlowComplete, GitHubDeviceFlowStart } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';

interface UseGitHubDeviceFlowOptions {
  onConnected?: () => Promise<void> | void;
}

export const useGitHubDeviceFlow = ({ onConnected }: UseGitHubDeviceFlowOptions = {}) => {
  const { t } = useI18n();
  const runtimeGitHub = getRegisteredRuntimeAPIs()?.github;
  const refreshStatus = useGitHubAuthStore((state) => state.refreshStatus);
  const [flow, setFlow] = React.useState<GitHubDeviceFlowStart | null>(null);
  const [pollIntervalMs, setPollIntervalMs] = React.useState<number | null>(null);
  const [isStarting, setIsStarting] = React.useState(false);
  const pollTimerRef = React.useRef<number | null>(null);

  const stopPolling = React.useCallback(() => {
    if (pollTimerRef.current != null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setPollIntervalMs(null);
  }, []);

  const cancel = React.useCallback(() => {
    stopPolling();
    setFlow(null);
  }, [stopPolling]);

  const start = React.useCallback(async () => {
    setIsStarting(true);
    try {
      const payload = runtimeGitHub
        ? await runtimeGitHub.authStart()
        : await (async () => {
            const response = await fetch('/api/github/auth/start', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({}),
            });
            const body = await response.json().catch(() => null) as (GitHubDeviceFlowStart & { error?: string }) | null;
            if (!response.ok || !body || !('deviceCode' in body)) {
              throw new Error(body?.error || response.statusText);
            }
            return body;
          })();
      setFlow(payload);
      setPollIntervalMs(Math.max(1, payload.interval) * 1000);
      void openExternalUrl(payload.verificationUriComplete || payload.verificationUri);
    } catch (error) {
      console.error('Failed to start GitHub connect:', error);
      toast.error(t('settings.github.page.toast.startConnectFailed'));
    } finally {
      setIsStarting(false);
    }
  }, [runtimeGitHub, t]);

  const pollOnce = React.useCallback(async (deviceCode: string): Promise<GitHubDeviceFlowComplete> => {
    if (runtimeGitHub) return runtimeGitHub.authComplete(deviceCode);
    const response = await fetch('/api/github/auth/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ deviceCode }),
    });
    const payload = await response.json().catch(() => null) as (GitHubDeviceFlowComplete & { error?: string }) | null;
    if (!response.ok || !payload) throw new Error(payload?.error || response.statusText);
    return payload;
  }, [runtimeGitHub]);

  React.useEffect(() => {
    if (!flow?.deviceCode || !pollIntervalMs || pollTimerRef.current != null) return;
    pollTimerRef.current = window.setInterval(() => {
      void (async () => {
        try {
          const result = await pollOnce(flow.deviceCode);
          if (result.connected) {
            toast.success(t('settings.github.page.toast.connected'));
            cancel();
            await refreshStatus(runtimeGitHub, { force: true });
            await onConnected?.();
            return;
          }
          if (result.status === 'slow_down') {
            setPollIntervalMs((current) => (current ? current + 5000 : 5000));
          }
          if (result.status === 'expired_token' || result.status === 'access_denied') {
            toast.error(result.error || t('settings.github.page.toast.authorizationFailed'));
            cancel();
          }
        } catch (error) {
          console.warn('GitHub polling failed:', error);
        }
      })();
    }, pollIntervalMs);
    return () => {
      if (pollTimerRef.current != null) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [cancel, flow, onConnected, pollIntervalMs, pollOnce, refreshStatus, runtimeGitHub, t]);

  React.useEffect(() => cancel, [cancel]);

  return { flow, isStarting, start, cancel };
};
