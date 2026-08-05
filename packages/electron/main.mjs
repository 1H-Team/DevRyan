import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, powerMonitor, powerSaveBlocker, session, shell, systemPreferences, WebContentsView } from 'electron';
import contextMenu from 'electron-context-menu';
import log from 'electron-log/main.js';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import updaterPkg from 'electron-updater';
import { ElectronSshManager } from './ssh-manager.mjs';
import { MacosSpeechManager } from './speech-manager.mjs';
import { clearElectronRuntimeCaches, getElectronRuntimeCacheInfo } from './cache-maintenance.mjs';
import { createKeepAwakeController } from './keep-awake-controller.mjs';
import { finishQuitAfterCleanup } from './quit-cleanup.mjs';
import { persistWindowState } from './window-state-persistence.mjs';
import { buildStartupSplashHtml as buildStartupSplashHtmlFromSettings } from './startup-splash.mjs';
import {
  isAllowedElectronContentUrl,
  isPrivilegedRendererUrl,
  privilegedOriginGuardJs,
} from './origin-policy.mjs';
import {
  BROWSER_WEBVIEW_PARTITION,
  hardenWebviewAttachParams,
  isAllowedWebviewNavigationUrl,
  isAllowedWebviewSourceUrl,
} from './browser-webview-policy.mjs';
import { createBrowserDevToolsController } from './browser-devtools-controller.mjs';
import { createBrowserSurfaceManager } from './browser-surface-manager.mjs';
import { isBenignNavigationAbort } from './browser-navigation-error.mjs';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = process.env.OPENCHAMBER_ELECTRON_DEV === '1' || !app.isPackaged;

const DEEP_LINK_PROTOCOL = 'openchamber';
const APP_USER_MODEL_ID = 'dev.openchamber.desktop';

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
  process.exit(0);
}

// Set the product name early so electron-log derives its log directory as
// ~/Library/Logs/DevRyan/ (not ~/Library/Logs/@openchamber/electron/).
app.setName('DevRyan');
app.setAppUserModelId(APP_USER_MODEL_ID);
app.commandLine.appendSwitch('proxy-bypass-list', '<-loopback>');

try {
  process.chdir(os.homedir());
} catch {
}

log.initialize();
log.transports.file.maxSize = 5 * 1024 * 1024;
log.transports.file.level = 'info';
log.transports.console.level = isDev ? 'debug' : 'warn';

// The in-process web server runs in this same Node process and uses plain
// `console.log/warn/error`. Without piping console through electron-log,
// that output never lands in ~/Library/Logs/DevRyan/main.log and we
// can't diagnose issues (e.g. OpenCode lifecycle, SSE disconnects) after
// the fact. Route all console calls through electron-log so server-side
// diagnostics are persisted.
Object.assign(console, log.functions);

const LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DIAGNOSTICS_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
try {
  const logPath = log.transports.file.getFile().path;
  const logDir = path.dirname(logPath);
  const cutoff = Date.now() - LOG_MAX_AGE_MS;
  for (const entry of fs.readdirSync(logDir)) {
    const candidate = path.join(logDir, entry);
    try {
      const info = fs.statSync(candidate);
      if (info.isFile() && info.mtimeMs < cutoff) {
        fs.unlinkSync(candidate);
      }
    } catch {
    }
  }
} catch {
}

const cleanupExpiredDiagnosticsTemps = async (destination) => {
  const directory = path.dirname(destination);
  const prefix = `.${path.basename(destination)}.diagnostics-`;
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.tmp')) continue;
    const candidate = path.join(directory, entry.name);
    const stat = await fsp.stat(candidate).catch(() => null);
    if (!stat || Date.now() - stat.mtimeMs < DIAGNOSTICS_TEMP_MAX_AGE_MS) continue;
    await fsp.unlink(candidate).catch(() => undefined);
  }
};

try {
  if (!app.isDefaultProtocolClient(DEEP_LINK_PROTOCOL)) {
    app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL);
  }
} catch (error) {
  // log.* not yet initialized at this point; fall back to console.
  console.warn('[electron] failed to register deep-link protocol:', error);
}

const readAppMetadata = () => {
  const candidates = [
    path.join(__dirname, 'package.json'),
    path.join(__dirname, '..', 'package.json'),
    path.join(app.getAppPath?.() || '', 'package.json'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.name === '@openchamber/electron' && typeof parsed.version === 'string') {
        return { name: parsed.name, version: parsed.version };
      }
    } catch {
    }
  }
  return { name: '@openchamber/electron', version: app.getVersion() };
};

const APP_METADATA = readAppMetadata();
const APP_VERSION = APP_METADATA.version;

const DEFAULT_DESKTOP_PORT = 57123;
const MIN_WINDOW_WIDTH = 800;
const MIN_WINDOW_HEIGHT = 520;
const MIN_RESTORE_WINDOW_WIDTH = 900;
const MIN_RESTORE_WINDOW_HEIGHT = 560;
const MINI_CHAT_WINDOW_WIDTH = 520;
const MINI_CHAT_WINDOW_HEIGHT = 760;
const MINI_CHAT_MIN_WINDOW_WIDTH = 360;
const MINI_CHAT_MIN_WINDOW_HEIGHT = 480;
const MAX_CAPTURE_PAGE_RECT_AREA = 4_000_000;
const LOCAL_HOST_ID = 'local';
const ENV_OVERRIDE_HOST_ID = '__env';
const GITHUB_REPOSITORY_OWNER = 'zoubenr';
const GITHUB_REPOSITORY_NAME = 'DevRyan';
const GITHUB_REPOSITORY_URL = `https://github.com/${GITHUB_REPOSITORY_OWNER}/${GITHUB_REPOSITORY_NAME}`;
const GITHUB_REPOSITORY_API_URL =
  `https://api.github.com/repos/${GITHUB_REPOSITORY_OWNER}/${GITHUB_REPOSITORY_NAME}`;
const UPDATE_METADATA_URL = `${GITHUB_REPOSITORY_API_URL}/releases/latest`;
const GITHUB_BUG_REPORT_URL = `${GITHUB_REPOSITORY_URL}/issues/new?template=bug_report.yml`;
const GITHUB_FEATURE_REQUEST_URL = `${GITHUB_REPOSITORY_URL}/issues/new?template=feature_request.yml`;
const DISCORD_INVITE_URL = 'https://discord.gg/ZYRSdnwwKA';
const INSTALLED_APPS_CACHE_TTL_SECS = 60 * 60 * 24;
const INSTALLED_APPS_CACHE_FILE = 'discovered-apps.json';

const { autoUpdater } = updaterPkg;
const keepAwakeController = createKeepAwakeController({ powerSaveBlocker });

const state = {
  serverHandle: null,
  sidecarUrl: null,
  localOrigin: null,
  bootOutcome: null,
  initScript: null,
  mainWindow: null,
  quitRequested: false,
  quitConfirmed: false,
  quitConfirmationPending: false,
  quitCleanupPromise: null,
  installingUpdate: false,
  pendingUpdate: null,
  unreachableHosts: new Set(),
  windowCounter: 1,
  focusedWindowIds: new Set(),
  windowGeometryRevisions: new Map(),
  miniChatWindowsBySession: new Map(),
  sshStatuses: new Map(),
  sshLogs: new Map(),
  browserCdpDiscoveryUrl: '',
  browserCdpDiscoveryToken: '',
  agentBrowserInstaller: null,
  agentBrowserInstallStatus: null,
  agentBrowserSkillStatus: null,
  agentBrowserSkillProvisioner: null,
  agentBrowserSkillWithdrawer: null,
  agentBrowserSetupPromise: null,
  agentBrowserManagedRuntime: false,
  agentBrowserRuntimeMode: 'pending',
};

let browserSurfaceManager = null;

const quitRisk = {
  hasActiveTunnel: false,
  hasRunningScheduledTasks: false,
  hasEnabledScheduledTasks: false,
  runningScheduledTasksCount: 0,
  enabledScheduledTasksCount: 0,
};

const shouldRequireQuitConfirmation = () =>
  quitRisk.hasActiveTunnel
  || quitRisk.hasRunningScheduledTasks
  || quitRisk.hasEnabledScheduledTasks;

const quitConfirmationMessage = () => {
  const reasons = [];
  if (quitRisk.hasActiveTunnel) {
    reasons.push('an active tunnel');
  }
  if (quitRisk.runningScheduledTasksCount > 0) {
    reasons.push(`${quitRisk.runningScheduledTasksCount} running scheduled task${quitRisk.runningScheduledTasksCount === 1 ? '' : 's'}`);
  }
  if (quitRisk.enabledScheduledTasksCount > 0) {
    reasons.push(`${quitRisk.enabledScheduledTasksCount} enabled scheduled task${quitRisk.enabledScheduledTasksCount === 1 ? '' : 's'}`);
  }
  if (reasons.length === 0) {
    return 'Background processes (sidecar, SSH sessions) will be stopped.';
  }
  return `DevRyan detected ${reasons.join(', ')}. Quitting now will stop sidecar/background processes and may interrupt pending work.`;
};

const prepareForQuit = ({ installingUpdate = false } = {}) => {
  state.quitRequested = true;
  state.quitConfirmed = true;
  state.installingUpdate = installingUpdate;
  state.quitConfirmationPending = false;
  browserCdpBridge?.closeAll('app_quit');
  browserSurfaceManager?.closeAll('app_quit');
  releaseDesktopKeepAwake();

  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    try {
      debounceWindowStatePersist(state.mainWindow, true);
    } catch {
    }
  }
};

const performConfirmedQuit = () => {
  if (state.quitConfirmed || state.quitCleanupPromise) return;
  prepareForQuit();
  state.quitCleanupPromise = finishQuitAfterCleanup({
    cleanupOwnedResources: async () => {
      speechManager.shutdown();
      await Promise.all([
        killSidecar(),
        Promise.resolve(sshManager.shutdownAll()).catch((error) => {
          log.warn('[electron] SSH shutdown failed during quit:', error);
        }),
      ]);
    },
    requestQuit: () => {
      state.quitCleanupPromise = null;
      app.quit();
    },
    forceExit: () => {
      state.quitCleanupPromise = null;
      app.exit(0);
    },
    onCleanupError: (error) => {
      log.warn('[electron] owned-resource cleanup failed during quit:', error);
    },
  });
};

const requestQuitWithConfirmation = async () => {
  await refreshQuitRiskFlags();

  if (!shouldRequireQuitConfirmation()) {
    performConfirmedQuit();
    return;
  }

  if (state.quitConfirmationPending) {
    return;
  }
  state.quitConfirmationPending = true;

  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
  const visible = windows.find((window) => window.isVisible());
  if (!visible) {
    const hidden = windows.find((window) => !window.isVisible());
    if (hidden) {
      hidden.show();
      hidden.focus();
    }
  }

  try {
    const result = await dialog.showMessageBox({
      type: 'warning',
      title: 'Quit DevRyan?',
      message: 'Quit DevRyan?',
      detail: quitConfirmationMessage(),
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    state.quitConfirmationPending = false;
    if (result.response === 0) {
      performConfirmedQuit();
    }
  } catch (error) {
    state.quitConfirmationPending = false;
    log.warn('[electron] quit confirmation dialog failed:', error);
  }
};

const refreshQuitRiskFlags = async () => {
  if (state.serverHandle && typeof state.serverHandle.getQuitRiskStatus === 'function') {
    try {
      const status = await state.serverHandle.getQuitRiskStatus();
      const scheduled = status?.scheduledTasks;
      if (scheduled && typeof scheduled === 'object') {
        const enabledCount = Number(scheduled.enabledScheduledTasksCount ?? 0);
        const runningCount = Number(scheduled.runningScheduledTasksCount ?? 0);
        quitRisk.enabledScheduledTasksCount = Number.isFinite(enabledCount) ? enabledCount : 0;
        quitRisk.runningScheduledTasksCount = Number.isFinite(runningCount) ? runningCount : 0;
        quitRisk.hasEnabledScheduledTasks = Boolean(scheduled.hasEnabledScheduledTasks) || quitRisk.enabledScheduledTasksCount > 0;
        quitRisk.hasRunningScheduledTasks = Boolean(scheduled.hasRunningScheduledTasks) || quitRisk.runningScheduledTasksCount > 0;
      }
      quitRisk.hasActiveTunnel = Boolean(status?.tunnel?.active);
      return;
    } catch {
    }
  }

  const base = typeof state.sidecarUrl === 'string' ? state.sidecarUrl.trim().replace(/\/$/, '') : '';
  if (!base) return;

  const scheduledUrl = `${base}/api/openchamber/scheduled-tasks/status`;
  const tunnelUrl = `${base}/api/openchamber/tunnel/status`;

  const fetchJson = async (url) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  };

  const [scheduled, tunnel] = await Promise.all([fetchJson(scheduledUrl), fetchJson(tunnelUrl)]);

  if (scheduled && typeof scheduled === 'object') {
    const enabledCount = Number(scheduled.enabledScheduledTasksCount ?? 0);
    const runningCount = Number(scheduled.runningScheduledTasksCount ?? 0);
    quitRisk.enabledScheduledTasksCount = Number.isFinite(enabledCount) ? enabledCount : 0;
    quitRisk.runningScheduledTasksCount = Number.isFinite(runningCount) ? runningCount : 0;
    quitRisk.hasEnabledScheduledTasks = Boolean(scheduled.hasEnabledScheduledTasks) || quitRisk.enabledScheduledTasksCount > 0;
    quitRisk.hasRunningScheduledTasks = Boolean(scheduled.hasRunningScheduledTasks) || quitRisk.runningScheduledTasksCount > 0;
  }

  if (tunnel && typeof tunnel === 'object') {
    quitRisk.hasActiveTunnel = Boolean(tunnel.active);
  }
};

const settingsFilePath = () => {
  if (typeof process.env.OPENCHAMBER_DATA_DIR === 'string' && process.env.OPENCHAMBER_DATA_DIR.trim()) {
    return path.join(process.env.OPENCHAMBER_DATA_DIR.trim(), 'settings.json');
  }
  return path.join(os.homedir(), '.config', 'openchamber', 'settings.json');
};

const dataRootDirectory = () => path.dirname(settingsFilePath());

const sshManager = new ElectronSshManager({
  settingsFilePath: settingsFilePath(),
  appVersion: APP_VERSION,
  emit: (event, detail) => emitToAllWindows(event, detail),
});

const speechManager = new MacosSpeechManager({
  baseDir: __dirname,
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  log,
  emit: (event, detail) => emitToAllWindows(event, detail),
});

const readJsonFile = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    // Parse errors can happen if a concurrent writer just truncated the file
    // and hasn't finished writing yet. Log loudly so we notice, then return
    // {} as before. Writes are atomic (tmp + rename) so this race is rare.
    log.warn?.('[electron] failed to read JSON file', filePath, error);
    return {};
  }
};

const writeJsonFile = async (filePath, data) => {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  // Atomic: write to a temp file then rename. Readers never see a partial
  // JSON file that could parse-error and get coerced to {}.
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, filePath);
};

const readSettingsRoot = () => {
  const root = readJsonFile(settingsFilePath());
  return root && typeof root === 'object' && !Array.isArray(root) ? root : {};
};

const readDesktopKeepAwakeEnabled = () => readSettingsRoot().desktopKeepAwakeEnabled === true;

const applyDesktopKeepAwake = (enabled) => {
  const result = keepAwakeController.apply(enabled === true);
  log.info('[electron] desktop keep awake updated', result);
  return result;
};

const releaseDesktopKeepAwake = () => {
  keepAwakeController.stop();
};

// Serializes read-modify-write of the settings file within this process.
// Multiple call sites (spawnLocalServer, writeDesktopHostsConfig, theme
// preference saves, ssh manager imports, etc.) would otherwise have their
// RMW pairs interleave across awaits, letting one writer's stale copy
// overwrite another writer's just-persisted changes.
let settingsMutationChain = Promise.resolve();
const mutateSettingsRoot = (mutator) => {
  const next = settingsMutationChain.then(async () => {
    const current = readSettingsRoot();
    const result = await mutator(current);
    const nextRoot = result ?? current;
    await writeJsonFile(settingsFilePath(), nextRoot);
  });
  // Keep the chain alive even if one mutator throws.
  settingsMutationChain = next.catch(() => {});
  return next;
};

const writeSettingsRoot = async (root) => writeJsonFile(settingsFilePath(), root);

const normalizeHostUrl = (raw) => {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
};

const sanitizeHostUrlForStorage = (raw) => normalizeHostUrl(raw);

const readDesktopHostsConfig = () => {
  const root = readSettingsRoot();
  const hostsRaw = Array.isArray(root.desktopHosts) ? root.desktopHosts : [];
  const hosts = hostsRaw
    .map((entry) => {
      const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
      const url = sanitizeHostUrlForStorage(entry?.url);
      if (!id || id === LOCAL_HOST_ID || !url) return null;
      const label = typeof entry?.label === 'string' && entry.label.trim() ? entry.label.trim() : url;
      return { id, label, url };
    })
    .filter(Boolean);

  return {
    hosts,
    defaultHostId: typeof root.desktopDefaultHostId === 'string' && root.desktopDefaultHostId.trim()
      ? root.desktopDefaultHostId.trim()
      : null,
    initialHostChoiceCompleted: root.desktopInitialHostChoiceCompleted === true,
  };
};

const writeDesktopHostsConfig = async (config) => {
  await mutateSettingsRoot((root) => {
    root.desktopHosts = Array.isArray(config?.hosts)
      ? config.hosts
          .map((entry) => {
            const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
            const url = sanitizeHostUrlForStorage(entry?.url);
            if (!id || id === LOCAL_HOST_ID || !url) return null;
            return {
              id,
              label: typeof entry?.label === 'string' && entry.label.trim() ? entry.label.trim() : url,
              url,
            };
          })
          .filter(Boolean)
      : [];
    root.desktopDefaultHostId = typeof config?.defaultHostId === 'string' && config.defaultHostId.trim()
      ? config.defaultHostId.trim()
      : null;
    if (typeof config?.initialHostChoiceCompleted === 'boolean') {
      root.desktopInitialHostChoiceCompleted = config.initialHostChoiceCompleted;
    }
  });
};

const readWindowState = () => {
  const stateValue = readSettingsRoot().desktopWindowState;
  return stateValue && typeof stateValue === 'object' ? stateValue : null;
};

const writeWindowState = async (browserWindow) => {
  await persistWindowState({
    browserWindow,
    mainWindowID: state.mainWindow?.id ?? null,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    mutateSettingsRoot,
  });
};

const debounceWindowStatePersist = (browserWindow, immediate = false) => {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  const key = String(browserWindow.id);
  const revision = (state.windowGeometryRevisions.get(key) || 0) + 1;
  state.windowGeometryRevisions.set(key, revision);

  const persist = async () => {
    if (state.windowGeometryRevisions.get(key) !== revision) return;
    await writeWindowState(browserWindow);
  };
  const reportFailure = (error) => {
    log.warn('[electron] failed to persist window state:', error);
  };

  if (immediate) {
    void persist().catch(reportFailure);
    return;
  }

  setTimeout(() => {
    void persist().catch(reportFailure);
  }, 300);
};

const buildHealthUrl = (url) => {
  try {
    const parsed = new URL(url);
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '') || ''}/health`;
    return parsed.toString();
  } catch {
    return null;
  }
};

const probeHostWithTimeout = async (url, timeoutMs) => {
  const healthUrl = buildHealthUrl(url);
  if (!healthUrl) {
    throw new Error('Invalid URL');
  }

  const started = Date.now();
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
    const status = response.status;
    return {
      status: status >= 200 && status < 300 ? 'ok' : (status === 401 || status === 403 ? 'auth' : 'unreachable'),
      latencyMs: Date.now() - started,
    };
  } catch {
    return { status: 'unreachable', latencyMs: Date.now() - started };
  }
};

const waitForHealth = async (url, timeoutMs = 20_000, initialPollMs = 250, maxPollMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  let pollMs = initialPollMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(buildHealthUrl(url), { signal: AbortSignal.timeout(Math.min(pollMs * 4, 1500)) });
      if (response.ok) {
        return true;
      }
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    pollMs = Math.min(pollMs * 2, maxPollMs);
  }
  return false;
};

const pickUnusedPort = async () => {
  const net = await import('node:net');
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
};

const isPortFree = async (port) => {
  if (!Number.isFinite(port) || port <= 0) return false;
  const net = await import('node:net');
  return await new Promise((resolve) => {
    const test = net.createServer();
    const done = (value) => {
      try { test.close(); } catch {}
      resolve(value);
    };
    test.once('error', () => done(false));
    test.listen(port, '127.0.0.1', () => done(true));
  });
};

// Return the LAN IPv4 of the interface that routes to the public internet.
// UDP "connect" is a kernel-side route lookup — no packet actually goes out —
// and it picks the same interface as a real outbound connection, which is what
// a phone on the same Wi-Fi needs to reach us. Falls back to scanning
// os.networkInterfaces() if the socket trick fails (e.g. no default route).
const detectLanIPv4Address = async () => {
  const ip = await new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const finish = (value) => {
      try { socket.close(); } catch {}
      resolve(value);
    };
    socket.once('error', () => finish(null));
    try {
      socket.connect(80, '8.8.8.8', (error) => {
        if (error) return finish(null);
        try {
          const addr = socket.address();
          finish(addr && typeof addr.address === 'string' ? addr.address : null);
        } catch {
          finish(null);
        }
      });
    } catch {
      finish(null);
    }
  });
  if (ip && ip !== '0.0.0.0' && !ip.startsWith('127.')) return ip;

  for (const entries of Object.values(os.networkInterfaces() || {})) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal && entry.address) {
        return entry.address;
      }
    }
  }
  return null;
};

const buildLocalUrl = (port) => `http://127.0.0.1:${port}`;

const resourceRoot = () => isDev ? path.join(__dirname, 'resources') : process.resourcesPath;
const resolveWebDistDir = () => path.join(resourceRoot(), 'web-dist');

const normalizeNotificationInput = (raw) => {
  if (!raw || typeof raw !== 'object') return {};
  // UI IPC path wraps in { payload: {...} }; sidecar stdout path is flat.
  if (raw.payload && typeof raw.payload === 'object') {
    return { ...raw, ...raw.payload };
  }
  return raw;
};

const isAnyWindowFocused = () =>
  BrowserWindow.getAllWindows().some(
    (window) => !window.isDestroyed() && window.isFocused(),
  );

const focusForegroundWindow = () => {
  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
  if (windows.length === 0) return;
  const target = state.mainWindow && !state.mainWindow.isDestroyed()
    ? state.mainWindow
    : windows.find((window) => window.isVisible()) || windows[0];
  // macOS: bring the app to foreground FIRST. When the window is minimized
  // to the Dock or hidden via Cmd+H, the app is in the background, and
  // subsequent window.show/restore/focus calls won't pull it forward
  // unless app.focus runs first.
  if (process.platform === 'darwin') app.focus({ steal: true });
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  if (typeof target.moveTop === 'function') target.moveTop();
};

// Keep references to live notifications so they aren't garbage-collected
// before the OS fires click/close. On macOS, losing the JS reference causes
// click events to silently stop firing after ~1 min.
// See https://blog.bloomca.me/2025/02/22/electron-mac-notifications
const activeNotifications = new Set();

const maybeShowNativeNotification = (rawInput) => {
  const payload = normalizeNotificationInput(rawInput);
  const requireHidden = Boolean(payload.requireHidden ?? payload.require_hidden);

  if (requireHidden && isAnyWindowFocused()) {
    return;
  }

  if (!Notification.isSupported()) {
    return;
  }

  const title = typeof payload.title === 'string' && payload.title.trim()
    ? payload.title.trim()
    : 'DevRyan';
  const body = typeof payload.body === 'string' ? payload.body : '';
  const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.trim()
    ? payload.sessionId.trim()
    : null;

  const notification = new Notification({
    title,
    body,
    silent: false,
    ...(process.platform === 'darwin' ? { sound: 'Glass' } : {}),
  });

  activeNotifications.add(notification);
  const release = () => { activeNotifications.delete(notification); };

  notification.on('click', () => {
    focusForegroundWindow();
    if (sessionId) {
      emitToAllWindows('openchamber:open-session', { sessionId });
    }
    release();
  });
  notification.on('close', release);
  notification.on('failed', release);

  notification.show();
};

const mapUpdaterProgressEvent = (payload) => ({
  event: payload.event,
  data: payload.data,
});

const SHELL_ENV_TIMEOUT_MS = 5_000;
let cachedShellEnv = null;
let shellEnvProbed = false;

const isNushell = (shell) => {
  const name = path.basename(shell).toLowerCase();
  return name === 'nu' || name === 'nu.exe';
};

const parseShellEnv = (buf) => {
  const result = {};
  for (const line of buf.toString('utf8').split('\0')) {
    if (!line) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    result[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return result;
};

const probeShellEnv = (shell, mode) => {
  const result = spawnSync(shell, [mode, '-c', 'env -0'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: SHELL_ENV_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  const env = parseShellEnv(result.stdout);
  return Object.keys(env).length > 0 ? env : null;
};

// Finder-launched apps on macOS inherit a minimal PATH (no /opt/homebrew, mise, asdf, etc.).
// Probe the user's login shell once so the sidecar sees the same PATH / tool env as `$SHELL -il`.
const loadShellEnv = () => {
  if (shellEnvProbed) return cachedShellEnv;
  shellEnvProbed = true;
  if (process.platform === 'win32') return null;
  const shell = process.env.SHELL || '/bin/sh';
  if (isNushell(shell)) return null;
  cachedShellEnv = probeShellEnv(shell, '-il') || probeShellEnv(shell, '-l');
  return cachedShellEnv;
};

// Merge the user's login-shell env (PATH, etc.) into this process before we
import { pathLooksUserConfigured, mergePathValues } from '@openchamber/web/server/lib/opencode/path-utils.js';

// import/start the server in-process. The server and its children (opencode
// CLI, git, etc.) inherit process.env directly now — there is no sidecar
// subprocess to hand a custom env to.
const inheritUserShellEnv = () => {
  const shellEnv = loadShellEnv();
  if (!shellEnv) return;

  const homeDir = os.homedir();
  const currentPath = process.env.PATH || '';
  const currentPathLooksUserConfigured = pathLooksUserConfigured(currentPath, homeDir, ':');

  for (const [key, value] of Object.entries(shellEnv)) {
    if (key === 'PATH') continue;
    if (typeof process.env[key] === 'undefined') {
      process.env[key] = value;
    }
  }

  const shellPath = typeof shellEnv.PATH === 'string' ? shellEnv.PATH : '';
  if (!currentPathLooksUserConfigured && shellPath) {
    process.env.PATH = mergePathValues(shellPath, currentPath, ':');
  }
};

const spawnLocalServer = async () => {
  inheritUserShellEnv();

  const settings = readSettingsRoot();
  // NOTE: We intentionally do NOT call preflightMacosProtectedDirectoryAccess
  // here. Stat'ing a path under ~/Documents/Desktop/Downloads triggers the
  // macOS TCC prompt before the user has any UI context for why. Defer to
  // the natural project-open flow, which runs after the user has clicked a
  // project and expects an access prompt. The preflight helper remains
  // available for callers that want an explicit pre-check.

  const storedPort = Number.isFinite(settings.desktopLocalPort) ? settings.desktopLocalPort : null;
  // When the user enables "Desktop Network Access" we bind on all interfaces
  // so phones/tablets on the same Wi-Fi can reach the app. UI shows a clear
  // warning and persists the flag via /api/config/settings.
  const lanAccessEnabled = settings.desktopLanAccessEnabled === true;
  const bindHost = lanAccessEnabled ? '0.0.0.0' : '127.0.0.1';
  // The in-process web server refuses to bind a network-exposed host without UI
  // auth (see server/lib/security/bind-host.js). Desktop Network Access is a
  // deliberate, warned opt-in with no desktop password mechanism, so honor that
  // opt-in here rather than crashing boot.
  if (lanAccessEnabled) {
    process.env.OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN = 'true';
    log.warn('[desktop] Network Access is enabled; the UI is reachable on your LAN without authentication.');
  } else {
    delete process.env.OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN;
  }

  // Probe before starting the server — main() in the server module sets up a
  // lot of global state before binding, and calling it twice after a listen
  // failure would double-wire runtimes. Pick a known-free port in one shot.
  const candidates = [storedPort, DEFAULT_DESKTOP_PORT].filter((v) => Number.isFinite(v) && v > 0);
  let chosenPort = 0;
  for (const candidate of candidates) {
    if (await isPortFree(candidate)) {
      chosenPort = candidate;
      break;
    }
  }
  if (chosenPort === 0) {
    chosenPort = await pickUnusedPort();
  }

  // The server module reads ENV_DESKTOP_NOTIFY / OPENCHAMBER_DIST_DIR /
  // OPENCHAMBER_RUNTIME at import time (top-level const), so these must be
  // set before the first import. After this point, the same env is used by
  // both the Electron main and the server running inside it.
  process.env.OPENCHAMBER_HOST = bindHost;
  process.env.OPENCHAMBER_DIST_DIR = resolveWebDistDir();
  process.env.OPENCHAMBER_RUNTIME = 'desktop';
  process.env.OPENCHAMBER_DESKTOP_NOTIFY = 'true';
  process.env.OPENCHAMBER_SKIP_API_COMPRESSION = process.env.OPENCHAMBER_SKIP_API_COMPRESSION || 'true';
  process.env.NO_PROXY = process.env.NO_PROXY || 'localhost,127.0.0.1';
  process.env.no_proxy = process.env.no_proxy || 'localhost,127.0.0.1';

  // Private browser capability handoff for the managed OpenCode child. Keep
  // these out of ambient process.env: lifecycle.js scrubs inherited values and
  // injects only this callback's exact trio into a child we own.
  state.browserCdpDiscoveryToken = crypto.randomBytes(32).toString('hex');
  state.browserCdpDiscoveryUrl = `http://127.0.0.1:${chosenPort}/api/desktop/browser-cdp`;
  state.agentBrowserRuntimeMode = (
    process.env.OPENCODE_SKIP_START === 'true'
    || process.env.OPENCHAMBER_SKIP_OPENCODE_START === 'true'
  ) ? 'external' : 'pending';
  delete process.env.DEVRYAN_BROWSER_CDP_DISCOVERY_URL;
  delete process.env.DEVRYAN_BROWSER_CDP_TOKEN;
  delete process.env.DEVRYAN_AGENT_BROWSER_BIN;

  try {
    const {
      createAgentBrowserInstaller,
      provisionAgentBrowserSkill,
      withdrawAgentBrowserSkill,
    } = await import('@openchamber/web/server/lib/agent-browser/install.js');
    const dataRoot = dataRootDirectory();
    const skillOptions = {
      dataRoot,
      homeDir: os.homedir(),
      managedElectron: true,
      log,
    };
    state.agentBrowserInstaller = createAgentBrowserInstaller({ dataRoot, env: process.env, log });
    state.agentBrowserSkillProvisioner = () => provisionAgentBrowserSkill(skillOptions);
    state.agentBrowserSkillWithdrawer = () => withdrawAgentBrowserSkill(skillOptions);
  } catch (error) {
    // Browser automation is optional. A failed local tool install must not
    // prevent the editor or managed OpenCode runtime from starting.
    state.agentBrowserInstallStatus = {
      ok: false,
      state: 'unavailable',
      expectedVersion: '0.33.2',
      installedVersion: null,
      binaryPath: '',
      issues: [{ code: 'startup-failed', message: error instanceof Error ? error.message : String(error) }],
    };
    log.warn('[agent-browser] managed setup failed; continuing without browser automation');
  }

  const { startWebUiServer } = await import('@openchamber/web/server/index.js');

  const handle = await startWebUiServer({
    port: chosenPort,
    host: bindHost,
    attachSignals: false,
    exitOnShutdown: false,
    onDesktopNotification: (payload) => maybeShowNativeNotification(payload),
    getIsWindowFocused: isAnyWindowFocused,
    getBrowserCdpBridgeStatus: () => resolveBridgeStatusForDiscovery(),
    getBrowserCdpDiscoveryToken: () => state.browserCdpDiscoveryToken || '',
    createBrowserLease: (request) => createDesktopBrowserLease(request),
    touchBrowserLease: (request) => touchDesktopBrowserLease(request),
    releaseBrowserLease: (request) => releaseDesktopBrowserLease(request),
    getManagedBrowserEnvironment: async () => {
      // This callback is invoked only on the managed-child launch path. Keep
      // installation and ~/.agents skill provisioning lazy so configured
      // external/remote OpenCode runtimes remain completely untouched.
      state.agentBrowserManagedRuntime = true;
      state.agentBrowserRuntimeMode = 'managed';
      if (!state.agentBrowserSetupPromise) {
        state.agentBrowserSetupPromise = (async () => {
          try {
            state.agentBrowserInstallStatus = await state.agentBrowserInstaller?.ensureInstalled?.();
            state.agentBrowserSkillStatus = state.agentBrowserInstallStatus?.ok
              ? await state.agentBrowserSkillProvisioner?.()
              : await state.agentBrowserSkillWithdrawer?.();
          } catch (error) {
            state.agentBrowserInstallStatus = {
              ...(state.agentBrowserInstallStatus || {}),
              ok: false,
              state: 'unavailable',
              expectedVersion: '0.33.2',
              installedVersion: null,
              binaryPath: '',
              issues: [{
                code: 'managed-setup-failed',
                message: error instanceof Error ? error.message : String(error),
              }],
            };
            state.agentBrowserSkillStatus = await state.agentBrowserSkillWithdrawer?.();
            log.warn('[agent-browser] managed setup failed; continuing without browser automation');
          }
        })().finally(() => {
          state.agentBrowserSetupPromise = null;
        });
      }
      await state.agentBrowserSetupPromise;
      const binaryPath = state.agentBrowserInstallStatus?.binaryPath;
      if (state.agentBrowserInstallStatus?.ok !== true
        || !state.browserCdpDiscoveryUrl
        || !state.browserCdpDiscoveryToken
        || typeof binaryPath !== 'string'
        || !path.isAbsolute(binaryPath)) {
        return {};
      }
      return {
        DEVRYAN_BROWSER_CDP_DISCOVERY_URL: state.browserCdpDiscoveryUrl,
        DEVRYAN_BROWSER_CDP_TOKEN: state.browserCdpDiscoveryToken,
        DEVRYAN_AGENT_BROWSER_BIN: binaryPath,
      };
    },
    getAppMetrics: () => app.getAppMetrics(),
  });

  const port = handle.getPort();
  const url = buildLocalUrl(port);

  state.serverHandle = handle;
  state.sidecarUrl = url;

  // Managed startup invokes getManagedBrowserEnvironment before it can become
  // ready. If readiness arrives without that callback, the lifecycle selected
  // an existing external runtime (for example an occupied OPENCODE_PORT).
  const runtimeModeTimer = setInterval(() => {
    if (state.agentBrowserRuntimeMode !== 'pending') {
      clearInterval(runtimeModeTimer);
      return;
    }
    if (handle.isReady?.()) {
      state.agentBrowserRuntimeMode = 'external';
      clearInterval(runtimeModeTimer);
    }
  }, 250);
  runtimeModeTimer.unref?.();

  await mutateSettingsRoot((root) => {
    root.desktopLocalPort = port;
  });

  return url;
};

let sidecarStopPromise = null;

const killSidecar = () => {
  if (!state.serverHandle) return sidecarStopPromise ?? Promise.resolve();
  const serverHandle = state.serverHandle;
  state.serverHandle = null;
  state.sidecarUrl = null;
  sidecarStopPromise = Promise.resolve()
    .then(() => serverHandle.stop({ exitProcess: false }))
    .catch((error) => {
      log.warn('[electron] web runtime shutdown failed:', error);
    })
    .finally(() => {
      sidecarStopPromise = null;
    });
  return sidecarStopPromise;
};

const macosMajorVersion = () => {
  if (process.platform !== 'darwin') return 0;
  const result = spawnSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' });
  const raw = (result.stdout || '').trim();
  const [majorRaw, minorRaw] = raw.split('.');
  const major = Number.parseInt(majorRaw || '0', 10);
  const minor = Number.parseInt(minorRaw || '0', 10);
  return major === 10 ? minor : major;
};

const buildContentOriginPolicy = () => {
  const config = readDesktopHostsConfig();
  return {
    localOrigin: state.localOrigin,
    hostUrls: config.hosts.map((entry) => entry.url),
    envServerUrl: normalizeHostUrl(process.env.OPENCHAMBER_SERVER_URL || ''),
  };
};

const buildInitScript = (localOrigin, bootOutcome, serverOrigin = localOrigin) => {
  const home = JSON.stringify(os.homedir() || '');
  const local = JSON.stringify(localOrigin || '');
  const server = JSON.stringify(serverOrigin || localOrigin || '');
  const macVersion = macosMajorVersion();
  const outcome = JSON.stringify(bootOutcome ?? null);
  const privilegedGuard = privilegedOriginGuardJs();
  return [
    '(function(){',
    `try{window.__OPENCHAMBER_MACOS_MAJOR__=${macVersion};window.__OPENCHAMBER_LOCAL_ORIGIN__=${local};var __oc_server=${server};var __oc_origin=location&&location.origin||'';var __oc_local=${local};var __oc_home=${home};var __oc_is_local=${privilegedGuard};if(__oc_is_local){window.__OPENCHAMBER_HOME__=__oc_home;}if(__oc_is_local&&__oc_server){window.__OPENCHAMBER_DESKTOP_SERVER__={origin:__oc_server,apiPrefix:'/api',opencodePort:null,cliAvailable:true};}var __oc_bo=${outcome};if(__oc_bo){window.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__=__oc_bo;}}catch(_e){}`,
    '}())',
  ].join('');
};

const computeBootOutcome = ({ envTargetUrl, probe, config, localAvailable }) => {
  if (envTargetUrl) {
    const status = probe && probe.status === 'unreachable' ? 'unreachable' : 'ok';
    return { target: 'remote', status, hostId: ENV_OVERRIDE_HOST_ID, url: envTargetUrl };
  }

  const defaultId = config.defaultHostId || '';
  if (!defaultId) {
    return { target: null, status: 'not-configured' };
  }

  if (defaultId === LOCAL_HOST_ID) {
    return localAvailable
      ? { target: 'local', status: 'ok' }
      : { target: 'local', status: 'unreachable' };
  }

  const host = config.hosts.find((entry) => entry.id === defaultId);
  if (!host) {
    return { target: 'remote', status: 'missing', hostId: defaultId };
  }

  const status = probe && probe.status === 'unreachable' ? 'unreachable' : 'ok';
  return { target: 'remote', status, hostId: host.id, url: host.url };
};

const buildStartupSplashHtml = () => {
  return buildStartupSplashHtmlFromSettings(readSettingsRoot());
};

const navigateWindow = async (browserWindow, url, { allowAbort = false } = {}) => {
  try {
    await browserWindow.loadURL(url);
  } catch (error) {
    if (allowAbort && isBenignNavigationAbort(error)) {
      return;
    }
    throw error;
  }
};

const emitToWindow = (browserWindow, event, detail) => {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  browserWindow.webContents.send('openchamber:emit', { event, detail });
};

const emitToAllWindows = (event, detail) => {
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    emitToWindow(browserWindow, event, detail);
  }
};

const pendingDeepLinks = [];

const parseDeepLink = (raw) => {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== `${DEEP_LINK_PROTOCOL}:`) return null;
    const type = url.hostname;
    if (!type) return null;
    const segments = url.pathname.split('/').filter(Boolean);
    const value = segments.length > 0
      ? decodeURIComponent(segments.join('/'))
      : '';
    return { type, value };
  } catch {
    return null;
  }
};

const switchToHostById = async (rawId) => {
  const id = typeof rawId === 'string' ? rawId.trim() : '';
  if (!id) return;
  const config = readDesktopHostsConfig();
  let targetUrl = null;
  if (id === LOCAL_HOST_ID) {
    targetUrl = state.sidecarUrl || state.localOrigin;
  } else {
    const host = config.hosts.find((entry) => entry.id === id);
    if (!host) {
      log.warn('[electron] deep-link host not found:', id);
      return;
    }
    targetUrl = host.url;
  }
  if (!targetUrl) {
    log.warn('[electron] deep-link host has no target URL:', id);
    return;
  }
  const bootOutcome = id === LOCAL_HOST_ID
    ? { target: 'local', status: 'ok' }
    : { target: 'remote', status: 'ok', hostId: id, url: targetUrl };
  log.info('[electron] switching to host', { id, bootOutcome });
  await activateMainWindow(targetUrl, state.localOrigin, bootOutcome);
};

const dispatchDeepLink = (link) => {
  if (!link) return;
  log.info('[electron] dispatching deep-link', { type: link.type, valueLen: link.value?.length || 0 });
  if (link.type === 'session' && link.value) {
    emitToAllWindows('openchamber:open-session', { sessionId: link.value });
    return;
  }
  if (link.type === 'project' && link.value) {
    emitToAllWindows('openchamber:open-project', { projectPath: link.value });
    return;
  }
  if (link.type === 'host' && link.value) {
    void switchToHostById(link.value);
    return;
  }
  log.warn('[electron] unknown deep-link action:', link.type);
};

const flushPendingDeepLinks = () => {
  while (pendingDeepLinks.length > 0) {
    dispatchDeepLink(pendingDeepLinks.shift());
  }
};

const isMainWindowReadyForDeepLink = () =>
  Boolean(state.mainWindow)
  && !state.mainWindow.isDestroyed()
  && !state.mainWindow.webContents.isLoading();

const handleDeepLinks = (urls) => {
  for (const raw of urls) {
    const parsed = parseDeepLink(raw);
    if (!parsed) continue;
    if (isMainWindowReadyForDeepLink()) {
      dispatchDeepLink(parsed);
    } else {
      pendingDeepLinks.push(parsed);
    }
  }
};

const extractInitialDeepLinks = () =>
  process.argv.filter((arg) => typeof arg === 'string' && arg.startsWith(`${DEEP_LINK_PROTOCOL}://`));

const dispatchDomEventToWindow = (browserWindow, event, detail) => {
  if (!browserWindow || browserWindow.isDestroyed()) return;

  const eventLiteral = JSON.stringify(event);
  const script = detail === undefined
    ? `window.dispatchEvent(new Event(${eventLiteral}));`
    : `window.dispatchEvent(new CustomEvent(${eventLiteral}, { detail: ${JSON.stringify(detail)} }));`;

  void browserWindow.webContents.executeJavaScript(script, true).catch(() => {});
};

const getMenuTargetWindow = () => {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  if (state.mainWindow && !state.mainWindow.isDestroyed()) return state.mainWindow;
  const [firstWindow] = BrowserWindow.getAllWindows();
  return firstWindow && !firstWindow.isDestroyed() ? firstWindow : null;
};

const dispatchMenuAction = (action) => {
  const target = getMenuTargetWindow();
  emitToWindow(target, 'openchamber:menu-action', action);
  dispatchDomEventToWindow(target, 'openchamber:menu-action', action);
};

const dispatchCheckForUpdates = () => {
  emitToAllWindows('openchamber:check-for-updates');
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    dispatchDomEventToWindow(browserWindow, 'openchamber:check-for-updates');
  }
};

const nextWindowLabel = () => {
  const value = state.windowCounter++;
  return value === 1 ? 'main' : `main-${value}`;
};

const readThemeSource = () => {
  const settings = readSettingsRoot();
  // themeMode is the user's intent; themeVariant is only the resolved
  // concrete appearance at persist time. When mode === 'system', we must
  // follow the OS even if variant was saved as a specific value.
  if (settings.themeMode === 'system' || settings.useSystemTheme === true) return 'system';
  if (settings.themeMode === 'light') return 'light';
  if (settings.themeMode === 'dark') return 'dark';
  if (settings.themeVariant === 'light') return 'light';
  if (settings.themeVariant === 'dark') return 'dark';
  return 'system';
};

// ---------------------------------------------------------------------------
// Main-owned browser surface and agent-lease management.
const browserLeaseOwners = new Map(); // leaseId -> { ownerWindowId, metadata }
const browserLeaseWindowClaims = new Map(); // directory + rootSessionId -> { ownerWindowId, claimedAt }
const observedBrowserLeaseByWindow = new Map(); // ownerWindowId -> leaseId
let browserLeaseRevision = 0;
let browserLeaseGlobalCountPublishQueued = false;
const MAX_BROWSER_LEASE_CONTEXT_CLAIMS_PER_REQUEST = 1_000;
const browserDevToolsController = createBrowserDevToolsController({
  createDevToolsView: () => new WebContentsView(),
});

const getBrowserSurfaceManager = () => {
  if (browserSurfaceManager) return browserSurfaceManager;
  browserSurfaceManager = createBrowserSurfaceManager({
    createPopoutWindow: (surfaceId) => createBrowserPopoutWindow(surfaceId),
    emitToWindow,
    getWindowById: browserWindowById,
    devToolsController: browserDevToolsController,
    onLeaseMetadata: (leaseId, metadata) => {
      const owner = browserLeaseOwners.get(leaseId);
      if (owner) owner.metadata = { ...owner.metadata, ...metadata };
      browserCdpBridge?.updateLeaseMetadata(leaseId, {
        ...metadata,
        hostname: hostnameForBrowserUrl(metadata?.url),
      });
    },
    onLeaseSurfaceDestroyed: (leaseId, reason) => {
      browserCdpBridge?.closeLease(leaseId, reason || 'surface_destroyed');
    },
    shouldQuit: () => state.quitRequested,
    log: (message, error) => (error ? log.warn(message, error) : log.info(message)),
  });
  return browserSurfaceManager;
};

const readAgentBrowserControlEnabled = () => {
  const settings = readSettingsRoot();
  // Default on. Capability paths are loopback-only and each lease is bound to
  // one main-owned browser surface before the private URL is returned.
  return settings.agentBrowserControlEnabled !== false;
};

const safeLeaseString = (value, maxLength = 2048) => (
  typeof value === 'string' ? value.slice(0, maxLength) : ''
);

const hostnameForBrowserUrl = (rawUrl) => {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname : '';
  } catch {
    return '';
  }
};

const isPrivilegedLeaseWindow = (browserWindow) => {
  if (
    !browserWindow
    || browserWindow.isDestroyed()
    || browserWindow.__ocMiniChat === true
    || browserWindow.__ocBrowserPopout === true
  ) return false;
  try {
    return isPrivilegedRendererUrl(browserWindow.webContents.getURL(), state.localOrigin);
  } catch {
    return false;
  }
};

const browserWindowById = (windowId) => BrowserWindow.getAllWindows().find(
  (candidate) => !candidate.isDestroyed() && candidate.id === windowId,
) || null;

// Renderer claims use UI-normalized paths while OpenCode tool context keeps
// native platform separators. Canonicalize both at the ownership boundary.
const normalizeBrowserLeaseClaimDirectory = (value) => {
  const slashNormalized = safeLeaseString(value, 8192).trim().replace(/\\/g, '/');
  if (!slashNormalized) return '';

  const withoutTrailingSeparators = slashNormalized === '/'
    ? slashNormalized
    : slashNormalized.replace(/\/+$/g, '');
  return withoutTrailingSeparators.replace(
    /^([A-Za-z]):(?=\/|$)/,
    (_match, driveLetter) => `${driveLetter.toLowerCase()}:`,
  );
};

const browserLeaseWindowClaimKey = (directory, rootSessionId) => {
  const normalizedDirectory = normalizeBrowserLeaseClaimDirectory(directory);
  const normalizedRootSessionId = safeLeaseString(rootSessionId, 256).trim();
  if (normalizedDirectory.includes('\u0000') || normalizedRootSessionId.includes('\u0000')) return null;
  return normalizedDirectory && normalizedRootSessionId
    ? `${normalizedDirectory}\u0000${normalizedRootSessionId}`
    : null;
};

const collectBrowserLeaseWindowClaimKeys = (contexts) => {
  if (!Array.isArray(contexts)) throw new Error('Browser lease contexts must be an array');
  if (contexts.length > MAX_BROWSER_LEASE_CONTEXT_CLAIMS_PER_REQUEST) {
    throw new Error(`Browser lease contexts cannot exceed ${MAX_BROWSER_LEASE_CONTEXT_CLAIMS_PER_REQUEST}`);
  }

  const claimKeys = [];
  const seen = new Set();
  for (const context of contexts) {
    const claimKey = browserLeaseWindowClaimKey(context?.directory, context?.rootSessionId);
    if (!claimKey) throw new Error('Browser lease context requires a directory and rootSessionId');
    if (seen.has(claimKey)) continue;
    seen.add(claimKey);
    claimKeys.push(claimKey);
  }
  return claimKeys;
};

const resolveBrowserLeaseOwnerWindow = (metadata) => {
  const claimKey = browserLeaseWindowClaimKey(metadata?.directory, metadata?.rootSessionId);
  if (!claimKey) return null;
  const claim = browserLeaseWindowClaims.get(claimKey);
  if (!claim) return null;
  const claimedWindow = browserWindowById(claim.ownerWindowId);
  if (isPrivilegedLeaseWindow(claimedWindow)) return claimedWindow;
  browserLeaseWindowClaims.delete(claimKey);
  return null;
};

const safeBrowserLeaseSnapshot = (leaseId, owner) => {
  const status = browserCdpBridge?.getLeaseStatus(leaseId);
  if (!status?.ok) return null;
  const metadata = status.metadata && typeof status.metadata === 'object' ? status.metadata : owner.metadata;
  const url = safeLeaseString(metadata.url, 8192);
  return {
    leaseId,
    surfaceId: browserSurfaceManager?.snapshotForLease(leaseId)?.surfaceId || '',
    rootSessionId: safeLeaseString(metadata.rootSessionId, 256),
    opencodeSessionID: safeLeaseString(metadata.opencodeSessionID, 256),
    directory: safeLeaseString(metadata.directory, 8192),
    agent: safeLeaseString(metadata.agent, 256) || 'Agent',
    title: safeLeaseString(metadata.title, 1024),
    hostname: safeLeaseString(metadata.hostname, 1024) || hostnameForBrowserUrl(url),
    url,
    lastActivityAt: Number.isFinite(status.lastActivityAt) ? status.lastActivityAt : Date.now(),
    clientAttached: (status.clients ?? 0) > 0,
  };
};

const createBrowserLeaseSnapshot = (ownerWindowId) => {
  const leases = [];
  for (const [leaseId, owner] of browserLeaseOwners) {
    if (owner.ownerWindowId !== ownerWindowId) continue;
    const lease = safeBrowserLeaseSnapshot(leaseId, owner);
    if (lease) leases.push(lease);
  }
  leases.sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  browserLeaseRevision += 1;
  return {
    revision: browserLeaseRevision,
    globalActiveLeaseCount: browserLeaseOwners.size,
    leases,
  };
};

const scheduleBrowserLeaseGlobalCountPublish = () => {
  if (browserLeaseGlobalCountPublishQueued) return;
  browserLeaseGlobalCountPublishQueued = true;
  queueMicrotask(() => {
    browserLeaseGlobalCountPublishQueued = false;
    const detail = { activeLeaseCount: browserLeaseOwners.size };
    for (const browserWindow of BrowserWindow.getAllWindows()) {
      if (!isPrivilegedLeaseWindow(browserWindow)) continue;
      emitToWindow(browserWindow, 'browser-agent-lease-total', detail);
    }
  });
};

const publishBrowserLeaseSnapshot = (ownerWindowId = null) => {
  const targetWindowIds = ownerWindowId === null
    ? Array.from(new Set(Array.from(browserLeaseOwners.values(), (owner) => owner.ownerWindowId)
      .filter(Number.isInteger)))
    : [ownerWindowId];

  for (const windowId of targetWindowIds) {
    const browserWindow = browserWindowById(windowId);
    if (!isPrivilegedLeaseWindow(browserWindow)) continue;
    emitToWindow(browserWindow, 'browser-agent-leases', createBrowserLeaseSnapshot(windowId));
  }
};

const removeBrowserLeaseOwner = (leaseId) => {
  const owner = browserLeaseOwners.get(leaseId);
  if (!owner) return null;
  browserLeaseOwners.delete(leaseId);
  browserSurfaceManager?.releaseLease(leaseId, 'lease_closed');
  scheduleBrowserLeaseGlobalCountPublish();
  if (observedBrowserLeaseByWindow.get(owner.ownerWindowId) === leaseId) {
    observedBrowserLeaseByWindow.delete(owner.ownerWindowId);
  }
  publishBrowserLeaseSnapshot(owner.ownerWindowId);
  return owner;
};

// The CDP bridge is created lazily on the first lease. It owns one shared
// listener and a separately fenced target/client/debugger state per lease.
let browserCdpBridge = null;
let browserCdpBridgePromise = null;

const ensureBrowserCdpBridge = async () => {
  if (browserCdpBridge) return browserCdpBridge;
  if (!browserCdpBridgePromise) {
    browserCdpBridgePromise = (async () => {
      const { WebSocketServer } = await import('ws');
      const { createBrowserCdpBridge } = await import('./browser-cdp-bridge.mjs');
      if (browserCdpBridge) return browserCdpBridge;
      browserCdpBridge = createBrowserCdpBridge({
        createWebSocketServer: (options) => new WebSocketServer(options),
        crypto,
        onAgentInput: (input) => {
          browserSurfaceManager?.showAgentInput(input?.leaseId, input);
          const owner = browserLeaseOwners.get(input?.leaseId);
          if (!owner || observedBrowserLeaseByWindow.get(owner.ownerWindowId) !== input.leaseId) return;
          const browserWindow = browserWindowById(owner.ownerWindowId);
          if (!isPrivilegedLeaseWindow(browserWindow)) return;
          emitToWindow(browserWindow, 'browser-agent-input', input);
        },
        onBeforeCommand: ({ leaseId, method }) => {
          if (method === 'Page.captureScreenshot') {
            return browserSurfaceManager?.setAgentCursorSuppressed(leaseId, true);
          }
        },
        onAfterCommand: ({ leaseId, method }) => {
          if (method === 'Page.captureScreenshot') {
            return browserSurfaceManager?.setAgentCursorSuppressed(leaseId, false);
          }
        },
        onStatusChange: () => publishBrowserLeaseSnapshot(),
        log: (message, error) => (error ? log.warn(message, error) : log.info(message)),
      });
      return browserCdpBridge;
    })().finally(() => {
      browserCdpBridgePromise = null;
    });
  }
  return await browserCdpBridgePromise;
};

const LEASE_GUEST_BIND_POLL_MS = 50;
const LEASE_OWNER_CLAIM_TIMEOUT_MS = 5_000;

const waitForBrowserLeaseOwnerWindow = async (metadata) => {
  const deadline = Date.now() + LEASE_OWNER_CLAIM_TIMEOUT_MS;
  while (!state.quitRequested) {
    const ownerWindow = resolveBrowserLeaseOwnerWindow(metadata);
    if (ownerWindow) return ownerWindow;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, LEASE_GUEST_BIND_POLL_MS));
  }
  return null;
};

const createDesktopBrowserLease = async ({ leaseId, metadata = {}, onClosed } = {}) => {
  if (!readAgentBrowserControlEnabled()) throw new Error('agent_browser_disabled');
  if (typeof leaseId !== 'string' || !leaseId) throw new Error('invalid_browser_lease');
  if (browserLeaseOwners.has(leaseId)) throw new Error('browser_lease_exists');

  // Task/session events can reach the managed child just before the renderer's
  // exact context-claim IPC. Wait briefly for that exact claim; never fall back
  // to focus, another directory, or another root.
  const ownerWindow = await waitForBrowserLeaseOwnerWindow(metadata);
  if (!ownerWindow) throw new Error('browser_lease_window_unavailable');
  const owner = { ownerWindowId: ownerWindow.id, metadata: { ...metadata } };
  browserLeaseOwners.set(leaseId, owner);

  let bridge;
  let started;
  try {
    bridge = await ensureBrowserCdpBridge();
    if (!readAgentBrowserControlEnabled() || state.quitRequested) {
      throw new Error(state.quitRequested ? 'browser_runtime_stopping' : 'agent_browser_disabled');
    }
    started = await bridge.createLease({
      leaseId,
      metadata,
      onClosed: (detail) => {
        removeBrowserLeaseOwner(leaseId);
        if (typeof onClosed === 'function') {
          Promise.resolve(onClosed(detail)).catch((error) => {
            log.warn(`[cdp-bridge] lease close callback failed for ${leaseId}`, error);
          });
        }
      },
    });
  } catch (error) {
    removeBrowserLeaseOwner(leaseId);
    throw error;
  }
  if (!started.ok) {
    removeBrowserLeaseOwner(leaseId);
    throw new Error(`browser_lease_${started.state || 'start_failed'}`);
  }

  try {
    const { webContents: surfaceContents } = getBrowserSurfaceManager().createLeaseSurface(ownerWindow, {
      leaseId,
      initialUrl: metadata?.url,
    });
    const bound = bridge.bindLeaseGuest(leaseId, surfaceContents, { ownerWindowId: ownerWindow.id });
    if (!bound.ok) throw new Error(`browser_lease_${bound.state || 'bind_failed'}`);
  } catch (error) {
    bridge.closeLease(leaseId, 'surface_bind_failed');
    throw error;
  }

  scheduleBrowserLeaseGlobalCountPublish();
  publishBrowserLeaseSnapshot(ownerWindow.id);
  return { ...started, state: 'ready' };
};

const touchDesktopBrowserLease = async ({ leaseId, metadata = {} } = {}) => {
  if (typeof leaseId !== 'string') return { ok: false, state: 'not_found' };
  if (!browserCdpBridge) {
    removeBrowserLeaseOwner(leaseId);
    return { ok: false, state: 'not_found' };
  }
  const owner = browserLeaseOwners.get(leaseId);
  if (owner && metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    owner.metadata = { ...owner.metadata, ...metadata };
  }
  const result = browserCdpBridge.touchLease(leaseId, metadata);
  if (result?.ok === false || result?.state === 'not_found') removeBrowserLeaseOwner(leaseId);
  return result;
};

const releaseDesktopBrowserLease = async ({ leaseId, reason = 'released' } = {}) => {
  if (typeof leaseId !== 'string') return { ok: true, state: 'not_found' };
  if (!browserCdpBridge) {
    removeBrowserLeaseOwner(leaseId);
    return { ok: true, state: 'not_found' };
  }
  const closed = browserCdpBridge.closeLease(leaseId, safeLeaseString(reason, 128) || 'released');
  if (!closed) removeBrowserLeaseOwner(leaseId);
  return { ok: true, state: closed ? 'closed' : 'not_found' };
};

const bindDesktopBrowserLeaseGuest = async (browserWindow, { leaseId } = {}) => {
  if (typeof leaseId !== 'string' || !leaseId) throw new Error('leaseId is required');
  const owner = browserLeaseOwners.get(leaseId);
  if (!owner || !browserWindow || owner.ownerWindowId !== browserWindow.id) {
    throw new Error('Browser lease does not belong to the requesting window');
  }
  const surface = browserSurfaceManager?.surfaceForLease(leaseId);
  if (!surface) throw new Error('Browser lease surface is not available');
  return browserCdpBridge?.getLeaseStatus(leaseId) || { ok: false, state: 'not_found' };
};

const setObservedDesktopBrowserLease = (browserWindow, { leaseId } = {}) => {
  if (!browserWindow || browserWindow.isDestroyed()) throw new Error('Window is not available');
  if (leaseId === null || leaseId === undefined || leaseId === '') {
    observedBrowserLeaseByWindow.delete(browserWindow.id);
    return { ok: true, leaseId: null };
  }
  const owner = browserLeaseOwners.get(leaseId);
  if (!owner || owner.ownerWindowId !== browserWindow.id) {
    throw new Error('Browser lease does not belong to the requesting window');
  }
  observedBrowserLeaseByWindow.set(browserWindow.id, leaseId);
  return { ok: true, leaseId };
};

const claimDesktopBrowserLeaseContexts = (browserWindow, { contexts } = {}) => {
  if (!isPrivilegedLeaseWindow(browserWindow)) throw new Error('Window is not available');
  const claimKeys = collectBrowserLeaseWindowClaimKeys(contexts);
  const claimedAt = Date.now();
  for (const claimKey of claimKeys) {
    // Refresh insertion order so authoritative, still-known contexts survive
    // the stale-claim cap. Other roots/directories remain additive.
    browserLeaseWindowClaims.delete(claimKey);
    browserLeaseWindowClaims.set(claimKey, { ownerWindowId: browserWindow.id, claimedAt });
  }
  for (const [leaseId, owner] of browserLeaseOwners) {
    if (Number.isInteger(owner.ownerWindowId)) continue;
    const ownerClaimKey = browserLeaseWindowClaimKey(owner.metadata?.directory, owner.metadata?.rootSessionId);
    if (!ownerClaimKey || !claimKeys.includes(ownerClaimKey)) continue;
    owner.ownerWindowId = browserWindow.id;
    browserSurfaceManager?.setLeaseHomeWindow(leaseId, browserWindow);
  }
  while (browserLeaseWindowClaims.size > MAX_BROWSER_LEASE_CONTEXT_CLAIMS_PER_REQUEST) {
    browserLeaseWindowClaims.delete(browserLeaseWindowClaims.keys().next().value);
  }
  publishBrowserLeaseSnapshot(browserWindow.id);
  return { ok: true, claimed: claimKeys.length };
};

const claimDesktopBrowserLeaseContext = (browserWindow, { directory, rootSessionId } = {}) => {
  return claimDesktopBrowserLeaseContexts(browserWindow, {
    contexts: [{ directory, rootSessionId }],
  });
};

const getBrowserCdpBridgeStatus = () => {
  if (!readAgentBrowserControlEnabled()) return { state: 'disabled' };
  return browserCdpBridge?.status() || { state: 'stopped', running: false, clients: 0, leaseCount: 0 };
};

// Kept as a compatibility diagnostic endpoint, but never publishes any
// lease's capability URL. New agents acquire a scoped URL through the private
// lease API instead.
const resolveBridgeStatusForDiscovery = async () => (
  readAgentBrowserControlEnabled() ? { state: 'lease_required' } : { state: 'disabled' }
);

// Disabling the setting must drop an active session immediately, not merely
// prevent the next one.
const enforceAgentBrowserControlSetting = () => {
  if (readAgentBrowserControlEnabled()) return;
  if (browserCdpBridge) {
    log.info('[cdp-bridge] closing all leases: agent browser control disabled');
    browserCdpBridge.closeAll('disabled');
    return;
  }
  if (browserCdpBridgePromise) {
    void browserCdpBridgePromise.then((bridge) => {
      if (!readAgentBrowserControlEnabled()) bridge.closeAll('disabled');
    }).catch(() => undefined);
  }
};

const readAgentBrowserRuntimeStatus = async ({ refresh = true } = {}) => {
  if (state.agentBrowserRuntimeMode === 'pending') {
    return {
      ok: false,
      state: 'pending',
      expectedVersion: '0.33.2',
      installedVersion: null,
      binaryPath: '',
      issues: [],
      skill: null,
      activeLeaseCount: browserLeaseOwners.size,
    };
  }
  if (!state.agentBrowserManagedRuntime || state.agentBrowserRuntimeMode === 'external') {
    return {
      ok: false,
      state: 'external-runtime',
      expectedVersion: '0.33.2',
      installedVersion: null,
      binaryPath: '',
      issues: [{
        code: 'external-runtime-noop',
        message: 'Agent browser setup is available only for the Electron-managed OpenCode runtime',
      }],
      skill: null,
      activeLeaseCount: browserLeaseOwners.size,
    };
  }
  if (state.agentBrowserSetupPromise) {
    await state.agentBrowserSetupPromise;
  }
  if (refresh && state.agentBrowserInstaller?.status) {
    try {
      state.agentBrowserInstallStatus = await state.agentBrowserInstaller.status();
    } catch (error) {
      state.agentBrowserInstallStatus = {
        ...(state.agentBrowserInstallStatus || {}),
        ok: false,
        state: 'unavailable',
        issues: [{ code: 'status-failed', message: error instanceof Error ? error.message : String(error) }],
      };
    }
  }
  return {
    ...(state.agentBrowserInstallStatus || {
      ok: false,
      state: 'unavailable',
      expectedVersion: '0.33.2',
      installedVersion: null,
      issues: [{ code: 'installer-unavailable', message: 'Agent browser installer is unavailable' }],
    }),
    skill: state.agentBrowserSkillStatus,
    activeLeaseCount: browserLeaseOwners.size,
  };
};

const createAgentBrowserMutationResult = (
  status,
  { applied = false, restartSucceeded = false, restartFailed = false } = {},
) => {
  const result = {
    ...(status && typeof status === 'object' ? status : {}),
    applied,
    restartSucceeded,
  };
  if (!restartFailed) return result;

  const issues = Array.isArray(result.issues)
    ? result.issues.filter((issue) => issue?.code !== 'restart-failed')
    : [];
  return {
    ...result,
    state: 'restart-failed',
    applied: false,
    restartSucceeded: false,
    issues: [
      ...issues,
      {
        code: 'restart-failed',
        message: 'Agent browser is installed, but OpenCode could not restart. Restart DevRyan to apply it.',
      },
    ],
  };
};

const mutateAgentBrowserInstallation = async (operation) => {
  if (!state.agentBrowserManagedRuntime || state.agentBrowserRuntimeMode !== 'managed') {
    return createAgentBrowserMutationResult(
      await readAgentBrowserRuntimeStatus({ refresh: false }),
    );
  }
  if (state.agentBrowserSetupPromise) {
    await state.agentBrowserSetupPromise;
  }
  const installer = state.agentBrowserInstaller;
  const action = installer?.[operation];
  if (typeof action !== 'function') {
    return createAgentBrowserMutationResult(
      await readAgentBrowserRuntimeStatus({ refresh: false }),
    );
  }
  try {
    state.agentBrowserInstallStatus = await action.call(installer);
  } catch (error) {
    state.agentBrowserInstallStatus = {
      ...(state.agentBrowserInstallStatus || {}),
      ok: false,
      state: 'unavailable',
      issues: [{ code: `${operation}-failed`, message: error instanceof Error ? error.message : String(error) }],
    };
  }

  state.agentBrowserSkillStatus = state.agentBrowserInstallStatus?.ok
    ? await state.agentBrowserSkillProvisioner?.()
    : await state.agentBrowserSkillWithdrawer?.();

  const runtimeStatus = await readAgentBrowserRuntimeStatus({ refresh: false });
  if (!runtimeStatus.ok) {
    return createAgentBrowserMutationResult(runtimeStatus);
  }
  if (typeof state.serverHandle?.restartOpenCode !== 'function') {
    log.warn('[agent-browser] installed successfully but managed OpenCode restart is unavailable');
    return createAgentBrowserMutationResult(runtimeStatus, { restartFailed: true });
  }

  try {
    await state.serverHandle.restartOpenCode();
  } catch (error) {
    log.warn('[agent-browser] installed successfully but managed OpenCode restart failed', error);
    return createAgentBrowserMutationResult(runtimeStatus, { restartFailed: true });
  }
  return createAgentBrowserMutationResult(
    await readAgentBrowserRuntimeStatus({ refresh: false }),
    { applied: true, restartSucceeded: true },
  );
};

const loadUrlInsideWebContents = (contents, rawUrl) => {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (contents.isDestroyed()) return false;
    void contents.loadURL(url.toString()).catch((error) => {
      log.warn('[webview] failed to load popup URL in place:', error);
    });
    return true;
  } catch {
    return false;
  }
};

// Popup containment + navigation protocol allowlist for every webview guest.
// setWindowOpenHandler is the real popup boundary (the in-page window.open
// patch is cosmetic); the will-navigate guard also constrains navigations
// initiated over CDP once the agent bridge lands.
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;

  contents.setWindowOpenHandler(({ url }) => {
    loadUrlInsideWebContents(contents, url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (isAllowedWebviewNavigationUrl(url)) return;
    event.preventDefault();
  });
});

// The browser partition denies permission prompts (camera, mic, geolocation,
// notifications, …) and downloads outright. Electron needs BOTH the request
// and check handlers for complete permission coverage. Fullscreen stays
// allowed so video sites behave.
const configureBrowserWebviewSession = () => {
  const browserSession = session.fromPartition(BROWSER_WEBVIEW_PARTITION);
  browserSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'fullscreen');
  });
  browserSession.setPermissionCheckHandler((_contents, permission) => permission === 'fullscreen');
  browserSession.on('will-download', (event) => {
    event.preventDefault();
  });
};

// Cache reporting/clearing spans the app session and the browser pane's
// persistent partition; keep both in sync so neither hides disk usage.
const cacheMaintenanceSessions = () => ({
  defaultSession: session.defaultSession,
  browserSession: session.fromPartition(BROWSER_WEBVIEW_PARTITION),
});

const createBrowserWindow = ({ label, restoreGeometry, url }) => {
  const saved = restoreGeometry ? readWindowState() : null;
  const useSaved = saved && typeof saved.width === 'number' && typeof saved.height === 'number';
  const desktopLocalOrigin = state.localOrigin || '';
  const desktopServerOrigin = state.sidecarUrl || state.localOrigin || '';
  const desktopHome = os.homedir() || '';
  const desktopMacosMajor = String(macosMajorVersion());
  const options = {
    title: 'DevRyan',
    width: useSaved ? Math.max(saved.width, MIN_RESTORE_WINDOW_WIDTH) : 1280,
    height: useSaved ? Math.max(saved.height, MIN_RESTORE_WINDOW_HEIGHT) : 800,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    backgroundColor: '#151313',
    // Tauri used an overlay title bar with explicit traffic-light placement.
    // Electron's hiddenInset adds its own extra inset, which leaves the controls
    // visibly lower than the app header. Use a plain hidden title bar instead.
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 17 } : undefined,
    webPreferences: {
      additionalArguments: [
        `--openchamber-local-origin=${desktopLocalOrigin}`,
        `--openchamber-server-origin=${desktopServerOrigin}`,
        `--openchamber-home=${desktopHome}`,
        `--openchamber-macos-major=${desktopMacosMajor}`,
        `--openchamber-boot-outcome=${JSON.stringify(state.bootOutcome || null)}`,
      ],
      preload: isDev ? path.join(__dirname, 'preload.mjs') : path.join(app.getAppPath(), 'preload.mjs'),
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox must stay off: the preload uses contextBridge + ipcRenderer
      // from Electron's Node layer. contextIsolation + nodeIntegration:false
      // keep the renderer world walled off from Node. Do NOT flip to true —
      // the preload would fail to load and __TAURI__ would go undefined.
      sandbox: false,
      // Required for the context panel's browser pane. Guests are hardened in
      // will-attach-webview (preload stripped, sandboxed, pinned partition).
      webviewTag: true,
    },
  };

  const browserWindow = new BrowserWindow(options);
  browserWindow.__ocLabel = label || nextWindowLabel();

  if (useSaved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    browserWindow.setPosition(saved.x, saved.y);
  }

  if (useSaved && saved.maximized) {
    browserWindow.maximize();
  }

  browserWindow.on('focus', () => {
    state.focusedWindowIds.add(browserWindow.id);
  });
  browserWindow.on('blur', () => {
    state.focusedWindowIds.delete(browserWindow.id);
  });

  // Traffic lights disappear during dock-restore animation when using
  // titleBarStyle:'hidden' + custom trafficLightPosition. macOS caches a
  // snapshot of the window at miniaturize time and plays it during the
  // genie-restore animation. We re-assert button position on 'minimize'
  // (before the snapshot) and 'restore'/'show'/'focus' to cover other
  // transient reset states AppKit puts the buttons in.
  if (process.platform === 'darwin') {
    const refreshTrafficLights = () => {
      if (browserWindow.isDestroyed()) return;
      try {
        browserWindow.setWindowButtonVisibility(true);
        browserWindow.setTrafficLightPosition({ x: 16, y: 17 });
      } catch {}
    };
    browserWindow.on('minimize', refreshTrafficLights);
    browserWindow.on('restore', () => {
      refreshTrafficLights();
      setTimeout(refreshTrafficLights, 250);
    });
    browserWindow.on('show', refreshTrafficLights);
    browserWindow.on('focus', refreshTrafficLights);
  }

  browserWindow.on('resize', () => {
    emitToWindow(browserWindow, 'openchamber:window-resized');
    debounceWindowStatePersist(browserWindow, false);
  });
  browserWindow.on('move', () => {
    debounceWindowStatePersist(browserWindow, false);
  });
  browserWindow.on('close', (event) => {
    if (process.platform === 'darwin' && !state.quitRequested) {
      const remainingVisible = BrowserWindow.getAllWindows().filter(
        (window) => !window.isDestroyed() && window.isVisible(),
      ).length;

      if (remainingVisible <= 1) {
        debounceWindowStatePersist(browserWindow, true);
        event.preventDefault();
        browserWindow.hide();
        return;
      }
    }

    debounceWindowStatePersist(browserWindow, true);
  });
  browserWindow.on('closed', () => {
    browserSurfaceManager?.handleHomeWindowClosed(browserWindow.id);
    observedBrowserLeaseByWindow.delete(browserWindow.id);
    for (const [claimKey, claim] of browserLeaseWindowClaims) {
      if (claim.ownerWindowId === browserWindow.id) browserLeaseWindowClaims.delete(claimKey);
    }
    for (const owner of browserLeaseOwners.values()) {
      if (owner.ownerWindowId === browserWindow.id) owner.ownerWindowId = null;
    }
    state.focusedWindowIds.delete(browserWindow.id);
    if (state.mainWindow && browserWindow.id === state.mainWindow.id) {
      state.mainWindow = null;
    }
    if (BrowserWindow.getAllWindows().length === 0) {
      if (!state.installingUpdate) {
        killSidecar();
      }
      if (process.platform !== 'darwin') {
        app.quit();
      }
    }
  });

  // Any navigation target that isn't our own UI (local server / configured
  // desktop hosts) should open in the user's default browser, not spawn
  // another Electron window loading arbitrary web content.
  const isAllowedNavigationUrl = (raw) => isAllowedElectronContentUrl(raw, buildContentOriginPolicy());

  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedNavigationUrl(url)) {
      return { action: 'allow' };
    }
    void shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  browserWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigationUrl(url)) return;
    event.preventDefault();
    void shell.openExternal(url).catch(() => {});
  });

  // Harden every <webview> guest this window tries to attach. The embedder
  // must be our own privileged UI (never a remote host page), and the guest
  // never inherits the preload/__TAURI__ IPC surface, runs sandboxed, and is
  // pinned to the browser partition. Tighter than upstream, which ships no
  // will-attach-webview handler at all.
  browserWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const embedderUrl = browserWindow.webContents.getURL();
    if (!isPrivilegedRendererUrl(embedderUrl, state.localOrigin)) {
      log.warn(`[webview] refused attach from non-privileged embedder: ${embedderUrl || '(unknown)'}`);
      event.preventDefault();
      return;
    }
    if (!isAllowedWebviewSourceUrl(params?.src)) {
      log.warn('[webview] refused attach with disallowed src');
      event.preventDefault();
      return;
    }
    hardenWebviewAttachParams(webPreferences, params);
  });

  browserWindow.webContents.setZoomFactor(1);
  browserWindow.webContents.on('zoom-changed', () => {
    browserWindow.webContents.setZoomFactor(1);
  });

  browserWindow.webContents.on('dom-ready', () => {
    if (state.initScript) {
      void browserWindow.webContents.executeJavaScript(state.initScript).catch(() => {});
    }
  });

  browserWindow.webContents.on('did-finish-load', () => {
    browserWindow.webContents.setZoomFactor(1);
    if (state.mainWindow && browserWindow.id === state.mainWindow.id && pendingDeepLinks.length > 0) {
      const timer = setTimeout(flushPendingDeepLinks, 400);
      if (typeof timer?.unref === 'function') timer.unref();
    }
  });

  browserWindow.once('ready-to-show', () => {
    browserWindow.show();
    browserWindow.focus();
  });

  if (url) {
    void navigateWindow(browserWindow, url);
  } else {
    void navigateWindow(
      browserWindow,
      `data:text/html;charset=utf-8,${encodeURIComponent(buildStartupSplashHtml())}`,
      { allowAbort: true },
    );
  }

  return browserWindow;
};

const activateMainWindow = async (url, localOrigin, bootOutcome) => {
  state.localOrigin = localOrigin;
  state.bootOutcome = bootOutcome ?? null;
  state.initScript = buildInitScript(localOrigin, state.bootOutcome, state.sidecarUrl || localOrigin);

  const mainWindow = state.mainWindow;
  if (mainWindow && !mainWindow.isDestroyed()) {
    await navigateWindow(mainWindow, url, { allowAbort: true });
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  state.mainWindow = createBrowserWindow({
    label: 'main',
    restoreGeometry: true,
    url,
  });
  return state.mainWindow;
};

const createAdditionalWindow = async (url) => {
  if (!state.localOrigin) {
    return null;
  }
  const browserWindow = createBrowserWindow({
    label: nextWindowLabel(),
    restoreGeometry: false,
    url,
  });
  return browserWindow;
};

const buildMiniChatUrl = ({ mode, sessionId, directory, projectId }) => {
  const base = state.localOrigin || state.sidecarUrl;
  if (!base) {
    throw new Error('Local UI is not available');
  }

  const url = new URL('/mini-chat.html', base);
  url.searchParams.set('mode', mode === 'session' ? 'session' : 'draft');
  if (sessionId) url.searchParams.set('sessionId', sessionId);
  if (directory) url.searchParams.set('directory', directory);
  if (projectId) url.searchParams.set('projectId', projectId);
  return url.toString();
};

const buildBrowserPopoutUrl = (surfaceId) => {
  const base = state.localOrigin || state.sidecarUrl;
  if (!base) throw new Error('Local UI is not available');
  const url = new URL('/browser.html', base);
  url.searchParams.set('surfaceId', safeLeaseString(surfaceId, 220));
  return url.toString();
};

const createBrowserPopoutWindow = async (surfaceId) => {
  const desktopLocalOrigin = state.localOrigin || '';
  const desktopServerOrigin = state.sidecarUrl || state.localOrigin || '';
  const browserWindow = new BrowserWindow({
    title: 'DevRyan Browser',
    width: 1180,
    height: 760,
    minWidth: 640,
    minHeight: 420,
    show: false,
    backgroundColor: '#151313',
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 12 } : undefined,
    webPreferences: {
      additionalArguments: [
        `--openchamber-local-origin=${desktopLocalOrigin}`,
        `--openchamber-server-origin=${desktopServerOrigin}`,
      ],
      preload: isDev ? path.join(__dirname, 'preload.mjs') : path.join(app.getAppPath(), 'preload.mjs'),
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
    },
  });
  browserWindow.__ocLabel = `browser-${safeLeaseString(surfaceId, 120)}`;
  browserWindow.__ocBrowserPopout = true;
  browserWindow.__ocBrowserSurfaceId = surfaceId;
  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  browserWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const target = new URL(url);
      const local = new URL(state.localOrigin || state.sidecarUrl || '');
      if (target.origin === local.origin && target.pathname === '/browser.html') return;
    } catch {
    }
    event.preventDefault();
  });
  browserWindow.once('ready-to-show', () => {
    if (browserWindow.isDestroyed()) return;
    browserWindow.show();
    browserWindow.focus();
  });
  void navigateWindow(browserWindow, buildBrowserPopoutUrl(surfaceId)).catch((error) => {
    log.warn('[browser-surface] failed to load pop-out shell', error);
    if (!browserWindow.isDestroyed()) browserWindow.destroy();
  });
  return browserWindow;
};

const createMiniChatWindow = async ({ mode, sessionId = '', directory = '', projectId = '' } = {}) => {
  if (mode === 'session' && sessionId) {
    const existing = state.miniChatWindowsBySession.get(sessionId);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return existing;
    }
    state.miniChatWindowsBySession.delete(sessionId);
  }

  const desktopLocalOrigin = state.localOrigin || '';
  const desktopServerOrigin = state.sidecarUrl || state.localOrigin || '';
  const desktopHome = os.homedir() || '';
  const desktopMacosMajor = String(macosMajorVersion());
  const browserWindow = new BrowserWindow({
    title: 'DevRyan Mini Chat',
    width: MINI_CHAT_WINDOW_WIDTH,
    height: MINI_CHAT_WINDOW_HEIGHT,
    minWidth: MINI_CHAT_MIN_WINDOW_WIDTH,
    minHeight: MINI_CHAT_MIN_WINDOW_HEIGHT,
    show: false,
    backgroundColor: '#151313',
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 17 } : undefined,
    webPreferences: {
      additionalArguments: [
        `--openchamber-local-origin=${desktopLocalOrigin}`,
        `--openchamber-server-origin=${desktopServerOrigin}`,
        `--openchamber-home=${desktopHome}`,
        `--openchamber-macos-major=${desktopMacosMajor}`,
      ],
      preload: isDev ? path.join(__dirname, 'preload.mjs') : path.join(app.getAppPath(), 'preload.mjs'),
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  browserWindow.__ocLabel = nextWindowLabel();
  browserWindow.__ocMiniChat = true;
  browserWindow.__ocMiniChatSessionId = mode === 'session' ? sessionId : '';
  browserWindow.__ocPinned = false;

  if (mode === 'session' && sessionId) {
    state.miniChatWindowsBySession.set(sessionId, browserWindow);
  }

  browserWindow.on('closed', () => {
    if (browserWindow.__ocMiniChatSessionId) {
      const existing = state.miniChatWindowsBySession.get(browserWindow.__ocMiniChatSessionId);
      if (existing?.id === browserWindow.id) {
        state.miniChatWindowsBySession.delete(browserWindow.__ocMiniChatSessionId);
      }
    }
  });

  if (process.platform === 'darwin') {
    const refreshTrafficLights = () => {
      if (browserWindow.isDestroyed()) return;
      try {
        browserWindow.setWindowButtonVisibility(true);
        browserWindow.setTrafficLightPosition({ x: 16, y: 17 });
      } catch {}
    };
    browserWindow.on('show', refreshTrafficLights);
    browserWindow.on('focus', refreshTrafficLights);
  }

  browserWindow.once('ready-to-show', () => {
    browserWindow.show();
    browserWindow.focus();
  });

  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  browserWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const target = new URL(url);
      const local = new URL(state.localOrigin || state.sidecarUrl || '');
      if (target.origin === local.origin) return;
    } catch {
    }
    event.preventDefault();
    void shell.openExternal(url).catch(() => {});
  });
  browserWindow.webContents.on('dom-ready', () => {
    if (state.initScript) {
      void browserWindow.webContents.executeJavaScript(state.initScript).catch(() => {});
    }
  });

  await navigateWindow(browserWindow, buildMiniChatUrl({ mode, sessionId, directory, projectId }));
  return browserWindow;
};

const setMiniChatPinned = (browserWindow, pinned) => {
  if (!browserWindow || browserWindow.isDestroyed()) {
    throw new Error('Window is not available');
  }
  if (browserWindow.__ocMiniChat !== true) {
    throw new Error('Pinning is only available for Mini Chat windows');
  }
  const nextPinned = pinned === true;
  browserWindow.__ocPinned = nextPinned;
  if (nextPinned) {
    browserWindow.setAlwaysOnTop(true, 'floating');
  } else {
    browserWindow.setAlwaysOnTop(false);
    if (process.platform === 'darwin') {
      browserWindow.setVisibleOnAllWorkspaces(false);
    }
  }
  return { pinned: nextPinned };
};

const resolveInitialUrl = async () => {
  const localUrl = isDev && await waitForHealth('http://127.0.0.1:3901', 5_000, 100)
    ? 'http://127.0.0.1:3901'
    : await spawnLocalServer();

  const localUiUrl = isDev && await waitForHealth('http://127.0.0.1:5173', 8_000, 100)
    ? 'http://127.0.0.1:5173'
    : localUrl;

  state.sidecarUrl = localUrl;
  const localAvailable = Boolean(localUrl);

  const localOrigin = new URL(localUiUrl).origin;
  let initialUrl = localUiUrl;
  let remoteProbe = null;

  const envTarget = normalizeHostUrl(process.env.OPENCHAMBER_SERVER_URL || '');
  const config = readDesktopHostsConfig();
  if (envTarget) {
    initialUrl = envTarget;
  } else if (config.defaultHostId && config.defaultHostId !== LOCAL_HOST_ID) {
    const host = config.hosts.find((entry) => entry.id === config.defaultHostId);
    if (host?.url) {
      initialUrl = host.url;
    }
  }

  if (initialUrl !== localUiUrl) {
    remoteProbe = await probeHostWithTimeout(initialUrl, 2_000);
    if (remoteProbe.status === 'unreachable') {
      remoteProbe = await probeHostWithTimeout(initialUrl, 10_000);
    }
    if (remoteProbe.status === 'unreachable') {
      state.unreachableHosts.add(initialUrl);
      initialUrl = localUiUrl;
    }
  }

  const bootOutcome = computeBootOutcome({
    envTargetUrl: envTarget || null,
    probe: remoteProbe,
    config,
    localAvailable,
  });

  return { initialUrl, localOrigin, localUiUrl, bootOutcome };
};

const compareSemver = (left, right) => {
  const a = String(left || '').replace(/^v/, '').split('.').map((value) => Number.parseInt(value || '0', 10));
  const b = String(right || '').replace(/^v/, '').split('.').map((value) => Number.parseInt(value || '0', 10));
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

const parseGithubRepo = () => {
  return { owner: GITHUB_REPOSITORY_OWNER, repo: GITHUB_REPOSITORY_NAME };
};

const setupAutoUpdater = () => {
  if (!app.isPackaged) {
    return;
  }
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.fullChangelog = true;
  autoUpdater.disableWebInstaller = false;
  autoUpdater.logger = log;

  const { owner, repo } = parseGithubRepo();
  autoUpdater.setFeedURL({
    provider: 'github',
    owner,
    repo,
  });

  autoUpdater.on('download-progress', (progress) => {
    emitToAllWindows('openchamber:update-progress', mapUpdaterProgressEvent({
      event: 'Progress',
      data: {
        chunkLength: Math.max(0, Math.round(progress.bytesPerSecond || 0)),
        downloaded: Math.round(progress.transferred || 0),
        total: Math.round(progress.total || 0),
      },
    }));
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info(`[electron] update-downloaded version=${info?.version || 'unknown'}`);
    if (state.pendingUpdate) {
      state.pendingUpdate.downloaded = true;
    }
  });

  autoUpdater.on('error', (err) => {
    log.error('[electron] autoUpdater error', err);
  });
};

const buildInstalledAppsCachePath = () => path.join(path.dirname(settingsFilePath()), INSTALLED_APPS_CACHE_FILE);

// Async variants. sips + mdfind via spawnSync blocked the Electron main event
// loop for 2-3s on boot (22 OPEN_IN_APPS × ~200 ms each). Use execFile promises
// so each child-process wait yields to the loop and the UI stays responsive.
const pathExists = async (candidate) => {
  try {
    await fsp.access(candidate);
    return true;
  } catch {
    return false;
  }
};

const resolveAppBundlePath = async (appName) => {
  if (process.platform !== 'darwin') return null;
  const bundleName = appName.endsWith('.app') ? appName : `${appName}.app`;
  const candidates = [
    `/Applications/${bundleName}`,
    `/System/Applications/${bundleName}`,
    `/System/Applications/Utilities/${bundleName}`,
    path.join(os.homedir(), 'Applications', bundleName),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  try {
    const { stdout } = await execFileAsync('mdfind', ['-name', bundleName], { encoding: 'utf8' });
    const first = (stdout || '').split('\n').map((line) => line.trim()).find(Boolean);
    return first || null;
  } catch {
    return null;
  }
};

const isAppBundleInstalled = async (appName) => Boolean(await resolveAppBundlePath(appName));

const iconToDataUrl = async (iconPath, appName) => {
  if (!iconPath || !(await pathExists(iconPath))) return null;
  const safeName = String(appName || 'app').replace(/[^a-z0-9]/gi, '_');
  const tempPath = path.join(os.tmpdir(), `openchamber-icon-${safeName}-${Date.now()}.png`);
  try {
    await execFileAsync('sips', ['-s', 'format', 'png', '-Z', '32', iconPath, '--out', tempPath], { stdio: 'ignore' });
  } catch {
    return null;
  }
  if (!(await pathExists(tempPath))) return null;
  try {
    const bytes = await fsp.readFile(tempPath);
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } finally {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
  }
};

const resolveAppIconPath = async (appPath) => {
  if (!appPath || !(await pathExists(appPath))) return null;
  const resourcesPath = path.join(appPath, 'Contents', 'Resources');
  if (!(await pathExists(resourcesPath))) return null;
  let entries;
  try {
    entries = await fsp.readdir(resourcesPath);
  } catch {
    return null;
  }
  const icon = entries.find((entry) => entry.toLowerCase().endsWith('.icns'));
  return icon ? path.join(resourcesPath, icon) : null;
};

const buildInstalledApps = async (apps) => {
  const seen = new Set();
  const names = apps
    .map((raw) => String(raw || '').trim())
    .filter((raw) => raw && !seen.has(raw) && seen.add(raw));
  const results = [];
  for (const name of names) {
    const appPath = await resolveAppBundlePath(name);
    if (!appPath) continue;
    const iconDataUrl = await iconToDataUrl(await resolveAppIconPath(appPath), name);
    results.push({ name, iconDataUrl });
  }
  return results;
};

const parseSshConfigImports = () => {
  const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
  if (!fs.existsSync(sshConfigPath)) return [];
  const lines = fs.readFileSync(sshConfigPath, 'utf8').split(/\r?\n/);
  const results = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.toLowerCase().startsWith('host ')) {
      continue;
    }
    const hosts = trimmed.slice(5).trim().split(/\s+/).filter(Boolean);
    for (const host of hosts) {
      results.push({
        host,
        pattern: /[*?]/.test(host),
        source: sshConfigPath,
        sshCommand: `ssh ${host}`,
      });
    }
  }
  return results;
};

const readDesktopSshInstances = () => {
  const root = readSettingsRoot();
  return { instances: Array.isArray(root.desktopSshInstances) ? root.desktopSshInstances : [] };
};

const writeDesktopSshInstances = async (config) => {
  const nextInstances = Array.isArray(config?.instances) ? config.instances : [];
  await mutateSettingsRoot((root) => {
    root.desktopSshInstances = nextInstances;
  });
  return { instances: nextInstances };
};

const updateHostUrlForSshInstance = async (id, label, localUrl) => {
  const config = readDesktopHostsConfig();
  const nextHosts = config.hosts.filter((entry) => entry.id !== id);
  nextHosts.push({ id, label, url: localUrl });
  await writeDesktopHostsConfig({ hosts: nextHosts, defaultHostId: config.defaultHostId });
};

const JETBRAINS_APP_IDS = new Set([
  'pycharm',
  'intellij',
  'webstorm',
  'phpstorm',
  'rider',
  'rustrover',
  'android-studio',
]);

const CLI_BY_APP_ID = {
  vscode: 'code',
  cursor: 'cursor',
  vscodium: 'codium',
  windsurf: 'windsurf',
  zed: 'zed',
};

const buildOpenProjectSpecs = ({ projectPath, appId, appName }) => {
  if (appId === 'finder') {
    return [{ program: 'open', args: [projectPath] }];
  }

  if (appId === 'terminal' || appId === 'iterm2' || appId === 'ghostty') {
    return [{ program: 'open', args: ['-a', appName, projectPath] }];
  }

  const specs = [];

  const cli = CLI_BY_APP_ID[appId];
  if (cli) {
    specs.push({ program: cli, args: ['-n', projectPath] });
  }

  if (JETBRAINS_APP_IDS.has(appId)) {
    specs.push({ program: 'open', args: ['-na', appName, '--args', projectPath] });
  }

  specs.push({ program: 'open', args: ['-a', appName, projectPath] });
  return specs;
};

const buildOpenFileSpecs = ({ filePath, appId, appName }) => {
  if (appId === 'finder') {
    return [{ program: 'open', args: ['-R', filePath] }];
  }

  const parentDir = path.dirname(filePath);
  if (appId === 'terminal' || appId === 'iterm2' || appId === 'ghostty') {
    return [{ program: 'open', args: ['-a', appName, parentDir] }];
  }

  const specs = [];

  const cli = CLI_BY_APP_ID[appId];
  if (cli) {
    specs.push({ program: cli, args: [filePath] });
  }

  specs.push({ program: 'open', args: ['-a', appName, filePath] });
  return specs;
};

const runSpecChain = (specs, appName) => {
  const failures = [];
  for (const spec of specs) {
    const result = spawnSync(spec.program, spec.args, { stdio: 'ignore' });
    if (result.error) {
      failures.push(`${spec.program}: ${result.error.message}`);
      continue;
    }
    if (result.status === 0) {
      return;
    }
    failures.push(`${spec.program} exited ${result.status}`);
  }
  throw new Error(`Failed to open in ${appName}: ${failures.join('; ')}`);
};

const handleInvoke = async (browserWindow, command, args = {}) => {
  switch (command) {
    case 'desktop_start_window_drag':
      return null;

    case 'desktop_is_window_fullscreen':
      return Boolean(browserWindow?.isFullScreen());

    case 'desktop_set_window_title':
      if (browserWindow && typeof args.title === 'string') {
        browserWindow.setTitle(args.title);
      }
      return null;

    case 'desktop_get_app_version':
      return APP_VERSION;

    case 'desktop_browser_cdp_status': {
      return getBrowserCdpBridgeStatus();
    }

    case 'desktop_browser_lease_snapshot':
      return createBrowserLeaseSnapshot(browserWindow.id);

    case 'desktop_browser_lease_claim_context':
      return claimDesktopBrowserLeaseContext(browserWindow, args);

    case 'desktop_browser_lease_claim_contexts':
      return claimDesktopBrowserLeaseContexts(browserWindow, args);

    case 'desktop_browser_lease_bind_guest':
      return bindDesktopBrowserLeaseGuest(browserWindow, args);

    case 'desktop_browser_lease_set_observed':
      return setObservedDesktopBrowserLease(browserWindow, args);

    case 'desktop_browser_surface_create':
      return getBrowserSurfaceManager().createManualSurface(browserWindow, args);

    case 'desktop_browser_surface_snapshot':
      return getBrowserSurfaceManager().getSurfaceSnapshot(browserWindow, args);

    case 'desktop_browser_surface_layout':
      return getBrowserSurfaceManager().layout(browserWindow, args);

    case 'desktop_browser_surface_command':
      return getBrowserSurfaceManager().command(browserWindow, args);

    case 'desktop_browser_surface_popout':
      return getBrowserSurfaceManager().popout(browserWindow, args);

    case 'desktop_browser_surface_dock':
      return getBrowserSurfaceManager().dock(browserWindow, args);

    case 'desktop_browser_surface_focus_popout':
      return getBrowserSurfaceManager().focusPopout(browserWindow, args);

    case 'desktop_browser_surface_release':
      return { released: getBrowserSurfaceManager().releaseOwned(browserWindow, args) };

    case 'desktop_browser_surface_inspect':
      return getBrowserSurfaceManager().inspect(browserWindow, args);

    case 'desktop_agent_browser_status':
      return readAgentBrowserRuntimeStatus();

    case 'desktop_agent_browser_install':
      return mutateAgentBrowserInstallation('install');

    case 'desktop_agent_browser_repair':
      return mutateAgentBrowserInstallation('repair');

    case 'desktop_browser_capture_page': {
      return getBrowserSurfaceManager().capture(browserWindow, args);
    }

    case 'desktop_browser_devtools_set_open': {
      return getBrowserSurfaceManager().setDevTools(browserWindow, args);
    }

    case 'desktop_capture_page_rect': {
      if (!browserWindow || browserWindow.isDestroyed()) {
        throw new Error('Window is not available');
      }

      const bounds = browserWindow.getContentBounds();
      const x = Number.isFinite(args.x) ? Math.max(0, Math.floor(args.x)) : 0;
      const y = Number.isFinite(args.y) ? Math.max(0, Math.floor(args.y)) : 0;
      const width = Number.isFinite(args.width) ? Math.max(1, Math.floor(args.width)) : 1;
      const height = Number.isFinite(args.height) ? Math.max(1, Math.floor(args.height)) : 1;
      const clampedX = Math.min(x, Math.max(0, bounds.width - 1));
      const clampedY = Math.min(y, Math.max(0, bounds.height - 1));
      const rect = {
        x: clampedX,
        y: clampedY,
        width: Math.min(width, Math.max(1, bounds.width - clampedX)),
        height: Math.min(height, Math.max(1, bounds.height - clampedY)),
      };
      if (rect.width * rect.height > MAX_CAPTURE_PAGE_RECT_AREA) {
        throw new Error('Capture area is too large');
      }

      const image = await browserWindow.webContents.capturePage(rect);
      const buffer = image.toJPEG(82);
      return {
        mime: 'image/jpeg',
        base64: buffer.toString('base64'),
        width: image.getSize().width,
        height: image.getSize().height,
      };
    }

    case 'desktop_save_markdown_file': {
      const defaultPath = typeof args.defaultFileName === 'string' ? args.defaultFileName.trim() : '';
      if (!defaultPath) {
        throw new Error('Default file name is required');
      }

      const content = typeof args.content === 'string' ? args.content : '';
      const result = await dialog.showSaveDialog(browserWindow || undefined, {
        defaultPath,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (result.canceled || !result.filePath) {
        return null;
      }

      await fsp.writeFile(result.filePath, content, 'utf8');
      return result.filePath;
    }

    case 'desktop_export_diagnostics': {
      const requestedScope = args?.scope && typeof args.scope === 'object'
        ? args.scope
        : { scope: 'runtime' };
      const scope = requestedScope.scope === 'task'
        ? {
            scope: 'task',
            sessionID: String(requestedScope.sessionID || '').trim(),
            directory: String(requestedScope.directory || '').trim() || undefined,
          }
        : { scope: 'runtime' };
      if (scope.scope === 'task' && !scope.sessionID) {
        throw new Error('Session ID is required for a task diagnostics export');
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const defaultFileName = `DevRyan-diagnostics-${scope.scope}-${stamp}.zip`;
      const result = await dialog.showSaveDialog(browserWindow || undefined, {
        defaultPath: defaultFileName,
        filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
        title: scope.scope === 'task' ? 'Export Task Diagnostics' : 'Export Runtime Diagnostics',
      });
      if (result.canceled || !result.filePath) {
        return { cancelled: true, fileName: defaultFileName };
      }
      const localOrigin = state.localOrigin || state.sidecarUrl;
      if (!localOrigin) {
        throw new Error('Local diagnostics server is unavailable');
      }
      const response = await fetch(`${localOrigin.replace(/\/+$/, '')}/api/diagnostics/export`, {
        method: 'POST',
        headers: {
          Accept: 'application/zip',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(scope),
      });
      if (!response.ok || !response.body) {
        const message = await response.text().catch(() => '');
        throw new Error(message || `Diagnostics export failed (${response.status})`);
      }

      await cleanupExpiredDiagnosticsTemps(result.filePath);
      const temporaryPath = path.join(
        path.dirname(result.filePath),
        `.${path.basename(result.filePath)}.diagnostics-${crypto.randomUUID()}.tmp`,
      );
      try {
        await pipeline(
          Readable.fromWeb(response.body),
          fs.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }),
        );
        const temporaryHandle = await fsp.open(temporaryPath, 'r+');
        try {
          await temporaryHandle.chmod(0o600);
          await temporaryHandle.sync();
        } finally {
          await temporaryHandle.close();
        }
        await fsp.rename(temporaryPath, result.filePath);
        const parentHandle = await fsp.open(path.dirname(result.filePath), 'r').catch(() => null);
        if (parentHandle) {
          try {
            await parentHandle.sync().catch(() => undefined);
          } finally {
            await parentHandle.close();
          }
        }
      } catch (error) {
        await fsp.unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
      return {
        cancelled: false,
        fileName: path.basename(result.filePath),
      };
    }

    case 'desktop_read_file': {
      const rawPath = typeof args.path === 'string' ? args.path : '';
      if (!rawPath) throw new Error('Path is required');
      // Defense in depth behind the IPC origin gate: even our own UI (or a
      // prompt-injected agent) can't read credential stores. Resolve the
      // path, require it under $HOME or tmpdir, and refuse known secret dirs
      // / dotfiles commonly holding keys.
      const filePath = path.resolve(rawPath);
      const home = os.homedir() || '';
      const tmp = os.tmpdir() || '';
      const underHome = home && (filePath === home || filePath.startsWith(home + path.sep));
      const underTmp = tmp && (filePath === tmp || filePath.startsWith(tmp + path.sep));
      if (!underHome && !underTmp) {
        throw new Error('File is outside the allowed workspace');
      }
      const DENIED_SEGMENTS = ['.ssh', '.aws', '.gnupg', '.gpg', '.config/gh', '.config/openchamber/credentials'];
      const relFromHome = underHome ? filePath.slice(home.length + 1) : '';
      const relNormalized = relFromHome.split(path.sep).join('/');
      if (DENIED_SEGMENTS.some((segment) => relNormalized === segment || relNormalized.startsWith(`${segment}/`))) {
        throw new Error('Access to this path is not allowed');
      }
      const basename = path.basename(filePath).toLowerCase();
      if (basename === '.env' || basename.startsWith('.env.') || basename.endsWith('.pem') || basename.endsWith('.key')) {
        throw new Error('Access to this path is not allowed');
      }
      const stats = await fsp.stat(filePath);
      if (stats.size > 50 * 1024 * 1024) {
        throw new Error('File is too large. Maximum size is 50MB.');
      }
      const bytes = await fsp.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime = ({
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.bmp': 'image/bmp',
        '.ico': 'image/x-icon',
        '.pdf': 'application/pdf',
        '.txt': 'text/plain',
        '.md': 'text/markdown',
        '.json': 'application/json',
        '.js': 'text/javascript',
        '.ts': 'text/typescript',
        '.tsx': 'text/typescript-jsx',
        '.jsx': 'text/javascript-jsx',
        '.html': 'text/html',
        '.css': 'text/css',
        '.py': 'text/x-python',
      })[ext] || 'application/octet-stream';
      return { mime, base64: bytes.toString('base64'), size: bytes.length };
    }

    case 'desktop_notify':
      maybeShowNativeNotification(args);
      return null;

    case 'desktop_macos_speech_capability':
      return speechManager.getCapability({ language: args.language });

    case 'desktop_macos_speech_authorize':
      return speechManager.requestAuthorization({ language: args.language });

    case 'desktop_macos_speech_devices':
      return speechManager.getInputDevices();

    case 'desktop_macos_microphone_status': {
      if (process.platform !== 'darwin') return { status: 'unsupported', granted: false, canPrompt: false };
      const status = systemPreferences.getMediaAccessStatus('microphone');
      return {
        status,
        granted: status === 'granted',
        canPrompt: status === 'not-determined',
      };
    }

    case 'desktop_macos_microphone_authorize': {
      if (process.platform !== 'darwin') return { status: 'unsupported', granted: false, canPrompt: false };
      const beforeStatus = systemPreferences.getMediaAccessStatus('microphone');
      if (beforeStatus === 'not-determined') {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        const afterStatus = systemPreferences.getMediaAccessStatus('microphone');
        return {
          status: afterStatus,
          granted: granted && afterStatus === 'granted',
          canPrompt: false,
        };
      }
      return {
        status: beforeStatus,
        granted: beforeStatus === 'granted',
        canPrompt: false,
      };
    }

    case 'desktop_macos_speech_start':
      return speechManager.start({
        language: args.language,
        inputDeviceId: args.inputDeviceId,
        silenceThresholdDb: args.silenceThresholdDb,
        silenceHoldMs: args.silenceHoldMs,
      });

    case 'desktop_macos_speech_stop':
      return speechManager.stop();

    case 'desktop_macos_speech_cancel':
      return speechManager.cancel();

    case 'desktop_get_cache_info':
      return getElectronRuntimeCacheInfo(cacheMaintenanceSessions());

    case 'desktop_clear_cache': {
      const result = await clearElectronRuntimeCaches({
        ...cacheMaintenanceSessions(),
        log,
      });
      if (!result.ok) {
        throw new Error('Failed to clear application cache');
      }
      return getElectronRuntimeCacheInfo(cacheMaintenanceSessions());
    }

    case 'desktop_open_path': {
      const targetPath = typeof args.path === 'string' ? args.path.trim() : '';
      const appName = typeof args.app === 'string' ? args.app.trim() : '';
      if (!targetPath) throw new Error('Path is required');
      if (process.platform === 'darwin') {
        const openArgs = appName ? ['-a', appName, targetPath] : [targetPath];
        spawn('open', openArgs, { detached: true, stdio: 'ignore' }).unref();
        return null;
      }
      await shell.openPath(targetPath);
      return null;
    }

    case 'desktop_open_external_url': {
      const target = typeof args.url === 'string' ? args.url.trim() : '';
      if (!target) throw new Error('URL is required');

      const parsed = new URL(target);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Only HTTP URLs can be opened externally');
      }

      await shell.openExternal(parsed.toString());
      return null;
    }

    case 'desktop_open_system_privacy_settings': {
      const target = typeof args.target === 'string' ? args.target : 'microphone';
      const anchor = target === 'speech'
        ? 'Privacy_SpeechRecognition'
        : 'Privacy_Microphone';
      await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`);
      return null;
    }

    case 'desktop_reveal_path': {
      const targetPath = typeof args.path === 'string' ? args.path.trim() : '';
      if (!targetPath) {
        throw new Error('Path is required');
      }

      const stats = await fsp.stat(targetPath).catch(() => null);
      if (stats?.isDirectory()) {
        await shell.openPath(targetPath);
        return null;
      }

      shell.showItemInFolder(targetPath);
      return null;
    }

    case 'desktop_open_in_app': {
      if (process.platform !== 'darwin') {
        throw new Error('desktop_open_in_app is only supported on macOS');
      }
      const projectPath = typeof args.projectPath === 'string' ? args.projectPath.trim() : '';
      const appId = typeof args.appId === 'string' ? args.appId.trim().toLowerCase() : '';
      const appName = typeof args.appName === 'string' ? args.appName.trim() : '';
      if (!projectPath || !appId || !appName) {
        throw new Error('Project path, app id, and app name are required');
      }
      runSpecChain(buildOpenProjectSpecs({ projectPath, appId, appName }), appName);
      return null;
    }

    case 'desktop_open_file_in_app': {
      if (process.platform !== 'darwin') {
        throw new Error('desktop_open_file_in_app is only supported on macOS');
      }
      const filePath = typeof args.filePath === 'string' ? args.filePath.trim() : '';
      const appId = typeof args.appId === 'string' ? args.appId.trim().toLowerCase() : '';
      const appName = typeof args.appName === 'string' ? args.appName.trim() : '';
      if (!filePath || !appId || !appName) {
        throw new Error('File path, app id, and app name are required');
      }
      runSpecChain(buildOpenFileSpecs({ filePath, appId, appName }), appName);
      return null;
    }

    case 'desktop_filter_installed_apps': {
      if (process.platform !== 'darwin') {
        throw new Error('desktop_filter_installed_apps is only supported on macOS');
      }
      if (!Array.isArray(args.apps)) return [];
      const results = await Promise.all(
        args.apps.map(async (appName) => (await isAppBundleInstalled(String(appName))) ? String(appName) : null)
      );
      return results.filter(Boolean);
    }

    case 'desktop_fetch_app_icons': {
      if (process.platform !== 'darwin') {
        throw new Error('desktop_fetch_app_icons is only supported on macOS');
      }
      const names = Array.isArray(args.apps) ? args.apps : [];
      const results = [];
      for (const name of names) {
        const appPath = await resolveAppBundlePath(String(name));
        if (!appPath) continue;
        const dataUrl = await iconToDataUrl(await resolveAppIconPath(appPath), String(name));
        if (dataUrl) results.push({ app: String(name), dataUrl });
      }
      return results;
    }

    case 'desktop_get_installed_apps': {
      if (process.platform !== 'darwin') {
        throw new Error('desktop_get_installed_apps is only supported on macOS');
      }
      const cachePath = buildInstalledAppsCachePath();
      const now = Math.floor(Date.now() / 1000);
      let cache = null;
      try {
        cache = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
      } catch {
      }
      const cachedApps = Array.isArray(cache?.apps) ? cache.apps : [];
      const hasCache = Boolean(cache);
      const isCacheStale = !cache || (now - Number(cache.updatedAt || 0)) > INSTALLED_APPS_CACHE_TTL_SECS;
      const refresh = async () => {
        const apps = await buildInstalledApps(Array.isArray(args.apps) ? args.apps : []);
        await fsp.mkdir(path.dirname(cachePath), { recursive: true });
        await fsp.writeFile(cachePath, JSON.stringify({ updatedAt: now, apps }, null, 2));
        emitToAllWindows('openchamber:installed-apps-updated', apps);
      };
      if (!hasCache || isCacheStale || args.force === true) {
        void refresh();
      }
      return { apps: cachedApps, hasCache, isCacheStale };
    }

    case 'desktop_hosts_get':
      return readDesktopHostsConfig();

    case 'desktop_hosts_set': {
      await writeDesktopHostsConfig(args.input || args.config || {});
      const updatedConfig = readDesktopHostsConfig();
      const envTarget = normalizeHostUrl(process.env.OPENCHAMBER_SERVER_URL || '');
      state.bootOutcome = computeBootOutcome({
        envTargetUrl: envTarget || null,
        probe: null,
        config: updatedConfig,
        localAvailable: Boolean(state.sidecarUrl || state.localOrigin),
      });
      state.initScript = buildInitScript(state.localOrigin, state.bootOutcome, state.sidecarUrl || state.localOrigin);
      log.info('[electron] hosts config updated, recomputed bootOutcome', state.bootOutcome);
      return null;
    }

    case 'desktop_host_probe':
      return probeHostWithTimeout(String(args.url || ''), 2_000);

    case 'desktop_set_window_theme': {
      const mode = typeof args.themeMode === 'string' ? args.themeMode : '';
      const variant = typeof args.themeVariant === 'string' ? args.themeVariant : '';
      // Priority order: themeMode expresses the user's intent (including
      // "follow OS"). Variant is just the resolved variant at send time;
      // when mode === 'system' with variant === 'dark' (because OS is
      // currently dark), we must still pin themeSource to 'system' so
      // Chromium keeps reacting to OS theme changes.
      if (mode === 'system') {
        nativeTheme.themeSource = 'system';
      } else if (mode === 'light') {
        nativeTheme.themeSource = 'light';
      } else if (mode === 'dark') {
        nativeTheme.themeSource = 'dark';
      } else if (variant === 'light') {
        nativeTheme.themeSource = 'light';
      } else if (variant === 'dark') {
        nativeTheme.themeSource = 'dark';
      } else {
        nativeTheme.themeSource = 'system';
      }
      return null;
    }

    case 'desktop_set_vibrancy': {
      // Vibrancy (macOS blur) is not supported in the Electron shell — the
      // Tauri build used NSVisualEffectView via Tauri plugin, Electron has
      // no equivalent for our titleBarStyle:'hidden' setup. Persist the
      // disabled state so settings UI reflects it; args.enabled is ignored.
      await mutateSettingsRoot((root) => {
        root.desktopVibrancy = false;
      });
      return { enabled: false, requiresRestart: false };
    }

    case 'desktop_set_keep_awake':
      return applyDesktopKeepAwake(args.enabled === true);

    case 'desktop_set_agent_browser_control': {
      const enabled = args.enabled === true;
      await mutateSettingsRoot((root) => {
        root.agentBrowserControlEnabled = enabled;
      });
      // Enforced in main: turning this off drops any live bridge session now.
      enforceAgentBrowserControlSetting();
      return { enabled };
    }

    case 'desktop_check_for_updates': {
      const currentVersion = APP_VERSION;
      let payload = null;
      try {
        const response = await fetch(UPDATE_METADATA_URL, {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': `DevRyan/${currentVersion}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: AbortSignal.timeout(10_000),
        });
        payload = await response.json();
      } catch {
      }

      let updateResult = null;
      try {
        updateResult = await autoUpdater.checkForUpdates();
      } catch {
      }

      const updateInfo = updateResult?.updateInfo;
      const nextVersion = String(
        (typeof updateInfo?.version === 'string' && updateInfo.version) ||
        (typeof payload?.version === 'string' && payload.version) ||
        (typeof payload?.tag_name === 'string' && payload.tag_name) ||
        currentVersion
      ).replace(/^v/, '');
      const available = compareSemver(nextVersion, currentVersion) > 0;
      const body =
        (typeof payload?.notes === 'string' && payload.notes.trim() ? payload.notes : null) ||
        (typeof payload?.body === 'string' && payload.body.trim() ? payload.body : null) ||
        (typeof updateInfo?.releaseNotes === 'string' && updateInfo.releaseNotes.trim() ? updateInfo.releaseNotes : null);
      state.pendingUpdate = available ? { version: nextVersion, metadata: payload, electronUpdate: updateResult } : null;
      return {
        available,
        currentVersion,
        version: available ? nextVersion : null,
        body: body || null,
        date:
          (typeof updateInfo?.releaseDate === 'string' && updateInfo.releaseDate) ||
          (typeof payload?.pub_date === 'string' && payload.pub_date) ||
          (typeof payload?.published_at === 'string' ? payload.published_at : null),
      };
    }

    case 'desktop_download_and_install_update':
      if (!state.pendingUpdate) {
        throw new Error('No pending update');
      }
      emitToAllWindows('openchamber:update-progress', mapUpdaterProgressEvent({
        event: 'Started',
        data: {
          contentLength: null,
        },
      }));
      if (!state.pendingUpdate.electronUpdate) {
        throw new Error('Electron updater metadata is not available for this build');
      }
      if (!state.pendingUpdate.downloaded) {
        await new Promise((resolve, reject) => {
          let settled = false;
          const cleanup = () => {
            autoUpdater.off('update-downloaded', onDownloaded);
            autoUpdater.off('error', onError);
          };
          const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback(value);
          };
          const onDownloaded = () => finish(resolve, null);
          const onError = (error) => finish(reject, error);
          autoUpdater.on('update-downloaded', onDownloaded);
          autoUpdater.on('error', onError);
          Promise.resolve(autoUpdater.downloadUpdate()).catch((error) => finish(reject, error));
        });
      }
      emitToAllWindows('openchamber:update-progress', mapUpdaterProgressEvent({
        event: 'Finished',
        data: {},
      }));
      return null;

    case 'desktop_restart': {
      const applyUpdate = Boolean(state.pendingUpdate?.downloaded && app.isPackaged);
      log.info(`[electron] desktop_restart applyUpdate=${applyUpdate} packaged=${app.isPackaged}`);
      if (applyUpdate && process.platform === 'darwin' && typeof app.isInApplicationsFolder === 'function') {
        try {
          if (!app.isInApplicationsFolder()) {
            throw new Error('Desktop update requires DevRyan.app to be installed in /Applications');
          }
        } catch (error) {
          log.warn('[electron] desktop_restart blocked', error);
          throw error;
        }
      }
      if (applyUpdate) {
        // Match the working updater pattern closely: only bypass the macOS
        // hide-on-close / quit-confirmation guards, leave the rest of the
        // updater-driven quit/install sequence alone.
        state.quitRequested = true;
        state.installingUpdate = true;
        state.quitConfirmationPending = false;
        if (state.mainWindow && !state.mainWindow.isDestroyed()) {
          try {
            debounceWindowStatePersist(state.mainWindow, true);
          } catch {
          }
        }
      }
      browserCdpBridge?.closeAll('app_restart');
      // Defer so the IPC reply flushes before the app starts shutting down.
      // Without this, quitAndInstall() can race with the renderer's pending
      // invoke and the restart appears to do nothing from the UI side.
      setImmediate(() => {
        try {
          if (applyUpdate) {
            autoUpdater.quitAndInstall();
          } else {
            app.relaunch();
            app.exit(0);
          }
        } catch (err) {
          log.error('[electron] desktop_restart failed', err);
        }
      });
      return null;
    }

    case 'desktop_get_lan_address':
      return await detectLanIPv4Address();

    case 'desktop_new_window': {
      const config = readDesktopHostsConfig();
      const localUiUrl = state.sidecarUrl || state.localOrigin;
      let targetUrl = localUiUrl;
      if (config.defaultHostId && config.defaultHostId !== LOCAL_HOST_ID) {
        const host = config.hosts.find((entry) => entry.id === config.defaultHostId);
        if (host?.url && !state.unreachableHosts.has(host.url)) {
          targetUrl = host.url;
        }
      }
      await createAdditionalWindow(targetUrl);
      return null;
    }

    case 'desktop_new_window_at_url': {
      const targetUrl = normalizeHostUrl(String(args.url || ''));
      if (!targetUrl) {
        throw new Error('Invalid URL');
      }
      if (!isAllowedElectronContentUrl(targetUrl, buildContentOriginPolicy())) {
        throw new Error('URL not allowed for Electron content');
      }
      await createAdditionalWindow(targetUrl);
      return null;
    }

    case 'desktop_open_session_mini_chat_window': {
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
      if (!sessionId) throw new Error('Session id is required');
      const directory = typeof args.directory === 'string' ? args.directory.trim() : '';
      await createMiniChatWindow({ mode: 'session', sessionId, directory });
      return null;
    }

    case 'desktop_open_draft_mini_chat_window': {
      const directory = typeof args.directory === 'string' ? args.directory.trim() : '';
      const projectId = typeof args.projectId === 'string' ? args.projectId.trim() : '';
      await createMiniChatWindow({ mode: 'draft', directory, projectId });
      return null;
    }

    case 'desktop_set_window_pinned':
      return setMiniChatPinned(browserWindow, args.pinned === true);

    case 'desktop_get_window_pinned':
      return { pinned: Boolean(browserWindow?.__ocPinned) };

    case 'desktop_focus_main_window':
      if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        if (state.mainWindow.isMinimized()) state.mainWindow.restore();
        state.mainWindow.show();
        state.mainWindow.focus();
        const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
        const directory = typeof args.directory === 'string' ? args.directory.trim() : '';
        const mode = typeof args.mode === 'string' ? args.mode.trim() : '';
        if (sessionId) {
          emitToWindow(state.mainWindow, 'openchamber:open-session', { sessionId, directory });
        } else if (mode === 'draft') {
          const projectId = typeof args.projectId === 'string' ? args.projectId.trim() : '';
          emitToWindow(state.mainWindow, 'openchamber:open-draft-session', { directory, projectId });
        }
        return { focused: true };
      }
      return { focused: false };

    case 'desktop_close_current_window':
      if (browserWindow && !browserWindow.isDestroyed()) {
        browserWindow.close();
      }
      return null;

    case 'desktop_ssh_instances_get':
      return sshManager.readInstances();

    case 'desktop_ssh_instances_set':
      await sshManager.setInstances(args.config || {});
      return null;

    case 'desktop_ssh_import_hosts':
      return await sshManager.importHosts();

    case 'desktop_ssh_connect': {
      const id = String(args.id || '').trim();
      await sshManager.connect(id);
      return null;
    }

    case 'desktop_ssh_disconnect': {
      const id = String(args.id || '').trim();
      await sshManager.disconnect(id);
      return null;
    }

    case 'desktop_ssh_status': {
      const id = String(args.id || '').trim();
      return await sshManager.statusesWithDefaults(id || undefined);
    }

    case 'desktop_ssh_logs':
      return sshManager.logsForInstance(String(args.id || '').trim(), Number(args.limit) || 200);

    case 'desktop_ssh_logs_clear':
      sshManager.clearLogsForInstance(String(args.id || '').trim());
      return null;

    default:
      throw new Error(`Unknown desktop command: ${command}`);
  }
};

const buildMacMenu = () => {
  const dispatchAction = (action) => dispatchMenuAction(action);
  const handleCopyAction = () => {
    BrowserWindow.getFocusedWindow()?.webContents.copy();
    dispatchAction('copy');
  };

  return Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        {
          label: 'Check for Updates',
          click: () => dispatchCheckForUpdates(),
        },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'Cmd+,', click: () => dispatchAction('settings') },
        { label: 'Command Palette', accelerator: 'Cmd+P', click: () => dispatchAction('command-palette') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'Cmd+Shift+Alt+N', click: () => void handleInvoke(null, 'desktop_new_window') },
        { type: 'separator' },
        { label: 'New Session', accelerator: 'Cmd+N', click: () => dispatchAction('new-session') },
        { label: 'New Worktree', accelerator: 'Cmd+Shift+N', click: () => dispatchAction('new-worktree-session') },
        { type: 'separator' },
        { label: 'Add Workspace', click: () => dispatchAction('change-workspace') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { label: 'Copy', accelerator: 'Cmd+C', click: () => handleCopyAction() },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Git', accelerator: 'Cmd+G', click: () => dispatchAction('open-git-tab') },
        { label: 'Diff', accelerator: 'Cmd+E', click: () => dispatchAction('open-diff-tab') },
        { label: 'Terminal', accelerator: 'Cmd+T', click: () => dispatchAction('open-terminal-tab') },
        { type: 'separator' },
        { label: 'Light Theme', click: () => dispatchAction('theme-light') },
        { label: 'Dark Theme', click: () => dispatchAction('theme-dark') },
        { label: 'System Theme', click: () => dispatchAction('theme-system') },
        { type: 'separator' },
        { label: 'Toggle Session Sidebar', accelerator: 'Cmd+L', click: () => dispatchAction('toggle-sidebar') },
        { label: 'Toggle Memory Debug', accelerator: 'Cmd+Shift+D', click: () => dispatchAction('toggle-memory-debug') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'Cmd+.', click: () => dispatchAction('help-dialog') },
        { label: 'Show Diagnostics', accelerator: 'Cmd+Shift+L', click: () => dispatchAction('download-logs') },
        { type: 'separator' },
        {
          label: 'Clear Cache',
          click: () => {
            void handleInvoke(null, 'desktop_clear_cache').catch((error) => {
              log.warn('[electron] failed to clear cache from menu:', error);
            });
          },
        },
        { type: 'separator' },
        { label: 'Report a Bug', click: () => shell.openExternal(GITHUB_BUG_REPORT_URL) },
        { label: 'Request a Feature', click: () => shell.openExternal(GITHUB_FEATURE_REQUEST_URL) },
        { type: 'separator' },
        { label: 'Join Discord', click: () => shell.openExternal(DISCORD_INVITE_URL) },
      ],
    },
  ]);
};

contextMenu({
  showInspectElement: isDev,
  showSaveImageAs: true,
  showCopyImage: true,
  showCopyLink: true,
});

// All desktop_* IPC and dialog:open run with full Electron main privileges
// (fs access, shell.openPath, spawn, app.relaunch, …). The preload shim is
// injected into every webContents in the window, including remote hosts the
// user switches to via DesktopHostSwitcher. Without a gate, a malicious
// remote page could read arbitrary local files, open arbitrary apps, etc.
//
// Strategy: commands fall into two buckets by capability, not by origin.
// Window/host-switcher operations (probe a URL, open a new window, set
// title, read the hosts list) are safe for any renderer. Filesystem,
// shell.openPath, installed-app scans, app relaunch, and file dialogs
// are gated to local senders — even the user's own remote UI shouldn't
// need them, and a compromised remote can't use them either.
const isLocalSender = (webContents) => {
  try {
    const raw = typeof webContents?.getURL === 'function' ? webContents.getURL() : '';
    return isPrivilegedRendererUrl(raw, state.localOrigin);
  } catch {
    return false;
  }
};

const COMMANDS_SAFE_FOR_REMOTE = new Set([
  'desktop_hosts_get',
  'desktop_host_probe',
  'desktop_new_window',
  'desktop_new_window_at_url',
  'desktop_set_window_title',
  'desktop_set_window_theme',
  'desktop_is_window_fullscreen',
  'desktop_start_window_drag',
  'desktop_get_app_version',
  'desktop_get_lan_address',
  // desktop_capture_page_rect is deliberately NOT in this set: it reads app
  // window pixels, and a remote host's UI must not be able to capture them.
  // Remote-origin UIs fall back to browser-side DOM capture for annotation
  // screenshots (lib/preview/screenshot-capture.ts).
]);

ipcMain.handle('openchamber:invoke', async (event, command, args) => {
  if (!isLocalSender(event.sender) && !COMMANDS_SAFE_FOR_REMOTE.has(command)) {
    log.warn(`[ipc] rejected ${command} from non-local origin: ${event.sender?.getURL?.() || '(unknown)'}`);
    throw new Error('IPC not available for this origin');
  }
  const browserWindow = BrowserWindow.fromWebContents(event.sender);
  return handleInvoke(browserWindow, command, args);
});

ipcMain.handle('openchamber:dialog:open', async (event, options) => {
  // Native file dialogs expose absolute local paths; never grant to remote.
  if (!isLocalSender(event.sender)) {
    log.warn(`[ipc] rejected dialog:open from non-local origin: ${event.sender?.getURL?.() || '(unknown)'}`);
    throw new Error('IPC not available for this origin');
  }
  const browserWindow = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(browserWindow || undefined, {
    title: typeof options?.title === 'string' ? options.title : undefined,
    filters: Array.isArray(options?.filters)
      ? options.filters
          .filter((filter) => filter && typeof filter === 'object')
          .map((filter) => ({
            name: typeof filter.name === 'string' && filter.name.trim().length > 0 ? filter.name : 'Files',
            extensions: Array.isArray(filter.extensions)
              ? filter.extensions.filter((extension) => typeof extension === 'string' && extension.trim().length > 0)
              : [],
          }))
      : undefined,
    properties: [
      options?.directory ? 'openDirectory' : 'openFile',
      options?.multiple ? 'multiSelections' : null,
      'createDirectory',
    ].filter(Boolean),
  });
  if (result.canceled) return null;
  if (options?.multiple) return result.filePaths;
  return result.filePaths[0] || null;
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin' && !state.quitRequested) {
    return;
  }

  if (!state.installingUpdate) {
    killSidecar();
    void sshManager.shutdownAll();
    speechManager.shutdown();
    releaseDesktopKeepAwake();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  if (state.quitCleanupPromise) {
    event.preventDefault();
    return;
  }
  if (state.quitConfirmed || state.installingUpdate || process.platform !== 'darwin') {
    state.quitRequested = true;
    releaseDesktopKeepAwake();
    return;
  }
  event.preventDefault();
  void requestQuitWithConfirmation();
});

app.on('will-quit', () => {
  browserCdpBridge?.closeAll('app_quit');
  browserSurfaceManager?.closeAll('app_quit');
  releaseDesktopKeepAwake();
});

app.on('second-instance', (_event, argv) => {
  const urls = Array.isArray(argv)
    ? argv.filter((arg) => typeof arg === 'string' && arg.startsWith(`${DEEP_LINK_PROTOCOL}://`))
    : [];
  if (urls.length > 0) handleDeepLinks(urls);
  focusForegroundWindow();
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLinks([url]);
});

app.on('activate', async () => {
  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
  if (windows.length > 0) {
    const visibleWindow = windows.find((window) => window.isVisible());
    const targetWindow = visibleWindow || state.mainWindow || windows[0];
    if (targetWindow.isMinimized()) targetWindow.restore();
    targetWindow.show();
    targetWindow.focus();
    return;
  }

  if (state.localOrigin) {
    const config = readDesktopHostsConfig();
    const localUiUrl = state.sidecarUrl || state.localOrigin;
    const host = config.defaultHostId && config.defaultHostId !== LOCAL_HOST_ID
      ? config.hosts.find((entry) => entry.id === config.defaultHostId)
      : null;
    const targetUrl = host?.url && !state.unreachableHosts.has(host.url) ? host.url : localUiUrl;
    await createAdditionalWindow(targetUrl);
  }
});

app.whenReady().then(async () => {
  log.info('[electron] app starting', {
    version: APP_VERSION,
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
  });
  nativeTheme.themeSource = readThemeSource();
  try {
    configureBrowserWebviewSession();
  } catch (error) {
    log.warn('[electron] failed to configure browser webview session:', error);
  }
  try {
    applyDesktopKeepAwake(readDesktopKeepAwakeEnabled());
  } catch (error) {
    log.warn('[electron] failed to apply persisted desktop keep awake setting:', error);
  }
  setupAutoUpdater();

  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(buildMacMenu());
  }

  state.mainWindow = createBrowserWindow({
    label: 'main',
    restoreGeometry: true,
    url: null,
  });

  if (app.isPackaged) {
    await clearElectronRuntimeCaches({
      ...cacheMaintenanceSessions(),
      log,
    });
  }

  const initial = extractInitialDeepLinks();
  if (initial.length > 0) handleDeepLinks(initial);

  const { initialUrl, localOrigin, bootOutcome } = await resolveInitialUrl();
  await activateMainWindow(initialUrl, localOrigin, bootOutcome);

  // Notify renderer on OS wake-from-sleep so the SSE event pipeline can
  // reconnect immediately instead of waiting for the heartbeat watchdog.
  powerMonitor.on('resume', () => {
    emitToAllWindows('openchamber:system-resume', { timestamp: Date.now() });
  });
}).catch((error) => {
  log.error('[electron] startup failed:', error);
  releaseDesktopKeepAwake();
  app.exit(1);
});
