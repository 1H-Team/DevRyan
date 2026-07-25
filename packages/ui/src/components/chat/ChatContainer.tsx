import React from 'react';
import { RiArrowLeftLine } from '@remixicon/react';
import type { Message, Part, Session } from '@opencode-ai/sdk/v2';

import { ChatInput } from './ChatInput';
import { useUIStore } from '@/stores/useUIStore';
import { Skeleton } from '@/components/ui/skeleton';
import ChatEmptyState from './ChatEmptyState';
import MessageList, { type MessageListHandle } from './MessageList';
import { useChatSelectionCopySanitizer } from './lib/useChatSelectionCopySanitizer';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import { StatusRowContainer } from './StatusRowContainer';
import ScrollToBottomButton from './components/ScrollToBottomButton';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import {
    CHAT_FORCE_SCROLL_BOTTOM_EVENT,
    useChatAutoFollow,
    type AnimationHandlers,
    type ChatForceScrollBottomEventDetail,
    type ContentChangeReason,
} from '@/hooks/useChatAutoFollow';
import { useChatTimelineController } from './hooks/useChatTimelineController';
import { DeferredChatDialog, LazyTimelineDialog } from './lazyChatDialogs';
import { LazyViewBoundary } from '@/components/views/lazyViews';
import { useChatTurnNavigation } from './hooks/useChatTurnNavigation';
import { useDeviceInfo } from '@/lib/device';
import { Button } from '@/components/ui/button';
import { OverlayScrollbar } from '@/components/ui/OverlayScrollbar';
import type { PermissionRequest } from '@/types/permission';
import type { QuestionRequest } from '@/types/question';
import { cn } from '@/lib/utils';
import {
    createScopedBlockingRequestsSelector,
} from './lib/blockingRequests';
import { useRetryVisibility } from './lib/turns/retryVisibility';
import { ManagedTaskCompactionContinuity } from './ManagedTaskCompactionContinuity';
import { getLatestCompactionBoundaryAt } from './managedTaskCompactionProjection';

// New sync system imports
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useStreamingStore } from '@/sync/streaming';
import {
    useSessionMessageCount,
    useSessionMessageRecords,
    useSessions,
    useDirectorySync,
    useSessionStatus,
    useSyncDirectory,
} from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { useSessionMessagePagination } from '@/sync/message-pagination-store';
import { getSessionMaterializationStatus } from '@/sync/materialization';
import { getAllSyncSessions } from '@/sync/sync-refs';
import { isSessionWorkingFromState } from '@/sync/session-working';
import { useI18n } from '@/lib/i18n';

const EMPTY_MESSAGES: Array<{ info: Message; parts: Part[] }> = [];
const EMPTY_PERMISSIONS: PermissionRequest[] = [];
const EMPTY_QUESTIONS: QuestionRequest[] = [];
const IDLE_SESSION_STATUS = { type: 'idle' as const };
const DEFAULT_RETRY_MESSAGE = 'Quota limit reached. Retrying automatically.';
const CHAT_SCROLL_STYLE = {
    overflowAnchor: 'none',
    overscrollBehavior: 'contain',
    overscrollBehaviorY: 'contain',
} as const;
// Keep a small scroll target below the final status row, but avoid the oversized
// end-of-chat blank area from the old 10vh/40px spacer.
const CHAT_BOTTOM_SPACER_DESKTOP = '3.5vh';
const CHAT_BOTTOM_SPACER_MOBILE = '40px';
const CHAT_NAVIGATION_IGNORED_TARGET_SELECTOR = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    '[contenteditable="true"]',
    '[role="button"]',
    '[role="combobox"]',
    '[role="dialog"]',
    '[role="listbox"]',
    '[role="menu"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="textbox"]',
    '[data-radix-popper-content-wrapper]',
].join(',');
type SessionMessageRecord = { info: Message; parts: Part[] };

const isHTMLElement = (target: EventTarget | null): target is HTMLElement => {
    return target instanceof HTMLElement;
};

const shouldIgnoreChatNavigationTarget = (target: EventTarget | null): boolean => {
    if (!isHTMLElement(target)) {
        return false;
    }

    return Boolean(target.closest(CHAT_NAVIGATION_IGNORED_TARGET_SELECTOR));
};

const shouldIgnoreChatNavigationForFocus = (activeElement: Element | null, scrollContainer: HTMLElement | null): boolean => {
    if (typeof document === 'undefined') {
        return true;
    }

    if (!activeElement || activeElement === document.body || activeElement === document.documentElement) {
        return true;
    }

    if (shouldIgnoreChatNavigationTarget(activeElement)) {
        return true;
    }

    return !scrollContainer?.contains(activeElement);
};

const hasBlockingChatOverlay = (): boolean => {
    const {
        isAboutDialogOpen,
        isCommandPaletteOpen,
        isHelpDialogOpen,
        isImagePreviewOpen,
        isMultiRunLauncherOpen,
        isSessionSwitcherOpen,
        isSettingsDialogOpen,
    } = useUIStore.getState();

    return isAboutDialogOpen
        || isCommandPaletteOpen
        || isHelpDialogOpen
        || isImagePreviewOpen
        || isMultiRunLauncherOpen
        || isSessionSwitcherOpen
        || isSettingsDialogOpen;
};

type HydratingToolSkeletonRow = {
    id: string;
    titleWidth: string;
    detailWidth: string;
};

type ChatViewportProps = {
    currentSessionId: string;
    isDesktopExpandedInput: boolean;
    isMobile: boolean;
    scrollRef: React.RefObject<HTMLDivElement | null>;
    messageListRef: React.RefObject<MessageListHandle | null>;
    turnStart: number;
    renderedMessages: SessionMessageRecord[];
    compactionBoundaryAt: number | null;
    hasMoreAboveTurns: boolean;
    isLoadingOlder: boolean;
    sessionIsWorking: boolean;
    streamingMessageId: string | null;
    activeStreamingPhase: import('./message/types').StreamPhase | null;
    retryOverlay: {
        sessionId: string;
        message: string;
        confirmedAt?: number;
        fallbackTimestamp?: number;
    } | null;
    handleMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    handleLoadOlder: () => void;
    scrollToBottom: () => void;
    sessionQuestions: QuestionRequest[];
    sessionPermissions: PermissionRequest[];
    isProgrammaticFollowActive: boolean;
};

const ChatViewport = React.memo(({
    currentSessionId,
    isDesktopExpandedInput,
    isMobile,
    scrollRef,
    messageListRef,
    turnStart,
    renderedMessages,
    compactionBoundaryAt,
    hasMoreAboveTurns,
    isLoadingOlder,
    sessionIsWorking,
    streamingMessageId,
    activeStreamingPhase,
    retryOverlay,
    handleMessageContentChange,
    getAnimationHandlers,
    handleLoadOlder,
    scrollToBottom,
    sessionQuestions,
    sessionPermissions,
    isProgrammaticFollowActive,
}: ChatViewportProps) => {
    const focusScrollContainer = React.useCallback((event: React.MouseEvent<HTMLElement>) => {
        if (event.defaultPrevented || shouldIgnoreChatNavigationTarget(event.target)) {
            return;
        }

        if (typeof window !== 'undefined' && window.getSelection()?.type === 'Range') {
            return;
        }

        scrollRef.current?.focus({ preventScroll: true });
    }, [scrollRef]);
    return (
        <div
            className={cn(
                'relative min-h-0',
                isDesktopExpandedInput
                    ? 'absolute inset-0 opacity-0 pointer-events-none'
                    : 'flex-1'
            )}
            aria-hidden={isDesktopExpandedInput}
        >
            <div className="absolute inset-0">
                <ScrollShadow
                    className="absolute inset-0 overflow-y-auto overflow-x-hidden z-0 chat-scroll overlay-scrollbar-target"
                    ref={scrollRef}
                    style={CHAT_SCROLL_STYLE}
                    observeMutations={false}
                    hideTopShadow
                    tabIndex={0}
                    onClick={focusScrollContainer}
                    data-scroll-shadow="true"
                    data-scrollbar="chat"
                >
                    <div className="relative z-0 min-h-full">
                        <MessageList
                            ref={messageListRef}
                            sessionKey={currentSessionId}
                            turnStart={turnStart}
                            messages={renderedMessages}
                            sessionIsWorking={sessionIsWorking}
                            activeStreamingMessageId={streamingMessageId}
                            activeStreamingPhase={activeStreamingPhase}
                            retryOverlay={retryOverlay}
                            onMessageContentChange={handleMessageContentChange}
                            getAnimationHandlers={getAnimationHandlers}
                            hasMoreAbove={hasMoreAboveTurns}
                            isLoadingOlder={isLoadingOlder}
                            onLoadOlder={handleLoadOlder}
                            scrollToBottom={scrollToBottom}
                            scrollRef={scrollRef}
                        />
                        {(sessionQuestions.length > 0 || sessionPermissions.length > 0) && (
                            <div>
                                {sessionQuestions.length > 0 ? (
                                    // Merge all pending QuestionRequests for this session into one
                                    // card so users see related clarifying questions together.
                                    // Reply routing still splits answers back to each underlying
                                    // request id inside QuestionCard.
                                    <QuestionCard
                                        key={sessionQuestions.map((q) => q.id).join('|')}
                                        requests={sessionQuestions}
                                    />
                                ) : null}
                                {sessionPermissions.map((permission) => (
                                    <PermissionCard key={permission.id} permission={permission} />
                                ))}
                            </div>
                        )}

                        <ManagedTaskCompactionContinuity
                            rootSessionId={currentSessionId}
                            compactionBoundaryAt={compactionBoundaryAt}
                            isMobile={isMobile}
                            onContentChange={handleMessageContentChange}
                        />

                        <div className="mb-3">
                            <StatusRowContainer />
                        </div>

                        <div
                            className="flex-shrink-0"
                            style={{ height: isMobile ? CHAT_BOTTOM_SPACER_MOBILE : CHAT_BOTTOM_SPACER_DESKTOP }}
                            aria-hidden="true"
                        />
                    </div>
                </ScrollShadow>
                <OverlayScrollbar containerRef={scrollRef} suppressVisibility={isProgrammaticFollowActive} userIntentOnly observeMutations={false} />
            </div>
        </div>
    );
}, (prev, next) => {
    return prev.currentSessionId === next.currentSessionId
        && prev.isDesktopExpandedInput === next.isDesktopExpandedInput
        && prev.isMobile === next.isMobile
        && prev.scrollRef === next.scrollRef
        && prev.messageListRef === next.messageListRef
        && prev.turnStart === next.turnStart
        && prev.renderedMessages === next.renderedMessages
        && prev.compactionBoundaryAt === next.compactionBoundaryAt
        && prev.hasMoreAboveTurns === next.hasMoreAboveTurns
        && prev.isLoadingOlder === next.isLoadingOlder
        && prev.sessionIsWorking === next.sessionIsWorking
        && prev.streamingMessageId === next.streamingMessageId
        && prev.activeStreamingPhase === next.activeStreamingPhase
        && prev.retryOverlay === next.retryOverlay
        && prev.handleMessageContentChange === next.handleMessageContentChange
        && prev.getAnimationHandlers === next.getAnimationHandlers
        && prev.handleLoadOlder === next.handleLoadOlder
        && prev.scrollToBottom === next.scrollToBottom
        && prev.sessionQuestions === next.sessionQuestions
        && prev.sessionPermissions === next.sessionPermissions
        && prev.isProgrammaticFollowActive === next.isProgrammaticFollowActive;
});

ChatViewport.displayName = 'ChatViewport';

const HYDRATING_SKELETON_ITEMS: Array<{
    id: number;
    toolRows: HydratingToolSkeletonRow[];
    textWidths: [string, string, string];
}> = [
    {
        id: 1,
        toolRows: [
            { id: 'search', titleWidth: 'w-24', detailWidth: 'w-52' },
            { id: 'read', titleWidth: 'w-20', detailWidth: 'w-36' },
            { id: 'edit', titleWidth: 'w-24', detailWidth: 'w-64' },
        ],
        textWidths: ['w-24', 'w-[92%]', 'w-[78%]'],
    },
    {
        id: 2,
        toolRows: [
            { id: 'read', titleWidth: 'w-20', detailWidth: 'w-40' },
            { id: 'search', titleWidth: 'w-24', detailWidth: 'w-48' },
        ],
        textWidths: ['w-20', 'w-[88%]', 'w-[70%]'],
    },
    {
        id: 3,
        toolRows: [
            { id: 'shell', titleWidth: 'w-28', detailWidth: 'w-44' },
            { id: 'edit', titleWidth: 'w-24', detailWidth: 'w-56' },
        ],
        textWidths: ['w-24', 'w-[84%]', 'w-[64%]'],
    },
];

type ChatContainerProps = {
    autoOpenDraft?: boolean;
};

export const ChatContainer: React.FC<ChatContainerProps> = ({ autoOpenDraft = true }) => {
    const { t } = useI18n();
    // Strip trailing block-serialization newlines when a chat message is copied
    // via native Cmd/Ctrl+C, so pasting it elsewhere doesn't gain blank lines.
    useChatSelectionCopySanitizer();
    // Session UI state
    const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
    const currentDraftId = useSessionUIStore((s) => s.currentDraftId);
    const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
    const setCurrentSession = useSessionUIStore((s) => s.setCurrentSession);
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
    const currentSessionDirectory = useSessionUIStore(
        React.useCallback(
            (s) => (currentSessionId ? s.getDirectoryForSession(currentSessionId) : null),
            [currentSessionId],
        ),
    );

    // Sync actions
    const sync = useSync();
    const syncDirectory = useSyncDirectory();
    const ensureSessionRenderable = React.useCallback(
        (sessionId: string) => sync.ensureSessionRenderable(sessionId, { directory: currentSessionDirectory }),
        [sync, currentSessionDirectory],
    );
    const loadMoreMessages = React.useCallback(
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        (sessionId: string, _direction: 'up' | 'down') => sync.loadMore(sessionId, { directory: currentSessionDirectory }),
        [sync, currentSessionDirectory],
    );

    // UI store
    const isExpandedInput = useUIStore((state) => state.isExpandedInput);
    const isTimelineDialogOpen = useUIStore((s) => s.isTimelineDialogOpen);
    const setTimelineDialogOpen = useUIStore((s) => s.setTimelineDialogOpen);

    // Streaming state
    const streamingMessageId = useStreamingStore(
        React.useCallback(
            (s) => (currentSessionId ? s.streamingMessageIds.get(currentSessionId) ?? null : null),
            [currentSessionId],
        ),
    );
    const activeStreamingPhase = useStreamingStore(
        React.useCallback(
            (s) => {
                if (!streamingMessageId) return null;
                return s.messageStreamStates.get(streamingMessageId)?.phase ?? null;
            },
            [streamingMessageId],
        ),
    );
    const sessionMessageCount = useSessionMessageCount(currentSessionId ?? '', currentSessionDirectory ?? undefined);
    const hasRenderableSessionSnapshot = useDirectorySync(
        React.useCallback(
            (state) => (currentSessionId ? getSessionMaterializationStatus(state, currentSessionId).renderable : false),
            [currentSessionId],
        ),
        currentSessionDirectory ?? undefined,
    );
    // Messages from sync system
    const sessionMessageRecords = useSessionMessageRecords(currentSessionId ?? '', currentSessionDirectory ?? undefined);
    const sessionMessages = currentSessionId ? sessionMessageRecords : EMPTY_MESSAGES;
    const compactionBoundaryAt = React.useMemo(
        () => getLatestCompactionBoundaryAt(sessionMessages),
        [sessionMessages],
    );
    const messagePagination = useSessionMessagePagination(
        currentSessionDirectory ?? syncDirectory,
        currentSessionId,
    );

    // Sessions from sync system
    const sessions = useSessions(currentSessionDirectory ?? undefined);

    // Plan-proposed transitions live in the sync layer (sync-context.tsx →
    // detectAndMarkPlanProposed on session.idle) so background sessions get
    // the badge too, not just the currently mounted one.

    // Session status from sync system
    const sessionStatusForCurrent = useSessionStatus(currentSessionId ?? '', currentSessionDirectory ?? undefined);
    const effectiveSessionStatusForCurrent = sessionStatusForCurrent ?? IDLE_SESSION_STATUS;

    const blockingRequestsSelector = React.useMemo(
        () => createScopedBlockingRequestsSelector<PermissionRequest, QuestionRequest>(currentSessionId),
        [currentSessionId],
    );
    const blockingRequests = useDirectorySync(blockingRequestsSelector, currentSessionDirectory ?? undefined);
    const sessionPermissions = blockingRequests.permissions.length > 0
        ? blockingRequests.permissions
        : EMPTY_PERMISSIONS;
    const sessionQuestions = blockingRequests.questions.length > 0
        ? blockingRequests.questions
        : EMPTY_QUESTIONS;
    const sessionMessageInfos = React.useMemo(
        () => sessionMessages.map((record) => record.info),
        [sessionMessages],
    );
    const sessionIsWorking = React.useMemo(() => {
        if (!currentSessionId || sessionQuestions.length > 0) {
            return false;
        }

        return isSessionWorkingFromState({
            status: sessionStatusForCurrent,
            permissions: sessionPermissions,
            messages: sessionMessageInfos,
        });
    }, [currentSessionId, sessionMessageInfos, sessionPermissions, sessionQuestions.length, sessionStatusForCurrent]);
    const activeRetryStatus = React.useMemo(() => {
        if (!currentSessionId || effectiveSessionStatusForCurrent.type !== 'retry') {
            return null;
        }

        const rawMessage = typeof (effectiveSessionStatusForCurrent as { message?: string }).message === 'string'
            ? (((effectiveSessionStatusForCurrent as { message?: string }).message) ?? '').trim()
            : '';

        return {
            sessionId: currentSessionId,
            message: rawMessage || DEFAULT_RETRY_MESSAGE,
            confirmedAt: (effectiveSessionStatusForCurrent as { confirmedAt?: number }).confirmedAt,
            attempt: (effectiveSessionStatusForCurrent as { attempt?: number }).attempt,
            next: (effectiveSessionStatusForCurrent as { next?: number }).next,
        };
    }, [currentSessionId, effectiveSessionStatusForCurrent]);
    const visibleRetryStatus = useRetryVisibility(activeRetryStatus);
    const [retryFallbackTimestamp, setRetryFallbackTimestamp] = React.useState<number>(0);
    const retryFallbackSessionRef = React.useRef<string | null>(null);
    const focusResyncInFlightRef = React.useRef<Set<string>>(new Set());

    React.useEffect(() => {
        if (!visibleRetryStatus || typeof visibleRetryStatus.confirmedAt === 'number') {
            retryFallbackSessionRef.current = null;
            setRetryFallbackTimestamp(0);
            return;
        }

        if (retryFallbackSessionRef.current !== visibleRetryStatus.sessionId) {
            retryFallbackSessionRef.current = visibleRetryStatus.sessionId;
            setRetryFallbackTimestamp(Date.now());
        }
    }, [visibleRetryStatus]);

    const retryOverlay = React.useMemo(() => {
        if (!visibleRetryStatus) {
            return null;
        }

        return {
            ...visibleRetryStatus,
            fallbackTimestamp: retryFallbackTimestamp,
        };
    }, [visibleRetryStatus, retryFallbackTimestamp]);

    // History metadata comes from the shared per-session pagination owner so a
    // cache-only session open rerenders when its first-page metadata arrives.
    const historyMeta = React.useMemo(() => {
        if (!currentSessionId) return null;
        return {
            limit: sessionMessages.length,
            complete: messagePagination.initialized
                ? messagePagination.complete || !messagePagination.cursor
                : true,
            loading: messagePagination.loading,
        };
    }, [currentSessionId, messagePagination, sessionMessages.length]);

    const { isMobile } = useDeviceInfo();
    const draftOpen = Boolean(currentDraftId && newSessionDraft?.open);
    const isDesktopExpandedInput = isExpandedInput && !isMobile;
    const messageListRef = React.useRef<MessageListHandle | null>(null);

    const parentSession = React.useMemo(() => {
        if (!currentSessionId) return null;
        const current = sessions.find((session) => session.id === currentSessionId);
        const parentID = current?.parentID;
        if (!parentID) return null;
        return sessions.find((session) => session.id === parentID)
            ?? getAllSyncSessions().find((session) => session.id === parentID)
            ?? null;
    }, [currentSessionId, sessions]);

    const handleReturnToParentSession = React.useCallback(() => {
        if (!parentSession) return;
        const parentDirectory = (parentSession as Session & { directory?: string | null }).directory ?? null;
        setCurrentSession(parentSession.id, parentDirectory);
    }, [parentSession, setCurrentSession]);

    const returnToParentButton = parentSession ? (
        <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={handleReturnToParentSession}
            className="absolute left-3 top-3 z-20 normal-case !font-normal bg-[var(--surface-background)]/95"
            aria-label={t('chat.container.returnToParent.aria')}
            title={parentSession.title?.trim()
                ? t('chat.container.returnToParent.titleNamed', { title: parentSession.title })
                : t('chat.container.returnToParent.title')}
        >
            <RiArrowLeftLine className="h-4 w-4" />
            {t('chat.container.returnToParent.label')}
        </Button>
    ) : null;

    React.useEffect(() => {
        if (autoOpenDraft && !currentSessionId && !currentDraftId) {
            openNewSessionDraft();
        }
    }, [autoOpenDraft, currentDraftId, currentSessionId, openNewSessionDraft]);

    const activeTurnChangeRef = React.useRef<(turnId: string | null) => void>(() => {});
    const handleActiveTurnChange = React.useCallback((turnId: string | null) => {
        activeTurnChangeRef.current(turnId);
    }, []);

    const {
        scrollRef,
        notifyContentChange: handleMessageContentChange,
        getAnimationHandlers,
        goToBottom,
        releaseAutoFollow,
        restoreSnapshot,
        isPinned,
        isFollowingProgrammatically,
        showScrollButton,
    } = useChatAutoFollow({
        currentSessionId,
        sessionMessageCount,
        sessionIsWorking,
        isMobile,
        onActiveTurnChange: handleActiveTurnChange,
    });

    const viewportMessages = sessionMessages;

    const timelineController = useChatTimelineController({
        sessionId: currentSessionId,
        messages: viewportMessages,
        historyMeta,
        scrollRef,
        messageListRef,
        loadMoreMessages,
        goToBottom,
        releaseAutoFollow,
        isPinned,
        showScrollButton,
    });
    const { loadEarlier } = timelineController;

    const resumeToLatestInstant = React.useCallback(() => {
        goToBottom('instant');
    }, [goToBottom]);

    React.useEffect(() => {
        activeTurnChangeRef.current = timelineController.handleActiveTurnChange;
    }, [timelineController.handleActiveTurnChange]);

    React.useEffect(() => {
        if (sessionPermissions.length === 0 && sessionQuestions.length === 0) {
            return;
        }
        handleMessageContentChange('permission');
    }, [handleMessageContentChange, sessionPermissions, sessionQuestions]);

    const handleLoadOlder = React.useCallback(() => {
        void loadEarlier();
    }, [loadEarlier]);

    const navigation = useChatTurnNavigation({
        sessionId: currentSessionId,
        turnIds: timelineController.turnIds,
        activeTurnId: timelineController.activeTurnId,
        scrollToTurn: timelineController.scrollToTurn,
        scrollToMessage: timelineController.scrollToMessage,
        resumeToBottom: timelineController.resumeToBottomInstant,
    });

    React.useEffect(() => {
        if (typeof window === 'undefined' || !currentSessionId) return;

        const handleForceScrollBottom = (event: Event) => {
            const customEvent = event as CustomEvent<ChatForceScrollBottomEventDetail>;
            if (customEvent.detail?.sessionId && customEvent.detail.sessionId !== currentSessionId) return;
            goToBottom('instant');
        };

        window.addEventListener(CHAT_FORCE_SCROLL_BOTTOM_EVENT, handleForceScrollBottom as EventListener);
        return () => {
            window.removeEventListener(CHAT_FORCE_SCROLL_BOTTOM_EVENT, handleForceScrollBottom as EventListener);
        };
    }, [currentSessionId, goToBottom]);

    React.useEffect(() => {
        if (typeof window === 'undefined' || !currentSessionId || isDesktopExpandedInput) {
            return;
        }

        const handleChatTurnKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.isComposing) {
                return;
            }

            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
                return;
            }

            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
                return;
            }

            const { activeMainTab } = useUIStore.getState();
            if (activeMainTab !== 'chat' || hasBlockingChatOverlay()) {
                return;
            }

            const scrollContainer = scrollRef.current;
            if (shouldIgnoreChatNavigationForFocus(document.activeElement, scrollContainer)) {
                return;
            }

            if (shouldIgnoreChatNavigationTarget(event.target)) {
                return;
            }

            event.preventDefault();
            const offset = event.key === 'ArrowUp' ? -1 : 1;
            void navigation.scrollByTurnOffset(offset, { resumePastEnd: false });
        };

        window.addEventListener('keydown', handleChatTurnKeyDown);
        return () => {
            window.removeEventListener('keydown', handleChatTurnKeyDown);
        };
    }, [currentSessionId, isDesktopExpandedInput, navigation, scrollRef]);


    React.useLayoutEffect(() => {
        const container = scrollRef.current;
        if (!container) return;

        const updateChatScrollHeight = () => {
            container.style.setProperty('--chat-scroll-height', `${container.clientHeight}px`);
        };

        updateChatScrollHeight();

        let rafId = 0;
        const scheduleUpdate = () => {
            if (rafId) return;
            rafId = requestAnimationFrame(() => {
                rafId = 0;
                updateChatScrollHeight();
            });
        };

        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', scheduleUpdate);
            return () => {
                if (rafId) cancelAnimationFrame(rafId);
                window.removeEventListener('resize', scheduleUpdate);
            };
        }

        const resizeObserver = new ResizeObserver(scheduleUpdate);
        resizeObserver.observe(container);

        return () => {
            if (rafId) cancelAnimationFrame(rafId);
            resizeObserver.disconnect();
        };
    }, [currentSessionId, isDesktopExpandedInput, scrollRef]);

    const lastScrolledSessionRef = React.useRef<string | null>(null);

    const isSessionHydrating =
        Boolean(currentSessionId)
        && !hasRenderableSessionSnapshot;

    React.useEffect(() => {
        if (!currentSessionId) return;
        if (lastScrolledSessionRef.current === currentSessionId) return;

        const hasHashTarget = typeof window !== 'undefined' && window.location.hash.length > 0;
        lastScrolledSessionRef.current = currentSessionId;
        if (hasHashTarget) {
            // Hash navigation handler will scroll to target; we just release auto-follow.
            releaseAutoFollow();
            return;
        }

        const run = () => {
            // Opening/switching chats should reveal the latest turn by default;
            // saved scroll positions remain available for callers that explicitly
            // request snapshot restoration.
            void restoreSnapshot({ mode: 'latest' });
        };
        if (typeof window === 'undefined') {
            run();
        } else {
            window.requestAnimationFrame(run);
        }
    }, [currentSessionId, releaseAutoFollow, restoreSnapshot]);

    React.useEffect(() => {
        if (!currentSessionId) return;
        // Decision: run the materializer on every session open, even when the
        // current message snapshot is renderable, so missing pagination metadata
        // is repaired without the user clicking "Load Older Messages" first.
        void ensureSessionRenderable(currentSessionId);
    }, [currentSessionId, ensureSessionRenderable]);

    React.useEffect(() => {
        if (!currentSessionId) return;
        const lastMessage = sessionMessageInfos[sessionMessageInfos.length - 1] as Message | undefined;
        const hasStaleTrailingAssistant = Boolean(
            lastMessage
            && lastMessage.role === 'assistant'
            && typeof (lastMessage as { time?: { completed?: number } }).time?.completed !== 'number'
        );
        const statusType = sessionStatusForCurrent?.type;
        const statusAllowsFocusResync = statusType !== 'busy' && statusType !== 'retry';
        const needsFocusResync = statusAllowsFocusResync && (
            !sessionStatusForCurrent
            || hasStaleTrailingAssistant
            || !hasRenderableSessionSnapshot
        );
        if (needsFocusResync) {
            const resyncKey = `${currentSessionDirectory ?? ''}\n${currentSessionId}`;
            if (focusResyncInFlightRef.current.has(resyncKey)) {
                return;
            }
            focusResyncInFlightRef.current.add(resyncKey);
            void sync.resyncSession(currentSessionId, {
                directory: currentSessionDirectory,
                reason: 'focus',
            }).catch(() => undefined).finally(() => {
                focusResyncInFlightRef.current.delete(resyncKey);
            });
        }
    }, [
        currentSessionId,
        currentSessionDirectory,
        hasRenderableSessionSnapshot,
        sessionMessageInfos,
        sessionStatusForCurrent,
        sync,
    ]);

	if (!currentSessionId && !draftOpen) {
		return (
			<div className="flex flex-col h-full bg-background">
				<ChatEmptyState />
			</div>
		);
	}

	if (!currentSessionId && draftOpen) {
		return (
			<div className="relative flex flex-col h-full bg-background transform-gpu">
				{!isDesktopExpandedInput ? (
				<div className="flex-1 flex items-center justify-center">
					<ChatEmptyState />
				</div>
				) : null}
                <div
                    className={cn(
                        'relative z-10',
						isDesktopExpandedInput
							? 'flex-1 min-h-0 bg-background'
							: 'bg-background'
					)}
				>
						<ChatInput scrollToBottom={resumeToLatestInstant} />
				</div>
			</div>
        );
    }

    if (!currentSessionId) {
        return null;
    }

	if (isSessionHydrating && sessionMessages.length === 0 && !sessionIsWorking) {
		return (
			<div className="relative flex flex-col h-full bg-background">
				{returnToParentButton}
				<div
					className={cn(
						'relative min-h-0',
                        isDesktopExpandedInput
                            ? 'absolute inset-0 opacity-0 pointer-events-none'
                            : 'flex-1'
                    )}
                    aria-hidden={isDesktopExpandedInput}
                >
                    <div className="absolute inset-0 overflow-y-auto overflow-x-hidden bg-background pt-6" style={CHAT_SCROLL_STYLE}>
                        <div className="space-y-4">
                            {HYDRATING_SKELETON_ITEMS.map((item) => (
                                <div key={item.id} className="group w-full">
                                    <div className="chat-message-column">
                                        <div className="space-y-2.5 px-4 py-3">
                                            <div className="space-y-1.5">
                                                {item.toolRows.map((row) => {
                                                    return (
                                                        <div key={`${item.id}-${row.id}`} className="flex items-center gap-2">
                                                            <Skeleton className="h-3.5 w-3.5 rounded-full flex-shrink-0" />
                                                            <Skeleton className={cn('h-4 rounded-md', row.titleWidth)} />
                                                            <Skeleton className={cn('h-4 rounded-md', row.detailWidth)} />
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                            <div className="space-y-1.5 pt-1">
                                                <Skeleton className={cn('h-4 rounded-md', item.textWidths[0])} />
                                                <Skeleton className={cn('h-4 rounded-md', item.textWidths[1])} />
                                                <Skeleton className={cn('h-4 rounded-md', item.textWidths[2])} />
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
                <div
                    className={cn(
                        'relative z-10',
						isDesktopExpandedInput
							? 'flex-1 min-h-0 bg-background'
							: 'bg-background'
					)}
				>
					<ChatInput scrollToBottom={resumeToLatestInstant} />
				</div>
            </div>
        );
    }

	if (sessionMessages.length === 0 && !sessionIsWorking) {
		return (
			<div className="relative flex flex-col h-full bg-background transform-gpu">
				{returnToParentButton}
				<div
					className={cn(
                        'relative min-h-0',
                        isDesktopExpandedInput
                            ? 'absolute inset-0 opacity-0 pointer-events-none'
                            : 'flex-1'
                    )}
                    aria-hidden={isDesktopExpandedInput}
                >
                    {!isDesktopExpandedInput ? (
                        <div className="absolute inset-0 flex items-center justify-center">
                            <ChatEmptyState />
                        </div>
                    ) : null}
                </div>
                <div
                    className={cn(
                        'relative z-10',
						isDesktopExpandedInput
							? 'flex-1 min-h-0 bg-background'
							: 'bg-background'
					)}
				>
					<ChatInput scrollToBottom={resumeToLatestInstant} />
				</div>
            </div>
        );
    }

	return (
		<div className="relative flex flex-col h-full bg-background">
			{returnToParentButton}
			<ChatViewport
                currentSessionId={currentSessionId}
                isDesktopExpandedInput={isDesktopExpandedInput}
                isMobile={isMobile}
                scrollRef={scrollRef}
                messageListRef={messageListRef}
                turnStart={timelineController.turnStart}
                renderedMessages={timelineController.renderedMessages}
                compactionBoundaryAt={compactionBoundaryAt}
                hasMoreAboveTurns={timelineController.historySignals.hasMoreAboveTurns}
                isLoadingOlder={timelineController.isLoadingOlder}
                sessionIsWorking={sessionIsWorking}
                streamingMessageId={streamingMessageId}
                activeStreamingPhase={activeStreamingPhase}
                retryOverlay={retryOverlay}
                handleMessageContentChange={handleMessageContentChange}
                getAnimationHandlers={getAnimationHandlers}
                handleLoadOlder={handleLoadOlder}
                scrollToBottom={resumeToLatestInstant}
                sessionQuestions={sessionQuestions}
                sessionPermissions={sessionPermissions}
                isProgrammaticFollowActive={isFollowingProgrammatically}
            />

            <div
                className={cn(
                    'relative z-10',
                    isDesktopExpandedInput
                        ? 'flex-1 min-h-0 bg-background'
                        : 'bg-background'
                )}
            >
                {!isDesktopExpandedInput && sessionMessages.length > 0 && (
                    <ScrollToBottomButton
                        visible={timelineController.showScrollToBottom}
                        onClick={navigation.resumeToLatest}
                    />
                )}
                <ChatInput scrollToBottom={resumeToLatestInstant} />
            </div>

            <DeferredChatDialog active={isTimelineDialogOpen}>
                <LazyViewBoundary>
                    <LazyTimelineDialog
                        open={isTimelineDialogOpen}
                        onOpenChange={setTimelineDialogOpen}
                        onScrollToMessage={timelineController.scrollToMessage}
                        onScrollByTurnOffset={navigation.scrollByTurnOffset}
                        onResumeToLatest={resumeToLatestInstant}
                    />
                </LazyViewBoundary>
            </DeferredChatDialog>
        </div>
    );
};
