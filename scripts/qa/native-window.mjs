import assert from 'node:assert/strict';
import { CdpConnection, evaluate } from './cdp.mjs';

// Electron exposes native BrowserWindow geometry through its main-process
// inspector. Chromium's Browser.getWindowForTarget is not implemented there.
// The caller owns the process and reserves this loopback inspector port.
export async function resizeQaNativeWindow({ inspectorPort, pageUrl, requested, ui, record }) {
  const endpoint = await ui.waitFor('owned Electron main inspector', async () => {
    const rows = await fetch(`http://127.0.0.1:${inspectorPort}/json/list`, {
      signal: AbortSignal.timeout(1000),
    }).then(response => response.ok ? response.json() : null).catch(() => null);
    if (!Array.isArray(rows)) return null;
    const targets = rows.filter(row => row.type === 'node' && typeof row.webSocketDebuggerUrl === 'string');
    if (targets.length !== 1) return null;
    const url = new URL(targets[0].webSocketDebuggerUrl);
    assert.equal(url.protocol, 'ws:');
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(Number(url.port), inspectorPort);
    return url.href;
  });
  const main = await CdpConnection.connect(endpoint);
  try {
    const native = await evaluate(main, `(() => {
      const { BrowserWindow } = process.getBuiltinModule('module').createRequire(process.execPath)('electron');
      const windows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()
        && window.webContents.getURL() === ${JSON.stringify(pageUrl)});
      if (windows.length !== 1) throw new Error('Expected one exact QA page window');
      const window = windows[0];
      return { windowId: window.id, bounds: window.getBounds(), minimum: window.getMinimumSize(),
        contentBounds: window.getContentBounds() };
    })()`);
    assert.ok(Number.isSafeInteger(native.windowId) && native.windowId > 0);
    assert.ok(Array.isArray(native.minimum) && native.minimum.length === 2
      && native.minimum.every(value => Number.isSafeInteger(value) && value >= 0));
    const supported = requested.width >= native.minimum[0] && requested.height >= native.minimum[1];
    await record({ ...native, requested, supported });
    if (!supported) throw new Error(`Requested native window ${requested.width}x${requested.height} is below the application minimum ${native.minimum.join('x')}`);
    await evaluate(main, `(() => {
      const { BrowserWindow } = process.getBuiltinModule('module').createRequire(process.execPath)('electron');
      const window = BrowserWindow.fromId(${native.windowId});
      if (!window || window.isDestroyed() || window.webContents.getURL() !== ${JSON.stringify(pageUrl)})
        throw new Error('Exact QA window changed before resize');
      window.setFullScreen(false);window.unmaximize();
      window.setSize(${requested.width}, ${requested.height});
    })()`);
    const committed = await ui.waitFor('native window bounds committed', async () => {
      const result = await evaluate(main, `(() => {
        const { BrowserWindow } = process.getBuiltinModule('module').createRequire(process.execPath)('electron');
        const window = BrowserWindow.fromId(${native.windowId});
        if (!window || window.isDestroyed() || window.webContents.getURL() !== ${JSON.stringify(pageUrl)})
          throw new Error('Exact QA window changed after resize');
        return { bounds: window.getBounds(), contentBounds: window.getContentBounds() };
      })()`);
      return result.bounds.width === requested.width && result.bounds.height === requested.height ? result : null;
    });
    await record({ ...native, ...committed, requested, supported: true });
    return committed;
  } finally { main.close(); }
}
