import React from 'react';
import { RiAttachment2, RiCloseLine, RiLoader4Line, RiSendPlane2Line, RiToolsLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { botsApi, type BotChannel, type BotsApi } from '@/lib/botsApi';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useBotChannelStore, type BotChannelStore } from '@/stores/useBotChannelStore';
import {
  resolveBotRuntimeMessageKey,
  resolveBotRuntimeWarningMessageKey,
  shouldSubmitBotComposerKey,
  type BotRuntimeWarning,
} from '../botPresentation';
import {
  BOT_ATTACHMENT_ACCEPT,
  collectBotAttachmentFiles,
  hasBotAttachmentFiles,
  nextBotAttachmentDragDepth,
  type BotAttachmentUploadFailure,
  uploadBotAttachmentFiles,
} from './botAttachmentUpload';

export type BotRuntimeRecoveryAction = {
  label: 'setup' | 'repair' | 'update';
  pending: boolean;
  pendingLabel?: string;
  onRun: () => Promise<void>;
};

type BotComposerProps = {
  botId: string;
  channel: BotChannel;
  runtimeState: string;
  runtimeCode?: string | null;
  runtimeAvailable: boolean;
  runtimeWarnings?: readonly BotRuntimeWarning[];
  recoveryAction?: BotRuntimeRecoveryAction | null;
  recoveryError?: string | null;
  onRuntimeIntent?: () => void;
  api?: Pick<BotsApi, 'uploadObject'>;
  channelStore?: BotChannelStore;
};

export const BotComposer: React.FC<BotComposerProps> = ({
  botId,
  channel,
  runtimeState,
  runtimeCode = null,
  runtimeAvailable,
  runtimeWarnings = [],
  recoveryAction = null,
  recoveryError = null,
  onRuntimeIntent,
  api = botsApi,
  channelStore = useBotChannelStore,
}) => {
  const { t } = useI18n();
  const draft = channelStore.draftStore((state) => state.draftsByChannelId[channel.id]) ?? {
    text: '',
    attachmentIds: [],
  };
  const pendingMessageId = channelStore((state) => state.pendingMessageIdByChannelId[channel.id]);
  const sendError = channelStore((state) => state.sendErrorCodeByChannelId[channel.id]);
  const [uploading, setUploading] = React.useState(false);
  const [draggingFiles, setDraggingFiles] = React.useState(false);
  const [uploadFailures, setUploadFailures] = React.useState<readonly BotAttachmentUploadFailure[]>([]);
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const dragEnterCountRef = React.useRef(0);
  const uploadingRef = React.useRef(false);
  const uploadGenerationRef = React.useRef(0);
  const runtimeMessageKey = resolveBotRuntimeMessageKey(runtimeState, runtimeCode);
  const hasWriteAccess = channel.canSend && channel.accessRole !== 'reader';
  const canSend = hasWriteAccess && runtimeAvailable;
  const accepting = Boolean(pendingMessageId);
  const canAttach = hasWriteAccess && !accepting && !uploading;
  const submitDisabled = !canSend
    || (!draft.text.trim() && draft.attachmentIds.length === 0)
    || accepting
    || uploading;

  const updateDraft = React.useCallback((next: { text: string; attachmentIds: readonly string[] }) => {
    channelStore.getState().setDraft(channel.id, next);
  }, [channel.id, channelStore]);

  React.useEffect(() => {
    uploadGenerationRef.current += 1;
    uploadingRef.current = false;
    dragEnterCountRef.current = 0;
    setUploading(false);
    setDraggingFiles(false);
    setUploadFailures([]);
    return () => { uploadGenerationRef.current += 1; };
  }, [channel.id]);

  React.useEffect(() => {
    if (canAttach) return;
    dragEnterCountRef.current = 0;
    setDraggingFiles(false);
  }, [canAttach]);

  const attachFiles = React.useCallback(async (files: readonly File[]) => {
    if (!hasWriteAccess || accepting || uploadingRef.current || files.length === 0) return;

    const uploadGeneration = ++uploadGenerationRef.current;
    const draftGeneration = channelStore.draftStore.getState().generation;
    const stillCurrent = () => uploadGenerationRef.current === uploadGeneration
      && channelStore.draftStore.getState().generation === draftGeneration;
    uploadingRef.current = true;
    setUploading(true);
    setUploadFailures([]);
    try {
      const result = await uploadBotAttachmentFiles({
        files,
        getAttachmentCount: () => (
          channelStore.draftStore.getState().draftsByChannelId[channel.id]?.attachmentIds.length || 0
        ),
        upload: async ({ file, contentType, dataBase64 }) => {
          if (!stillCurrent()) throw new Error('Bot conversation changed');
          const { object } = await api.uploadObject(botId, channel.id, {
            contentType,
            dataBase64,
            provenance: { source: 'channel_upload', name: file.name.slice(0, 255) },
          });
          return object.id;
        },
        onUploaded: ({ objectId }) => {
          if (!stillCurrent()) return;
          const current = channelStore.draftStore.getState().draftsByChannelId[channel.id] ?? {
            text: '',
            attachmentIds: [],
          };
          updateDraft({
            text: current.text,
            attachmentIds: [...current.attachmentIds, objectId],
          });
        },
      });
      if (stillCurrent()) {
        setUploadFailures(result.failures);
      }
    } finally {
      // Re-entry is blocked by uploadingRef while this runs, so no newer upload
      // can be in flight; always release the composer, even after a channel or
      // draft switch, or it stays stuck on the spinner.
      uploadingRef.current = false;
      setUploading(false);
    }
  }, [accepting, api, botId, channel.id, channelStore, hasWriteAccess, updateDraft]);

  const resetFileDrag = React.useCallback(() => {
    dragEnterCountRef.current = nextBotAttachmentDragDepth(
      dragEnterCountRef.current,
      'reset',
    );
    setDraggingFiles(false);
  }, []);

  const submit = React.useCallback(async () => {
    if (submitDisabled) return;
    try {
      const accepted = await channelStore.getState().sendDraft(channel.id);
      if (accepted) inputRef.current?.focus();
    } catch {
      inputRef.current?.focus();
    }
  }, [channel.id, channelStore, submitDisabled]);

  return (
    <div className="border-t border-border/60 bg-background px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2 sm:px-5">
      <div className="mx-auto w-full max-w-[760px]">
        {runtimeWarnings.length > 0 ? (
          <ul className="mb-2 space-y-1 border-l-2 border-[var(--status-warning)] px-3 py-1.5" role="status" data-bot-runtime-warnings>
            {runtimeWarnings.map((warning) => {
              const warningKey = resolveBotRuntimeWarningMessageKey(warning.code);
              return (
                <li key={warning.code} className="flex items-start gap-2" data-bot-runtime-warning={warning.code}>
                  <RiToolsLine className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-warning)]" aria-hidden />
                  <span className="min-w-0 flex-1 typography-meta text-foreground">
                    {warningKey ? t(warningKey) : warning.message}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
        {runtimeMessageKey ? (
          <div className="mb-2 flex flex-wrap items-center gap-2 border-l-2 border-[var(--status-warning)] px-3 py-1.5" role="status">
            <RiToolsLine className="h-4 w-4 shrink-0 text-[var(--status-warning)]" aria-hidden />
            <span className="min-w-0 flex-1 typography-meta text-foreground">{t(runtimeMessageKey)}</span>
            {recoveryAction ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={recoveryAction.pending}
                onClick={() => void recoveryAction.onRun()}
              >
                {recoveryAction.pending
                  ? recoveryAction.pendingLabel || t('bots.runtime.actionWorking')
                  : t(`bots.runtime.${recoveryAction.label}`)}
              </Button>
            ) : null}
          </div>
        ) : null}
        {recoveryError ? (
          <p className="mb-2 typography-meta text-[var(--status-error)]" role="alert">{recoveryError}</p>
        ) : null}

        <form
          aria-label={t('bots.composer.formAria')}
          onFocusCapture={onRuntimeIntent}
          onPointerDownCapture={onRuntimeIntent}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className={cn(
            'relative rounded-[14px] border border-border/70 bg-[var(--surface-elevated)] focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/15',
            draggingFiles && 'border-primary ring-2 ring-primary/50',
          )}
          onDropCapture={(event) => {
            if (hasBotAttachmentFiles(event.dataTransfer)) event.preventDefault();
          }}
          onDragEnter={(event) => {
            if (!hasBotAttachmentFiles(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            if (!canAttach) return;
            dragEnterCountRef.current = nextBotAttachmentDragDepth(
              dragEnterCountRef.current,
              'enter',
            );
            setDraggingFiles(true);
          }}
          onDragOver={(event) => {
            if (!hasBotAttachmentFiles(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'copy';
            if (canAttach) setDraggingFiles(true);
          }}
          onDragLeave={(event) => {
            if (!hasBotAttachmentFiles(event.dataTransfer) && !draggingFiles) return;
            event.preventDefault();
            event.stopPropagation();
            dragEnterCountRef.current = nextBotAttachmentDragDepth(
              dragEnterCountRef.current,
              'leave',
            );
            if (dragEnterCountRef.current === 0) setDraggingFiles(false);
          }}
          onDragEnd={resetFileDrag}
          onDrop={(event) => {
            if (!hasBotAttachmentFiles(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            resetFileDrag();
            if (!canAttach) return;
            onRuntimeIntent?.();
            void attachFiles(collectBotAttachmentFiles(event.dataTransfer));
          }}
        >
          {draggingFiles ? (
            <div
              className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[13px] bg-background/90"
              role="status"
            >
              <div className="flex items-center gap-2 typography-ui-label text-foreground">
                <RiAttachment2 className="h-4 w-4 text-primary" aria-hidden />
                {t('bots.composer.dropFiles')}
              </div>
            </div>
          ) : null}

          <div className="flex items-end gap-2 p-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={BOT_ATTACHMENT_ACCEPT}
              disabled={!hasWriteAccess || accepting || uploading}
              className="sr-only"
              tabIndex={-1}
              onChange={async (event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = '';
                await attachFiles(files);
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-9 shrink-0"
              disabled={!hasWriteAccess || accepting || uploading}
              aria-label={t('bots.composer.attachAria')}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? <RiLoader4Line className="animate-spin motion-reduce:animate-none" /> : <RiAttachment2 />}
            </Button>
            <label htmlFor={`bot-composer-${channel.id}`} className="sr-only">{t('bots.composer.label')}</label>
            <Textarea
              ref={inputRef}
              id={`bot-composer-${channel.id}`}
              simple
              rows={1}
              value={draft.text}
              disabled={!hasWriteAccess || accepting}
              placeholder={hasWriteAccess ? t('bots.composer.placeholder') : t('bots.composer.readOnly')}
              outerClassName="min-w-0 flex-1"
              className="min-h-9 max-h-48 w-full resize-none bg-transparent px-1 py-2 typography-body leading-5 text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
              onChange={(event) => {
                onRuntimeIntent?.();
                updateDraft({ text: event.target.value, attachmentIds: draft.attachmentIds });
              }}
              onKeyDown={(event) => {
                if (!shouldSubmitBotComposerKey({
                  key: event.key,
                  shiftKey: event.shiftKey,
                  isComposing: event.nativeEvent.isComposing,
                })) return;
                event.preventDefault();
                void submit();
              }}
            />
            <Button type="submit" size="icon" className="size-9 shrink-0" disabled={submitDisabled} aria-label={t('bots.composer.sendAria')}>
              {pendingMessageId ? <RiLoader4Line className="animate-spin motion-reduce:animate-none" /> : <RiSendPlane2Line />}
            </Button>
          </div>

          {draft.attachmentIds.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5 px-3 pb-2" aria-label={t('bots.chat.attachments.label')}>
              {draft.attachmentIds.map((attachmentId, index) => (
                <li key={attachmentId} className="inline-flex h-7 items-center gap-1 rounded-md border border-border/60 px-2 typography-micro text-muted-foreground">
                  <RiAttachment2 className="h-3 w-3" aria-hidden />
                  {t('bots.chat.attachments.item', { number: index + 1 })}
                  <button
                    type="button"
                    disabled={accepting}
                    className="ml-0.5 rounded-sm p-0.5 hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                    aria-label={t('bots.composer.removeAttachment', { number: index + 1 })}
                    onClick={() => updateDraft({
                      text: draft.text,
                      attachmentIds: draft.attachmentIds.filter((id) => id !== attachmentId),
                    })}
                  >
                    <RiCloseLine className="h-3 w-3" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {uploadFailures.length > 0 ? (
            <ul className="space-y-1 px-3 pb-2 typography-micro text-[var(--status-error)]" role="alert">
              {uploadFailures.map((failure, index) => (
                <li key={`${failure.filename}-${failure.reason}-${index}`}>
                  {t(`bots.composer.uploadFailure.${failure.reason}`, { filename: failure.filename })}
                </li>
              ))}
            </ul>
          ) : null}

          {!hasWriteAccess || sendError ? (
            <span className="block px-3 pb-2 typography-micro text-muted-foreground" aria-live="polite">
              {!hasWriteAccess
                ? t(`bots.composer.access.${channel.accessRole}`)
                : sendError
                  ? t('bots.composer.retainedAfterError')
                  : null}
            </span>
          ) : null}
        </form>
      </div>
    </div>
  );
};
