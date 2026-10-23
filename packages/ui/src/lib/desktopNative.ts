import { isDesktopShell } from '@/lib/desktop';

type InvokeArgs = Record<string, unknown>;

const isElectronDesktop = (): boolean => {
  return typeof window !== 'undefined' && Boolean((window as { __DEVRYAN_ELECTRON__?: unknown }).__DEVRYAN_ELECTRON__);
};

const getInvoke = () => {
  if (typeof window === 'undefined') {
    return null;
  }
  const tauri = (window as unknown as {
    __TAURI__?: { core?: { invoke?: (cmd: string, args?: InvokeArgs) => Promise<unknown> } };
  }).__TAURI__;
  return typeof tauri?.core?.invoke === 'function' ? tauri.core.invoke : null;
};

export const invokeDesktopCommand = async <TValue = unknown>(
  command: string,
  args?: InvokeArgs,
): Promise<TValue> => {
  const invoke = getInvoke();
  if (!invoke) {
    throw new Error('Desktop runtime is not available');
  }
  return invoke(command, args) as Promise<TValue>;
};

export const startDesktopWindowDrag = async (): Promise<void> => {
  if (!isDesktopShell()) {
    return;
  }

  try {
    if (isElectronDesktop()) {
      await invokeDesktopCommand('desktop_start_window_drag');
      return;
    }

    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().startDragging();
  } catch {
    // ignore
  }
};

export const isDesktopWindowFullscreen = async (): Promise<boolean> => {
  if (!isDesktopShell()) {
    return false;
  }

  try {
    if (!isElectronDesktop()) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      return await getCurrentWindow().isFullscreen();
    }

    return Boolean(await invokeDesktopCommand('desktop_is_window_fullscreen'));
  } catch {
    return false;
  }
};

export const setDesktopWindowTitle = async (title: string): Promise<void> => {
  if (!isDesktopShell()) {
    return;
  }

  try {
    if (!isElectronDesktop()) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().setTitle(title);
      return;
    }

    await invokeDesktopCommand('desktop_set_window_title', { title });
  } catch {
    // ignore
  }
};

export const setDesktopWindowTheme = async (
  themeMode?: string,
  themeVariant?: string,
): Promise<void> => {
  if (!isDesktopShell()) {
    return;
  }

  try {
    if (!isElectronDesktop()) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('desktop_set_window_theme', { themeMode, themeVariant });
      return;
    }

    await invokeDesktopCommand('desktop_set_window_theme', { themeMode, themeVariant });
  } catch {
    // ignore
  }
};

export const getDesktopAppVersion = async (): Promise<string | null> => {
  if (!isDesktopShell()) {
    return null;
  }

  try {
    if (!isElectronDesktop()) {
      const { getVersion } = await import('@tauri-apps/api/app');
      return await getVersion();
    }

    const version = await invokeDesktopCommand('desktop_get_app_version');
    return typeof version === 'string' && version.trim().length > 0 ? version : null;
  } catch {
    return null;
  }
};

export const listenDesktopNativeDragDrop = async (
  handler: (event: unknown) => void,
): Promise<(() => void) | null> => {
  if (!isDesktopShell() || typeof window === 'undefined') {
    return null;
  }

  // Electron uses the renderer's native DOM drag/drop events instead of a
  // separate webview drag listener.
  if (isElectronDesktop()) {
    return null;
  }

  try {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const webviewWindow = getCurrentWebviewWindow();
    return await webviewWindow.onDragDropEvent(handler as never);
  } catch {
    return null;
  }
};
