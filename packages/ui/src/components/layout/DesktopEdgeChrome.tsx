import React, { useEffect } from 'react';
import { RiSearchLine } from '@remixicon/react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { SidebarLeftIcon } from '@/components/icons/ToolbarIcons';
import { useUIStore } from '@/stores/useUIStore';
import { useTabletStandalonePwaRuntime } from '@/lib/device';
import { cn } from '@/lib/utils';
import { isDesktopShell } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import {
  getDesktopChromeLeftInset,
  getDesktopChromeLeftInsetClassName,
} from '@/components/layout/desktopChromeInsets';
import { DESKTOP_HEADER_ICON_BUTTON_CLASS } from '@/components/layout/headerIconButton';
import { DesktopRightChromeActions } from '@/components/layout/DesktopRightChromeActions';

const SidebarLeftExpandIcon = (props: React.ComponentProps<typeof SidebarLeftIcon>) => (
  <SidebarLeftIcon {...props} chevronDirection="right" />
);

interface DesktopEdgeChromeProps {
  hideActions: boolean;
}

export const DesktopEdgeChrome: React.FC<DesktopEdgeChromeProps> = ({ hideActions }) => {
  const { t } = useI18n();
  const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const isSessionSearchOpen = useUIStore((state) => state.isSessionSearchOpen);
  const setSessionSearchOpen = useUIStore((state) => state.setSessionSearchOpen);
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

  if (!isDesktopApp) {
    return null;
  }

  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-x-0 top-0 z-30 h-[var(--oc-header-height,56px)] select-none',
        macosHeaderSizeClass,
      )}
      style={{ ['--oc-desktop-chrome-left' as string]: leftInsetValue }}
      aria-hidden={false}
    >
      <div
        aria-hidden
        className="app-region-drag pointer-events-auto absolute top-0 left-0 h-full"
        style={{ width: 'var(--oc-desktop-chrome-left, 0.75rem)' }}
      />
      {!hideActions && (
        <div
          className={cn(
            'app-region-no-drag pointer-events-auto absolute top-0 flex h-full items-center gap-1.5',
            leftInsetClassName,
          )}
        >
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
                  <SidebarLeftIcon className="h-[18px] w-[18px]" chevronDirection="left" />
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
        </div>
      )}

      {!hideActions && (
        <div
          className="app-region-no-drag pointer-events-auto absolute top-0 flex h-full items-center"
          style={rightClusterStyle}
        >
          <DesktopRightChromeActions />
        </div>
      )}
    </div>
  );
};
