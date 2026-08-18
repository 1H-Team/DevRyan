import React from 'react';
import { RiExternalLinkLine, RiPushpin2Fill, RiPushpin2Line } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatSurfaceProvider } from '@/components/chat/ChatSurfaceContext';
import { ActiveSessionChangesBadge } from '@/components/session/ActiveSessionChangesBadge';
import { ContextUsageDisplay } from '@/components/ui/ContextUsageDisplay';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { invokeDesktop, isElectronShell } from '@/lib/desktop';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionWorktreeStore } from '@/sync/session-worktree-store';
import { useSessionMessageRecords, useSessionMessagesResolved, useSessions } from '@/sync/sync-context';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { getProviderContextUsageFromMessages } from '@/stores/utils/contextUsageUtils';
import { useStableSessionContextUsage } from '@/hooks/useStableSessionContextUsage';
import { useProviderBackedContextUsage } from '@/hooks/useProviderBackedContextUsage';

type MiniChatMode = 'session' | 'draft';

type MiniChatLayoutProps = {
  mode: MiniChatMode;
  autoOpenDraft?: boolean;
  unavailable?: boolean;
};

const normalizePath = (value: string | null | undefined): string => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  const normalized = raw.replace(/\\/g, '/');
  return normalized === '/' ? '/' : normalized.replace(/\/+$/, '');
};

const MiniChatHeader: React.FC<{ mode: MiniChatMode }> = ({ mode }) => {
  const { t } = useI18n();
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const draftOpen = useSessionUIStore((state) => Boolean(state.currentDraftId && state.newSessionDraft?.open));
  const draftProjectId = useSessionUIStore((state) => state.newSessionDraft?.selectedProjectId ?? null);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const sessions = useSessions();
  const currentSessionMessages = useSessionMessageRecords(currentSessionId ?? '');
  const currentSessionMessagesResolved = useSessionMessagesResolved(currentSessionId ?? '');
  const worktreePath = useSessionUIStore((state) => currentSessionId ? state.worktreeMetadata.get(currentSessionId)?.path ?? '' : '');
  const worktreeAttachment = useSessionWorktreeStore((state) => currentSessionId ? state.getAttachment(currentSessionId) : undefined);
  const draftDirectory = useSessionUIStore((state) => {
    if (!(state.currentDraftId && state.newSessionDraft?.open)) return '';
    return normalizePath(state.newSessionDraft.bootstrapPendingDirectory ?? state.newSessionDraft.directoryOverride ?? '');
  });
  const [pinned, setPinned] = React.useState(false);
  const macosMajor = typeof window !== 'undefined' ? window.__OPENCHAMBER_MACOS_MAJOR__ ?? 0 : 0;
  const hasMacTrafficLights = Number.isFinite(macosMajor) && macosMajor > 0;
  const macosHeaderSizeClass = hasMacTrafficLights
    ? macosMajor >= 26
      ? 'h-12'
      : macosMajor <= 15
        ? 'h-14'
        : ''
    : '';

  const session = React.useMemo(
    () => currentSessionId ? sessions.find((entry) => entry.id === currentSessionId) ?? null : null,
    [currentSessionId, sessions],
  );
  const sessionWorktreeMetadata = (session as { worktreeMetadata?: { path?: string | null; branch?: string | null; projectDirectory?: string | null } } | null)?.worktreeMetadata ?? null;

  React.useEffect(() => {
    if (!isElectronShell()) return;
    void invokeDesktop<{ pinned?: boolean }>('desktop_get_window_pinned').then((result) => {
      if (typeof result?.pinned === 'boolean') setPinned(result.pinned);
    });
  }, []);

  const title = session?.title?.trim()
    || (draftOpen || mode === 'draft' ? t('miniChat.header.newSession') : t('miniChat.header.session'));
  const sessionDirectory = normalizePath((session as { directory?: string | null } | null)?.directory ?? null);
  const worktreeDirectory = normalizePath(worktreePath || sessionWorktreeMetadata?.path || worktreeAttachment?.cwd || worktreeAttachment?.worktreeRoot || '');
  const currentDirectoryNormalized = normalizePath(currentDirectory);
  const openDirectory = worktreeDirectory || sessionDirectory || draftDirectory || currentDirectoryNormalized;
  const providers = useConfigStore((state) => state.providers);
  const contextUsage = React.useMemo(() => {
    if (!currentSessionId || currentSessionMessages.length === 0) return null;
    return getProviderContextUsageFromMessages(currentSessionMessages, providers);
  }, [currentSessionId, currentSessionMessages, providers]);
  const providerBackedContextUsage = useProviderBackedContextUsage({
    sessionID: currentSessionId,
    directory: openDirectory,
    fallback: contextUsage,
  });
  const stableContextUsage = useStableSessionContextUsage({
    directory: openDirectory,
    sessionId: currentSessionId,
    usage: providerBackedContextUsage,
    resolved: !currentSessionId || currentSessionMessagesResolved,
  });
  const dragRegionStyle = { WebkitAppRegion: 'drag' } as React.CSSProperties;
  const noDragRegionStyle = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

  const handleTogglePinned = React.useCallback(() => {
    const nextPinned = !pinned;
    setPinned(nextPinned);
    void invokeDesktop('desktop_set_window_pinned', { pinned: nextPinned }).catch(() => {
      setPinned(!nextPinned);
    });
  }, [pinned]);

  const handleOpenMainApp = React.useCallback(() => {
    const payload = currentSessionId
      ? { sessionId: currentSessionId, directory: (session as { directory?: string | null } | null)?.directory ?? currentDirectory ?? '' }
      : { mode: 'draft', directory: openDirectory || currentDirectory || '', projectId: draftProjectId };
    void invokeDesktop<{ focused?: boolean }>('desktop_focus_main_window', payload)
      .then((result) => {
        if (result?.focused === true) {
          return invokeDesktop('desktop_close_current_window');
        }
        return null;
      });
  }, [currentDirectory, currentSessionId, draftProjectId, openDirectory, session]);

  return (
    <header
      className={cn(
        'flex items-center gap-3 border-b border-[var(--interactive-border)] bg-[var(--surface-background)] pr-3',
        hasMacTrafficLights ? 'pl-[5.5rem]' : 'pl-3',
        macosHeaderSizeClass || 'min-h-14',
      )}
      style={dragRegionStyle}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
        <div className="min-w-0 truncate typography-ui-label text-[14px] font-normal leading-tight text-foreground">{title}</div>
        {currentSessionId ? (
          <ActiveSessionChangesBadge
            sessionId={currentSessionId}
            directory={openDirectory || undefined}
          />
        ) : null}
      </div>
      {stableContextUsage && stableContextUsage.activeInputTokens > 0 ? (
        <ContextUsageDisplay
          usage={stableContextUsage}
          className="h-9 shrink-0 pl-1 pr-1 typography-ui-label"
          valueClassName="font-semibold leading-none"
          hideIcon
          showPercentIcon
          percentIconClassName="h-5 w-5"
        />
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={handleTogglePinned}
        aria-label={pinned ? t('miniChat.actions.unpinAria') : t('miniChat.actions.pinAria')}
        title={pinned ? t('miniChat.actions.unpin') : t('miniChat.actions.pin')}
        style={noDragRegionStyle}
      >
        {pinned ? <RiPushpin2Fill className="h-4 w-4" /> : <RiPushpin2Line className="h-4 w-4" />}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={handleOpenMainApp}
        aria-label={t('miniChat.actions.openMainAria')}
        title={t('miniChat.actions.openMain')}
        style={noDragRegionStyle}
      >
        <RiExternalLinkLine className="h-4 w-4" />
      </Button>
    </header>
  );
};

export const MiniChatLayout: React.FC<MiniChatLayoutProps> = ({ mode, autoOpenDraft = false, unavailable = false }) => {
  const { t } = useI18n();

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <MiniChatHeader mode={mode} />
      <main className="min-h-0 flex-1">
        {unavailable ? (
          <div className="flex h-full items-center justify-center px-6 text-center typography-ui-label text-muted-foreground">
            <div className="max-w-sm rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-4 py-3">
              <div className="font-medium text-foreground">{t('miniChat.unavailable.title')}</div>
              <div className="mt-1 typography-small text-muted-foreground">{t('miniChat.unavailable.description')}</div>
            </div>
          </div>
        ) : (
          <ChatSurfaceProvider mode="mini-chat">
            <ChatContainer autoOpenDraft={autoOpenDraft} />
          </ChatSurfaceProvider>
        )}
      </main>
    </div>
  );
};
