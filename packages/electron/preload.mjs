import { contextBridge, ipcRenderer } from 'electron';
import { isPrivilegedRendererOrigin } from './origin-policy.mjs';

const eventListeners = new Map();

const readArgValue = (name) => {
  const prefix = `${name}=`;
  const entry = process.argv.find((value) => typeof value === 'string' && value.startsWith(prefix));
  if (!entry) {
    return '';
  }
  return entry.slice(prefix.length);
};

const localOrigin = readArgValue('--openchamber-local-origin');
const serverOrigin = readArgValue('--openchamber-server-origin');
const homeDirectory = readArgValue('--openchamber-home');
const macosMajorRaw = readArgValue('--openchamber-macos-major');
const macosMajor = Number.parseInt(macosMajorRaw, 10);

// Preload re-executes on every cross-origin navigation (we run with
// sandbox:false, per-document). Two separate concerns to balance:
//  - __OPENCHAMBER_ELECTRON__ is a shell-identity flag (no capability).
//    Remote UIs still need it so isDesktopShell() returns true and the
//    window renders with desktop affordances (DesktopHostSwitcher,
//    title bar offsets, etc.). Expose unconditionally.
//  - Sensitive globals and IPC-backed capabilities are gated to the exact
//    app-owned localOrigin (plus file:// / about:blank boot surfaces).
//    Configured remote hosts — including localhost SSH tunnels — may render
//    in Electron but are not treated as privileged local UI.
const currentOrigin = (() => {
  try {
    return typeof location !== 'undefined' ? location.origin : '';
  } catch {
    return '';
  }
})();
const isLocalPage = isPrivilegedRendererOrigin(currentOrigin, localOrigin);
const LOCAL_ONLY_BOT_RUNTIME_COMMANDS = new Set([
  'desktop_bot_runtime_status',
  'desktop_bot_runtime_operation_status',
  'desktop_bot_runtime_setup',
  'desktop_bot_runtime_repair',
  'desktop_bot_runtime_update',
  'desktop_bot_runtime_rollback',
  'desktop_export_bot_recovery',
  'desktop_restore_bot_recovery',
  'desktop_runtime_service_status',
  'desktop_runtime_service_enable',
  'desktop_runtime_service_disable',
  'desktop_runtime_service_open_settings',
]);

const invokeMain = (command, args = {}) => {
  // The startup splash BrowserWindow can be constructed before the in-process
  // server chooses its port, leaving this immutable boot argument empty. In
  // that case defer to main.mjs, which authorizes every privileged invocation
  // against the sender's live URL and the now-authoritative local origin.
  if (localOrigin && !isLocalPage && LOCAL_ONLY_BOT_RUNTIME_COMMANDS.has(command)) {
    return Promise.reject(new Error('Bot runtime IPC is available only to the local DevRyan UI'));
  }
  return ipcRenderer.invoke('openchamber:invoke', command, args);
};

// Remote pages need __OPENCHAMBER_LOCAL_ORIGIN__ so the HostSwitcher knows
// the URL of the Local entry (isDesktopLocalOriginActive() falls back to
// window.location.origin otherwise — wrong on remote). Low risk: the value
// is just "http://127.0.0.1:<port>" which is not exploitable without the
// IPC channel, and CORS on the local server prevents remote-origin fetches.
if (localOrigin) {
  contextBridge.exposeInMainWorld('__OPENCHAMBER_LOCAL_ORIGIN__', localOrigin);
}

if (isLocalPage && serverOrigin) {
  contextBridge.exposeInMainWorld('__OPENCHAMBER_DESKTOP_SERVER__', {
    origin: serverOrigin,
    apiPrefix: '/api',
    opencodePort: null,
    cliAvailable: true,
  });
}

// Home directory leaks the OS username — keep local-only. Remote pages
// operate on the REMOTE server's filesystem, local home is irrelevant
// (and would be misleading if consumed as a workspace hint).
if (isLocalPage && homeDirectory) {
  contextBridge.exposeInMainWorld('__OPENCHAMBER_HOME__', homeDirectory);
}

// macOS major version drives window chrome offsets (traffic lights) — UI
// presentation only, safe to expose.
if (Number.isFinite(macosMajor) && macosMajor > 0) {
  contextBridge.exposeInMainWorld('__OPENCHAMBER_MACOS_MAJOR__', macosMajor);
}

contextBridge.exposeInMainWorld('__OPENCHAMBER_ELECTRON__', {
  runtime: 'electron',
});

// Note: bootOutcome must stay writable from the main world's initScript so
// re-navigations (host switch via deep link) can refresh it. contextBridge-
// exposed globals are read-only, which blocks that update — rely solely on
// the main-process initScript injection (dispatched on did-finish-load).

const addListener = (event, handler) => {
  const listeners = eventListeners.get(event) || new Set();
  listeners.add(handler);
  eventListeners.set(event, listeners);

  return () => {
    const current = eventListeners.get(event);
    if (!current) {
      return;
    }
    current.delete(handler);
    if (current.size === 0) {
      eventListeners.delete(event);
    }
  };
};

const dispatchNativeEvent = (event, detail) => {
  const listeners = eventListeners.get(event);
  if (listeners) {
    for (const listener of listeners) {
      try {
        listener({ payload: detail });
      } catch (error) {
        console.error(`[electron:preload] listener failed for ${event}:`, error);
      }
    }
  }

  try {
    const domEvent = detail === undefined
      ? new Event(event)
      : new CustomEvent(event, { detail });
    window.dispatchEvent(domEvent);
  } catch (error) {
    console.error(`[electron:preload] failed to dispatch DOM event ${event}:`, error);
  }
};

// Main-process events are read-only notifications (update progress,
// window focus, etc.) — safe to deliver to any page rendered in this
// webContents. The events themselves don't grant capability.
ipcRenderer.on('openchamber:emit', (_evt, payload) => {
  if (!payload || typeof payload !== 'object') {
    return;
  }

  const event = typeof payload.event === 'string' ? payload.event : '';
  if (!event) {
    return;
  }

  dispatchNativeEvent(event, payload.detail);
});

// __TAURI__ is exposed on all pages; the main-process gate in
// ipcMain.handle('openchamber:invoke') decides per-command what is safe
// for non-local callers (window/host-switcher ops yes, file/shell ops
// no). See COMMANDS_SAFE_FOR_REMOTE in main.mjs.
contextBridge.exposeInMainWorld('__TAURI__', {
  core: {
    invoke: (cmd, args) => invokeMain(cmd, args || {}),
  },
  dialog: {
    open: (options) => ipcRenderer.invoke('openchamber:dialog:open', options || {}),
  },
  shell: {
    open: (url) => invokeMain('desktop_open_external_url', { url }),
  },
  event: {
    listen: async (event, handler) => addListener(event, handler),
  },
});
