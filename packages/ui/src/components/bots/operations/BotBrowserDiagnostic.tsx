import React from 'react';
import { RiComputerLine, RiLoader4Line, RiUserSharedLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { BotComputerBrowserStatus, BotHumanInputEvent } from '@/lib/botsApi';
import { useBotOperationsStore, type BotOperationsStore } from '@/stores/useBotOperationsStore';
import { resolveBotControlPresentation } from '../botPresentation';
import { BotComputerCanvas, type BotComputerCanvasHandle } from './BotComputerCanvas';

type BotBrowserDiagnosticProps = {
  botId: string;
  channelId: string;
  botActive: boolean;
  principalId: string | null;
  canControl: boolean;
  active: boolean;
  runId?: string;
  operationsStore?: BotOperationsStore;
};

const FIRST_FRAME_TIMEOUT_MS = 5_000;
const COMPUTER_STATUS_POLL_MS = 2_000;

const browserWarning = (browser: BotComputerBrowserStatus | undefined): {
  kind: string;
  key: I18nKey;
  host?: string;
} | null => {
  if (!browser) return null;
  if (browser.displayReady === false) {
    return { kind: 'display-failure', key: 'bots.operations.computer.diagnosticDisplayFailure' };
  }
  const diagnostic = browser.lastNavigationDiagnostic;
  if (diagnostic?.kind === 'egress_denied' && diagnostic.blockedHost) {
    return {
      kind: 'egress-denied',
      key: 'bots.operations.computer.diagnosticEgressDenied',
      host: diagnostic.blockedHost,
    };
  }
  if (diagnostic?.kind === 'subresource_failure') {
    return {
      kind: 'subresource-failure',
      key: diagnostic.blockedHost
        ? 'bots.operations.computer.diagnosticSubresourceFailureHost'
        : 'bots.operations.computer.diagnosticSubresourceFailure',
      host: diagnostic.blockedHost || undefined,
    };
  }
  if (browser.healthy === false && browser.lifecycleState !== 'stopped') {
    return { kind: 'browser-failure', key: 'bots.operations.computer.diagnosticBrowserFailure' };
  }
  if (diagnostic?.kind === 'site_rejection') {
    return { kind: 'site-rejection', key: 'bots.operations.computer.diagnosticSiteRejection' };
  }
  // Last on purpose: a residual cookie diagnostic must never mask a real
  // browser failure or site rejection.
  if (diagnostic?.kind === 'blocked_cookies') {
    return { kind: 'blocked-cookies', key: 'bots.operations.computer.diagnosticCookiesBlocked' };
  }
  return null;
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
  if (streamFailed) return 'screen-unavailable';
  if (viewing) return 'viewing';
  if (pending) return 'connecting';
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
  runId,
  operationsStore = useBotOperationsStore,
}) => {
  const { t } = useI18n();
  const view = operationsStore((state) => state.computerViewsByBotId[botId]);
  const viewPending = operationsStore((state) => Boolean(
    state.computerViewPendingByBotId[botId]
  ));
  const viewErrorCode = operationsStore((state) => state.computerViewErrorCodeByBotId[botId] ?? null);
  const status = operationsStore((state) => state.computersByBotId[botId]);
  const waitingForControl = operationsStore((state) => (
    (state.runIdsByChannelId[channelId] || []).some((runId) => (
      state.runsById[runId]?.state === 'waiting_control'
    ))
  ));
  const [now, setNow] = React.useState(() => Date.now());
  const [pendingControl, setPendingControl] = React.useState(false);
  const [controlError, setControlError] = React.useState(false);
  const [releaseErrorLeaseId, setReleaseErrorLeaseId] = React.useState<string | null>(null);
  const [streamFailedBotId, setStreamFailedBotId] = React.useState<string | null>(null);
  const [autoStartSuppressed, setAutoStartSuppressed] = React.useState(false);
  const [loadedViewId, setLoadedViewId] = React.useState<string | null>(null);
  const canvasRef = React.useRef<BotComputerCanvasHandle | null>(null);
  const retryCount = React.useRef(0);
  const presentation = resolveBotControlPresentation({
    control: status?.control ?? null,
    principalId,
    now,
  });
  const ownedLeaseId = presentation.ownedByViewer ? status?.control?.leaseId ?? null : null;
  const returnableLeaseId = principalId && status?.control?.actorId === principalId
    ? status.control.leaseId : null;
  const expiredOwnedLease = Boolean(returnableLeaseId && typeof status?.control?.expiresAt === 'number'
    && status.control.expiresAt <= now);
  const streamFailed = streamFailedBotId === botId;
  const visibleView = active ? view : undefined;
  const firstFrameLoaded = Boolean(visibleView && loadedViewId === visibleView.id);
  const streamConnecting = Boolean(visibleView && !firstFrameLoaded);
  const viewState = resolveViewState({
    viewing: firstFrameLoaded,
    pending: viewPending || streamConnecting,
    streamFailed,
    errorCode: viewErrorCode,
  });
  const descriptionKey = viewDescriptionKey({
    pending: viewPending || streamConnecting,
    streamFailed,
    errorCode: viewErrorCode,
  });
  const diagnosticWarning = browserWarning(status?.browser);

  const releaseView = React.useCallback(async () => {
    const state = operationsStore.getState();
    if (state.principalId !== principalId) return;
    const expected = state.computerViewsByBotId[botId];
    if (!expected && !state.computerViewPendingByBotId[botId]) return;
    if (expected && (expected.channelId !== channelId || expected.runId !== runId)) return;
    canvasRef.current?.cancelPendingInput();
    const control = operationsStore.getState().computersByBotId[botId]?.control;
    // Stop the local stream/ticket immediately. Returning control must not hold
    // teardown hostage to a hung command or control HTTP response.
    const stopped = operationsStore.getState().stopComputerView(botId).catch(() => undefined);
    if (control?.actorId === principalId && control.leaseId) {
      const leaseId = control.leaseId;
      void operationsStore.getState().returnComputerControl(botId, leaseId).catch(async () => {
        const current = operationsStore.getState();
        if (current.principalId !== principalId || current.computersByBotId[botId]?.control?.leaseId !== leaseId) return;
        // Closing the stream can already have returned this lease on the host.
        // Confirm that outcome before surfacing a duplicate return as a failure.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            current.refreshComputer(botId, leaseId).catch(() => undefined),
            new Promise<void>((resolve) => { timer = setTimeout(resolve, COMPUTER_STATUS_POLL_MS); }),
          ]);
        } finally { if (timer !== undefined) clearTimeout(timer); }
        const refreshed = operationsStore.getState();
        if (refreshed.principalId === principalId && refreshed.computersByBotId[botId]?.control?.leaseId === leaseId) {
          setReleaseErrorLeaseId(leaseId);
        }
      });
    }
    await stopped;
  }, [botId, channelId, operationsStore, principalId, runId]);

  React.useEffect(() => () => {
    void releaseView();
  }, [releaseView]);

  React.useEffect(() => {
    if (active && botActive && view?.channelId === channelId && view.runId === runId) return;
    if (!active || !botActive) void releaseView();
  }, [active, botActive, channelId, releaseView, runId, view]);

  React.useEffect(() => {
    if (!active || !botActive || view || viewPending || viewErrorCode
      || streamFailed || autoStartSuppressed) return;
    void operationsStore.getState().startComputerView(botId, channelId, runId).catch(() => undefined);
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
    runId,
  ]);

  React.useEffect(() => {
    setAutoStartSuppressed(false);
    setStreamFailedBotId(null);
    setLoadedViewId(null);
    retryCount.current = 0;
  }, [botId, channelId, runId]);

  React.useEffect(() => {
    if (!active || !botActive || viewPending || (!streamFailed && !viewErrorCode)
      || retryCount.current >= 2 || /denied|forbidden|authentication|activity_changed/.test(viewErrorCode ?? '')) return;
    const delay = 750 * (2 ** retryCount.current);
    const timer = window.setTimeout(() => {
      retryCount.current += 1;
      setAutoStartSuppressed(false);
      setStreamFailedBotId(null);
      void operationsStore.getState().startComputerView(botId, channelId, runId).catch(() => undefined);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [active, botActive, botId, channelId, operationsStore, runId, streamFailed, viewErrorCode, viewPending]);

  React.useEffect(() => {
    if (active && botActive) return;
    setAutoStartSuppressed(false);
  }, [active, botActive]);

  React.useEffect(() => {
    if (!active || !botActive || !visibleView || firstFrameLoaded || streamFailed) return;
    const expectedViewId = visibleView.id;
    const timer = window.setTimeout(() => {
      if (operationsStore.getState().computerViewsByBotId[botId]?.id !== expectedViewId) return;
      setAutoStartSuppressed(true);
      setStreamFailedBotId(botId);
      void releaseView();
    }, FIRST_FRAME_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [
    active,
    botActive,
    botId,
    firstFrameLoaded,
    operationsStore,
    releaseView,
    streamFailed,
    visibleView,
  ]);

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
    const expiresAt = status?.control?.expiresAt;
    if (!presentation.ownedByViewer || typeof expiresAt !== 'number') return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Math.min(2_147_483_647, expiresAt - Date.now() + 1)),
    );
    return () => window.clearTimeout(timer);
  }, [presentation.ownedByViewer, status?.control?.expiresAt]);

  React.useEffect(() => {
    const leaseId = presentation.ownedByViewer ? status?.control?.leaseId : null;
    if (!active || !botActive || !view || !leaseId) return;
    const timer = window.setInterval(() => {
      void operationsStore.getState().heartbeatComputerControl(botId, leaseId).catch(() => undefined);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [active, botActive, botId, operationsStore, presentation.ownedByViewer, status?.control?.leaseId, view]);

  React.useEffect(() => {
    if (!active || !botActive || !visibleView || !ownedLeaseId) return;
    const refresh = () => {
      void operationsStore.getState().refreshComputerDiagnostic(botId).catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, COMPUTER_STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, botActive, botId, operationsStore, ownedLeaseId, visibleView]);

  React.useEffect(() => {
    if (!active || !botActive || !canControl || !expiredOwnedLease || !returnableLeaseId) return;
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      const state = operationsStore.getState();
      if (disposed || pending || state.principalId !== principalId
        || state.computersByBotId[botId]?.control?.leaseId !== returnableLeaseId) return;
      pending = true;
      try { await state.refreshComputer(botId, returnableLeaseId); } catch { /* The warning and explicit retry remain visible. */ }
      finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, COMPUTER_STATUS_POLL_MS);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [active, botActive, botId, canControl, expiredOwnedLease, operationsStore, principalId, returnableLeaseId]);

  const stopViewing = async () => {
    setAutoStartSuppressed(true);
    setStreamFailedBotId(null);
    await releaseView();
  };

  const startViewing = () => {
    setAutoStartSuppressed(false);
    setStreamFailedBotId(null);
    setControlError(false);
    void operationsStore.getState().startComputerView(botId, channelId, runId).catch(() => undefined);
  };

  const handleFirstFrame = React.useCallback((viewId: string) => {
    if (operationsStore.getState().computerViewsByBotId[botId]?.id !== viewId) return;
    setLoadedViewId(viewId);
    setStreamFailedBotId(null);
    retryCount.current = 0;
  }, [botId, operationsStore]);

  const handleStreamFailure = React.useCallback((viewId: string) => {
    if (operationsStore.getState().computerViewsByBotId[botId]?.id !== viewId) return;
    setAutoStartSuppressed(true);
    setStreamFailedBotId(botId);
    void releaseView();
  }, [botId, operationsStore, releaseView]);

  const handleInput = React.useCallback(async (
    viewId: string,
    events: readonly BotHumanInputEvent[],
    signal: AbortSignal,
  ) => {
    const state = operationsStore.getState();
    const currentView = state.computerViewsByBotId[botId];
    const control = state.computersByBotId[botId]?.control;
    if (!currentView || currentView.id !== viewId || currentView.channelId !== channelId
      || !control?.leaseId
      || control.actorId !== principalId || typeof control.expiresAt !== 'number'
      || control.expiresAt <= Date.now()) {
      throw new Error('Bot computer input is no longer available');
    }
    await state.sendHumanComputerInput(botId, viewId, control.leaseId, events, signal);
  }, [botId, channelId, operationsStore, principalId]);

  const handleInputFailure = React.useCallback(() => {
    setControlError(true);
    void operationsStore.getState().refreshComputer(botId).catch(() => undefined);
  }, [botId, operationsStore]);

  const returnControl = React.useCallback(async () => {
    if (!returnableLeaseId) return;
    setPendingControl(true);
    setControlError(false);
    try {
      // A failed last input must never prevent returning the server lease.
      await canvasRef.current?.drainPendingInput().catch(() => undefined);
      const state = operationsStore.getState();
      if (state.principalId !== principalId || state.computersByBotId[botId]?.control?.leaseId !== returnableLeaseId
        || state.computersByBotId[botId]?.control?.actorId !== principalId) return;
      await state.returnComputerControl(botId, returnableLeaseId);
    } catch {
      setControlError(true);
    } finally {
      setPendingControl(false);
    }
  }, [botId, operationsStore, principalId, returnableLeaseId]);

  const inputEnabled = Boolean(
    active && botActive && canControl && firstFrameLoaded && ownedLeaseId && visibleView
  );

  const viewToggle = visibleView ? (
    <Button type="button" variant="outline" size="xs" onClick={stopViewing}>
      {t('bots.operations.computer.stopViewing')}
    </Button>
  ) : (
    <Button type="button" size="xs" disabled={viewPending} onClick={startViewing}>
      {t('bots.operations.computer.startViewing')}
    </Button>
  );

  if (!botActive) {
    return (
      <div className="px-4 py-10 text-center" data-bot-screen-view-state="inactive">
        <RiComputerLine className="mx-auto h-6 w-6 text-muted-foreground" aria-hidden />
        <p className="mt-2 typography-ui-label text-foreground">{t('bots.operations.computer.inactiveTitle')}</p>
        <p className="mt-1 typography-meta text-muted-foreground">{t('bots.operations.computer.inactiveDescription')}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col p-3" data-bot-live-computer={botId}>
      <div
        className="relative min-h-[160px] flex-1 overflow-hidden rounded-[10px] border border-border/70 bg-black"
        data-bot-screen-view-state={viewState}
      >
        {visibleView ? (
          <div className={`absolute inset-0 transition-opacity ${
            firstFrameLoaded ? 'opacity-100' : 'opacity-0'
          }`}>
            <BotComputerCanvas
              ref={canvasRef}
              view={visibleView}
              alt={t('bots.operations.computer.liveScreenAlt')}
              inputEnabled={inputEnabled}
              onFirstFrame={handleFirstFrame}
              onFailure={handleStreamFailure}
              onInput={handleInput}
              onInputFailure={handleInputFailure}
            />
          </div>
        ) : null}
        {!visibleView || !firstFrameLoaded ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-5 text-center text-white/75">
            {viewPending || streamConnecting ? (
              <RiLoader4Line className="h-6 w-6 animate-spin motion-reduce:animate-none" aria-hidden />
            ) : (
              <RiComputerLine className="h-6 w-6" aria-hidden />
            )}
            <p className="mt-2 typography-ui-label text-white">
              {viewPending || streamConnecting
                ? t('bots.operations.computer.connecting')
                : t('bots.operations.computer.viewingOff')}
            </p>
            <p className="mt-1 max-w-[280px] typography-meta text-white/65">
              {t(descriptionKey)}
            </p>
          </div>
        ) : null}
      </div>

      <div className="mt-3 space-y-2">
        {expiredOwnedLease && canControl ? (
          <div className="flex items-start gap-2 rounded-md border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 px-2.5 py-2" data-bot-control-release-pending="true" role="status">
            <p className="min-w-0 flex-1 typography-micro text-foreground">{t('bots.operations.computer.releaseExpired')}</p>
            <Button type="button" variant="outline" size="xs" disabled={pendingControl} onClick={returnControl}>
              {t('bots.operations.computer.return')}
            </Button>
          </div>
        ) : null}
        {waitingForControl ? (
          <div
            className="flex items-center gap-2 rounded-md border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 px-2.5 py-2"
            data-bot-control-wait={returnableLeaseId ? 'owned' : 'other'}
            role="status"
          >
            <RiUserSharedLine className="h-4 w-4 shrink-0 text-[var(--status-warning)]" aria-hidden />
            <p className="min-w-0 flex-1 typography-micro text-foreground">
              {returnableLeaseId
                ? t('bots.operations.computer.waitingControlOwned')
                : t('bots.operations.computer.waitingControlOther')}
            </p>
            {ownedLeaseId ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={pendingControl}
                onClick={returnControl}
              >
                {t('bots.operations.computer.return')}
              </Button>
            ) : null}
          </div>
        ) : null}

        {visibleView && diagnosticWarning ? (
          <p
            className="rounded-md border border-[var(--status-warning)]/35 bg-[var(--status-warning)]/10 px-2.5 py-2 typography-micro text-foreground"
            data-bot-browser-warning={diagnosticWarning.kind}
            role="alert"
          >
            {t(diagnosticWarning.key, diagnosticWarning.host ? { host: diagnosticWarning.host } : undefined)}
          </p>
        ) : null}

        {visibleView && !expiredOwnedLease ? (
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
              {inputEnabled ? (
                <p className="typography-micro text-muted-foreground">
                  {t('bots.operations.computer.inputHint')}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {viewToggle}
              {canControl ? (
                ownedLeaseId ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={pendingControl}
                    onClick={returnControl}
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
          </div>
        ) : (
          <div className="flex items-center justify-end">
            {viewToggle}
          </div>
        )}
        {controlError || (releaseErrorLeaseId && releaseErrorLeaseId === status?.control?.leaseId) ? (
          <p className="typography-micro text-[var(--status-error)]" role="alert">
            {t('bots.operations.computer.controlFailed')}
          </p>
        ) : null}
      </div>
    </div>
  );
};
