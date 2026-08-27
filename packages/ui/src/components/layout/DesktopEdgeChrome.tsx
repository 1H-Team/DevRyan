import React, { useEffect } from 'react';
import { RiSearchLine } from '@remixicon/react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  SidebarLeftCollapseIcon,
  SidebarLeftExpandIcon,
} from '@/components/icons/ToolbarIcons';
import { useUIStore } from '@/stores/useUIStore';
import { useTabletStandalonePwaRuntime } from '@/lib/device';
import { cn } from '@/lib/utils';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import {
  getDesktopChromeLeftInset,
  getDesktopChromeLeftInsetClassName,
} from '@/components/layout/desktopChromeInsets';
import { DESKTOP_HEADER_ICON_BUTTON_CLASS } from '@/components/layout/headerIconButton';
import { DesktopRightChromeActions } from '@/components/layout/DesktopRightChromeActions';
import { BotSidebarControlButton } from '@/components/layout/BotSidebarControlButton';

interface DesktopEdgeChromeProps {
  hideActions: boolean;
  isMobile: boolean;
  botMode?: boolean;
  browserActionPortalRef?: React.Ref<HTMLSpanElement>;
}

export const DesktopEdgeChrome: React.FC<DesktopEdgeChromeProps> = ({
  hideActions,
  isMobile,
  botMode = false,
  browserActionPortalRef,
}) => {
  const { t } = useI18n();
  const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const isSessionSearchOpen = useUIStore((state) => state.isSessionSearchOpen);
  const setSessionSearchOpen = useUIStore((state) => state.setSessionSearchOpen);
  const isRightSidebarOpen = useUIStore((state) => state.isRightSidebarOpen);
  const toggleRightSidebar = useUIStore((state) => state.toggleRightSidebar);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);

  const isTabletStandalonePwa = useTabletStandalonePwaRuntime();
  const [isDesktopApp, setIsDesktopApp] = React.useState(() => isDesktopShell());
  const isMacPlatform = React.useMemo(() => {
    if (typeof navigator === 'undefined') {
      return false;
    }
    return /Macintosh|Mac OS X/.test(navigator.userAgent || '');
  }, []);
  const [isDesktopWindowFullscreen, setIsDesktopWindowFullscreen] = React.useState(false);
  const isVSCode = isVSCodeRuntime();

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    setIsDesktopApp(isDesktopShell());
  }, []);

  useEffect(() => {
    if (!isDesktopApp || !isMacPlatform) {
      setIsDesktopWindowFullscreen(false);
      return;
    }

    let disposed = false;
    let unlistenResize: (() => void) | null = null;

    const syncFullscreenState = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const currentWindow = getCurrentWindow();
        const fullscreen = await currentWindow.isFullscreen();
        if (!disposed) {
          setIsDesktopWindowFullscreen(fullscreen);
        }
      } catch {
        if (!disposed) {
          setIsDesktopWindowFullscreen(false);
        }
      }
    };

    const attach = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const currentWindow = getCurrentWindow();
        unlistenResize = await currentWindow.onResized(() => {
          void syncFullscreenState();
        });
      } catch {
        // Ignore listener setup failures; fallback state remains false.
      }
    };

    void syncFullscreenState();
    void attach();

    return () => {
      disposed = true;
      if (unlistenResize) {
        unlistenResize();
      }
    };
  }, [isDesktopApp, isMacPlatform]);

  const avoidMacTrafficLights = (isDesktopApp && isMacPlatform && !isDesktopWindowFullscreen) || isTabletStandalonePwa;
  const leftInsetClassName = getDesktopChromeLeftInsetClassName({ avoidMacTrafficLights });
  const leftInsetValue = getDesktopChromeLeftInset({ avoidMacTrafficLights });

  const macosMajorVersion = React.useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    const injected = (window as unknown as { __OPENCHAMBER_MACOS_MAJOR__?: unknown }).__OPENCHAMBER_MACOS_MAJOR__;
    if (typeof injected === 'number' && Number.isFinite(injected) && injected > 0) {
      return injected;
    }

    if (typeof navigator === 'undefined') {
      return null;
    }
    const match = (navigator.userAgent || '').match(/Mac OS X (\d+)[._](\d+)/);
    if (!match) {
      return null;
    }
    const first = Number.parseInt(match[1], 10);
    const second = Number.parseInt(match[2], 10);
    if (Number.isNaN(first)) {
      return null;
    }
    return first === 10 ? second : first;
  }, []);

  const macosHeaderSizeClass = React.useMemo(() => {
    if (!isDesktopApp || !isMacPlatform || macosMajorVersion === null) {
      return '';
    }
    if (macosMajorVersion >= 26) {
      return 'h-12';
    }
    if (macosMajorVersion <= 15) {
      return 'h-14';
    }
    return '';
  }, [isDesktopApp, isMacPlatform, macosMajorVersion]);

  const shortcutLabel = React.useCallback((actionId: string) => {
    return formatShortcutForDisplay(getEffectiveShortcutCombo(actionId, shortcutOverrides));
  }, [shortcutOverrides]);

  const rightClusterStyle = React.useMemo<React.CSSProperties>(() => ({
    right: 'calc(0.75rem + var(--oc-wco-right-inset, 0px))',
  }), []);

  const botChromeHeightStyle = React.useMemo<React.CSSProperties | undefined>(() => {
    if (!botMode || isDesktopApp || isVSCode) {
      return undefined;
    }

    return {
      height: 'max(3rem, var(--oc-wco-titlebar-height, 0px))',
    };
  }, [botMode, isDesktopApp, isVSCode]);

  if (isMobile || (isVSCode && !botMode)) {
    return null;
  }

  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-x-0 top-0 z-30 select-none',
        botMode ? 'h-12' : 'h-[var(--oc-header-height,56px)]',
        macosHeaderSizeClass,
      )}
      style={{
        ['--oc-desktop-chrome-left' as string]: leftInsetValue,
        ...botChromeHeightStyle,
      }}
      role={botMode ? 'toolbar' : undefined}
      aria-label={botMode ? t('bots.header.toolbarAria') : undefined}
      aria-hidden={false}
      data-bot-edge-controls={botMode || undefined}
    >
      <div
        aria-hidden
        className="app-region-drag pointer-events-auto absolute top-0 left-0 h-full"
        style={{ width: 'var(--oc-desktop-chrome-left, 0.75rem)' }}
      />
      {!hideActions && (isDesktopApp || botMode) && (
        <div
          className={cn(
            'app-region-no-drag pointer-events-auto absolute top-0 flex h-full items-center gap-1.5',
            leftInsetClassName,
          )}
        >
          {botMode ? (
            <BotSidebarControlButton
              side="left"
              open={isSidebarOpen}
              onToggle={toggleSidebar}
            />
          ) : (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={toggleSidebar}
                    className={DESKTOP_HEADER_ICON_BUTTON_CLASS}
                    aria-label={isSidebarOpen
                      ? t('sessions.sidebar.header.actions.closeSessions')
                      : t('header.actions.openSessionsAria')}
                  >
                    {isSidebarOpen ? (
                      <SidebarLeftCollapseIcon className="h-[18px] w-[18px]" />
                    ) : (
                      <SidebarLeftExpandIcon className="h-[18px] w-[18px]" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>
                    {isSidebarOpen
                      ? t('sessions.sidebar.header.actions.closeSessions')
                      : t('header.actions.openSessionsWithShortcut', { shortcut: shortcutLabel('toggle_sidebar') })}
                  </p>
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setSessionSearchOpen(true)}
                    className={DESKTOP_HEADER_ICON_BUTTON_CLASS}
                    aria-label={t('sessions.sidebar.header.actions.searchSessions')}
                    aria-expanded={isSessionSearchOpen}
                  >
                    <RiSearchLine className="h-[18px] w-[18px]" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{t('sessions.sidebar.header.actions.searchSessions')}</p>
                </TooltipContent>
              </Tooltip>
            </>
          )}
        </div>
      )}

      {!hideActions && (
        <div
          className="app-region-no-drag pointer-events-auto absolute top-0 flex h-full items-center"
          style={rightClusterStyle}
        >
          {botMode ? (
            <BotSidebarControlButton
              side="right"
              open={isRightSidebarOpen}
              onToggle={toggleRightSidebar}
            />
          ) : (
            <DesktopRightChromeActions browserActionPortalRef={browserActionPortalRef} />
          )}
        </div>
      )}
    </div>
  );
};
