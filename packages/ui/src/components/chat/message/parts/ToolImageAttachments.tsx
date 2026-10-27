import React from 'react';
import type { ToolPart as ToolPartType } from '@opencode-ai/sdk/v2';
import { RiFileImageLine } from '@remixicon/react';

import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { getToolMetadata } from '@/lib/toolHelpers';
import { cn } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionDirectory } from '@/sync/sync-context';
import type { ToolPopupContent } from '../types';
import {
    MAX_TOOL_IMAGE_THUMBNAILS,
    peekToolImage,
    readToolImageAttachments,
    resolveToolImage,
    type ResolvedToolImage,
    type ToolImageAttachment,
} from './toolImageLoading';
import { useNearViewport } from './useNearViewport';

type TileState = { status: 'ready'; image: ResolvedToolImage } | { status: 'error' } | { status: 'idle' };

interface ToolImageAttachmentsProps {
    part: ToolPartType;
    onShowPopup?: (content: ToolPopupContent) => void;
    onContentChange?: (reason?: ContentChangeReason) => void;
}

interface ToolImageStripProps extends Omit<ToolImageAttachmentsProps, 'part'> {
    toolName: string;
    attachments: readonly ToolImageAttachment[];
}

const initialStates = (attachments: readonly ToolImageAttachment[]): Record<string, TileState> => (
    Object.fromEntries(attachments.map((attachment) => {
        const cached = peekToolImage(attachment);
        return [attachment.id, cached ? { status: 'ready', image: cached } : { status: 'idle' }];
    }))
);

const ToolImageStrip: React.FC<ToolImageStripProps> = ({ toolName, attachments, onShowPopup, onContentChange }) => {
    const { t } = useI18n();
    const { ref, isNearViewport } = useNearViewport<HTMLDivElement>();
    const sessionDirectory = useSessionDirectory(attachments[0]?.sessionID);
    const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
    const directory = sessionDirectory ?? currentDirectory ?? undefined;
    const visible = React.useMemo(() => (
        attachments.length > MAX_TOOL_IMAGE_THUMBNAILS ? attachments.slice(0, MAX_TOOL_IMAGE_THUMBNAILS) : attachments
    ), [attachments]);
    const [states, setStates] = React.useState<Record<string, TileState>>(() => initialStates(visible));
    const onContentChangeRef = React.useRef(onContentChange);

    React.useEffect(() => {
        onContentChangeRef.current = onContentChange;
    }, [onContentChange]);

    React.useEffect(() => {
        if (!isNearViewport) return;
        let cancelled = false;
        const settle = (id: string, next: TileState) => {
            if (cancelled) return;
            setStates((current) => current[id]?.status === next.status ? current : { ...current, [id]: next });
            onContentChangeRef.current?.('structural');
        };
        for (const attachment of visible) {
            if (peekToolImage(attachment)) continue;
            resolveToolImage(attachment, { baseUrl: opencodeClient.getBaseUrl(), directory })
                .then((image) => settle(attachment.id, image ? { status: 'ready', image } : { status: 'error' }))
                .catch(() => settle(attachment.id, { status: 'error' }));
        }
        return () => {
            cancelled = true;
        };
    }, [directory, isNearViewport, visible]);

    const openPreview = React.useCallback((attachment: ToolImageAttachment) => {
        if (!onShowPopup) return;
        const ready = visible.flatMap((candidate) => {
            const state = states[candidate.id];
            return state?.status === 'ready' ? [{ attachment: candidate, image: state.image }] : [];
        });
        const index = ready.findIndex((entry) => entry.attachment.id === attachment.id);
        const current = ready[index];
        if (!current) return;
        const gallery = ready.map((entry) => ({
            url: entry.image.url, mimeType: entry.image.mime, filename: entry.attachment.filename, size: entry.image.size,
        }));
        onShowPopup({
            open: true,
            title: current.attachment.filename,
            content: '',
            metadata: { tool: 'tool-image', toolName },
            image: { ...gallery[index], ...(gallery.length > 1 ? { gallery, index } : {}) },
        });
    }, [onShowPopup, states, toolName, visible]);

    const hidden = attachments.length - visible.length;

    return (
        <div
            ref={ref}
            className="flex flex-wrap items-center gap-2 pl-6 pr-2 pb-1.5"
            role="group"
            aria-label={t('chat.toolImage.group', { tool: getToolMetadata(toolName).displayName })}
            data-tool-image-count={attachments.length}
        >
            {visible.map((attachment) => {
                const state = states[attachment.id] ?? { status: 'idle' as const };
                const tileClass = 'relative h-20 w-28 overflow-hidden rounded-lg border border-border/40 bg-muted/10';
                if (state.status === 'ready') {
                    return (
                        <button
                            key={attachment.id}
                            type="button"
                            className={cn(
                                tileClass,
                                'flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                                onShowPopup && 'cursor-zoom-in',
                            )}
                            onClick={(event) => {
                                event.stopPropagation();
                                openPreview(attachment);
                            }}
                            disabled={!onShowPopup}
                            aria-label={t('chat.toolImage.open', { name: attachment.filename })}
                            title={attachment.filename}
                            data-tool-image-state="ready"
                        >
                            <img
                                src={state.image.url}
                                alt={attachment.filename}
                                className="h-full w-full object-cover"
                                decoding="async"
                                loading="lazy"
                                draggable={false}
                                onError={() => setStates((current) => ({ ...current, [attachment.id]: { status: 'error' } }))}
                            />
                        </button>
                    );
                }
                if (state.status === 'error') {
                    return (
                        <div
                            key={attachment.id}
                            className={cn(tileClass, 'flex flex-col items-center justify-center gap-1 px-2 text-center')}
                            title={attachment.filename}
                            data-tool-image-state="error"
                        >
                            <RiFileImageLine className="h-4 w-4 text-muted-foreground" />
                            <span className="typography-micro text-muted-foreground">{t('chat.toolImage.unavailable')}</span>
                        </div>
                    );
                }
                return (
                    <div
                        key={attachment.id}
                        className={cn(tileClass, 'animate-pulse bg-muted/20')}
                        aria-label={t('chat.toolImage.loading')}
                        data-tool-image-state="idle"
                    />
                );
            })}
            {hidden > 0 ? (
                <span className="typography-meta text-muted-foreground">{t('chat.toolImage.more', { count: hidden })}</span>
            ) : null}
        </div>
    );
};

/**
 * Thumbnails for the PNG/JPEG/GIF/WebP media a tool returned. Renders nothing
 * (and subscribes to nothing) for the many tool parts without images.
 */
const ToolImageAttachments: React.FC<ToolImageAttachmentsProps> = ({ part, onShowPopup, onContentChange }) => {
    const attachments = readToolImageAttachments(part);
    if (attachments.length === 0) return null;
    return (
        <ToolImageStrip
            toolName={part.tool}
            attachments={attachments}
            onShowPopup={onShowPopup}
            onContentChange={onContentChange}
        />
    );
};

export default React.memo(ToolImageAttachments);
