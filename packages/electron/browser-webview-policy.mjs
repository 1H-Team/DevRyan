// Policy for <webview> guests hosted by the in-app browser pane.
//
// The preload shim (with its __TAURI__ IPC surface) is injected per-window,
// and Electron copies the embedder's preferences onto guests unless
// will-attach-webview intervenes. These helpers are pure so the hardening
// rules are unit-testable without an Electron runtime:
//   - hardenWebviewAttachParams mutates the attach-time webPreferences/params
//     in place (strip preload, force isolation/sandbox, pin the partition)
//   - isAllowedWebviewSourceUrl / isAllowedWebviewNavigationUrl restrict the
//     guest's URL space to http(s) + about:blank, including later navigations
//     (which also constrains CDP-initiated navigation).

export const BROWSER_WEBVIEW_PARTITION = 'persist:openchamber-browser';

const parseUrl = (rawUrl) => {
  try {
    return new URL(String(rawUrl || ''));
  } catch {
    return null;
  }
};

export const isAllowedWebviewSourceUrl = (rawUrl) => {
  const value = String(rawUrl || '');
  if (!value || value === 'about:blank') return true;
  const url = parseUrl(value);
  if (!url) return false;
  return url.protocol === 'http:' || url.protocol === 'https:';
};

export const isAllowedWebviewNavigationUrl = (rawUrl) => isAllowedWebviewSourceUrl(rawUrl);

// Mutates `webPreferences` and `params` (the will-attach-webview payload) in
// place and returns them for convenience. Everything here is deny-by-default:
// no preload, no node, isolated + sandboxed guest, pinned partition.
export const hardenWebviewAttachParams = (webPreferences, params) => {
  const prefs = webPreferences && typeof webPreferences === 'object' ? webPreferences : {};
  const attachParams = params && typeof params === 'object' ? params : {};

  delete prefs.preload;
  delete prefs.preloadURL;
  prefs.nodeIntegration = false;
  prefs.nodeIntegrationInSubFrames = false;
  prefs.nodeIntegrationInWorker = false;
  prefs.contextIsolation = true;
  prefs.sandbox = true;
  prefs.webSecurity = true;
  prefs.allowRunningInsecureContent = false;
  prefs.experimentalFeatures = false;
  prefs.enableBlinkFeatures = '';
  prefs.webviewTag = false;
  // Guests inherit the embedder's backgroundThrottling:false (needed there for
  // streaming). Browser guests are not streaming surfaces — let Chromium
  // throttle them whenever they are hidden or occluded.
  prefs.backgroundThrottling = true;

  delete attachParams.preload;
  attachParams.partition = BROWSER_WEBVIEW_PARTITION;
  if (!isAllowedWebviewSourceUrl(attachParams.src)) {
    attachParams.src = 'about:blank';
  }

  return { webPreferences: prefs, params: attachParams };
};
