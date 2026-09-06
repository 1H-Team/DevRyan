import React from 'react';
import { RiExternalLinkLine, RiFileImageLine } from '@remixicon/react';

import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { ToolPopupContent } from '../types';
import {
    extractAssistantImageCandidates,
    type AssistantImageCandidate,
    type AssistantImageMessage,
} from './generatedImageResults';
import {
    createAssistantImageObjectUrlRegistry,
    isSafeAssistantImageExternalUrl,
    loadAssistantImageBlob,
    prepareAssistantImageCandidates,
    resolveAssistantImageEditorPath,
    type AssistantImagePreparation,
} from './assistantImageLoading';
import { useNearViewport } from './useNearViewport';
import {
    buildAssistantImagePopup,
    formatExactAssistantImageSize,
    getAssistantImageGalleryClassName,
    type ReadyAssistantImageTileState,
} from './assistantImageGalleryPresentation';

interface AssistantImageGalleryProps {
    messages: readonly AssistantImageMessage[];
    sessionId?: string;
    directory?: string;
    onShowPopup?: (content: ToolPopupContent) => void;
    onContentChange?: (reason?: ContentChangeReason) => void;
}

interface IdleTileState {
    status: 'idle';
}

interface FailedTileState {
    status: 'error';
    errorCode: string;
}

type TileState = IdleTileState | ReadyAssistantImageTileState | FailedTileState;

const createIdleStates = (candidates: readonly AssistantImageCandidate[]): Record<string, TileState> => (
    Object.fromEntries(candidates.map((candidate) => [candidate.id, { status: 'idle' as const }]))
);

const AssistantImageGallery: React.FC<AssistantImageGalleryProps> = ({
    messages,
    sessionId,
    directory,
    onShowPopup,
    onContentChange,
}) => {
    const candidates = React.useMemo(() => extractAssistantImageCandidates({
        messages,
        responseComplete: true,
    }), [messages]);
    const { t } = useI18n();
    const runtime = React.useContext(RuntimeAPIContext);
    const { ref, isNearViewport } = useNearViewport<HTMLDivElement>();
    const [tileStates, setTileStates] = React.useState<Record<string, TileState>>(() => createIdleStates(candidates));
    const onContentChangeRef = React.useRef(onContentChange);
    const decodeFailuresRef = React.useRef(new Set<string>());

    React.useEffect(() => {
        onContentChangeRef.current = onContentChange;
    }, [onContentChange]);

    React.useEffect(() => {
        if (!isNearViewport || candidates.length === 0) return;

        const controller = new AbortController();
        const objectUrls = createAssistantImageObjectUrlRegistry();
        const completedTransitions = new Set<string>();

        const commitTransition = (candidateId: string, state: ReadyAssistantImageTileState | FailedTileState) => {
            if (controller.signal.aborted || completedTransitions.has(candidateId)) return;
            completedTransitions.add(candidateId);
            setTileStates((current) => ({ ...current, [candidateId]: state }));
            onContentChangeRef.current?.('structural');
        };

        const loadPreparation = async (preparation: AssistantImagePreparation) => {
            const { candidate } = preparation;
            if (preparation.status === 'error') {
                commitTransition(candidate.id, { status: 'error', errorCode: preparation.errorCode });
                return;
            }
            try {
                const loaded = await loadAssistantImageBlob({
                    url: preparation.url,
                    signal: controller.signal,
                });
                if (controller.signal.aborted) {
                    URL.revokeObjectURL(loaded.objectUrl);
                    return;
                }
                objectUrls.track(loaded.objectUrl);
                commitTransition(candidate.id, {
                    status: 'ready',
                    objectUrl: loaded.objectUrl,
                    mimeType: loaded.mimeType,
                    size: loaded.size,
                    filename: preparation.filename,
                });
            } catch (error) {
                if (controller.signal.aborted) return;
                console.warn('Unable to load assistant image preview:', error);
                commitTransition(candidate.id, { status: 'error', errorCode: 'LOAD_FAILED' });
            }
        };

        void prepareAssistantImageCandidates({
            candidates,
            sessionId,
            directory,

            signal: controller.signal,
        }).then(async (preparations) => {
            await Promise.all(preparations.map(loadPreparation));
        }).catch((error) => {
            if (!controller.signal.aborted) {
                console.warn('Unable to prepare assistant image previews:', error);
                for (const candidate of candidates) {
                    commitTransition(candidate.id, { status: 'error', errorCode: 'PREPARE_FAILED' });
                }
            }
        });

        return () => {
            controller.abort();
            objectUrls.revokeAll();
        };
    }, [candidates, directory, isNearViewport, sessionId]);

    const openPreview = React.useCallback((candidate: AssistantImageCandidate, state: ReadyAssistantImageTileState) => {
        if (!onShowPopup) return;
        onShowPopup(buildAssistantImagePopup(candidate, state));
    }, [onShowPopup]);

    const markDecodeFailure = React.useCallback((candidate: AssistantImageCandidate) => {
        if (decodeFailuresRef.current.has(candidate.id)) return;
        decodeFailuresRef.current.add(candidate.id);
        setTileStates((current) => {
            if (current[candidate.id]?.status !== 'ready') return current;
            return { ...current, [candidate.id]: { status: 'error', errorCode: 'DECODE_FAILED' } };
        });
        onContentChangeRef.current?.('structural');
    }, []);

    if (candidates.length === 0) return null;

    return (
        <div
            ref={ref}
            className={getAssistantImageGalleryClassName(candidates.length)}
            data-assistant-image-gallery="true"
            data-assistant-image-count={candidates.length}
        >
            {candidates.map((candidate) => {
                const state = tileStates[candidate.id] ?? { status: 'idle' as const };
                const commonFigureClass = 'relative aspect-[4/3] min-w-0 overflow-hidden rounded-xl border border-border/40 bg-muted/10';
                if (state.status === 'ready') {
                    return (
                        <figure key={candidate.id} className={commonFigureClass} data-assistant-image-state="ready">
                            <button
                                type="button"
                                onClick={() => openPreview(candidate, state)}
                                onKeyDown={(event) => {
                                    if (event.key !== 'Enter' && event.key !== ' ') return;
                                    event.preventDefault();
                                    openPreview(candidate, state);
                                }}
                                disabled={!onShowPopup}
                                className={cn(
                                    'absolute inset-0 flex h-full w-full items-center justify-center overflow-hidden text-left',
                                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
                                    onShowPopup && 'cursor-zoom-in',
                                )}
                                aria-label={t('chat.assistantImage.openPreview', { name: candidate.caption })}
                            >
                                <img
                                    src={state.objectUrl}
                                    alt={candidate.caption}
                                    className="h-full w-full object-contain"
                                    loading="lazy"
                                    decoding="async"
                                    referrerPolicy="no-referrer"
                                    onError={() => markDecodeFailure(candidate)}
                                />
                            </button>
                            <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 border-t border-border/30 bg-background/90 px-3 py-2 backdrop-blur-sm">
                                <span className="min-w-0 truncate typography-meta text-foreground" title={candidate.caption}>
                                    {candidate.caption}
                                </span>
                                <span className="flex-shrink-0 typography-micro text-muted-foreground" title={t('chat.assistantImage.sizeBytes', { size: state.size })}>
                                    {formatExactAssistantImageSize(state.size)}
                                </span>
                            </figcaption>
                        </figure>
                    );
                }

                if (state.status === 'error') {
                    const isExternal = isSafeAssistantImageExternalUrl(candidate.source);
                    const canOpenInEditor = !isExternal && Boolean(runtime?.editor);
                    const failureContent = (
                        <>
                            <RiFileImageLine className="h-6 w-6 flex-shrink-0 text-muted-foreground" />
                            <span className="min-w-0 text-center">
                                <span className="block truncate typography-meta text-foreground" title={candidate.caption}>{candidate.caption}</span>
                                <span className="block typography-micro text-muted-foreground">{t('chat.assistantImage.previewUnavailable')}</span>
                            </span>
                            {isExternal ? <RiExternalLinkLine className="h-4 w-4 flex-shrink-0 text-muted-foreground" /> : null}
                        </>
                    );
                    const failureClass = 'absolute inset-0 flex h-full w-full items-center justify-center gap-2 px-4 text-center hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary';
                    return (
                        <figure key={candidate.id} className={commonFigureClass} data-assistant-image-state="error" data-error-code={state.errorCode}>
                            {canOpenInEditor ? (
                                <button
                                    type="button"
                                    className={failureClass}
                                    onClick={() => void runtime?.editor?.openFile(resolveAssistantImageEditorPath(candidate.source, directory))}
                                    aria-label={t('chat.assistantImage.openInEditor', { name: candidate.caption })}
                                >
                                    {failureContent}
                                </button>
                            ) : isExternal ? (
                                <a
                                    href={candidate.source}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    referrerPolicy="no-referrer"
                                    className={failureClass}
                                    aria-label={t('chat.assistantImage.openExternal', { name: candidate.caption })}
                                >
                                    {failureContent}
                                </a>
                            ) : (
                                <div className={failureClass}>{failureContent}</div>
                            )}
                        </figure>
                    );
                }

                return (
                    <div
                        key={candidate.id}
                        className={cn(commonFigureClass, 'animate-pulse bg-muted/20')}
                        aria-label={t('chat.assistantImage.loading')}
                        data-assistant-image-state="idle"
                    />
                );
            })}
        </div>
    );
};

export default React.memo(AssistantImageGallery);
