import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isPrivilegedRendererUrl } from './origin-policy.mjs';
import { WINDOWS_PREVIEW_VERSION, WINDOWS_PREVIEW_OPENCODE_VERSION } from './windows-preview.mjs';

export async function runPackagedPreviewSmoke({ app, window, session, baseUrl, environment = process.env }) {
  const fixtureRoot = environment.DEVRYAN_PREVIEW_SMOKE_ROOT;
  const receipt = environment.DEVRYAN_PREVIEW_SMOKE_RECEIPT;
  if (!app.isPackaged || process.platform !== 'win32' || !path.isAbsolute(fixtureRoot || '')
    || !path.isAbsolute(receipt || '') || path.dirname(receipt) !== fixtureRoot) throw new Error('windows_preview_smoke_fixture_invalid');
  const deadline = Date.now() + 90_000;
  let health;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/health', baseUrl), { signal: AbortSignal.timeout(2_000) });
      health = await response.json();
      if (response.ok && health.isOpenCodeReady === true && health.openCode?.ready === true && window && !window.isDestroyed()
        && !window.webContents.isLoading() && new URL(window.webContents.getURL()).origin === new URL(baseUrl).origin) break;
    } catch { /* Startup is bounded; the final readiness assertion retains failures. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (health?.isOpenCodeReady !== true || health.openCode?.runtimeMode !== 'standard-preview'
    || health.openCode.version !== WINDOWS_PREVIEW_OPENCODE_VERSION || health.openCode.ordinaryUserPermissions !== true) {
    throw new Error('windows_preview_smoke_readiness_failed');
  }
  if (!window || window.isDestroyed() || window.webContents.isLoading()
    || !isPrivilegedRendererUrl(window.webContents.getURL(), baseUrl)
    || new URL(window.webContents.getURL()).origin !== new URL(baseUrl).origin) throw new Error('windows_preview_smoke_renderer_failed');
  const renderer = await window.webContents.executeJavaScript('({title:document.title,body:!!document.body,bridge:!!window.__OPENCHAMBER_ELECTRON__})');
  if (!renderer.body || !renderer.bridge) throw new Error('windows_preview_smoke_preload_failed');
  const { runWindowsPreviewSessionSmoke } = await import(pathToFileURL(path.join(process.resourcesPath, 'windows-preview-session-smoke.mjs')).href);
  const request = async (relative, init = {}) => {
    const url = new URL(relative, baseUrl);
    if (url.origin !== new URL(baseUrl).origin) throw new Error('windows_preview_smoke_request_origin_invalid');
    const cookies = await session.cookies.get({ url: url.href });
    const headers = new Headers(init.headers);
    headers.set('cookie', cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '));
    return fetch(url, { ...init, headers });
  };
  const functional = await runWindowsPreviewSessionSmoke({ baseUrl, request,
    phase: environment.DEVRYAN_PREVIEW_SMOKE_PHASE || 'initial', fixtureRoot });
  const evidence = { schema: 1, appVersion: app.getVersion(), expectedVersion: WINDOWS_PREVIEW_VERSION,
    arch: process.arch, runtimeMode: health.openCode.runtimeMode, opencodeVersion: health.openCode.version,
    ordinaryUserPermissions: true, renderer, functional: { ...functional, status: 'passed' }, pid: process.pid };
  await fs.writeFile(receipt, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  // The caller observes receipt and asks this process to quit through its
  // owned cleanup path; no cookie, API key or provider config enters evidence.
}
