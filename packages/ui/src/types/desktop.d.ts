import type { DesktopBootOutcome } from '@/lib/desktopBoot';

declare global {
  interface Window {
    __DEVRYAN_HOME__?: string;
    __DEVRYAN_MACOS_MAJOR__?: number;
    __DEVRYAN_LOCAL_ORIGIN__?: string;
    __DEVRYAN_ELECTRON__?: { runtime?: string };
    __DEVRYAN_DESKTOP_BOOT_OUTCOME__?: DesktopBootOutcome;
  }
}

export {};
