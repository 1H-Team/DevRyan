import React, { useRef, useEffect } from 'react';
import { motion, useDragControls, useMotionValue, animate } from 'motion/react';
import { Header } from './Header';
import { BottomTerminalDock } from './BottomTerminalDock';
import { Sidebar, SIDEBAR_CONTENT_WIDTH } from './Sidebar';
import { RightSidebar, RIGHT_SIDEBAR_CONTENT_WIDTH } from './RightSidebar';
import { RightSidebarTabs } from './RightSidebarTabs';
import { DesktopEdgeChrome } from './DesktopEdgeChrome';
import { ContextPanel } from './ContextPanel';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { CommandPalette } from '../ui/CommandPalette';
import { HelpDialog } from '../ui/HelpDialog';
import { OpenCodeStatusDialog } from '../ui/OpenCodeStatusDialog';
import { SessionSidebar } from '@/components/session/SessionSidebar';
import { SessionDialogs } from '@/components/session/SessionDialogs';
import { DiffWorkerProvider } from '@/contexts/DiffWorkerProvider';
import { MultiRunLauncher } from '@/components/multirun';
import { DrawerProvider } from '@/contexts/DrawerContext';

import { useUIStore } from '@/stores/useUIStore';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { isDesktopShell } from '@/lib/desktop';
import { getSettingsFullPageOverlayClassName } from '@/components/views/SettingsView.styles';
import {
    DeferredLazyView,
    LazyDiffView,
    LazyGitView,
    LazyMultiRunWindow,
    LazyPlanView,
    LazySettingsView,
    LazyTerminalView,
    LazyViewBoundary,
} from '@/components/views/lazyViews';

import { ChatView } from '@/components/views/ChatView';
import {
    getAutoClosedAfterPanelVisibilityChange,
    getResponsivePanelDecision,
    type ResponsivePanelAction,
} from './responsivePanels';

// Mobile drawer width as screen percentage
const MOBILE_DRAWER_WIDTH_PERCENT = 85;
const DESKTOP_SIDEBAR_MIN_WIDTH = 220;
const DESKTOP_SIDEBAR_MAX_WIDTH = 500;
const DESKTOP_RIGHT_SIDEBAR_MIN_WIDTH = 300;
const DESKTOP_RIGHT_SIDEBAR_MAX_WIDTH = 860;

export const MainLayout: React.FC = () => {
    const { t } = useI18n();
    const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
    const isRightSidebarOpen = useUIStore((state) => state.isRightSidebarOpen);
    const isBottomTerminalOpen = useUIStore((state) => state.isBottomTerminalOpen);
    const setRightSidebarOpen = useUIStore((state) => state.setRightSidebarOpen);
    const setBottomTerminalOpen = useUIStore((state) => state.setBottomTerminalOpen);
    const activeMainTab = useUIStore((state) => state.activeMainTab);
    const setIsMobile = useUIStore((state) => state.setIsMobile);
    const isSessionSwitcherOpen = useUIStore((state) => state.isSessionSwitcherOpen);
    const isSettingsDialogOpen = useUIStore((state) => state.isSettingsDialogOpen);
    const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
    const isMultiRunLauncherOpen = useUIStore((state) => state.isMultiRunLauncherOpen);
    const setMultiRunLauncherOpen = useUIStore((state) => state.setMultiRunLauncherOpen);
    const multiRunLauncherPrefillPrompt = useUIStore((state) => state.multiRunLauncherPrefillPrompt);

    const { isMobile, isTablet } = useDeviceInfo();
    const isDesktopShellRuntime = React.useMemo(() => isDesktopShell(), []);
    const sidebarWidth = useUIStore((state) => state.sidebarWidth);
    const rightSidebarWidth = useUIStore((state) => state.rightSidebarWidth);
    const [browserActionPortalTarget, setBrowserActionPortalTarget] = React.useState<HTMLSpanElement | null>(null);
    const rightSidebarAutoClosedRef = React.useRef(false);
    const bottomTerminalAutoClosedRef = React.useRef(false);
    const responsiveRightSidebarChangeRef = React.useRef<ResponsivePanelAction | null>(null);
    const responsiveBottomTerminalChangeRef = React.useRef<ResponsivePanelAction | null>(null);

    // Mobile drawer state
    const [mobileLeftDrawerOpen, setMobileLeftDrawerOpen] = React.useState(false);
    const mobileRightDrawerOpenRef = React.useRef(false);

    // Left drawer motion value
    const leftDrawerX = useMotionValue(0);
    const leftDrawerDragControls = useDragControls();
    const leftDrawerWidth = useRef(0);

    // Right drawer motion value
    const rightDrawerX = useMotionValue(0);
    const rightDrawerWidth = useRef(0);

    // Compute drawer width
    useEffect(() => {
        if (isMobile) {
            leftDrawerWidth.current = window.innerWidth * (MOBILE_DRAWER_WIDTH_PERCENT / 100);
            rightDrawerWidth.current = window.innerWidth * (MOBILE_DRAWER_WIDTH_PERCENT / 100);
        }
    }, [isMobile]);

    // Sync left drawer state and motion value
    useEffect(() => {
        if (!isMobile) return;
        const targetX = mobileLeftDrawerOpen ? 0 : -leftDrawerWidth.current;
        animate(leftDrawerX, targetX, {
            type: "spring",
            stiffness: 400,
            damping: 35,
            mass: 0.8
        });
    }, [mobileLeftDrawerOpen, isMobile, leftDrawerX]);

    // Sync right drawer state and motion value
    useEffect(() => {
        if (!isMobile) return;
        mobileRightDrawerOpenRef.current = isRightSidebarOpen;
        const targetX = isRightSidebarOpen ? 0 : rightDrawerWidth.current;
        animate(rightDrawerX, targetX, {
            type: "spring",
            stiffness: 400,
            damping: 35,
            mass: 0.8
        });
    }, [isMobile, isRightSidebarOpen, rightDrawerX]);

    // Sync session switcher state to left drawer (one-way)
    useEffect(() => {
        if (isMobile) {
            setMobileLeftDrawerOpen(isSessionSwitcherOpen);
        }
    }, [isSessionSwitcherOpen, isMobile]);

    // Ensure mobile drawers are closed when opening full-screen settings
    useEffect(() => {
        if (!isMobile || !isSettingsDialogOpen) {
            return;
        }

        setMobileLeftDrawerOpen(false);
        if (isSessionSwitcherOpen) {
            useUIStore.getState().setSessionSwitcherOpen(false);
        }
        if (isRightSidebarOpen) {
            setRightSidebarOpen(false);
        }
    }, [isMobile, isSettingsDialogOpen, isSessionSwitcherOpen, isRightSidebarOpen, setRightSidebarOpen]);

    // Sync right drawer and git sidebar state
    useEffect(() => {
        if (isMobile) {
            mobileRightDrawerOpenRef.current = isRightSidebarOpen;
        }
    }, [isRightSidebarOpen, isMobile]);

    // Trigger initial update check shortly after mount, then repeat using server-suggested cadence.
    const checkForUpdates = useUpdateStore((state) => state.checkForUpdates);
    React.useEffect(() => {
        const initialDelayMs = 3000;
        const defaultIntervalMs = 60 * 60 * 1000;
        const minIntervalMs = 5 * 60 * 1000;
        const maxIntervalMs = 24 * 60 * 60 * 1000;
        let disposed = false;
        let timer: number | null = null;

        const clampIntervalMs = (seconds: number): number => {
            const ms = Math.round(seconds * 1000);
            return Math.max(minIntervalMs, Math.min(maxIntervalMs, ms));
        };

        const scheduleNext = (delayMs: number) => {
            if (disposed) return;
            timer = window.setTimeout(async () => {
                const suggestedSec = await checkForUpdates();
                const nextDelay = typeof suggestedSec === 'number' && Number.isFinite(suggestedSec)
                    ? clampIntervalMs(suggestedSec)
                    : defaultIntervalMs;
                scheduleNext(nextDelay);
            }, delayMs);
        };

        scheduleNext(initialDelayMs);

        return () => {
            disposed = true;
            if (timer !== null) {
                window.clearTimeout(timer);
            }
        };
    }, [checkForUpdates]);

    React.useEffect(() => {
        const previous = useUIStore.getState().isMobile;
        if (previous !== isMobile) {
            setIsMobile(isMobile);
        }
    }, [isMobile, setIsMobile]);

    React.useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }

        let timeoutId: number | undefined;

        const handleResize = () => {
            if (timeoutId !== undefined) {
                window.clearTimeout(timeoutId);
            }

            timeoutId = window.setTimeout(() => {
                useUIStore.getState().updateProportionalSidebarWidths();
            }, 150);
        };

        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            if (timeoutId !== undefined) {
                window.clearTimeout(timeoutId);
            }
        };
    }, []);

    React.useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }

        let timeoutId: number | undefined;

        const handleResponsivePanels = () => {
            const state = useUIStore.getState();
            const decision = getResponsivePanelDecision({
                width: window.innerWidth,
                height: window.innerHeight,
                isMobile,
                isTablet,
                isRightSidebarOpen: state.isRightSidebarOpen,
                isBottomTerminalOpen: state.isBottomTerminalOpen,
                rightSidebarAutoClosed: rightSidebarAutoClosedRef.current,
                bottomTerminalAutoClosed: bottomTerminalAutoClosedRef.current,
            });

            rightSidebarAutoClosedRef.current = decision.rightSidebarAutoClosed;
            bottomTerminalAutoClosedRef.current = decision.bottomTerminalAutoClosed;

            if (decision.rightSidebarAction === 'close') {
                responsiveRightSidebarChangeRef.current = 'close';
                setRightSidebarOpen(false);
            } else if (decision.rightSidebarAction === 'open') {
                responsiveRightSidebarChangeRef.current = 'open';
                setRightSidebarOpen(true);
            }

            if (decision.bottomTerminalAction === 'close') {
                responsiveBottomTerminalChangeRef.current = 'close';
                setBottomTerminalOpen(false);
            } else if (decision.bottomTerminalAction === 'open') {
                responsiveBottomTerminalChangeRef.current = 'open';
                setBottomTerminalOpen(true);
            }
        };

        const handleResize = () => {
            if (timeoutId !== undefined) {
                window.clearTimeout(timeoutId);
            }

            timeoutId = window.setTimeout(() => {
                handleResponsivePanels();
            }, 100);
        };

        handleResponsivePanels();
        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            if (timeoutId !== undefined) {
                window.clearTimeout(timeoutId);
            }
        };
    }, [isMobile, isTablet, setBottomTerminalOpen, setRightSidebarOpen]);

    React.useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }

        const unsubscribe = useUIStore.subscribe((state, prevState) => {
            if (state.isRightSidebarOpen !== prevState.isRightSidebarOpen) {
                const isResponsiveChange = responsiveRightSidebarChangeRef.current !== null;
                // Manual sidebar changes are treated as user intent and cancel any
                // pending responsive restore; only layout-initiated changes preserve it.
                rightSidebarAutoClosedRef.current = getAutoClosedAfterPanelVisibilityChange({
                    autoClosed: rightSidebarAutoClosedRef.current,
                    didVisibilityChange: true,
                    isResponsiveChange,
                });

                if (isResponsiveChange) {
                    responsiveRightSidebarChangeRef.current = null;
                }
            }

            if (state.isBottomTerminalOpen !== prevState.isBottomTerminalOpen) {
                const isResponsiveChange = responsiveBottomTerminalChangeRef.current !== null;
                bottomTerminalAutoClosedRef.current = getAutoClosedAfterPanelVisibilityChange({
                    autoClosed: bottomTerminalAutoClosedRef.current,
                    didVisibilityChange: true,
                    isResponsiveChange,
                });

                if (isResponsiveChange) {
                    responsiveBottomTerminalChangeRef.current = null;
                }
            }
        });

        return () => {
            unsubscribe();
        };
    }, [isMobile, isTablet, setBottomTerminalOpen, setRightSidebarOpen]);

    const secondaryView = React.useMemo(() => {
        switch (activeMainTab) {
            case 'plan':
                return <LazyViewBoundary><LazyPlanView /></LazyViewBoundary>;
            case 'git':
                return <LazyViewBoundary><LazyGitView /></LazyViewBoundary>;
            case 'diff':
                return <LazyViewBoundary><LazyDiffView /></LazyViewBoundary>;
            case 'terminal':
                return <LazyViewBoundary><LazyTerminalView /></LazyViewBoundary>;
            default:
                return null;
        }
    }, [activeMainTab]);

    const isChatActive = activeMainTab === 'chat';
    const visibleSidebarWidth = React.useMemo(() => {
        const rawWidth = sidebarWidth || SIDEBAR_CONTENT_WIDTH;
        return Math.min(DESKTOP_SIDEBAR_MAX_WIDTH, Math.max(DESKTOP_SIDEBAR_MIN_WIDTH, rawWidth));
    }, [sidebarWidth]);
    const visibleRightSidebarWidth = React.useMemo(() => {
        const rawWidth = rightSidebarWidth || RIGHT_SIDEBAR_CONTENT_WIDTH;
        return Math.min(DESKTOP_RIGHT_SIDEBAR_MAX_WIDTH, Math.max(DESKTOP_RIGHT_SIDEBAR_MIN_WIDTH, rawWidth));
    }, [rightSidebarWidth]);
    const handleLeftDrawerPointerDown = React.useCallback((event: React.PointerEvent<HTMLElement>) => {
        const target = event.target;
        if (target instanceof Element && target.closest('[data-mobile-drawer-drag-lock]')) {
            return;
        }
        leftDrawerDragControls.start(event);
    }, [leftDrawerDragControls]);

    // Memoize sidebar children by JSX identity so that toggling isSidebarOpen /
    // isRightSidebarOpen does NOT recurse React into these heavy trees. Without
    // this, the first frame of the width transition is delayed by SessionSidebar's
    // reconciliation (~2k lines, many store subscriptions), causing a visible stutter.
    const sessionSidebarElement = React.useMemo(() => <SessionSidebar />, []);
    const rightSidebarTabsElement = React.useMemo(() => <ErrorBoundary><RightSidebarTabs /></ErrorBoundary>, []);

    return (
        <DiffWorkerProvider>
            <div
                data-page-scroll-lock="true"
                className={cn(
                    'main-content-safe-area relative h-[100dvh] overflow-hidden',
                    isMobile ? 'flex flex-col' : 'flex',
                    'bg-background'
                )}
            >
                <CommandPalette />
                <HelpDialog />
                <OpenCodeStatusDialog />
                <SessionDialogs />

                {isMobile ? (
                <DrawerProvider value={{
                    leftDrawerOpen: mobileLeftDrawerOpen,
                    rightDrawerOpen: isRightSidebarOpen,
                    toggleLeftDrawer: () => {
                        if (isRightSidebarOpen) {
                            setRightSidebarOpen(false);
                        }
                        setMobileLeftDrawerOpen(!mobileLeftDrawerOpen);
                    },
                    toggleRightDrawer: () => {
                        if (mobileLeftDrawerOpen) {
                            setMobileLeftDrawerOpen(false);
                        }
                        setRightSidebarOpen(!isRightSidebarOpen);
                    },
                    leftDrawerX,
                    rightDrawerX,
                    leftDrawerWidth,
                    rightDrawerWidth,
                    setMobileLeftDrawerOpen,
                    setRightSidebarOpen,
                }}>
                    {/* Mobile: header + drawer mode */}
                    {!isSettingsDialogOpen && <Header 
                        onToggleLeftDrawer={() => {
                            if (isRightSidebarOpen) {
                                setRightSidebarOpen(false);
                            }
                            setMobileLeftDrawerOpen(!mobileLeftDrawerOpen);
                        }}
                        onToggleRightDrawer={() => {
                            if (mobileLeftDrawerOpen) {
                                setMobileLeftDrawerOpen(false);
                            }
                            setRightSidebarOpen(!isRightSidebarOpen);
                        }}
                        leftDrawerOpen={mobileLeftDrawerOpen}
                        rightDrawerOpen={isRightSidebarOpen}
                    />}
                    
                    {/* Backdrop */}
                    <motion.button
                        type="button"
                        initial={false}
                        animate={{
                            opacity: mobileLeftDrawerOpen || isRightSidebarOpen ? 1 : 0,
                            pointerEvents: mobileLeftDrawerOpen || isRightSidebarOpen ? 'auto' : 'none',
                        }}
                        className="fixed left-0 right-0 bottom-0 top-[var(--oc-header-height,56px)] z-40 bg-black/50 cursor-default"
                        onClick={() => {
                            setMobileLeftDrawerOpen(false);
                            setRightSidebarOpen(false);
                        }}
                        aria-label={t('mainLayout.mobile.closeDrawerAria')}
                    />
                    
                    {/* Left drawer (Session) */}
                    <motion.aside
                        drag="x"
                        dragControls={leftDrawerDragControls}
                        dragListener={false}
                        dragElastic={0.08}
                        dragMomentum={false}
                        dragConstraints={{ left: -(leftDrawerWidth.current || window.innerWidth * 0.85), right: 0 }}
                        onPointerDown={handleLeftDrawerPointerDown}
                        style={{
                            width: `${MOBILE_DRAWER_WIDTH_PERCENT}%`,
                            x: leftDrawerX,
                        }}
                        onDragEnd={(_, info) => {
                            const drawerWidthPx = leftDrawerWidth.current || window.innerWidth * 0.85;
                            const threshold = drawerWidthPx * 0.3;
                            const velocityThreshold = 500;
                            const currentX = leftDrawerX.get();
                            
                            const shouldClose = info.offset.x < -threshold || info.velocity.x < -velocityThreshold;
                            const shouldOpen = info.offset.x > threshold || info.velocity.x > velocityThreshold;
                            
                            if (shouldClose) {
                                leftDrawerX.set(-drawerWidthPx);
                                setMobileLeftDrawerOpen(false);
                            } else if (shouldOpen) {
                                leftDrawerX.set(0);
                                setMobileLeftDrawerOpen(true);
                            } else {
                                if (currentX > -drawerWidthPx / 2) {
                                    leftDrawerX.set(0);
                                } else {
                                    leftDrawerX.set(-drawerWidthPx);
                                }
                            }
                        }}
                        className={cn(
                            'fixed left-0 top-[var(--oc-header-height,56px)] z-50 h-[calc(100%-var(--oc-header-height,56px))] bg-background',
                            'cursor-grab active:cursor-grabbing'
                        )}
                        aria-hidden={!mobileLeftDrawerOpen}
                    >
                        <div
                            data-page-scroll-lock="true"
                            className="h-full overflow-hidden flex bg-[var(--surface-background)] shadow-none drawer-safe-area"
                            style={{ backgroundImage: 'linear-gradient(var(--surface-muted), var(--surface-muted))' }}
                        >
                            <div className="flex-1 min-w-0 overflow-hidden flex flex-col" data-page-scroll-lock="true">
                                <ErrorBoundary>
                                    <SessionSidebar mobileVariant />
                                </ErrorBoundary>
                            </div>
                        </div>
                    </motion.aside>
                    
                    {/* Right drawer (Source / Files) */}
                    <motion.aside
                        drag="x"
                        dragElastic={0.08}
                        dragMomentum={false}
                        dragConstraints={{ left: 0, right: rightDrawerWidth.current || window.innerWidth * 0.85 }}
                        style={{
                            width: `${MOBILE_DRAWER_WIDTH_PERCENT}%`,
                            x: rightDrawerX,
                        }}
                        onDragEnd={(_, info) => {
                            const drawerWidthPx = rightDrawerWidth.current || window.innerWidth * 0.85;
                            const threshold = drawerWidthPx * 0.3;
                            const velocityThreshold = 500;
                            const currentX = rightDrawerX.get();
                            
                            const shouldClose = info.offset.x > threshold || info.velocity.x > velocityThreshold;
                            const shouldOpen = info.offset.x < -threshold || info.velocity.x < -velocityThreshold;
                            
                            if (shouldClose) {
                                rightDrawerX.set(drawerWidthPx);
                                setRightSidebarOpen(false);
                            } else if (shouldOpen) {
                                rightDrawerX.set(0);
                                setRightSidebarOpen(true);
                            } else {
                                if (currentX < drawerWidthPx / 2) {
                                    rightDrawerX.set(0);
                                } else {
                                    rightDrawerX.set(drawerWidthPx);
                                }
                            }
                        }}
                        className={cn(
                            'fixed right-0 top-[var(--oc-header-height,56px)] z-50 h-[calc(100%-var(--oc-header-height,56px))] bg-background',
                            'cursor-grab active:cursor-grabbing'
                        )}
                        aria-hidden={!isRightSidebarOpen}
                    >
                        <div className="h-full overflow-hidden flex flex-col bg-background shadow-none drawer-safe-area" data-page-scroll-lock="true">
                            <ErrorBoundary><RightSidebarTabs /></ErrorBoundary>
                        </div>
                    </motion.aside>
                    
                    {/* Main content area (fixed) */}
                    <div
                        data-page-scroll-lock="true"
                        className={cn(
                            'flex flex-1 overflow-hidden relative',
                            isSettingsDialogOpen && 'hidden'
                        )}
                    >
                        <main className="w-full h-full overflow-hidden bg-background relative" data-page-scroll-lock="true">
                            <div className={cn('absolute inset-0', !isChatActive && 'invisible')}>
                                <ErrorBoundary><ChatView /></ErrorBoundary>
                            </div>
                            {secondaryView && (
                                <div className="absolute inset-0">
                                    <ErrorBoundary>{secondaryView}</ErrorBoundary>
                                </div>
                            )}
                            {isMultiRunLauncherOpen && (
                                <div className="absolute inset-0 z-10 bg-background">
                                    <ErrorBoundary>
                                        <MultiRunLauncher
                                            initialPrompt={multiRunLauncherPrefillPrompt}
                                            onCreated={() => setMultiRunLauncherOpen(false)}
                                            onCancel={() => setMultiRunLauncherOpen(false)}
                                        />
                                    </ErrorBoundary>
                                </div>
                            )}
                        </main>
                    </div>
                </DrawerProvider>
            ) : (
                <>
                    {/* Desktop: Sidebar is a left column; header belongs to content column */}
                    <div className="flex flex-1 overflow-hidden relative">
                        <div className={cn(
                            'absolute inset-0 flex overflow-hidden',
                            isDesktopShellRuntime ? 'bg-sidebar' : 'bg-sidebar'
                        )} data-page-scroll-lock="true">
                            {isSidebarOpen ? (
                                <>
                                    <div
                                        aria-hidden
                                        className={cn(
                                            'pointer-events-none absolute top-0 z-0',
                                            isDesktopShellRuntime ? 'bg-sidebar' : 'bg-sidebar'
                                        )}
                                        style={{
                                            left: `${visibleSidebarWidth}px`,
                                            width: '10px',
                                            height: '10px',
                                            WebkitMaskImage: 'radial-gradient(circle at 100% 100%, transparent calc(10px - 1px), black 10px)',
                                            maskImage: 'radial-gradient(circle at 100% 100%, transparent calc(10px - 1px), black 10px)',
                                        }}
                                    />
                                    <div
                                        aria-hidden
                                        className={cn(
                                            'pointer-events-none absolute bottom-0 z-0',
                                            isDesktopShellRuntime ? 'bg-sidebar' : 'bg-sidebar'
                                        )}
                                        style={{
                                            left: `${visibleSidebarWidth}px`,
                                            width: '10px',
                                            height: '10px',
                                            WebkitMaskImage: 'radial-gradient(circle at 100% 0%, transparent calc(10px - 1px), black 10px)',
                                            maskImage: 'radial-gradient(circle at 100% 0%, transparent calc(10px - 1px), black 10px)',
                                        }}
                                    />
                                </>
                            ) : null}
                            {isRightSidebarOpen ? (
                                <>
                                    <div
                                        aria-hidden
                                        className={cn(
                                            'pointer-events-none absolute top-0 z-0',
                                            isDesktopShellRuntime ? 'bg-sidebar' : 'bg-sidebar'
                                        )}
                                        style={{
                                            right: `${visibleRightSidebarWidth}px`,
                                            width: '10px',
                                            height: '10px',
                                            WebkitMaskImage: 'radial-gradient(circle at 0 100%, transparent calc(10px - 1px), black 10px)',
                                            maskImage: 'radial-gradient(circle at 0 100%, transparent calc(10px - 1px), black 10px)',
                                        }}
                                    />
                                    <div
                                        aria-hidden
                                        className={cn(
                                            'pointer-events-none absolute bottom-0 z-0',
                                            isDesktopShellRuntime ? 'bg-sidebar' : 'bg-sidebar'
                                        )}
                                        style={{
                                            right: `${visibleRightSidebarWidth}px`,
                                            width: '10px',
                                            height: '10px',
                                            WebkitMaskImage: 'radial-gradient(circle at 0 0, transparent calc(10px - 1px), black 10px)',
                                            maskImage: 'radial-gradient(circle at 0 0, transparent calc(10px - 1px), black 10px)',
                                        }}
                                    />
                                </>
                            ) : null}
                            <Sidebar
                                isOpen={isSidebarOpen}
                                isMobile={isMobile}
                                className="border-0"
                            >
                                {sessionSidebarElement}
                            </Sidebar>
                            <div className={cn(
                                'relative flex flex-1 min-w-0 flex-col overflow-hidden',
                                'bg-sidebar',
                                isSidebarOpen && 'border-l border-border/50 rounded-tl-[10px] rounded-bl-[10px]',
                                isRightSidebarOpen && 'border-r border-border/50 rounded-tr-[10px] rounded-br-[10px]'
                            )} data-page-scroll-lock="true">
                                <Header browserActionPortalTarget={browserActionPortalTarget} />
                                <div className={cn(
                                    'flex flex-1 min-h-0 overflow-hidden',
                                    isSidebarOpen || isChatActive ? '' : 'border-l border-border/50',
                                    isRightSidebarOpen ? '' : 'border-r border-border/50'
                                )} data-page-scroll-lock="true">
                                    <div className="relative flex flex-1 min-h-0 min-w-0 overflow-hidden" data-page-scroll-lock="true">
                                        <main className="flex-1 overflow-hidden bg-background relative" data-page-scroll-lock="true">
                                            <div className={cn('absolute inset-0', !isChatActive && 'invisible')}>
                                                <ErrorBoundary><ChatView /></ErrorBoundary>
                                            </div>
                                            {secondaryView && (
                                                <div className="absolute inset-0">
                                                    <ErrorBoundary>{secondaryView}</ErrorBoundary>
                                                </div>
                                            )}
                                        </main>
                                        <ContextPanel />
                                    </div>
                                </div>
                                <BottomTerminalDock isOpen={isBottomTerminalOpen} isMobile={isMobile}>
                                    {isBottomTerminalOpen ? (
                                        <LazyViewBoundary>
                                            <LazyTerminalView />
                                        </LazyViewBoundary>
                                    ) : null}
                                </BottomTerminalDock>
                            </div>
                            <RightSidebar
                                isOpen={isRightSidebarOpen}
                                className="border-0"
                            >
                                {rightSidebarTabsElement}
                            </RightSidebar>
                            <DesktopEdgeChrome
                                hideActions={isSettingsDialogOpen}
                                isMobile={isMobile}
                                browserActionPortalRef={setBrowserActionPortalTarget}
                            />
                        </div>

                    </div>
                    <DeferredLazyView active={isMultiRunLauncherOpen}>
                        <LazyViewBoundary>
                            <LazyMultiRunWindow
                                open={isMultiRunLauncherOpen}
                                onOpenChange={setMultiRunLauncherOpen}
                                initialPrompt={multiRunLauncherPrefillPrompt}
                            />
                        </LazyViewBoundary>
                    </DeferredLazyView>
                </>
            )}

                {isSettingsDialogOpen && (
                    <div
                        className={getSettingsFullPageOverlayClassName()}
                        style={isMobile ? { paddingTop: 'var(--oc-safe-area-top, 0px)' } : undefined}
                    >
                        <LazyViewBoundary>
                            <LazySettingsView onClose={() => setSettingsDialogOpen(false)} />
                        </LazyViewBoundary>
                    </div>
                )}

        </div>
    </DiffWorkerProvider>
    );
};
