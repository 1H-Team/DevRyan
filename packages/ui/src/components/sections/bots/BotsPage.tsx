import React from 'react';
import { RiRefreshLine, RiRobot2Line } from '@remixicon/react';

import { resolveBotRuntimeRecovery } from '@/components/bots/botPresentation';
import {
  botRuntimeProgressLabel,
  useBotRuntimeOperation,
} from '@/components/bots/useBotRuntimeOperation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  botsApi,
  BotsApiError,
  type BotManagementDetail,
  type BotModelOptions,
  type BotPurgeExecutionResult,
  type BotRevisionDetail,
  type BotSummary,
  type BotsApi,
} from '@/lib/botsApi';
import { botsDesktopApi, type BotsDesktopApi } from '@/lib/botsDesktopApi';
import { useAuthPrincipal } from '@/lib/authSession';
import { useI18n } from '@/lib/i18n';
import { botChannelSelectors, useBotChannelStore } from '@/stores/useBotChannelStore';
import { useBotsStore } from '@/stores/useBotsStore';
import { BotEditor } from './BotEditor';
import { BotGallery } from './BotGallery';
import { BotRuntimeServicePanel } from './BotRuntimeServicePanel';
import {
  createDefaultBotRevisionContract,
  getPendingBotAction,
  removeBotFromCatalog,
  type PendingBotMutation,
} from './botManagementPresentation';

export type BotsPageProps = {
  api?: BotsApi;
  initialCatalog?: readonly BotSummary[];
  initialDetail?: BotManagementDetail | null;
  initialCanCreateBot?: boolean;

  desktopApi?: BotsDesktopApi;
};

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : 'Unable to complete the Bot management request.'
);

export const BotsPage: React.FC<BotsPageProps> = ({
  api = botsApi,
  initialCatalog = [],
  initialDetail = null,
  initialCanCreateBot = false,

  desktopApi = botsDesktopApi,
}) => {
  const { t } = useI18n();
  const principal = useAuthPrincipal();
  const [catalog, setCatalog] = React.useState<readonly BotSummary[]>(initialCatalog);
  const [selectedBotId, setSelectedBotId] = React.useState<string | null>(
    initialDetail?.bot.id || initialCatalog[0]?.id || null,
  );
  const [detail, setDetail] = React.useState<BotManagementDetail | null>(initialDetail);
  const [loadingCatalog, setLoadingCatalog] = React.useState(initialCatalog.length === 0);
  const [loadingDetail, setLoadingDetail] = React.useState(false);
  const [pendingBotMutations, setPendingBotMutations] = React.useState<Readonly<Record<string, PendingBotMutation>>>({});
  const [creating, setCreating] = React.useState(false);
  const [requestError, setRequestError] = React.useState<{ code: string | null; message: string } | null>(null);
  const [catalogError, setCatalogError] = React.useState<string | null>(null);
  const [canCreateBot, setCanCreateBot] = React.useState(initialCanCreateBot);
  const [publicationNotice, setPublicationNotice] = React.useState<string | null>(null);
  const [activationHealth, setActivationHealth] = React.useState<Awaited<ReturnType<BotsApi['getBotActivationHealth']>> | null>(null);
  const [modelOptions, setModelOptions] = React.useState<BotModelOptions | null>(null);
  const [purgeResult, setPurgeResult] = React.useState<BotPurgeExecutionResult | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createName, setCreateName] = React.useState('');
  const [focusNameSignal, setFocusNameSignal] = React.useState(0);
  const [legacyRuntimeRecoveryPending, setLegacyRuntimeRecoveryPending] = React.useState(false);
  const [runtimeRecoveryError, setRuntimeRecoveryError] = React.useState<string | null>(null);
  const catalogRequest = React.useRef(0);
  const detailRequest = React.useRef(0);
  const modelOptionsRequest = React.useRef(0);
  const mutationSequence = React.useRef(0);
  const selectedBotIdRef = React.useRef(selectedBotId);
  const capabilities = useBotsStore((state) => state.capabilities);
  const runtimeOperation = useBotRuntimeOperation(desktopApi);
  const usesAuthoritativeRuntimeProgress = Boolean(
    desktopApi.operationStatus && desktopApi.listenProgress,
  );
  const runtimeRecoveryPending = usesAuthoritativeRuntimeProgress
    ? runtimeOperation.pending
    : legacyRuntimeRecoveryPending;
  const runtimeRecoveryProgressLabel = botRuntimeProgressLabel(runtimeOperation.progress, t);
  const capabilityCanCreateBot = capabilities?.canCreateBot;
  const loadCapabilities = useBotsStore((state) => state.loadCapabilities);
  const setCapabilities = useBotsStore((state) => state.setCapabilities);
  const canCreate = capabilityCanCreateBot ?? canCreateBot;
  const runtimeRecoveryKind = resolveBotRuntimeRecovery(capabilities, desktopApi.isAvailable());
  const busyAction = getPendingBotAction(pendingBotMutations, detail?.bot.id || null);
  const ownerChannelId = useBotChannelStore(
    botChannelSelectors.ownerChannelId(detail?.bot.id || '', principal.id),
  );
  const ownerChannelMessageCount = useBotChannelStore((state) => (
    ownerChannelId ? state.channelsById[ownerChannelId]?.lastMessageSequence || 0 : 0
  ));

  const refreshCapabilities = React.useCallback(async () => {
    const next = await api.getCapabilities();
    setCapabilities(next);
    return next;
  }, [api, setCapabilities]);

  const recoverRuntime = React.useCallback(async (
    current: Awaited<ReturnType<BotsApi['getCapabilities']>>,
  ) => {
    const kind = resolveBotRuntimeRecovery(current, desktopApi.isAvailable());
    if (!kind) return current;
    if (!usesAuthoritativeRuntimeProgress) setLegacyRuntimeRecoveryPending(true);
    setRuntimeRecoveryError(null);
    try {
      if (kind === 'setup') await desktopApi.setup();
      else if (kind === 'update') await desktopApi.update();
      else await desktopApi.repair();
      return await refreshCapabilities();
    } catch (error) {
      setRuntimeRecoveryError(errorMessage(error));
      throw error;
    } finally {
      if (!usesAuthoritativeRuntimeProgress) setLegacyRuntimeRecoveryPending(false);
      await runtimeOperation.refresh();
    }
  }, [desktopApi, refreshCapabilities, runtimeOperation, usesAuthoritativeRuntimeProgress]);

  const recordError = React.useCallback((error: unknown) => {
    setRequestError({
      code: error instanceof BotsApiError ? error.code : null,
      message: errorMessage(error),
    });
  }, []);

  const invalidateBot = React.useCallback((botId: string) => {
    useBotsStore.getState().removeBot(botId);
    setCatalog((current) => removeBotFromCatalog(current, botId));
    setSelectedBotId((current) => current === botId ? null : current);
    setDetail((current) => current?.bot.id === botId ? null : current);
    if (selectedBotIdRef.current === botId) {
      setActivationHealth(null);
      setPurgeResult(null);
    }
  }, []);

  const loadCatalog = React.useCallback(async () => {

    const request = catalogRequest.current + 1;
    catalogRequest.current = request;
    setLoadingCatalog(true);
    try {
      const result = await api.listBots();
      if (catalogRequest.current !== request) return;
      setCatalog(result.bots);
      setCanCreateBot(result.canCreateBot === true);
      setSelectedBotId((current) => (
        current && result.bots.some((bot) => bot.id === current)
          ? current
          : result.bots[0]?.id || null
      ));
      setDetail((current) => (
        current && result.bots.some((bot) => bot.id === current.bot.id) ? current : null
      ));
      setCatalogError(null);
    } catch (error) {
      if (catalogRequest.current !== request) return;
      setCatalogError(errorMessage(error));
    } finally {
      if (catalogRequest.current === request) setLoadingCatalog(false);
    }
  }, [api]);

  const loadDetail = React.useCallback(async (botId: string) => {
    const request = detailRequest.current + 1;
    detailRequest.current = request;
    setLoadingDetail(true);
    try {
      const result = await api.getBot(botId);
      if (detailRequest.current !== request) return;
      setDetail(result);
      setActivationHealth(null);
      setPurgeResult(null);
      setRequestError(null);
    } catch (error) {
      if (detailRequest.current !== request) return;
      if (error instanceof BotsApiError && error.code === 'bot_not_found') {
        setRequestError(null);
        invalidateBot(botId);
        await loadCatalog();
        return;
      }
      setDetail(null);
      recordError(error);
    } finally {
      if (detailRequest.current === request) setLoadingDetail(false);
    }
  }, [api, invalidateBot, loadCatalog, recordError]);

  const loadModelOptions = React.useCallback(async (botId: string) => {
    const request = modelOptionsRequest.current + 1;
    modelOptionsRequest.current = request;
    setModelOptions(null);
    try {
      const result = await api.getBotModelOptions(botId);
      if (modelOptionsRequest.current !== request) return;
      setModelOptions(result);
    } catch {
      if (modelOptionsRequest.current === request) setModelOptions(null);
    }
  }, [api]);

  React.useEffect(() => {
    if (initialCatalog.length > 0) return;
    void loadCatalog();
  }, [initialCatalog.length, loadCatalog]);

  React.useEffect(() => {

    const refreshOnFocus = () => void loadCatalog();
    const refreshOnVisibility = () => {
      if (document.visibilityState === 'visible') void loadCatalog();
    };
    window.addEventListener('focus', refreshOnFocus);
    document.addEventListener('visibilitychange', refreshOnVisibility);
    return () => {
      window.removeEventListener('focus', refreshOnFocus);
      document.removeEventListener('visibilitychange', refreshOnVisibility);
    };
  }, [loadCatalog]);

  React.useEffect(() => {
    if (selectedBotId || catalog.length === 0) return;
    setSelectedBotId(catalog[0]?.id || null);
  }, [catalog, selectedBotId]);

  React.useEffect(() => {
    selectedBotIdRef.current = selectedBotId;
  }, [selectedBotId]);

  React.useEffect(() => {
    if (capabilityCanCreateBot !== undefined) return;
    void loadCapabilities();
  }, [capabilityCanCreateBot, loadCapabilities]);

  React.useEffect(() => {
    if (!selectedBotId
      || initialDetail?.bot.id === selectedBotId
      || detail?.bot.id === selectedBotId) return;
    void loadDetail(selectedBotId);
  }, [detail?.bot.id, initialDetail?.bot.id, loadDetail, selectedBotId]);

  React.useEffect(() => {
    if (!detail?.canManage) {
      modelOptionsRequest.current += 1;
      setModelOptions(null);
      return;
    }
    void loadModelOptions(detail.bot.id);
  }, [detail?.bot.id, detail?.canManage, loadModelOptions]);

  React.useEffect(() => setRuntimeRecoveryError(null), [detail?.bot.id]);

  const refreshSelected = React.useCallback(async () => {
    if (!selectedBotId) return;
    await Promise.all([loadCatalog(), loadDetail(selectedBotId)]);
  }, [loadCatalog, loadDetail, selectedBotId]);

  const runBotMutation = React.useCallback(async (
    botId: string,
    action: string,
    operation: () => Promise<void>,
  ): Promise<boolean> => {
    const token = mutationSequence.current + 1;
    mutationSequence.current = token;
    setPendingBotMutations((current) => ({
      ...current,
      [botId]: { action, token },
    }));
    setRequestError(null);
    setPublicationNotice(null);
    try {
      await operation();
      return true;
    } catch (error) {
      recordError(error);
      return false;
    } finally {
      setPendingBotMutations((current) => {
        if (current[botId]?.token !== token) return current;
        const next = { ...current };
        delete next[botId];
        return next;
      });
    }
  }, [recordError]);

  const runCreateMutation = React.useCallback(async (
    operation: () => Promise<void>,
  ): Promise<boolean> => {
    setCreating(true);
    setRequestError(null);
    try {
      await operation();
      return true;
    } catch (error) {
      recordError(error);
      return false;
    } finally {
      setCreating(false);
    }
  }, [recordError]);

  return (
    <div className="app-region-no-drag relative flex h-full min-h-0 flex-col overflow-hidden bg-background md:flex-row">
      <BotGallery
        bots={catalog}
        selectedBotId={selectedBotId}
        loading={loadingCatalog}
        error={catalogError}
        canCreate={canCreate}
        onSelect={(botId) => {
          setSelectedBotId(botId);
          if (detail?.bot.id !== botId) setDetail(null);
        }}
        onCreate={() => {
          setRequestError(null);
          setCreateName('');
          setCreateOpen(true);
        }}
      />

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <BotRuntimeServicePanel canManage={principal.role === 'admin'} desktopApi={desktopApi} />
        <div className="min-h-0 flex-1">
        {loadingDetail ? (
          <div className="flex h-full items-center justify-center typography-ui text-muted-foreground" role="status">Loading Bot management…</div>
        ) : detail ? (
          <BotEditor
            detail={detail}
            activationHealth={activationHealth}
            modelOptions={modelOptions}
            focusNameSignal={focusNameSignal}
            purgeResult={purgeResult}
            busyAction={busyAction}
            errorCode={requestError?.code || null}
            errorMessage={requestError?.message || null}
            noticeMessage={publicationNotice}
            onSaveProfile={(profile) => void runBotMutation(detail.bot.id, 'save-profile', async () => {
              const result = await api.updateBotProfile(detail.bot.id, {
                ...profile,
                expectedUpdatedAt: detail.bot.updatedAt,
              });
              useBotsStore.getState().upsertBot(result.bot);
              setCatalog((current) => current.map((bot) => bot.id === result.bot.id ? result.bot : bot));
              setDetail((current) => current ? { ...current, bot: result.bot } : current);
              setPublicationNotice(result.avatarCleanupRequired
                ? 'Changes saved. The previous avatar is queued for cleanup.'
                : 'Changes saved.');
            })}
            onPublishRevision={(revision, contract, profile) => void runBotMutation(detail.bot.id, 'publish-revision', async () => {
              let runtimeRecoveryAttempted = false;
              let revisionToPublish = revision;
              let detailForPublish = detail;
              if (revision.activatedAt !== null) {
                const created = await api.createBotRevision(detail.bot.id, {
                  basedOnRevisionId: revision.id,
                  contract,
                });
                revisionToPublish = created.revision;
                detailForPublish = {
                  ...detail,
                  revisions: [...detail.revisions, created.revision],
                };
                setDetail(detailForPublish);
              }
              const desktopAvailable = desktopApi.isAvailable();
              const publish = (
                targetRevision: BotRevisionDetail,
                targetDetail: BotManagementDetail,
                includeAvatar: boolean,
              ) => api.publishBotRevision(detail.bot.id, targetRevision.id, {
                contract: targetRevision === revisionToPublish ? contract : targetRevision.contract,
                expectedUpdatedAt: targetRevision.updatedAt,
                profile: {
                  name: profile.name,
                  title: profile.title,
                  summary: profile.summary,
                  expectedUpdatedAt: targetDetail.bot.updatedAt,
                  ...(includeAvatar && profile.avatar !== undefined ? { avatar: profile.avatar } : {}),
                },
              });
              const loadBlockedState = async () => {
                const [nextDetail, health] = await Promise.all([
                  api.getBot(detail.bot.id),
                  api.getBotActivationHealth(detail.bot.id, revisionToPublish.id),
                ]);
                setDetail(nextDetail);
                setActivationHealth(health);
                return { nextDetail, health };
              };
              const applyPublished = (result: Awaited<ReturnType<BotsApi['publishBotRevision']>>) => {
                const finalBot = result.bot;
                useBotsStore.getState().upsertBot(finalBot);
                setCatalog((current) => current.map((bot) => (
                  bot.id === finalBot.id ? finalBot : bot
                )));
                setDetail((current) => {
                  if (!current) return current;
                  const hasRevision = current.revisions.some((entry) => entry.id === result.revision.id);
                  return {
                    ...current,
                    bot: finalBot,
                    revisions: hasRevision
                      ? current.revisions.map((entry) => entry.id === result.revision.id ? result.revision : entry)
                      : [...current.revisions, result.revision],
                  };
                });
                setActivationHealth(result.health);
                setRuntimeRecoveryError(null);
                setPublicationNotice(result.avatarCleanupRequired
                  ? 'Bot published. The previous avatar is queued for cleanup; the published Bot and current avatar are ready to use.'
                  : 'Bot published and ready to use in chat.');
              };

              try {
                const current = await refreshCapabilities();
                if (resolveBotRuntimeRecovery(current, desktopAvailable)) {
                  runtimeRecoveryAttempted = true;
                  setPublicationNotice('Preparing the local Bot runtime…');
                  await recoverRuntime(current);
                }
              } catch {
                // Publishing still saves the exact setup and returns authoritative readiness details.
              }

              try {
                applyPublished(await publish(revisionToPublish, detailForPublish, true));
              } catch (error) {
                if (!(error instanceof BotsApiError) || error.code !== 'bot_activation_blocked') {
                  throw error;
                }
                const blocked = await loadBlockedState();
                const runtimeFailed = blocked.health.gates.some((gate) => (
                  gate.id === 'images' && gate.status === 'fail'
                ));
                if (!runtimeFailed || runtimeRecoveryAttempted) throw error;

                const current = await refreshCapabilities();
                if (!resolveBotRuntimeRecovery(current, desktopAvailable)) throw error;
                runtimeRecoveryAttempted = true;
                await recoverRuntime(current);

                const refreshed = await api.getBot(detail.bot.id);
                const savedRevision = refreshed.revisions.find((entry): entry is BotRevisionDetail => (
                  entry.id === revisionToPublish.id && Object.hasOwn(entry, 'contract')
                ));
                if (!savedRevision) throw error;
                try {
                  applyPublished(await publish(
                    savedRevision,
                    refreshed,
                    detail.bot.activeRevisionId !== null,
                  ));
                } catch (retryError) {
                  if (retryError instanceof BotsApiError && retryError.code === 'bot_activation_blocked') {
                    await loadBlockedState();
                  }
                  throw retryError;
                }
              }
            })}
            runtimeRecoveryKind={runtimeRecoveryKind}
            runtimeRecoveryPending={runtimeRecoveryPending}
            runtimeRecoveryProgressLabel={runtimeRecoveryProgressLabel}
            runtimeRecoveryError={runtimeRecoveryError || (
              runtimeRecoveryKind && runtimeOperation.progress?.phase === 'failed'
                ? runtimeOperation.progress.message || null
                : null
            )}
            onRecoverRuntime={(revision) => {
              if (!runtimeRecoveryKind || runtimeRecoveryPending) return;
              setPublicationNotice(null);
              void (async () => {
                try {
                  const current = capabilities || await refreshCapabilities();
                  await recoverRuntime(current);
                  const health = await api.getBotActivationHealth(detail.bot.id, revision.id);
                  setActivationHealth(health);
                  if (health.ready) {
                    setRequestError(null);
                    setPublicationNotice('Bot runtime is ready. Save & Publish can now complete.');
                  } else {
                    setRequestError({
                      code: 'bot_activation_blocked',
                      message: 'Bot setup still has readiness checks to resolve.',
                    });
                    setPublicationNotice('Bot runtime setup completed. The remaining readiness checks are shown below.');
                  }
                } catch (error) {
                  setRuntimeRecoveryError(errorMessage(error));
                }
              })();
            }}
            onAssignMembership={(input) => void runBotMutation(detail.bot.id, `membership:${input.userId}`, async () => {
              const result = await api.setBotMembership(detail.bot.id, input);
              setDetail((current) => current ? {
                ...current,
                memberships: [
                  ...current.memberships.filter((membership) => membership.userId !== result.membership.userId),
                  result.membership,
                ],
              } : current);
            })}
            onRevokeMembership={(membership) => void runBotMutation(detail.bot.id, `membership:${membership.userId}`, async () => {
              const result = await api.revokeBotMembership(detail.bot.id, membership.userId, membership.updatedAt);
              setDetail((current) => current ? {
                ...current,
                memberships: current.memberships.map((entry) => entry.userId === result.membership.userId ? result.membership : entry),
              } : current);
            })}
            onSaveCredential={(input) => runBotMutation(detail.bot.id, 'credential', async () => {
              const result = await api.saveBotCredentialMetadata(detail.bot.id, input);
              setDetail((current) => current ? {
                ...current,
                credentials: [
                  ...current.credentials.filter((credential) => credential.id !== result.credential.id),
                  result.credential,
                ],
              } : current);
            })}
            onRotateCredential={(credential, secret) => runBotMutation(detail.bot.id, 'credential', async () => {
              const result = await api.rotateBotCredential(detail.bot.id, credential.id, {
                secret,
                expectedUpdatedAt: credential.updatedAt,
              });
              setDetail((current) => current ? {
                ...current,
                credentials: [
                  ...current.credentials.filter((entry) => entry.id !== result.credential.id),
                  result.credential,
                ],
              } : current);
            })}
            onReconnectCredential={(credential) => runBotMutation(detail.bot.id, 'credential', async () => {
              const result = await api.reconnectBotCredential(detail.bot.id, credential.id, {
                connectionId: 'host:openai', expectedUpdatedAt: credential.updatedAt,
              });
              setDetail((current) => current ? { ...current,
                credentials: current.credentials.map((entry) => entry.id === result.credential.id ? result.credential : entry),
              } : current);
            })}
            onTransition={(lifecycle) => void runBotMutation(detail.bot.id, `lifecycle:${lifecycle}`, async () => {
              const result = await api.transitionBotLifecycle(detail.bot.id, {
                lifecycle,
                expectedUpdatedAt: detail.bot.updatedAt,
              });
              useBotsStore.getState().upsertBot(result.bot);
              await refreshSelected();
            })}
            hasChatHistory={ownerChannelMessageCount > 0}
            onClearChatHistory={ownerChannelId ? () => void runBotMutation(detail.bot.id, 'clear-chat-history', async () => {
              const result = await api.deleteBotChannel(ownerChannelId);
              useBotChannelStore.getState().removeChannel(ownerChannelId);
              try {
                const replacement = await api.getOrCreateOwnerChannel(detail.bot.id);
                useBotChannelStore.getState().upsertChannel(replacement.channel);
              } catch {
                void useBotChannelStore.getState().ensureOwnerChannel(detail.bot.id).catch(() => undefined);
              }
              setPublicationNotice(result.notice || 'Chat history cleared.');
            }) : undefined}
            onDeleteCompletely={(request) => void runBotMutation(detail.bot.id, 'purge-complete', async () => {
              const result = await api.deleteBotCompletely(detail.bot.id, request);
              if (result.purge.botDeleted) {
                invalidateBot(detail.bot.id);
                await loadCatalog();
                return;
              }
              if (selectedBotIdRef.current === detail.bot.id) setPurgeResult(result.purge);
              await refreshSelected();
            })}
            onRetryPurge={(resourceIds) => void runBotMutation(detail.bot.id, 'purge-retry', async () => {
              const result = await api.retryBotPurge(detail.bot.id, { resourceIds });
              if (result.purge.botDeleted) {
                invalidateBot(detail.bot.id);
                await loadCatalog();
                return;
              }
              if (selectedBotIdRef.current === detail.bot.id) setPurgeResult(result.purge);
            })}
            onResourcesChanged={refreshSelected}
          />
        ) : selectedBotId ? (
          <div className="flex h-full items-center justify-center p-6 text-center">
            <div>
              <p className="typography-ui-label text-foreground">Unable to load this Bot.</p>
              {requestError ? (
                <p className="mt-1 max-w-md typography-ui text-muted-foreground" role="alert">
                  {requestError.message}
                  {requestError.code ? <span className="mt-1 block font-mono text-xs">{requestError.code}</span> : null}
                </p>
              ) : null}
              <Button type="button" size="xs" variant="outline" className="mt-3" onClick={() => void loadDetail(selectedBotId)}>
                <RiRefreshLine className="h-3.5 w-3.5" aria-hidden /> Retry
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center">
            <div className="max-w-sm">
              <RiRobot2Line className="mx-auto h-6 w-6 text-muted-foreground/60" aria-hidden />
              <h1 className="mt-2 typography-ui-header font-semibold text-foreground">
                {requestError || catalogError ? 'Unable to load Bots' : t('settings.page.bots.title')}
              </h1>
              <p className="mt-1 typography-ui text-muted-foreground" role={requestError || catalogError ? 'alert' : undefined}>
                {requestError?.message || catalogError || 'Select an assigned Bot or create one to begin.'}
              </p>
              {requestError?.code ? <p className="mt-1 font-mono text-xs text-muted-foreground">{requestError.code}</p> : null}
              {requestError || catalogError ? (
                <Button type="button" size="xs" variant="outline" className="mt-3" onClick={() => void loadCatalog()}>
                  <RiRefreshLine className="h-3.5 w-3.5" aria-hidden /> Retry
                </Button>
              ) : null}
            </div>
          </div>
        )}
        </div>
      </main>

      <Dialog open={createOpen} onOpenChange={(open) => {
        if (creating) return;
        setCreateOpen(open);
      }}>
        <DialogContent className="max-w-md" data-bot-create-dialog>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              const name = createName.trim();
              if (!name) return;
              void runCreateMutation(async () => {
                const result = await api.createBot({
                  name,
                  tenancy: 'team',
                  contract: createDefaultBotRevisionContract(name),
                });
                setCatalog((current) => [...current.filter((bot) => bot.id !== result.bot.id), result.bot]
                  .sort((left, right) => left.name.localeCompare(right.name)));
                setSelectedBotId(result.bot.id);
                setDetail({
                  bot: result.bot,
                  canManage: true,
                  revisions: [result.revision],
                  memberships: [result.membership],
                  credentials: [],
                });
                setCreateOpen(false);
                setFocusNameSignal((current) => current + 1);
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>Create Bot</DialogTitle>
              <DialogDescription>Name the Bot now. DevRyan applies secure capability-first defaults; review the profile, then activate it.</DialogDescription>
            </DialogHeader>
            <label className="block space-y-1 typography-meta text-muted-foreground">
              <span>Name</span>
              <Input autoFocus value={createName} onChange={(event) => setCreateName(event.target.value)} />
            </label>
            {requestError ? (
              <div
                className="rounded-lg border border-[color-mix(in_srgb,var(--status-error)_35%,var(--border))] bg-[color-mix(in_srgb,var(--status-error)_8%,var(--background))] px-3 py-2"
                data-bot-create-error
                role="alert"
              >
                <p className="typography-ui-label text-[var(--status-error)]">{requestError.message}</p>
                {requestError.code ? (
                  <code className="mt-1 block typography-micro text-muted-foreground">{requestError.code}</code>
                ) : null}
              </div>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={creating}
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!createName.trim() || creating}>
                {creating ? 'Creating…' : 'Create Bot'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
};
