import React from 'react';

import {
  botsDesktopApi,
  type BotRuntimeOperationProgress,
  type BotsDesktopApi,
} from '@/lib/botsDesktopApi';
import type { I18nKey } from '@/lib/i18n';
import type { I18nParams } from '@/lib/i18n/store';

const terminalPhase = (phase: BotRuntimeOperationProgress['phase']): boolean => (
  phase === 'ready' || phase === 'failed'
);

export const botRuntimeProgressLabel = (
  progress: BotRuntimeOperationProgress | null,
  t: (key: I18nKey, values?: I18nParams) => string,
): string => {
  if (!progress) return t('bots.runtime.actionWorking');
  if (progress.phase === 'downloading_image') {
    const total = progress.total ?? 5;
    const current = Math.min(total, (progress.completed ?? 0) + 1);
    return t('bots.runtime.progress.downloading', { current, total });
  }
  const phaseKeys: Record<Exclude<BotRuntimeOperationProgress['phase'], 'downloading_image'>, I18nKey> = {
    checking: 'bots.runtime.progress.checking',
    verifying_images: 'bots.runtime.progress.verifying_images',
    starting_services: 'bots.runtime.progress.starting_services',
    verifying_health: 'bots.runtime.progress.verifying_health',
    ready: 'bots.runtime.progress.ready',
    failed: 'bots.runtime.progress.failed',
  };
  return t(phaseKeys[progress.phase]);
};

export const useBotRuntimeOperation = (
  desktopApi: BotsDesktopApi = botsDesktopApi,
): {
  progress: BotRuntimeOperationProgress | null;
  pending: boolean;
  refresh: () => Promise<void>;
} => {
  const [progress, setProgress] = React.useState<BotRuntimeOperationProgress | null>(null);
  const mountedRef = React.useRef(true);
  const eventRevisionRef = React.useRef(0);

  const refresh = React.useCallback(async () => {
    if (!desktopApi.operationStatus || !desktopApi.isAvailable()) return;
    const revision = eventRevisionRef.current;
    const operation = await desktopApi.operationStatus().catch(() => null);
    if (!mountedRef.current || revision !== eventRevisionRef.current) return;
    setProgress(operation);
  }, [desktopApi]);

  React.useEffect(() => {
    mountedRef.current = true;
    let unlisten: (() => void) | null = null;
    if (desktopApi.listenProgress && desktopApi.isAvailable()) {
      void desktopApi.listenProgress((next) => {
        if (!mountedRef.current) return;
        eventRevisionRef.current += 1;
        setProgress(next);
      }).then((remove) => {
        if (!mountedRef.current) remove();
        else unlisten = remove;
      }).catch(() => undefined);
    }
    void refresh();
    return () => {
      mountedRef.current = false;
      unlisten?.();
    };
  }, [desktopApi, refresh]);

  return {
    progress,
    pending: Boolean(progress && !terminalPhase(progress.phase)),
    refresh,
  };
};
