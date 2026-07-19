import * as vscode from 'vscode';
import * as os from 'os';
import { getThemeKindName } from './theme';
import type { ConnectionStatus } from './opencode';
import type { WorkspaceFolderCandidate } from './workspaceResolver';

export type PanelType = 'chat' | 'agentManager';

export interface WebviewHtmlOptions {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  workspaceFolder: string;
  workspaceFolders?: WorkspaceFolderCandidate[];
  initialStatus: ConnectionStatus;
  cliAvailable: boolean;
  panelType?: PanelType;
  initialSessionId?: string;
  viewMode?: 'sidebar' | 'editor';
  devServerUrl?: string | null;
  extensionVersion?: string;
}

const asCspToken = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const toOrigin = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

const uniqueTokens = (values: Array<string | null | undefined>): string => {
  return Array.from(new Set(values.map(asCspToken).filter((value): value is string => Boolean(value)))).join(' ');
};

export function getWebviewHtml(options: WebviewHtmlOptions): string {
  const {
    webview,
    extensionUri,
    workspaceFolder,
    workspaceFolders = [],
    initialStatus,
    cliAvailable,
    panelType = 'chat',
    initialSessionId,
    viewMode = 'sidebar',
    devServerUrl,
    extensionVersion = '',
  } = options;
  const workspaceFoldersJson = JSON.stringify(workspaceFolders).replace(/</g, '\\u003c');

  const scriptPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'assets', 'index.js');
  const scriptUri = webview.asWebviewUri(scriptPath);
  const normalizedDevServerUrl = asCspToken(devServerUrl)?.replace(/\/$/, '') ?? null;
  const devServerOrigin = toOrigin(normalizedDevServerUrl);
  const styleSrc = uniqueTokens([webview.cspSource, "'unsafe-inline'", devServerOrigin]);
  const scriptSrc = uniqueTokens([webview.cspSource, "'unsafe-inline'", "'unsafe-eval'", devServerOrigin]);
  const connectSrc = uniqueTokens(['*', 'ws:', 'wss:', 'http:', 'https:', devServerOrigin]);
  const imgSrc = uniqueTokens([webview.cspSource, 'data:', 'https:', devServerOrigin]);
  const fontSrc = uniqueTokens([webview.cspSource, 'data:', devServerOrigin]);
  const workerSrc = uniqueTokens([webview.cspSource, devServerOrigin]);

  const themeKind = getThemeKindName(vscode.window.activeColorTheme.kind);

  // Use VS Code CSS variables for proper theme integration
  // These variables are automatically provided by VS Code to webviews
  // 
  // Splash logo geometry:
  // edge=48, cos30=0.866, sin30=0.5, centerY=50
  // top=(50, 2), left=(8.432, 26), right=(91.568, 26), center=(50, 50)
  // bottomLeft=(8.432, 74), bottomRight=(91.568, 74), bottom=(50, 98)
  // topFaceCenterY = (2 + 26 + 50 + 26) / 4 = 26
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${styleSrc}; script-src ${scriptSrc}; connect-src ${connectSrc}; img-src ${imgSrc}; font-src ${fontSrc}; worker-src ${workerSrc};">
  <style>
    html, body, #root { height: 100%; width: 100%; margin: 0; padding: 0; }
    body { 
      overflow: hidden; 
      background: var(--vscode-editor-background, var(--vscode-sideBar-background)); 
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
      color: var(--vscode-foreground);
    }
    
    /* Initial loading screen styles - uses VS Code theme variables */
    #initial-loading {
      position: fixed;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      z-index: 9999;
      background: var(--vscode-editor-background, var(--vscode-sideBar-background));
      transition: opacity 0.3s ease-out;
    }
    #initial-loading.fade-out {
      opacity: 0;
      pointer-events: none;
    }
    /* Logo colors use VS Code foreground color */
    #initial-loading .logo-stroke {
      stroke: var(--vscode-foreground);
    }
    #initial-loading .logo-fill {
      fill: var(--vscode-foreground);
      opacity: 0.15;
    }
    #initial-loading .logo-fill-solid {
      fill: var(--vscode-foreground);
    }
    #initial-loading .logo-fill-dim {
      fill: var(--vscode-foreground);
      opacity: 0.4;
    }
    #initial-loading .status-text {
      font-size: 13px;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      text-align: center;
    }
    #initial-loading .error-text {
      font-size: 12px;
      color: var(--vscode-errorForeground, #f48771);
      text-align: center;
      max-width: 280px;
    }
  </style>
  <title>DevRyan</title>
</head>
<body>
  <!-- Initial loading screen with simplified DevRyan logo -->
  <div id="initial-loading">
    <svg class="logo" width="70" height="70" viewBox="0 0 593.11 516.12" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <clipPath id="devryan-load-clip">
          <path d="M48.18,50.68v425.54h497.18V50.68H48.18ZM346.33,85.39c-34.03,14.36-61.01,41.46-74.79,55.3-2.21,2.22-4.31,4.34-6.32,6.38-17.58,17.79-25.6,25.91-44.71,34.43-12.61,5.62-18.28,20.4-12.66,33.01,4.15,9.31,13.28,14.83,22.85,14.83,3.4,0,6.86-.7,10.16-2.17,27.72-12.35,41.23-26.03,59.94-44.97,1.96-1.99,4.01-4.06,6.18-6.24,8.23-8.26,22.56-22.65,39.36-33.88v18.52c-12.32,9.47-22.84,20.03-28.73,25.94-1.95,1.96-3.8,3.83-5.59,5.64l-.55.56c-19.11,19.34-34.2,34.62-64.5,48.12-5.17,2.3-10.64,3.47-16.27,3.47-15.78,0-30.13-9.31-36.55-23.73-8.98-20.15.11-43.84,20.26-52.82,16.54-7.37,22.96-13.88,40.14-31.27,2.03-2.05,4.13-4.19,6.36-6.42,15.32-15.39,45.92-46.11,85.42-60.88v16.16Z"/>
        </clipPath>
      </defs>
      <g clip-path="url(#devryan-load-clip)">
        <path d="M295.81,323.54v-113.1s0-26.82,0-26.82c0-16.33-4-30.24-12.69-43.26-4.31-6.45-9.94-12.34-16.48-17.49-17.21-13.54-40.75-21.94-63.27-21.94-55.78,0-100.99,45.21-100.99,100.99,0,93.03,90.44,176.35,188.66,222.77,3.63,1.72,7.83,1.72,11.46,0,98.22-46.42,188.66-129.73,188.66-222.77,0-55.78-45.21-100.99-100.99-100.99-42.15,0-80.16,36.55-100.92,57.39-22.14,22.24-32.59,34.43-58.57,46" stroke="#1e2a38" stroke-linecap="round" stroke-linejoin="round" stroke-width="50"/>
      </g>
    </svg>
    <div class="status-text" id="loading-status">
      ${initialStatus === 'connecting' ? 'Starting OpenCode API…' : initialStatus === 'connected' ? 'Initializing…' : 'Connecting…'}
    </div>
    ${!cliAvailable ? `<div class="error-text">OpenCode CLI not found. Please install it first.</div>` : ''}
  </div>
  
  <div id="root"></div>
  <script>
    // Polyfill process for Node.js modules running in browser
    window.process = window.process || { env: { NODE_ENV: 'production' }, platform: '', version: '', browser: true };

    window.__VSCODE_CONFIG__ = {
      workspaceFolder: "${workspaceFolder.replace(/\\/g, '\\\\')}",
      workspaceFolders: ${workspaceFoldersJson},
      theme: "${themeKind}",
      connectionStatus: "${initialStatus}",
      cliAvailable: ${cliAvailable},
      extensionVersion: "${extensionVersion.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}",
      platform: "${os.platform()}",
      arch: "${os.arch()}",
      panelType: "${panelType}",
      viewMode: "${viewMode}",
      initialSessionId: ${initialSessionId ? `"${initialSessionId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : 'null'},
    };
    window.__OPENCHAMBER_HOME__ = "${workspaceFolder.replace(/\\/g, '\\\\')}";
    
    // Handle connection status updates to update loading screen
    window.addEventListener('message', function(event) {
      var msg = event.data;
      if (msg && msg.type === 'connectionStatus') {
        var statusEl = document.getElementById('loading-status');
        if (statusEl) {
          if (msg.status === 'connecting') {
            statusEl.textContent = 'Starting OpenCode API…';
            statusEl.classList.remove('error-text');
          } else if (msg.status === 'connected') {
            statusEl.textContent = 'Connected!';
            statusEl.classList.remove('error-text');
          } else if (msg.status === 'error') {
            statusEl.textContent = msg.error || 'Connection error';
            statusEl.classList.add('error-text');
          } else {
            statusEl.textContent = 'Reconnecting…';
            statusEl.classList.remove('error-text');
          }
        }
      }
    });
  </script>
  <script type="module">
    const prodEntryUrl = ${JSON.stringify(scriptUri.toString())};
    const devServerUrl = ${normalizedDevServerUrl ? JSON.stringify(normalizedDevServerUrl) : 'null'};

    const loadProductionBundle = () => {
      const script = document.createElement('script');
      script.type = 'module';
      script.src = prodEntryUrl;
      document.body.appendChild(script);
    };

    if (!devServerUrl) {
      loadProductionBundle();
    } else {
      const baseUrl = devServerUrl;

      const statusEl = document.getElementById('loading-status');
      const setStatus = (text) => {
        if (statusEl) {
          statusEl.textContent = text;
        }
      };

      const retryDelayMs = 500;
      let attempt = 0;

      const waitForRootMount = (timeoutMs) => {
        const root = document.getElementById('root');
        if (!root) {
          return Promise.resolve(false);
        }

        if (root.childNodes.length > 0) {
          return Promise.resolve(true);
        }

        return new Promise((resolve) => {
          const observer = new MutationObserver(() => {
            if (root.childNodes.length > 0) {
              observer.disconnect();
              clearTimeout(timer);
              resolve(true);
            }
          });

          observer.observe(root, { childList: true, subtree: true });
          const timer = window.setTimeout(() => {
            observer.disconnect();
            resolve(root.childNodes.length > 0);
          }, timeoutMs);
        });
      };

      const tryLoadDevBundle = () => {
        const viteClientUrl = baseUrl + '/@vite/client';
        const reactRefreshUrl = baseUrl + '/@react-refresh';
        const devEntryUrl = baseUrl + '/main.tsx';
        const hostLabel = (() => {
          try {
            return new URL(baseUrl).host;
          } catch {
            return baseUrl;
          }
        })();

        setStatus('Starting webview dev server (' + hostLabel + ')...');

        Promise.resolve()
          .then(() => import(viteClientUrl))
          .then(() => import(reactRefreshUrl))
          .then((mod) => {
            const runtime = mod && mod.default ? mod.default : null;
            if (runtime && typeof runtime.injectIntoGlobalHook === 'function') {
              runtime.injectIntoGlobalHook(window);
              window.$RefreshReg$ = () => {};
              window.$RefreshSig$ = () => (type) => type;
              window.__vite_plugin_react_preamble_installed__ = true;
            }
          })
          .then(() => import(devEntryUrl))
          .then(() => waitForRootMount(4000))
          .then((mounted) => {
            if (!mounted) {
              throw new Error('Dev bundle loaded but app did not mount');
            }
          })
          .catch((error) => {
            attempt += 1;
            console.warn('[DevRyan] VS Code webview dev bundle unavailable, retrying...', error);
            setStatus('Waiting for webview dev server (' + hostLabel + ')... attempt ' + attempt);
            window.setTimeout(() => {
              tryLoadDevBundle();
            }, retryDelayMs);
          });
      };

      tryLoadDevBundle();
    }
  </script>
</body>
</html>`;
}
