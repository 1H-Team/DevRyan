import React from 'react';
import { RiComputerLine, RiLoader4Line, RiUserSharedLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useBotOperationsStore, type BotOperationsStore } from '@/stores/useBotOperationsStore';
import { resolveBotControlPresentation } from '../botPresentation';

type BotBrowserDiagnosticProps = {
  botId: string;
  channelId: string;
  botActive: boolean;
  principalId: string | null;
  canControl: boolean;
  active: boolean;
  operationsStore?: BotOperationsStore;
};

const viewFailureKey = (code: string | null): I18nKey => {
  if (code === 'bot_computer_lifecycle_inactive') return 'bots.operations.computer.inactiveDescription';
  if (code === 'bot_authentication_required' || code === 'bot_membership_required'
    || code === 'bot_channel_forbidden' || code === 'bot_channel_not_found') {
    return 'bots.operations.computer.permissionDenied';
  }
  if (code === 'network_error' || code === 'bots_unavailable' || code?.startsWith('bot_runtime_')
    || code?.startsWith('bot_computer_') || code?.startsWith('bot_browser_transport_')) {
    return 'bots.operations.computer.runtimeUnavailable';
  }
  return 'bots.operations.computer.screenUnavailable';
};

const viewFailureState = (code: string | null): string => {
  const key = viewFailureKey(code);
  if (key === 'bots.operations.computer.inactiveDescription') return 'inactive';
  if (key === 'bots.operations.computer.permissionDenied') return 'permission-denied';
  if (key === 'bots.operations.computer.runtimeUnavailable') return 'runtime-unavailable';
  return 'screen-unavailable';
};

const resolveViewState = ({
  viewing,
  pending,
  streamFailed,
  errorCode,
}: {
  viewing: boolean;
  pending: boolean;
  streamFailed: boolean;
  errorCode: string | null;
}): string => {
  if (viewing) return 'viewing';
  if (pending) return 'connecting';
  if (streamFailed) return 'screen-unavailable';
  if (errorCode) return viewFailureState(errorCode);
  return 'off';
};

const viewDescriptionKey = ({
  pending,
  streamFailed,
  errorCode,
}: {
  pending: boolean;
  streamFailed: boolean;
  errorCode: string | null;
}): I18nKey => {
  if (pending) return 'bots.operations.computer.connectingDescription';
  if (streamFailed) return 'bots.operations.computer.screenUnavailable';
  if (errorCode) return viewFailureKey(errorCode);
  return 'bots.operations.computer.viewingOffDescription';
};

export const BotBrowserDiagnostic: React.FC<BotBrowserDiagnosticProps> = ({
  botId,
  channelId,
  botActive,
  principalId,
  canControl,
  active,
  operationsStore = useBotOperationsStore,
}) => {
  const { t } = useI18n();
  const view = operationsStore((state) => state.computerViewsByBotId[botId]);
  const viewPending = operationsStore((state) => Boolean(
    state.computerViewPendingByBotId[botId]
  ));
  const viewErrorCode = operationsStore((state) => state.computerViewErrorCodeByBotId[botId] ?? null);
  const status = operationsStore((state) => state.computersByBotId[botId]);
  const [now, setNow] = React.useState(() => Date.now());
  const [pendingControl, setPendingControl] = React.useState(false);
  const [controlError, setControlError] = React.useState(false);
  const [streamFailedBotId, setStreamFailedBotId] = React.useState<string | null>(null);
  const [autoStartSuppressed, setAutoStartSuppressed] = React.useState(false);
  const presentation = resolveBotControlPresentation({
    control: status?.control ?? null,
    principalId,
    now,
  });
  const ownedLeaseId = presentation.ownedByViewer ? status?.control?.leaseId ?? null : null;
  const streamFailed = streamFailedBotId === botId;
  const visibleView = active ? view : undefined;
  const viewState = resolveViewState({
    viewing: Boolean(visibleView),
    pending: viewPending,
    streamFailed,
    errorCode: viewErrorCode,
  });
  const descriptionKey = viewDescriptionKey({
    pending: viewPending,
    streamFailed,
    errorCode: viewErrorCode,
  });

  React.useEffect(() => () => {
    if (!operationsStore.getState().computerViewsByBotId[botId]) return;
    void operationsStore.getState().stopComputerView(botId).catch(() => undefined);
  }, [botId, operationsStore]);

  React.useEffect(() => {
    if ((active && botActive && view?.channelId === channelId) || !view) return;
    void operationsStore.getState().stopComputerView(botId).catch(() => undefined);
  }, [active, botActive, botId, channelId, operationsStore, view]);

  React.useEffect(() => {
    if (!active || !botActive || view || viewPending || viewErrorCode
      || streamFailed || autoStartSuppressed) return;
    void operationsStore.getState().startComputerView(botId, channelId).catch(() => undefined);
  }, [
    active,
    autoStartSuppressed,
    botActive,
    botId,
    channelId,
    operationsStore,
    streamFailed,
    view,
    viewErrorCode,
    viewPending,
  ]);

  React.useEffect(() => {
    setAutoStartSuppressed(false);
    setStreamFailedBotId(null);
  }, [botId, channelId]);

  React.useEffect(() => {
    if (active && botActive) return;
    setAutoStartSuppressed(false);
  }, [active, botActive]);

  React.useEffect(() => {
    if (!active || !botActive || !view || !canControl || status) return;
    void operationsStore.getState().refreshComputer(botId).catch(() => setControlError(true));
  }, [active, botActive, botId, canControl, operationsStore, status, view]);

  React.useEffect(() => {
    if (!presentation.active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [presentation.active]);

  React.useEffect(() => {
    const leaseId = presentation.ownedByViewer ? status?.control?.leaseId : null;
    if (!active || !botActive || !view || !leaseId) return;
    const timer = window.setInterval(() => {
      void operationsStore.getState().heartbeatComputerControl(botId, leaseId).catch(() => undefined);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [active, botActive, botId, operationsStore, presentation.ownedByViewer, status?.control?.leaseId, view]);

  if (!botActive) {
    return (
      <div className="px-4 py-10 text-center" data-bot-screen-view-state="inactive">
        <RiComputerLine className="mx-auto h-6 w-6 text-muted-foreground" aria-hidden />
        <p className="mt-2 typography-ui-label text-foreground">{t('bots.operations.computer.inactiveTitle')}</p>
        <p className="mt-1 typography-meta text-muted-foreground">{t('bots.operations.computer.inactiveDescription')}</p>
      </div>
    );
  }

  const stopViewing = () => {
    setAutoStartSuppressed(true);
    setStreamFailedBotId(null);
    void operationsStore.getState().stopComputerView(botId).catch(() => undefined);
  };

  const startViewing = () => {
    setAutoStartSuppressed(false);
    setStreamFailedBotId(null);
    setControlError(false);
    void operationsStore.getState().startComputerView(botId, channelId).catch(() => undefined);
  };

  return (
    <div className="flex h-full min-h-0 flex-col p-3" data-bot-live-computer={botId}>
      <div
        className="relative min-h-[160px] flex-1 overflow-hidden rounded-[10px] border border-border/70 bg-black"
        data-bot-screen-view-state={viewState}
      >
        {visibleView ? (
          <img
            src={visibleView.streamUrl}
            alt={t('bots.operations.computer.liveScreenAlt')}
            className="h-full w-full object-contain"
            draggable={false}
            onError={() => {
              setAutoStartSuppressed(true);
              setStreamFailedBotId(botId);
              void operationsStore.getState().stopComputerView(botId).catch(() => undefined);
            }}
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-5 text-center text-white/75">
            {viewPending ? (
              <RiLoader4Line className="h-6 w-6 animate-spin motion-reduce:animate-none" aria-hidden />
            ) : (
              <RiComputerLine className="h-6 w-6" aria-hidden />
            )}
            <p className="mt-2 typography-ui-label text-white">
              {viewPending
                ? t('bots.operations.computer.connecting')
                : t('bots.operations.computer.viewingOff')}
            </p>
            <p className="mt-1 max-w-[280px] typography-meta text-white/65">
              {t(descriptionKey)}
            </p>
          </div>
        )}
      </div>

      <div className="mt-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="typography-micro text-muted-foreground">
            {t('bots.operations.computer.notRecorded')}
          </p>
          {visibleView ? (
            <Button type="button" variant="outline" size="xs" onClick={stopViewing}>
              {t('bots.operations.computer.stopViewing')}
            </Button>
          ) : (
            <Button type="button" size="xs" disabled={viewPending} onClick={startViewing}>
              {t('bots.operations.computer.startViewing')}
            </Button>
          )}
        </div>

        {visibleView ? (
          <div className="flex items-start gap-2 border-t border-border/50 pt-2">
            <RiUserSharedLine className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="typography-ui-label text-foreground">
                {canControl
                  ? presentation.active
                    ? presentation.ownedByViewer
                      ? t('bots.operations.computer.youControl')
                      : t('bots.operations.computer.humanControls', {
                        actor: presentation.actorLabel ?? t('bots.operations.computer.human'),
                      })
                    : t('bots.operations.computer.agentControls')
                  : t('bots.operations.computer.viewOnly')}
              </p>
              <p className="typography-micro text-muted-foreground" aria-live="polite">
                {canControl && presentation.active
                  ? t('bots.operations.computer.agentPaused', {
                    seconds: presentation.expiresInSeconds ?? 0,
                  })
                  : t('bots.operations.computer.agentActive')}
              </p>
            </div>
            {canControl ? (
              ownedLeaseId ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={pendingControl}
                  onClick={async () => {
                    setPendingControl(true);
                    setControlError(false);
                    try {
                      await operationsStore.getState().returnComputerControl(botId, ownedLeaseId);
                    } catch {
                      setControlError(true);
                    } finally {
                      setPendingControl(false);
                    }
                  }}
                >
                  {t('bots.operations.computer.return')}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="xs"
                  disabled={pendingControl || presentation.active}
                  onClick={async () => {
                    setPendingControl(true);
                    setControlError(false);
                    try {
                      await operationsStore.getState().takeComputerControl(botId);
                      setNow(Date.now());
                    } catch {
                      setControlError(true);
                    } finally {
                      setPendingControl(false);
                    }
                  }}
                >
                  {t('bots.operations.computer.take')}
                </Button>
              )
            ) : null}
          </div>
        ) : null}
        {controlError ? (
          <p className="typography-micro text-[var(--status-error)]" role="alert">
            {t('bots.operations.computer.controlFailed')}
          </p>
        ) : null}
      </div>
    </div>
  );
};
