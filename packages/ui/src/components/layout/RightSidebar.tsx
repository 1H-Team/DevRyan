import React from 'react';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { isDesktopShell, isVSCodeRuntime, startDesktopWindowDrag } from '@/lib/desktop';
import { useTabletStandalonePwaRuntime } from '@/lib/device';

export const RIGHT_SIDEBAR_CONTENT_WIDTH = 420;
const RIGHT_SIDEBAR_MIN_WIDTH = 300;
const RIGHT_SIDEBAR_MAX_WIDTH = 860;

interface RightSidebarProps {
  isOpen: boolean;
  children: React.ReactNode;
  className?: string;
}

export const RightSidebar: React.FC<RightSidebarProps> = ({ isOpen, children, className }) => {
  const { t } = useI18n();
  const rightSidebarWidth = useUIStore((state) => state.rightSidebarWidth);
  const setRightSidebarWidth = useUIStore((state) => state.setRightSidebarWidth);
  const isDesktopApp = React.useMemo(() => isDesktopShell(), []);
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const isTabletStandalonePwa = useTabletStandalonePwaRuntime();
  const [isResizing, setIsResizing] = React.useState(false);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(rightSidebarWidth || 420);
  const resizingWidthRef = React.useRef<number | null>(null);
  const activeResizePointerIDRef = React.useRef<number | null>(null);
  const sidebarRef = React.useRef<HTMLElement | null>(null);

  const [prefersReducedMotion, setPrefersReducedMotion] = React.useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = (event: MediaQueryListEvent) => setPrefersReducedMotion(event.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const clampRightSidebarWidth = React.useCallback((value: number) => {
    return Math.min(RIGHT_SIDEBAR_MAX_WIDTH, Math.max(RIGHT_SIDEBAR_MIN_WIDTH, value));
  }, []);

  const applyLiveWidth = React.useCallback((nextWidth: number) => {
    const sidebar = sidebarRef.current;
    if (!sidebar) {
      return;
    }

    sidebar.style.setProperty('--oc-right-sidebar-width', `${nextWidth}px`);
    sidebar.style.setProperty('--oc-right-sidebar-content-width', `${nextWidth}px`);
  }, []);

  const appliedWidth = isOpen
    ? Math.min(RIGHT_SIDEBAR_MAX_WIDTH, Math.max(RIGHT_SIDEBAR_MIN_WIDTH, rightSidebarWidth || RIGHT_SIDEBAR_CONTENT_WIDTH))
    : 0;

  // Inner content keeps a stable width while the outer aside animates, so the
  // content does not reflow mid-collapse — it slides/fades and is clipped.
  const contentWidth = Math.min(
    RIGHT_SIDEBAR_MAX_WIDTH,
    Math.max(RIGHT_SIDEBAR_MIN_WIDTH, rightSidebarWidth || RIGHT_SIDEBAR_CONTENT_WIDTH)
  );

  const handlePointerDown = (event: React.PointerEvent) => {
    if (!isOpen) {
      return;
    }

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }

    activeResizePointerIDRef.current = event.pointerId;
    setIsResizing(true);
    startXRef.current = event.clientX;
    startWidthRef.current = appliedWidth;
    resizingWidthRef.current = appliedWidth;
    applyLiveWidth(appliedWidth);
    event.preventDefault();
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (!isResizing || activeResizePointerIDRef.current !== event.pointerId) {
      return;
    }

    const delta = startXRef.current - event.clientX;
    const nextWidth = clampRightSidebarWidth(startWidthRef.current + delta);
    if (resizingWidthRef.current === nextWidth) {
      return;
    }

    resizingWidthRef.current = nextWidth;
    applyLiveWidth(nextWidth);
  };

  const handlePointerEnd = (event: React.PointerEvent) => {
    if (activeResizePointerIDRef.current !== event.pointerId) {
      return;
    }

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }

    const finalWidth = clampRightSidebarWidth(resizingWidthRef.current ?? appliedWidth);
    activeResizePointerIDRef.current = null;
    resizingWidthRef.current = null;
    setIsResizing(false);
    setRightSidebarWidth(finalWidth);
  };

  React.useEffect(() => {
    if (!isResizing) {
      resizingWidthRef.current = null;
      activeResizePointerIDRef.current = null;
    }
  }, [isResizing]);

  const handleDragStart = React.useCallback(async (event: React.MouseEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('.app-region-no-drag')) {
      return;
    }
    if (target.closest('button, a, input, select, textarea')) {
      return;
    }
    if (event.button !== 0) {
      return;
    }
    if (!isDesktopApp) {
      return;
    }

    await startDesktopWindowDrag();
  }, [isDesktopApp]);

  const webWindowControlsOverlayStyle = React.useMemo<React.CSSProperties | undefined>(() => {
    if (isDesktopApp || isVSCode) {
      return undefined;
    }

    return {
      paddingLeft: 'calc(0.75rem + var(--oc-wco-left-inset, 0px))',
      paddingRight: 'calc(0.75rem + var(--oc-wco-right-inset, 0px))',
      ...(isTabletStandalonePwa ? { paddingTop: 'var(--oc-safe-area-top, 0px)' } : null),
    };
  }, [isDesktopApp, isTabletStandalonePwa, isVSCode]);

  return (
    <aside
      ref={sidebarRef}
      className={cn(
        'relative flex h-full overflow-hidden border-l border-border/40',
        'bg-sidebar',
        isResizing || prefersReducedMotion ? 'transition-none' : 'transition-[width,min-width,max-width] duration-300 ease-in-out',
        !isOpen && 'border-l-0',
        className,
      )}
      style={{
        width: 'var(--oc-right-sidebar-width)',
        minWidth: 'var(--oc-right-sidebar-width)',
        maxWidth: 'var(--oc-right-sidebar-width)',
        ['--oc-right-sidebar-width' as string]: `${isResizing ? (resizingWidthRef.current ?? appliedWidth) : appliedWidth}px`,
        ['--oc-right-sidebar-content-width' as string]: `${isResizing ? (resizingWidthRef.current ?? contentWidth) : contentWidth}px`,
        overflowX: 'clip',
        contain: 'layout paint style',
        willChange: isResizing || prefersReducedMotion ? 'auto' : 'width',
      }}
      aria-hidden={!isOpen || appliedWidth === 0}
    >
      {isOpen ? (
        <div
          onMouseDown={handleDragStart}
          className={cn(
            'app-region-drag absolute inset-x-0 top-0 z-20',
            'h-[var(--oc-header-height,56px)]',
          )}
          style={webWindowControlsOverlayStyle}
          aria-hidden
        />
      ) : null}
      {isOpen && (
        <div
          className={cn(
            'group absolute left-0 top-0 z-20 flex h-full w-3 cursor-col-resize items-stretch justify-start',
          )}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('sidebar.resize.rightPanelAria')}
        >
          <span
            className={cn(
              'h-full w-[3px] transition-colors group-hover:bg-[var(--interactive-border)]/80',
              isResizing && 'bg-[var(--interactive-border)]'
            )}
            aria-hidden
          />
        </div>
      )}
      <div
        className={cn(
          'relative z-10 flex h-full min-h-0 w-full flex-col',
          isResizing && 'pointer-events-none',
          !isOpen && 'pointer-events-none select-none opacity-0',
          !prefersReducedMotion && !isResizing && 'transition-[transform,opacity] duration-200 ease-out',
        )}
        style={{
          width: 'var(--oc-right-sidebar-content-width)',
          minWidth: 'var(--oc-right-sidebar-content-width)',
          transform: !isOpen && !prefersReducedMotion ? 'translateX(12px)' : 'translateX(0)',
          paddingTop: 'var(--oc-header-height, 56px)',
        }}
        aria-hidden={!isOpen}
      >
        {children}
      </div>
    </aside>
  );
};
