import React from 'react';

import { MessageFreshnessDetector } from '@/lib/messageFreshness';
import { createScrollSpy } from '@/components/chat/lib/scroll/scrollSpy';
import { useViewportStore, type SessionMemoryState } from '@/sync/viewport-store';

export type AutoFollowState = 'following' | 'released';

export type ContentChangeReason = 'text' | 'structural' | 'permission';

export const CHAT_PRESERVE_SCROLL_ANCHOR_EVENT = 'openchamber:chat-preserve-scroll-anchor';
export const CHAT_FORCE_SCROLL_BOTTOM_EVENT = 'openchamber:chat-force-scroll-bottom';

export interface ChatPreserveScrollAnchorEventDetail {
    durationMs?: number;
}

export interface ChatForceScrollBottomEventDetail {
    sessionId?: string;
}

export const requestChatScrollToBottom = (sessionId?: string): void => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent<ChatForceScrollBottomEventDetail>(
        CHAT_FORCE_SCROLL_BOTTOM_EVENT,
        { detail: sessionId ? { sessionId } : {} },
    ));
};

export interface AnimationHandlers {
    onChunk: () => void;
    onComplete: () => void;
    onStreamingCandidate?: () => void;
    onAnimationStart?: () => void;
    onReservationCancelled?: () => void;
    onReasoningBlock?: () => void;
    onAnimatedHeightChange?: (height: number) => void;
}

interface UseChatAutoFollowOptions {
    currentSessionId: string | null;
    sessionMessageCount: number;
    sessionIsWorking: boolean;
    isMobile: boolean;
    onActiveTurnChange?: (turnId: string | null) => void;
}

export interface UseChatAutoFollowResult {
    scrollRef: React.RefObject<HTMLDivElement | null>;
    state: AutoFollowState;
    isPinned: boolean;
    isOverflowing: boolean;
    isFollowingProgrammatically: boolean;
    showScrollButton: boolean;
    notifyContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    goToBottom: (mode?: 'instant' | 'smooth') => void;
    releaseAutoFollow: () => void;
    saveSnapshotNow: () => void;
    restoreSnapshot: (options?: RestoreSnapshotOptions) => Promise<boolean>;
}

export type RestoreSnapshotMode = 'saved-position' | 'latest';

export interface RestoreSnapshotOptions {
    mode?: RestoreSnapshotMode;
}

const BOTTOM_SPACER_DESKTOP_VH = 0.10;
const BOTTOM_SPACER_MOBILE_PX = 40;
const PROGRAMMATIC_WRITE_WINDOW_MS = 200;
const SAVE_DEBOUNCE_MS = 150;
const LERP = 0.18;
const SETTLE_EPSILON = 0.5;
const SETTLE_FRAMES = 4;
const TOUCH_FINGER_DOWN_THRESHOLD = 2;
const SETTLE_BURST_DURATION_MS = 280;
const REPIN_GRACE_AFTER_RELEASE_MS = 1200;
const EXPLICIT_SCROLL_INTENT_WINDOW_MS = 500;
const DEFAULT_ANCHOR_PRESERVATION_MS = 600;

// The bottom of the chat has an empty spacer (10vh on desktop, 40px on mobile)
// — its height is exactly how far above scrollHeight the user can be while still
// looking at "empty" space. We use that same value as the threshold for both
// re-pinning auto-follow and showing the scroll-to-bottom button.
const computeBottomZoneThreshold = (isMobile: boolean, container?: HTMLElement | null): number => {
    if (isMobile) return BOTTOM_SPACER_MOBILE_PX;
    const height = container?.clientHeight ?? 0;
    if (height <= 0) return 96;
    return Math.max(48, height * BOTTOM_SPACER_DESKTOP_VH);
};

const distanceFromBottom = (el: HTMLElement): number => {
    return el.scrollHeight - el.scrollTop - el.clientHeight;
};

const isNearBottom = (el: HTMLElement, isMobile: boolean): boolean => {
    return distanceFromBottom(el) <= computeBottomZoneThreshold(isMobile, el);
};

const isReleaseKey = (event: KeyboardEvent): boolean => {
    if (event.altKey || event.ctrlKey || event.metaKey) {
        return false;
    }
    switch (event.key) {
        case 'ArrowUp':
        case 'PageUp':
        case 'Home':
            return true;
        default:
            return false;
    }
};

const nestedScrollableTarget = (root: HTMLElement, target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof Element)) return null;
    const nested = target.closest('[data-scrollable]');
    if (!nested || nested === root || !(nested instanceof HTMLElement)) return null;
    return nested;
};

const nestedScrollableCanConsumeUp = (root: HTMLElement, target: EventTarget | null): boolean => {
    const nested = nestedScrollableTarget(root, target);
    if (!nested) return false;
    return nested.scrollTop > 0;
};

const isAtBottomSnapshot = (snapshot: NonNullable<SessionMemoryState['scrollPosition']>, isMobile: boolean): boolean => {
    const max = Math.max(0, snapshot.scrollHeight - snapshot.clientHeight);
    if (max <= 0) return true;
    const threshold = computeBottomZoneThreshold(isMobile, null);
    return max - snapshot.scrollTop <= threshold;
};

export const shouldRestoreSavedScrollPosition = (
    mode: RestoreSnapshotMode,
    snapshot: SessionMemoryState['scrollPosition'] | undefined,
    isMobile: boolean,
): snapshot is NonNullable<SessionMemoryState['scrollPosition']> => {
    if (mode !== 'saved-position' || !snapshot) return false;
    return !isAtBottomSnapshot(snapshot, isMobile);
};

export const shouldSettlePinnedIdleTransition = ({
    state,
    previousSessionIsWorking,
    nextSessionIsWorking,
}: {
    state: AutoFollowState;
    previousSessionIsWorking: boolean;
    nextSessionIsWorking: boolean;
}): boolean => {
    return state === 'following' && previousSessionIsWorking && !nextSessionIsWorking;
};

export const shouldSettlePinnedIdleContentChange = ({
    state,
    sessionIsWorking,
}: {
    state: AutoFollowState;
    sessionIsWorking: boolean;
}): boolean => {
    return state === 'following' && !sessionIsWorking;
};

export const shouldReleaseAutoFollowFromScroll = ({
    state,
    previousScrollTop,
    nextScrollTop,
    previousScrollHeight,
    nextScrollHeight,
    isNearBottomAfterScroll,
    isProgrammatic,
    hasExplicitUserIntent,
}: {
    state: AutoFollowState;
    previousScrollTop: number;
    nextScrollTop: number;
    previousScrollHeight?: number;
    nextScrollHeight?: number;
    isNearBottomAfterScroll?: boolean;
    isProgrammatic: boolean;
    hasExplicitUserIntent: boolean;
}): boolean => {
    if (state !== 'following') return false;
    if (isProgrammatic) return false;
    if (!hasExplicitUserIntent) return false;
    if (nextScrollTop >= previousScrollTop) return false;
    const heightChanged = Number.isFinite(previousScrollHeight)
        && Number.isFinite(nextScrollHeight)
        && previousScrollHeight !== nextScrollHeight;
    if (isNearBottomAfterScroll && heightChanged) return false;
    return true;
};

export type PinnedContentFollowAction = 'continuous-follow' | 'idle-settle' | 'none';
export type PinnedFollowWriteMode = 'instant' | 'animated' | 'none';

export const getPinnedContentFollowAction = ({
    state,
    sessionIsWorking,
    anchorPreservationActive = false,
}: {
    state: AutoFollowState;
    sessionIsWorking: boolean;
    anchorPreservationActive?: boolean;
}): PinnedContentFollowAction => {
    if (anchorPreservationActive) return 'none';
    if (state !== 'following') return 'none';
    return sessionIsWorking ? 'continuous-follow' : 'idle-settle';
};

export const getPinnedFollowWriteMode = ({
    action,
    explicitSmoothRequest,
}: {
    action: PinnedContentFollowAction;
    explicitSmoothRequest: boolean;
}): PinnedFollowWriteMode => {
    if (action === 'none') return 'none';
    if (action === 'continuous-follow' && explicitSmoothRequest) return 'animated';
    return 'instant';
};

// While actively streaming we follow the bottom *forward only*. A momentary backward target
// (target < current scrollTop) comes from the virtualizer re-measuring a row smaller for a
// frame; snapping to it makes the viewport jump up and then back down, which reads as scroll
// stutter. Returning null means "hold position this frame"; the idle settle pass lands the
// exact bottom once streaming stops. Pure + exported for unit testing.
export const resolveForwardOnlyFollowTarget = ({
    currentScrollTop,
    scrollHeight,
    clientHeight,
}: {
    currentScrollTop: number;
    scrollHeight: number;
    clientHeight: number;
}): number | null => {
    const target = Math.max(0, scrollHeight - clientHeight);
    return target > currentScrollTop ? target : null;
};

export const useChatAutoFollow = ({
    currentSessionId,
    sessionMessageCount,
    sessionIsWorking,
    isMobile,
    onActiveTurnChange,
}: UseChatAutoFollowOptions): UseChatAutoFollowResult => {
    const scrollRef = React.useRef<HTMLDivElement | null>(null);
    const [containerEl, setContainerEl] = React.useState<HTMLDivElement | null>(null);
    const lastSeenContainerRef = React.useRef<HTMLDivElement | null>(null);

    const [state, setState] = React.useState<AutoFollowState>('following');
    const [isOverflowing, setIsOverflowing] = React.useState(false);
    const [showScrollButton, setShowScrollButton] = React.useState(false);
    const [isFollowingProgrammatically, setIsFollowingProgrammatically] = React.useState(false);

    const stateRef = React.useRef<AutoFollowState>('following');
    const sessionWorkingRef = React.useRef(sessionIsWorking);
    sessionWorkingRef.current = sessionIsWorking;
    const previousSessionIsWorkingRef = React.useRef(sessionIsWorking);
    const sessionMessageCountRef = React.useRef(sessionMessageCount);
    sessionMessageCountRef.current = sessionMessageCount;
    const currentSessionIdRef = React.useRef(currentSessionId);
    currentSessionIdRef.current = currentSessionId;

    const lastSessionIdRef = React.useRef<string | null>(null);
    const programmaticWriteUntilRef = React.useRef(0);
    const followRafRef = React.useRef<number | null>(null);
    const settledFramesRef = React.useRef(0);
    const lastScrollTopRef = React.useRef(0);
    const lastScrollHeightRef = React.useRef(0);
    const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingSaveRef = React.useRef<{ sessionId: string; anchor: number } | null>(null);
    const settleBurstRafRef = React.useRef<number | null>(null);
    const lastUserReleaseAtRef = React.useRef(0);
    const explicitScrollIntentUntilRef = React.useRef(0);
    const anchorPreservationUntilRef = React.useRef(0);
    // When restoreSnapshot is invoked while ChatViewport is still hydrating
    // (skeleton rendered, no scroll container yet), we record the session here
    // so a follow-up effect can replay the restore once the container mounts.
    const pendingInitialRestoreRef = React.useRef<{ sessionId: string; mode: RestoreSnapshotMode } | null>(null);
    const resizeObserverAvailableRef = React.useRef(
        typeof ResizeObserver !== 'undefined',
    );

    const updateViewportAnchor = useViewportStore((s) => s.updateViewportAnchor);

    // Detect when the scroll container DOM element changes (mount, unmount, remount).
    // Without this, listener-attach effects would only ever bind to the element that
    // existed at the hook's first render, missing later mounts (e.g. after first send
    // promotes a draft session to a real chat with messages).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    React.useLayoutEffect(() => {
        if (scrollRef.current !== lastSeenContainerRef.current) {
            lastSeenContainerRef.current = scrollRef.current;
            setContainerEl(scrollRef.current);
        }
    });

    const setStateValue = React.useCallback((next: AutoFollowState) => {
        if (stateRef.current === next) return;
        stateRef.current = next;
        setState(next);
    }, []);

    const markProgrammaticWrite = React.useCallback(() => {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        programmaticWriteUntilRef.current = now + PROGRAMMATIC_WRITE_WINDOW_MS;
    }, []);

    const isInProgrammaticWindow = React.useCallback(() => {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        return now < programmaticWriteUntilRef.current;
    }, []);

    const markExplicitScrollIntent = React.useCallback(() => {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        explicitScrollIntentUntilRef.current = now + EXPLICIT_SCROLL_INTENT_WINDOW_MS;
    }, []);

    const hasExplicitScrollIntent = React.useCallback(() => {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        return now < explicitScrollIntentUntilRef.current;
    }, []);

    const isAnchorPreservationActive = React.useCallback(() => {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        return now < anchorPreservationUntilRef.current;
    }, []);

    const stopFollowLoop = React.useCallback(() => {
        if (followRafRef.current !== null && typeof window !== 'undefined') {
            window.cancelAnimationFrame(followRafRef.current);
        }
        followRafRef.current = null;
        settledFramesRef.current = 0;
        setIsFollowingProgrammatically(false);
    }, []);

    const tickFollow = React.useCallback(() => {
        followRafRef.current = null;
        const container = scrollRef.current;
        if (!container) {
            stopFollowLoop();
            return;
        }
        if (stateRef.current !== 'following' || !sessionWorkingRef.current) {
            stopFollowLoop();
            return;
        }

        const target = Math.max(0, container.scrollHeight - container.clientHeight);
        const current = container.scrollTop;
        const delta = target - current;

        if (Math.abs(delta) <= SETTLE_EPSILON) {
            if (current !== target) {
                markProgrammaticWrite();
                container.scrollTop = target;
                lastScrollTopRef.current = target;
                lastScrollHeightRef.current = container.scrollHeight;
            }
            settledFramesRef.current += 1;
            if (settledFramesRef.current >= SETTLE_FRAMES) {
                stopFollowLoop();
                return;
            }
            followRafRef.current = window.requestAnimationFrame(tickFollow);
            return;
        }

        settledFramesRef.current = 0;
        const next = current + delta * LERP;
        markProgrammaticWrite();
        container.scrollTop = next;
        lastScrollTopRef.current = container.scrollTop;
        lastScrollHeightRef.current = container.scrollHeight;
        followRafRef.current = window.requestAnimationFrame(tickFollow);
    }, [markProgrammaticWrite, stopFollowLoop]);

    const startFollowLoop = React.useCallback(() => {
        if (typeof window === 'undefined') return;
        if (followRafRef.current !== null) return;
        if (stateRef.current !== 'following' || !sessionWorkingRef.current) return;
        settledFramesRef.current = 0;
        setIsFollowingProgrammatically(true);
        followRafRef.current = window.requestAnimationFrame(tickFollow);
    }, [tickFollow]);

    const writeScrollTopInstant = React.useCallback((target: number) => {
        const container = scrollRef.current;
        if (!container) return;
        const max = Math.max(0, container.scrollHeight - container.clientHeight);
        const clamped = Math.max(0, Math.min(target, max));
        markProgrammaticWrite();
        container.scrollTop = clamped;
        lastScrollTopRef.current = container.scrollTop;
        lastScrollHeightRef.current = container.scrollHeight;
    }, [markProgrammaticWrite]);

    const writeScrollBottomInstant = React.useCallback(() => {
        const container = scrollRef.current;
        if (!container) return;
        writeScrollTopInstant(Math.max(0, container.scrollHeight - container.clientHeight));
    }, [writeScrollTopInstant]);

    // Forward-only variant used during active streaming follow: never moves the viewport
    // backward (see resolveForwardOnlyFollowTarget) so virtualizer re-measure jitter doesn't
    // read as scroll stutter.
    const writeScrollBottomForward = React.useCallback(() => {
        const container = scrollRef.current;
        if (!container) return;
        const target = resolveForwardOnlyFollowTarget({
            currentScrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
        });
        if (target === null) return;
        markProgrammaticWrite();
        container.scrollTop = target;
        lastScrollTopRef.current = container.scrollTop;
        lastScrollHeightRef.current = container.scrollHeight;
    }, [markProgrammaticWrite]);

    const stopSettleBurst = React.useCallback(() => {
        if (settleBurstRafRef.current !== null && typeof window !== 'undefined') {
            window.cancelAnimationFrame(settleBurstRafRef.current);
        }
        settleBurstRafRef.current = null;
    }, []);

    const startSettleBurst = React.useCallback(() => {
        if (typeof window === 'undefined') return;
        stopSettleBurst();
        const until = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + SETTLE_BURST_DURATION_MS;
        const tick = () => {
            settleBurstRafRef.current = null;
            if (stateRef.current !== 'following') return;
            const c = scrollRef.current;
            if (!c) return;
            const target = Math.max(0, c.scrollHeight - c.clientHeight);
            if (Math.abs(c.scrollTop - target) > SETTLE_EPSILON) {
                markProgrammaticWrite();
                c.scrollTop = target;
                lastScrollTopRef.current = target;
                lastScrollHeightRef.current = c.scrollHeight;
            }
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            if (now < until) {
                settleBurstRafRef.current = window.requestAnimationFrame(tick);
            }
        };
        settleBurstRafRef.current = window.requestAnimationFrame(tick);
    }, [markProgrammaticWrite, stopSettleBurst]);

    const followPinnedLatestContent = React.useCallback(() => {
        const action = getPinnedContentFollowAction({
            state: stateRef.current,
            sessionIsWorking: sessionWorkingRef.current,
            anchorPreservationActive: isAnchorPreservationActive(),
        });
        const mode = getPinnedFollowWriteMode({
            action,
            explicitSmoothRequest: false,
        });

        if (mode === 'none') {
            return;
        }

        if (mode === 'instant') {
            if (action === 'idle-settle') {
                writeScrollBottomInstant();
                startSettleBurst();
            } else {
                // continuous-follow while streaming: forward-only so virtualizer re-measure
                // jitter never jumps the viewport backward (the observed scroll stutter).
                writeScrollBottomForward();
            }
            return;
        }

        startFollowLoop();
    }, [isAnchorPreservationActive, startFollowLoop, startSettleBurst, writeScrollBottomForward, writeScrollBottomInstant]);

    const followPinnedLatestContentSmooth = React.useCallback(() => {
        const action = getPinnedContentFollowAction({
            state: stateRef.current,
            sessionIsWorking: sessionWorkingRef.current,
            anchorPreservationActive: isAnchorPreservationActive(),
        });
        const mode = getPinnedFollowWriteMode({
            action,
            explicitSmoothRequest: true,
        });

        if (mode === 'none') {
            return;
        }

        if (mode === 'animated') {
            startFollowLoop();
            return;
        }

        writeScrollBottomInstant();
        if (action === 'idle-settle') {
            startSettleBurst();
        }
    }, [isAnchorPreservationActive, startFollowLoop, startSettleBurst, writeScrollBottomInstant]);

    const preserveScrollAnchor = React.useCallback((durationMs: number = DEFAULT_ANCHOR_PRESERVATION_MS) => {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const safeDuration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : DEFAULT_ANCHOR_PRESERVATION_MS;
        anchorPreservationUntilRef.current = Math.max(anchorPreservationUntilRef.current, now + safeDuration);
        stopFollowLoop();
        stopSettleBurst();
        lastUserReleaseAtRef.current = now;
        setStateValue('released');
    }, [setStateValue, stopFollowLoop, stopSettleBurst]);

    const releaseAutoFollow = React.useCallback(() => {
        stopFollowLoop();
        stopSettleBurst();
        lastUserReleaseAtRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
        setStateValue('released');
    }, [setStateValue, stopFollowLoop, stopSettleBurst]);

    const releaseFromUserIntent = React.useCallback(() => {
        markExplicitScrollIntent();
        if (stateRef.current === 'following') {
            stopFollowLoop();
            stopSettleBurst();
            lastUserReleaseAtRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
            setStateValue('released');
        } else {
            lastUserReleaseAtRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
        }
    }, [markExplicitScrollIntent, setStateValue, stopFollowLoop, stopSettleBurst]);

    const goToBottom = React.useCallback((mode: 'instant' | 'smooth' = 'instant') => {
        const container = scrollRef.current;
        setStateValue('following');
        lastUserReleaseAtRef.current = 0;
        if (!container) return;
        if (mode === 'smooth' && sessionWorkingRef.current) {
            followPinnedLatestContentSmooth();
            return;
        }
        const target = Math.max(0, container.scrollHeight - container.clientHeight);
        writeScrollTopInstant(target);
        if (sessionWorkingRef.current) {
            followPinnedLatestContent();
        } else {
            startSettleBurst();
        }
    }, [followPinnedLatestContent, followPinnedLatestContentSmooth, setStateValue, startSettleBurst, writeScrollTopInstant]);

    const flushSave = React.useCallback(() => {
        if (saveTimerRef.current !== null) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
        }
        const pending = pendingSaveRef.current;
        if (!pending) return;
        const container = scrollRef.current;
        if (!container) {
            pendingSaveRef.current = null;
            return;
        }
        updateViewportAnchor(pending.sessionId, pending.anchor, {
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
        });
        pendingSaveRef.current = null;
    }, [updateViewportAnchor]);

    const queueSave = React.useCallback(() => {
        const sessionId = currentSessionIdRef.current;
        if (!sessionId) return;
        const container = scrollRef.current;
        if (!container) return;

        const { scrollTop, scrollHeight, clientHeight } = container;
        const anchorRatio = scrollHeight > 0
            ? (scrollTop + clientHeight / 2) / scrollHeight
            : 0;
        const anchor = Math.floor(anchorRatio * sessionMessageCountRef.current);

        pendingSaveRef.current = { sessionId, anchor };
        if (saveTimerRef.current !== null) return;
        saveTimerRef.current = setTimeout(() => {
            saveTimerRef.current = null;
            flushSave();
        }, SAVE_DEBOUNCE_MS);
    }, [flushSave]);

    const saveSnapshotNow = React.useCallback(() => {
        flushSave();
    }, [flushSave]);

    const restoreSnapshot = React.useCallback(async (options?: RestoreSnapshotOptions): Promise<boolean> => {
        const sessionId = currentSessionIdRef.current;
        if (!sessionId) return false;
        const mode = options?.mode ?? 'saved-position';

        const container = scrollRef.current;
        if (!container) {
            // ChatViewport not mounted yet (e.g., session still hydrating).
            // Record the request and mode so the container-attach effect can replay it.
            pendingInitialRestoreRef.current = { sessionId, mode };
            setStateValue('following');
            return false;
        }
        pendingInitialRestoreRef.current = null;

        const saved = useViewportStore.getState().sessionMemoryState.get(sessionId)?.scrollPosition;

        if (!shouldRestoreSavedScrollPosition(mode, saved, isMobile)) {
            setStateValue('following');
            lastUserReleaseAtRef.current = 0;
            const target = Math.max(0, container.scrollHeight - container.clientHeight);
            writeScrollTopInstant(target);
            if (sessionWorkingRef.current) {
                followPinnedLatestContent();
            }
            startSettleBurst();
            return false;
        }

        const savedMaxScroll = Math.max(0, saved.scrollHeight - saved.clientHeight);
        const ratio = savedMaxScroll > 0 ? saved.scrollTop / savedMaxScroll : 0;
        const currentMaxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
        const targetTop = Math.round(ratio * currentMaxScroll);

        setStateValue('released');
        writeScrollTopInstant(targetTop);

        const memState = useViewportStore.getState().sessionMemoryState.get(sessionId);
        updateViewportAnchor(sessionId, memState?.viewportAnchor ?? 0, {
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
        });

        return true;
    }, [followPinnedLatestContent, isMobile, setStateValue, startSettleBurst, updateViewportAnchor, writeScrollTopInstant]);

    React.useEffect(() => {
        if (!currentSessionId || currentSessionId === lastSessionIdRef.current) {
            return;
        }
        lastSessionIdRef.current = currentSessionId;
        MessageFreshnessDetector.getInstance().recordSessionStart(currentSessionId);
        flushSave();
        stopFollowLoop();
        stopSettleBurst();
        markProgrammaticWrite();
        previousSessionIsWorkingRef.current = sessionIsWorking;
        // Drop any pending restore request inherited from a different session.
        if (pendingInitialRestoreRef.current && pendingInitialRestoreRef.current.sessionId !== currentSessionId) {
            pendingInitialRestoreRef.current = null;
        }
    }, [currentSessionId, flushSave, markProgrammaticWrite, sessionIsWorking, stopFollowLoop, stopSettleBurst]);

    React.useEffect(() => {
        const previousSessionIsWorking = previousSessionIsWorkingRef.current;
        previousSessionIsWorkingRef.current = sessionIsWorking;

        if (!sessionIsWorking) {
            stopFollowLoop();
            if (shouldSettlePinnedIdleTransition({
                state: stateRef.current,
                previousSessionIsWorking,
                nextSessionIsWorking: sessionIsWorking,
            })) {
                writeScrollBottomInstant();
                startSettleBurst();
            }
        } else if (stateRef.current === 'following') {
            writeScrollBottomInstant();
        }
    }, [sessionIsWorking, startSettleBurst, stopFollowLoop, writeScrollBottomInstant]);

    // Replay a deferred restoreSnapshot once ChatViewport mounts. Layout timing
    // keeps the initial bottom/latest placement from painting at a stale offset.
    React.useLayoutEffect(() => {
        if (!containerEl) return;
        const pending = pendingInitialRestoreRef.current;
        if (pending && pending.sessionId === currentSessionId) {
            void restoreSnapshot({ mode: pending.mode });
        }
    }, [containerEl, currentSessionId, restoreSnapshot]);

    const updateOverflowAndButton = React.useCallback(() => {
        const container = scrollRef.current;
        if (!container) {
            setIsOverflowing(false);
            setShowScrollButton(false);
            return;
        }
        const overflowing = container.scrollHeight > container.clientHeight + 1;
        setIsOverflowing(overflowing);
        if (!overflowing) {
            setShowScrollButton(false);
            return;
        }
        const showButton = stateRef.current === 'released' && !isNearBottom(container, isMobile);
        setShowScrollButton(showButton);
    }, [isMobile]);

    const handleScrollEvent = React.useCallback(() => {
        const container = scrollRef.current;
        if (!container) return;

        const programmatic = isInProgrammaticWindow();
        const currentTop = container.scrollTop;
        const previousTop = lastScrollTopRef.current;
        const currentScrollHeight = container.scrollHeight;
        const previousScrollHeight = lastScrollHeightRef.current || currentScrollHeight;
        lastScrollTopRef.current = currentTop;
        lastScrollHeightRef.current = currentScrollHeight;

        updateOverflowAndButton();

        if (programmatic) {
            return;
        }

        if (shouldReleaseAutoFollowFromScroll({
            state: stateRef.current,
            previousScrollTop: previousTop,
            nextScrollTop: currentTop,
            previousScrollHeight,
            nextScrollHeight: currentScrollHeight,
            isNearBottomAfterScroll: isNearBottom(container, isMobile),
            isProgrammatic: programmatic,
            hasExplicitUserIntent: hasExplicitScrollIntent(),
        })) {
            stopFollowLoop();
            stopSettleBurst();
            lastUserReleaseAtRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
            setStateValue('released');
        }

        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const inGrace = (now - lastUserReleaseAtRef.current) < REPIN_GRACE_AFTER_RELEASE_MS;
        if (stateRef.current === 'released' && isNearBottom(container, isMobile) && !inGrace) {
            setStateValue('following');
            if (sessionWorkingRef.current) {
                followPinnedLatestContent();
            }
        }

        queueSave();
    }, [
        hasExplicitScrollIntent,
        isInProgrammaticWindow,
        isMobile,
        queueSave,
        setStateValue,
        followPinnedLatestContent,
        stopFollowLoop,
        stopSettleBurst,
        updateOverflowAndButton,
    ]);

    React.useEffect(() => {
        const container = containerEl;
        if (!container) return;

        const handleWheel = (event: WheelEvent) => {
            if (event.deltaY >= 0) return;
            if (nestedScrollableCanConsumeUp(container, event.target)) return;
            releaseFromUserIntent();
        };

        let touchLastY: number | null = null;
        const handleTouchStart = (event: TouchEvent) => {
            const touch = event.touches.item(0);
            touchLastY = touch ? touch.clientY : null;
        };
        const handleTouchMove = (event: TouchEvent) => {
            const touch = event.touches.item(0);
            if (!touch) {
                touchLastY = null;
                return;
            }
            const previousY = touchLastY;
            touchLastY = touch.clientY;
            if (previousY === null) return;
            const fingerDelta = touch.clientY - previousY;
            if (fingerDelta <= TOUCH_FINGER_DOWN_THRESHOLD) return;
            if (nestedScrollableCanConsumeUp(container, event.target)) return;
            releaseFromUserIntent();
        };
        const handleTouchEnd = () => {
            touchLastY = null;
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (!isReleaseKey(event)) return;
            releaseFromUserIntent();
        };

        const handlePointerDownIntent = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (!target.closest('[data-overlay-scrollbar-thumb]')) return;
            releaseFromUserIntent();
        };

        const handlePreserveScrollAnchor = (event: Event) => {
            const customEvent = event as CustomEvent<ChatPreserveScrollAnchorEventDetail>;
            preserveScrollAnchor(customEvent.detail?.durationMs);
        };

        container.addEventListener('scroll', handleScrollEvent, { passive: true });
        container.addEventListener('wheel', handleWheel, { passive: true });
        container.addEventListener('touchstart', handleTouchStart, { passive: true });
        container.addEventListener('touchmove', handleTouchMove, { passive: true });
        container.addEventListener('touchend', handleTouchEnd, { passive: true });
        container.addEventListener('touchcancel', handleTouchEnd, { passive: true });
        container.addEventListener('keydown', handleKeyDown);
        container.addEventListener(CHAT_PRESERVE_SCROLL_ANCHOR_EVENT, handlePreserveScrollAnchor as EventListener);
        if (typeof window !== 'undefined') {
            window.addEventListener('pointerdown', handlePointerDownIntent, true);
        }

        return () => {
            container.removeEventListener('scroll', handleScrollEvent);
            container.removeEventListener('wheel', handleWheel);
            container.removeEventListener('touchstart', handleTouchStart);
            container.removeEventListener('touchmove', handleTouchMove);
            container.removeEventListener('touchend', handleTouchEnd);
            container.removeEventListener('touchcancel', handleTouchEnd);
            container.removeEventListener('keydown', handleKeyDown);
            container.removeEventListener(CHAT_PRESERVE_SCROLL_ANCHOR_EVENT, handlePreserveScrollAnchor as EventListener);
            if (typeof window !== 'undefined') {
                window.removeEventListener('pointerdown', handlePointerDownIntent, true);
            }
        };
    }, [containerEl, handleScrollEvent, preserveScrollAnchor, releaseFromUserIntent]);

    React.useLayoutEffect(() => {
        const container = containerEl;
        if (!container || typeof ResizeObserver === 'undefined') {
            resizeObserverAvailableRef.current = false;
            return;
        }

        const inner = container.firstElementChild;
        if (!(inner instanceof Element)) {
            resizeObserverAvailableRef.current = false;
            return;
        }

        resizeObserverAvailableRef.current = true;

        const observer = new ResizeObserver(() => {
            updateOverflowAndButton();
            followPinnedLatestContent();
        });

        // Content growth is the authoritative automatic-follow signal. Do not
        // observe the scroll viewport itself: composer/window resizing must not
        // masquerade as transcript growth and compete with content anchoring.
        observer.observe(inner);
        return () => observer.disconnect();
    }, [containerEl, followPinnedLatestContent, updateOverflowAndButton]);

    React.useEffect(() => {
        updateOverflowAndButton();
    }, [sessionMessageCount, updateOverflowAndButton]);

    const notifyContentChange = React.useCallback((_reason?: ContentChangeReason) => {
        void _reason;
        updateOverflowAndButton();
        // ResizeObserver owns normal transcript growth. The fallback keeps
        // older/non-DOM test runtimes functional without creating a second
        // scroll writer in Chromium.
        if (!resizeObserverAvailableRef.current) {
            followPinnedLatestContent();
        }
    }, [followPinnedLatestContent, updateOverflowAndButton]);

    const animationHandlersRef = React.useRef<Map<string, AnimationHandlers>>(new Map());

    const getAnimationHandlers = React.useCallback((messageId: string): AnimationHandlers => {
        const cached = animationHandlersRef.current.get(messageId);
        if (cached) return cached;

        const kick = () => {
            if (!resizeObserverAvailableRef.current) {
                followPinnedLatestContent();
            }
        };

        const handlers: AnimationHandlers = {
            onChunk: kick,
            onComplete: () => {
                updateOverflowAndButton();
                kick();
            },
            onStreamingCandidate: () => {},
            onAnimationStart: () => {},
            onAnimatedHeightChange: kick,
            onReservationCancelled: () => {},
            onReasoningBlock: () => {},
        };
        animationHandlersRef.current.set(messageId, handlers);
        return handlers;
    }, [followPinnedLatestContent, updateOverflowAndButton]);

    React.useEffect(() => {
        return () => {
            stopFollowLoop();
            stopSettleBurst();
            flushSave();
            if (saveTimerRef.current !== null) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
            }
        };
    }, [flushSave, stopFollowLoop, stopSettleBurst]);

    React.useEffect(() => {
        if (!onActiveTurnChange) return;
        const container = containerEl;
        if (!container) return;

        let lastActiveTurnId: string | null = null;
        const spy = createScrollSpy({
            onActive: (turnId) => {
                if (turnId === lastActiveTurnId) return;
                lastActiveTurnId = turnId;
                onActiveTurnChange(turnId);
            },
        });
        spy.setContainer(container);

        const elementByTurnId = new Map<string, HTMLElement>();
        const registerTurnNode = (node: HTMLElement) => {
            const turnId = node.dataset.turnId;
            if (!turnId) return false;
            elementByTurnId.set(turnId, node);
            spy.register(node, turnId);
            return true;
        };
        const unregisterTurnNode = (node: HTMLElement) => {
            const turnId = node.dataset.turnId;
            if (!turnId) return false;
            if (elementByTurnId.get(turnId) !== node) return false;
            elementByTurnId.delete(turnId);
            spy.unregister(turnId);
            return true;
        };
        const collectTurnNodes = (node: Node): HTMLElement[] => {
            if (!(node instanceof HTMLElement)) return [];
            const collected: HTMLElement[] = [];
            if (node.matches('[data-turn-id]')) collected.push(node);
            node.querySelectorAll<HTMLElement>('[data-turn-id]').forEach((el) => collected.push(el));
            return collected;
        };

        container.querySelectorAll<HTMLElement>('[data-turn-id]').forEach(registerTurnNode);
        spy.markDirty();

        const mutationObserver = new MutationObserver((records) => {
            let changed = false;
            records.forEach((record) => {
                record.removedNodes.forEach((node) => {
                    collectTurnNodes(node).forEach((turnNode) => {
                        if (unregisterTurnNode(turnNode)) changed = true;
                    });
                });
                record.addedNodes.forEach((node) => {
                    collectTurnNodes(node).forEach((turnNode) => {
                        if (registerTurnNode(turnNode)) changed = true;
                    });
                });
            });
            if (changed) spy.markDirty();
        });
        mutationObserver.observe(container, { subtree: true, childList: true });

        const onScroll = () => spy.onScroll();
        container.addEventListener('scroll', onScroll, { passive: true });

        return () => {
            container.removeEventListener('scroll', onScroll);
            mutationObserver.disconnect();
            spy.destroy();
        };
    }, [containerEl, onActiveTurnChange]);

    return {
        scrollRef,
        state,
        isPinned: state === 'following',
        isOverflowing,
        isFollowingProgrammatically,
        showScrollButton,
        notifyContentChange,
        getAnimationHandlers,
        goToBottom,
        releaseAutoFollow,
        saveSnapshotNow,
        restoreSnapshot,
    };
};
