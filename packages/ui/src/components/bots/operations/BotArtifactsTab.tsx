import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  RiComputerLine,
  RiDownload2Line,
  RiFile3Line,
  RiLoader4Line,
  RiRefreshLine,
} from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { useAuthPrincipal } from '@/lib/authSession';
import { botsApi, type BotSharedFile, type BotsApi } from '@/lib/botsApi';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { BotChannelStore } from '@/stores/useBotChannelStore';
import {
  type BotSharedFilesStore,
  useBotSharedFilesStore,
} from '@/stores/useBotSharedFilesStore';
import type { BotsStore } from '@/stores/useBotsStore';
import { friendlyComputerPath } from './botSharedFilePresentation';

type BotArtifactsTabProps = {
  botId: string;
  channelId: string;
  api?: Pick<BotsApi, 'listSharedFiles' | 'retrySharedFile' | 'downloadObject'>;
  onOpenComputer?: (path: string) => void;
  channelStore?: BotChannelStore;
  botsStore?: BotsStore;
  sharedFilesStore?: BotSharedFilesStore;
};

const relativeTime = (value: string): string => {
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 0) return '';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
};

const statusClass = (state: BotSharedFile['copyState']): string => cn(
  'rounded-full border px-1.5 py-0.5 typography-micro font-medium capitalize',
  state === 'ready' && 'border-[var(--status-success)]/30 bg-[var(--status-success)]/10 text-[var(--status-success)]',
  state === 'failed' && 'border-[var(--status-error)]/30 bg-[var(--status-error)]/10 text-[var(--status-error)]',
  (state === 'pending' || state === 'copying') && 'border-border bg-muted text-muted-foreground',
);

type BotSharedFileRowProps = {
  file: BotSharedFile;
  viewerUserId: string | null;
  busy: boolean;
  onDownload: (file: BotSharedFile) => void;
  onOpenComputer: (file: BotSharedFile) => void;
  onRetry: (file: BotSharedFile) => void;
};

export const BotSharedFileRow: React.FC<BotSharedFileRowProps> = ({
  file,
  viewerUserId,
  busy,
  onDownload,
  onOpenComputer,
  onRetry,
}) => {
  const { t } = useI18n();
  return (
    <li className="border-b border-border/50 py-3 last:border-b-0" data-bot-shared-file={file.id}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <RiFile3Line className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate typography-ui-label text-foreground">{file.filename}</p>
            <span className={statusClass(file.copyState)}>{file.copyState}</span>
          </div>
          <p className="mt-0.5 typography-micro text-muted-foreground">
            {file.direction === 'bot'
              ? t('bots.operations.shared.sentByBot')
              : file.senderUserId === viewerUserId
                ? t('bots.operations.shared.sentByYou')
                : t('bots.operations.shared.sentByMember')}
            {relativeTime(file.createdAt) ? ` · ${relativeTime(file.createdAt)}` : ''}
            {file.size !== null ? ` · ${Math.max(1, Math.ceil(file.size / 1024))} KB` : ''}
          </p>
          <p className="mt-1 truncate typography-micro text-muted-foreground" title={file.computerPath}>
            {friendlyComputerPath(file.computerPath)}
          </p>
          {file.copyState === 'failed' ? (
            <p className="mt-1 typography-micro text-[var(--status-error)]" role="status">
              {t('bots.operations.shared.copyFailed')}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button type="button" variant="outline" size="xs" disabled={file.copyState !== 'ready' || busy} onClick={() => onDownload(file)}>
              <RiDownload2Line />
              {t('bots.operations.shared.download')}
            </Button>
            <Button type="button" variant="outline" size="xs" disabled={file.copyState !== 'ready'} onClick={() => onOpenComputer(file)}>
              <RiComputerLine />
              {t('bots.operations.shared.openComputer')}
            </Button>
            {file.copyState === 'failed' ? (
              <Button type="button" variant="outline" size="xs" disabled={busy} onClick={() => onRetry(file)}>
                <RiRefreshLine />
                {t('bots.operations.shared.retry')}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
};

export const BotArtifactsTab: React.FC<BotArtifactsTabProps> = ({
  botId,
  channelId,
  api = botsApi,
  onOpenComputer,
  sharedFilesStore = useBotSharedFilesStore,
}) => {
  const { t } = useI18n();
  const principal = useAuthPrincipal();
  const files = sharedFilesStore(useShallow((state) => (
    (state.fileIdsByChannelId[channelId] || [])
      .map((id) => state.filesById[id])
      .filter((file): file is BotSharedFile => Boolean(file))
  )));
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const viewGenerationRef = React.useRef(0);
  React.useLayoutEffect(() => {
    viewGenerationRef.current += 1;
    setBusyId(null);
    return () => { viewGenerationRef.current += 1; };
  }, [botId, channelId, principal.id]);
  const captureView = React.useCallback(() => {
    const scopeIsCurrent = sharedFilesStore.getState().captureScope(channelId);
    const generation = viewGenerationRef.current;
    return () => scopeIsCurrent() && generation === viewGenerationRef.current;
  }, [channelId, sharedFilesStore]);

  const load = React.useCallback(async ({ quiet = false } = {}) => {
    const isCurrent = captureView();
    if (!quiet) setLoading(true);
    try {
      const files = await sharedFilesStore.getState().loadChannel(botId, channelId, api);
      if (!isCurrent()) return [];
      setError(false);
      return files;
    } catch {
      if (isCurrent()) setError(true);
      return [];
    } finally {
      if (!quiet && isCurrent()) setLoading(false);
    }
  }, [api, botId, captureView, channelId, sharedFilesStore]);

  React.useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = async (quiet = false) => {
      const next = await load({ quiet });
      if (!active) return;
      if (next.some((file) => file.copyState === 'pending' || file.copyState === 'copying')) {
        timer = setTimeout(() => void refresh(true), 2_000);
      }
    };
    void refresh();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [load, principal.id]);

  const download = async (file: BotSharedFile) => {
    const isCurrent = captureView();
    setBusyId(file.id);
    try {
      const blob = await api.downloadObject(botId, file.objectId);
      if (!isCurrent()) return;
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = file.filename;
      anchor.click();
      URL.revokeObjectURL(href);
      setError(false);
    } catch {
      if (isCurrent()) setError(true);
    } finally {
      if (isCurrent()) setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 px-4 py-10 typography-meta text-muted-foreground" role="status">
        <RiLoader4Line className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
        {t('bots.operations.shared.loading')}
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="typography-ui-label text-foreground">{t('bots.operations.shared.emptyTitle')}</p>
        <p className="mt-1 typography-meta text-muted-foreground">{t('bots.operations.shared.emptyDescription')}</p>
        {error ? <p className="mt-2 typography-micro text-[var(--status-error)]" role="alert">{t('bots.operations.shared.loadFailed')}</p> : null}
      </div>
    );
  }

  return (
    <div>
      {error ? <p className="border-b border-border/50 px-4 py-2 typography-micro text-[var(--status-error)]" role="alert">{t('bots.operations.shared.loadFailed')}</p> : null}
      <ul className="px-3" aria-label={t('bots.operations.shared.listAria')}>
        {files.map((file) => (
          <BotSharedFileRow
            key={file.id}
            file={file}
            viewerUserId={principal.id}
            busy={busyId === file.id}
            onDownload={(entry) => void download(entry)}
            onOpenComputer={(entry) => {
              void navigator.clipboard?.writeText(entry.computerPath);
              onOpenComputer?.(entry.computerPath);
            }}
            onRetry={(entry) => {
              const isCurrent = captureView();
              setBusyId(entry.id);
              void api.retrySharedFile(botId, channelId, entry.id).then((result) => {
                if (!isCurrent()) return;
                sharedFilesStore.getState().upsertFile(result.sharedFile);
                setError(false);
              }).catch(() => { if (isCurrent()) setError(true); }).finally(() => { if (isCurrent()) setBusyId(null); });
            }}
          />
        ))}
      </ul>
    </div>
  );
};
