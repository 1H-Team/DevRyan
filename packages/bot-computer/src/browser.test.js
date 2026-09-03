import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, test } from 'bun:test';
import {
  ComputerBrowserError,
  clearStaleChromiumStartupArtifacts,
  chromiumLaunchArguments,
  createBrowserController,
  createHumanInputDispatcher,
  dispatchHumanInputEvents,
  launchChromiumDriver,
  REVIEWED_BROWSER_COMMANDS,
  validateHumanInputArgs,
} from './browser.js';
import { createAccessibilityRefStore } from './refs.js';
import { createControlLeaseManager } from './control.js';
import { createScreencastBroker } from './screencast.js';

describe('Chromium startup artifact cleanup', () => {
  test('launches headed Chromium while retaining the fixed profile, proxy, and viewport', () => {
    const args = chromiumLaunchArguments({
      profileDirectory: '/data/chromium',
      proxyUrl: 'http://127.0.0.1:41234',
    });
    expect(args).not.toContain('--headless=new');
    expect(args).toContain('--window-size=1280,720');
    expect(args).toContain('--force-device-scale-factor=1');
    expect(args).toContain('--proxy-server=http://127.0.0.1:41234');
    expect(args).toContain('--proxy-bypass-list=<-loopback>');
    expect(args).toContain('--user-data-dir=/data/chromium');
    expect(args).toContain('--disable-extensions');
    expect(args).toContain('--disable-quic');
    // A start URL on the command line would defeat RestoreOnStartup session restore,
    // and these flags would disable it outright.
    expect(args).not.toContain('about:blank');
    expect(args.every((argument) => argument.startsWith('--'))).toBe(true);
    expect(args).not.toContain('--no-startup-window');
    expect(args).not.toContain('--incognito');
    expect(args).not.toContain('--guest');
  });

  test('removes only disposable singleton and CDP artifacts before relaunch', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-browser-artifacts-'));
    const outside = path.join(directory, '..', `${path.basename(directory)}-outside`);
    try {
      await fs.writeFile(outside, 'preserve');
      await fs.writeFile(path.join(directory, 'DevToolsActivePort'), 'stale');
      await fs.writeFile(path.join(directory, 'SingletonCookie'), 'stale');
      await fs.symlink(outside, path.join(directory, 'SingletonLock'));
      await fs.writeFile(path.join(directory, 'SingletonSocket'), 'stale');
      await fs.writeFile(path.join(directory, 'Preferences'), 'authoritative');

      await clearStaleChromiumStartupArtifacts({ profileDirectory: directory });

      for (const filename of ['DevToolsActivePort', 'SingletonCookie', 'SingletonLock', 'SingletonSocket']) {
        await expect(fs.lstat(path.join(directory, filename))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(await fs.readFile(path.join(directory, 'Preferences'), 'utf8')).toBe('authoritative');
      expect(await fs.readFile(outside, 'utf8')).toBe('preserve');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
      await fs.rm(outside, { force: true });
    }
  });
});

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0xff, 0xd9]);

describe('held human input cleanup', () => {
  const pointerDown = { type: 'pointer', phase: 'down', x: 12, y: 24, button: 'left', buttons: 1, clickCount: 1 };
  const keyDown = { type: 'key', phase: 'down', key: 'Shift', code: 'ShiftLeft', modifiers: ['Shift'], location: 1, repeat: false };

  test('releases held keys/buttons despite a hung acknowledgment and fences the remaining old batch', async () => {
    const calls = [];
    let acknowledge;
    let markDown;
    const downStarted = new Promise((resolve) => { markDown = resolve; });
    const hung = new Promise((resolve) => { acknowledge = resolve; });
    const dispatcher = createHumanInputDispatcher({ send: async (method, params) => {
      calls.push([method, params]);
      if (params.type === 'mousePressed') { markDown(); await hung; }
    } });
    await dispatcher.dispatch([keyDown]);
    const oldBatch = dispatcher.dispatch([pointerDown, { ...keyDown, key: 'x', code: 'KeyX' }]).catch((error) => error);
    await downStarted;
    await dispatcher.release();
    expect(calls.map(([, params]) => params.type)).toEqual(['keyDown', 'mousePressed', 'keyUp', 'mouseReleased']);
    await dispatcher.dispatch([{ type: 'text', text: 'new lease' }]);
    acknowledge();
    expect(await oldBatch).toMatchObject({ code: 'DEVRYAN_BOT_CONTROL_NOT_OWNER' });
    expect(calls.filter(([, params]) => params.code === 'KeyX')).toHaveLength(0);
    const before = calls.length;
    await dispatcher.release();
    expect(calls).toHaveLength(before);
  });

  test('revalidates authority before each event and bounds failed release without forgetting held keys', async () => {
    let owned = true;
    let refuseRelease = true;
    const calls = [];
    const dispatcher = createHumanInputDispatcher({ releaseTimeoutMs: 20, send: async (_method, params) => {
      calls.push(params);
      if (params.type === 'keyDown') owned = false;
      if (params.type === 'keyUp' && refuseRelease) await new Promise(() => undefined);
    } });
    await expect(dispatcher.dispatch([keyDown, { type: 'text', text: 'must not dispatch' }], {
      assertAuthorized() { if (!owned) throw Object.assign(new Error('Revoked'), { code: 'DEVRYAN_BOT_CONTROL_NOT_OWNER' }); },
    })).rejects.toMatchObject({ code: 'DEVRYAN_BOT_CONTROL_NOT_OWNER' });
    expect(calls).toHaveLength(1);
    await expect(dispatcher.release()).rejects.toMatchObject({ code: 'DEVRYAN_BOT_CONTROL_RELEASE_FAILED' });
    refuseRelease = false;
    await dispatcher.release();
    expect(calls.map(({ type }) => type)).toEqual(['keyDown', 'keyUp', 'keyUp']);
  });
});

const fixture = ({ diagnostics = null } = {}) => {
  const calls = [];
  let pageHandler = () => undefined;
  let healthy = true;
  const terminationHandlers = new Set();
  const driver = {
    isHealthy: () => healthy,
    onTerminated: (handler) => {
      terminationHandlers.add(handler);
      return () => terminationHandlers.delete(handler);
    },
    setPageChangeHandler: (handler) => { pageHandler = handler; },
    startScreencast: async (onFrame) => {
      calls.push(['startScreencast']);
      onFrame(jpeg, { width: 10, height: 10 });
      return async () => calls.push(['stopScreencast']);
    },
    navigate: async (url) => calls.push(['navigate', url]),
    snapshot: async () => [{ backendNodeId: 12, role: 'button', name: 'Save' }],
    click: async (node) => calls.push(['click', node.backendNodeId]),
    fill: async (node, text) => calls.push(['fill', node.backendNodeId, text]),
    select: async (node, value) => calls.push(['select', node.backendNodeId, value]),
    key: async (key) => calls.push(['key', key]),
    scroll: async (value) => calls.push(['scroll', value]),
    input: async (events) => {
      calls.push(['input', events]);
      return { dispatched: events.length };
    },
    upload: async (node, filePath) => calls.push(['upload', node.backendNodeId, filePath]),
    screenshot: async () => jpeg,
    close: async () => {
      healthy = false;
      calls.push(['close']);
    },
  };
  const refs = createAccessibilityRefStore({ randomBytes: () => Buffer.alloc(8, 5) });
  const control = createControlLeaseManager();
  const workspace = {
    stageUpload: async () => ({ path: '/workspace/input.txt', filename: 'input.txt', size: 4 }),
    publishDownload: async () => ({ artifactId: 'artifact-01', filename: 'out.txt', size: 4 }),
  };
  const profiles = { resetProfile: async ({ closeBrowser }) => { await closeBrowser(); return { reset: true }; } };
  const screencast = createScreencastBroker();
  const controller = createBrowserController({
    launchDriver: async () => { calls.push(['launch']); return driver; },
    refs,
    control,
    workspace,
    profiles,
    screencast,
    diagnostics,
  });
  return { controller, calls, refs, control, screencast, pageChanged: () => pageHandler() };
};

const createCdpHarness = async () => {
  class FakeChild extends EventEmitter {
    exitCode = null;

    kill() {
      if (this.exitCode !== null) return true;
      this.exitCode = 0;
      this.emit('exit', 0);
      return true;
    }
  }
  const child = new FakeChild();
  const listeners = new Map();
  const closeListeners = new Set();
  const calls = [];
  const sessionByTarget = new Map();
  let closed = false;
  let createdTargets = 0;
  const connection = {
    ready: Promise.resolve(),
    async send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === 'Browser.getVersion') return { product: 'Chromium/151.0' };
      if (method === 'Target.createTarget') {
        createdTargets += 1;
        return { targetId: createdTargets === 1 ? 'root' : `fresh-${createdTargets}` };
      }
      if (method === 'Target.attachToTarget') {
        const session = `${params.targetId}-session`;
        sessionByTarget.set(params.targetId, session);
        return { sessionId: session };
      }
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: `${sessionId}-frame`, url: 'https://example.com/' } } };
      }
      if (method === 'Page.captureScreenshot') return { data: jpeg.toString('base64') };
      if (method === 'Accessibility.getFullAXTree') {
        return { nodes: [{ backendDOMNodeId: sessionId === 'root-session' ? 1 : 2, role: { value: 'button' }, name: { value: 'Continue' } }] };
      }
      return {};
    },
    on(method, callback) {
      const callbacks = listeners.get(method) || new Set();
      callbacks.add(callback);
      listeners.set(method, callbacks);
      return () => callbacks.delete(callback);
    },
    onClose(callback) { closeListeners.add(callback); return () => closeListeners.delete(callback); },
    isClosed: () => closed,
    close() {
      if (closed) return;
      closed = true;
      for (const callback of closeListeners) callback();
    },
  };
  const diagnostics = {
    recordRequest() {}, recordResponse() {}, recordCookieBlock() {}, recordFailure() {},
    recordDialog: (...args) => calls.push({ method: 'diagnostic.dialog', params: args[0] }),
    recordPopupLimit: (...args) => calls.push({ method: 'diagnostic.popup_limit', params: args[0] }),
  };
  const driver = await launchChromiumDriver({
    executablePath: '/usr/bin/chromium-browser',
    profileDirectory: '/tmp/devryan-cdp-profile',
    scratchDirectory: '/tmp/devryan-cdp-scratch',
    proxyUrl: 'http://127.0.0.1:43123',
    spawnImpl: () => child,
    fsPromises: {
      mkdir: async () => {},
      unlink: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      readFile: async () => '9222\n/devtools/browser/fixture',
    },
    connectionFactory: () => connection,
    diagnostics,
  });
  const emit = (method, params, sessionId) => {
    for (const callback of listeners.get(method) || []) callback(params, sessionId);
  };
  const waitForTargets = async (count) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (driver.status().activeTargetCount === count) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`Timed out waiting for ${count} targets`);
  };
  return { driver, calls, emit, waitForTargets, sessionByTarget };
};

describe('active Chromium page targets', () => {
  test('follows bounded popup targets and returns input and screencast to each opener', async () => {
    const harness = await createCdpHarness();
    let pageChanges = 0;
    harness.driver.setPageChangeHandler(() => { pageChanges += 1; });
    const frames = [];
    await harness.driver.startScreencast((frame) => frames.push(frame));

    harness.emit('Target.targetCreated', { targetInfo: {
      targetId: 'popup-1', type: 'page', openerId: 'root', url: 'https://login.example/popup',
    } });
    await harness.waitForTargets(2);
    expect(harness.driver.status()).toMatchObject({ activeTargetCount: 2, popupOpen: true });
    await harness.driver.input([{ type: 'text', text: 'popup input' }]);
    await harness.driver.screenshot({ format: 'jpeg', quality: 60 });
    expect(harness.calls).toContainEqual(expect.objectContaining({
      method: 'Input.insertText', params: { text: 'popup input' }, sessionId: 'popup-1-session',
    }));
    expect(harness.calls).toContainEqual(expect.objectContaining({
      method: 'Page.captureScreenshot', sessionId: 'popup-1-session',
    }));
    expect(harness.calls).toContainEqual(expect.objectContaining({
      method: 'Page.stopScreencast', sessionId: 'root-session',
    }));

    for (const [targetId, openerId, count] of [
      ['popup-2', 'popup-1', 3],
      ['popup-3', 'popup-2', 4],
    ]) {
      harness.emit('Target.targetCreated', { targetInfo: {
        targetId, type: 'page', openerId, url: `https://login.example/${targetId}`,
      } });
      await harness.waitForTargets(count);
    }
    harness.emit('Target.targetCreated', { targetInfo: {
      targetId: 'popup-4', type: 'page', openerId: 'popup-3', url: 'https://login.example/fourth',
    } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.driver.status().activeTargetCount).toBe(4);
    expect(harness.calls).toContainEqual(expect.objectContaining({
      method: 'Target.closeTarget', params: { targetId: 'popup-4' }, sessionId: undefined,
    }));
    expect(harness.calls).toContainEqual(expect.objectContaining({ method: 'diagnostic.popup_limit' }));

    harness.emit('Target.targetDestroyed', { targetId: 'popup-3' });
    await harness.waitForTargets(3);
    expect(harness.calls).toContainEqual(expect.objectContaining({
      method: 'Page.startScreencast', sessionId: 'popup-2-session',
    }));
    expect(frames.length).toBeGreaterThan(0);
    expect(pageChanges).toBeGreaterThanOrEqual(4);
    await harness.driver.close({ force: true });
  });

  test('closes session-restored tabs it does not drive without touching the browser', async () => {
    const harness = await createCdpHarness();

    harness.emit('Target.targetCreated', { targetInfo: {
      targetId: 'restored-1', type: 'page', url: 'https://app.example/dashboard',
    } });
    harness.emit('Target.targetCreated', { targetInfo: {
      targetId: 'root', type: 'page', url: 'about:blank',
    } });
    harness.emit('Target.targetCreated', { targetInfo: {
      targetId: 'worker-1', type: 'service_worker', url: 'https://app.example/sw.js',
    } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.calls).toContainEqual(expect.objectContaining({
      method: 'Target.closeTarget', params: { targetId: 'restored-1' }, sessionId: undefined,
    }));
    expect(harness.calls).not.toContainEqual(expect.objectContaining({
      method: 'Target.closeTarget', params: { targetId: 'root' },
    }));
    expect(harness.calls).not.toContainEqual(expect.objectContaining({
      method: 'Target.closeTarget', params: { targetId: 'worker-1' },
    }));
    expect(harness.calls.some((call) => call.method === 'Browser.close')).toBe(false);
    expect(harness.driver.status()).toMatchObject({ activeTargetCount: 1, popupOpen: false });
    expect(harness.driver.isHealthy()).toBe(true);
    await harness.driver.close({ force: true });
  });

  test('resets only the page after a stuck command and keeps the Chromium process', async () => {
    const harness = await createCdpHarness();
    let pageChanges = 0;
    harness.driver.setPageChangeHandler(() => { pageChanges += 1; });
    const frames = [];
    await harness.driver.startScreencast((frame) => frames.push(frame));
    harness.emit('Target.targetCreated', { targetInfo: {
      targetId: 'popup-1', type: 'page', openerId: 'root', url: 'https://login.example/popup',
    } });
    await harness.waitForTargets(2);

    const result = await harness.driver.resetPage();

    expect(result).toEqual({ targetId: 'fresh-2', closedTargets: 2 });
    expect(harness.driver.status()).toMatchObject({ activeTargetCount: 1, popupOpen: false });
    expect(harness.driver.isHealthy()).toBe(true);
    for (const targetId of ['root', 'popup-1']) {
      expect(harness.calls).toContainEqual(expect.objectContaining({
        method: 'Target.closeTarget', params: { targetId }, sessionId: undefined,
      }));
    }
    expect(harness.calls.some((call) => call.method === 'Browser.close')).toBe(false);
    expect(harness.calls).toContainEqual(expect.objectContaining({
      method: 'Page.startScreencast', sessionId: 'fresh-2-session',
    }));
    expect(pageChanges).toBeGreaterThanOrEqual(1);

    harness.emit('Target.targetDestroyed', { targetId: 'root' });
    harness.emit('Target.targetDestroyed', { targetId: 'popup-1' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.driver.isHealthy()).toBe(true);
    await harness.driver.screenshot({ format: 'jpeg', quality: 60 });
    expect(harness.calls).toContainEqual(expect.objectContaining({
      method: 'Page.captureScreenshot', sessionId: 'fresh-2-session',
    }));
    await harness.driver.close({ force: true });
  });

  test('dismisses blocking dialogs while accepting beforeunload', async () => {
    const harness = await createCdpHarness();
    harness.emit('Page.javascriptDialogOpening', {
      type: 'confirm', message: 'Continue?', url: 'https://example.com/login',
    }, 'root-session');
    harness.emit('Page.javascriptDialogOpening', {
      type: 'beforeunload', message: 'Leave?', url: 'https://example.com/login',
    }, 'root-session');
    await Promise.resolve();

    expect(harness.calls).toContainEqual(expect.objectContaining({
      method: 'Page.handleJavaScriptDialog', params: { accept: false }, sessionId: 'root-session',
    }));
    expect(harness.calls).toContainEqual(expect.objectContaining({
      method: 'Page.handleJavaScriptDialog', params: { accept: true }, sessionId: 'root-session',
    }));
    expect(harness.calls.filter((call) => call.method === 'diagnostic.dialog')).toHaveLength(2);
    await harness.driver.close({ force: true });
  });
});

const recoveryFixture = () => {
  const calls = [];
  const drivers = [];
  const refs = createAccessibilityRefStore({ randomBytes: () => Buffer.alloc(8, 6) });
  const control = createControlLeaseManager();
  const workspace = {
    stageUpload: async () => ({ path: '/workspace/input.txt', filename: 'input.txt', size: 4 }),
    publishDownload: async () => ({ artifactId: 'artifact-01', filename: 'out.txt', size: 4 }),
  };
  const profiles = { resetProfile: async ({ closeBrowser }) => closeBrowser() };
  const screencast = createScreencastBroker();
  let releaseSecondLaunch = null;
  let holdSecondLaunch = false;

  const makeDriver = (number) => {
    let healthy = true;
    let failSnapshot = false;
    let failClick = false;
    let timeoutSnapshot = false;
    let timeoutClick = false;
    let failPageReset = false;
    const terminationHandlers = new Set();
    const timedOut = () => new ComputerBrowserError(
      'Chromium command timed out',
      'DEVRYAN_BOT_BROWSER_COMMAND_TIMEOUT',
      504,
    );
    const terminate = (code = 'DEVRYAN_BOT_BROWSER_CLOSED') => {
      healthy = false;
      for (const handler of terminationHandlers) handler(code);
    };
    const driver = {
      number,
      isHealthy: () => healthy,
      onTerminated: (handler) => {
        terminationHandlers.add(handler);
        return () => terminationHandlers.delete(handler);
      },
      setPageChangeHandler: () => {},
      startScreencast: async () => async () => {},
      navigate: async () => {},
      async snapshot() {
        calls.push(['snapshot', number]);
        if (timeoutSnapshot) {
          timeoutSnapshot = false;
          throw timedOut();
        }
        if (failSnapshot) {
          failSnapshot = false;
          terminate();
          throw new ComputerBrowserError(
            'fixture connection closed',
            'DEVRYAN_BOT_BROWSER_CLOSED',
            503,
          );
        }
        return [{ backendNodeId: number, role: 'button', name: `Save ${number}` }];
      },
      async click() {
        calls.push(['click', number]);
        if (timeoutClick) {
          timeoutClick = false;
          throw timedOut();
        }
        if (failClick) {
          failClick = false;
          terminate();
          throw new ComputerBrowserError(
            'fixture connection closed',
            'DEVRYAN_BOT_BROWSER_CLOSED',
            503,
          );
        }
      },
      fill: async () => {},
      select: async () => {},
      key: async () => {},
      scroll: async () => {},
      upload: async () => {},
      screenshot: async () => jpeg,
      async close() {
        calls.push(['close', number]);
        terminate();
      },
      async resetPage() {
        calls.push(['resetPage', number]);
        if (failPageReset) {
          failPageReset = false;
          throw timedOut();
        }
        return { targetId: `fresh-${number}`, closedTargets: 1 };
      },
      terminate,
      failNextSnapshot: () => { failSnapshot = true; },
      failNextClick: () => { failClick = true; },
      timeoutNextSnapshot: () => { timeoutSnapshot = true; },
      timeoutNextClick: () => { timeoutClick = true; },
      failNextPageReset: () => { failPageReset = true; },
      notifyLateTermination: () => {
        for (const handler of terminationHandlers) handler('DEVRYAN_BOT_BROWSER_CLOSED');
      },
    };
    return driver;
  };

  const controller = createBrowserController({
    async launchDriver() {
      const number = drivers.length + 1;
      calls.push(['launch', number]);
      if (number === 2 && holdSecondLaunch) {
        await new Promise((resolve) => { releaseSecondLaunch = resolve; });
      }
      const driver = makeDriver(number);
      drivers.push(driver);
      return driver;
    },
    refs,
    control,
    workspace,
    profiles,
    screencast,
  });
  return {
    controller,
    calls,
    drivers,
    holdSecondLaunch() { holdSecondLaunch = true; },
    releaseSecondLaunch() { releaseSecondLaunch?.(); },
  };
};

describe('reviewed computer browser commands', () => {
  test('exposes the exact reviewed command inventory and no JavaScript evaluation', () => {
    expect(REVIEWED_BROWSER_COMMANDS).toEqual([
      'navigate', 'snapshot', 'click', 'fill', 'select', 'key', 'scroll', 'wait',
      'upload', 'download', 'screenshot',
    ]);
    expect(REVIEWED_BROWSER_COMMANDS).not.toContain('evaluate');
    expect(REVIEWED_BROWSER_COMMANDS).not.toContain('javascript');
    expect(REVIEWED_BROWSER_COMMANDS).not.toContain('close');
  });

  test('denies any command that would close the persistent browser', async () => {
    const { controller, calls } = fixture();
    await controller.execute('snapshot', {});
    await expect(controller.execute('close', {}))
      .rejects.toMatchObject({ code: 'DEVRYAN_BOT_BROWSER_COMMAND_DENIED' });
    await expect(controller.executeHuman('close', {}))
      .rejects.toMatchObject({ code: 'DEVRYAN_BOT_BROWSER_COMMAND_DENIED' });
    expect(calls).not.toContainEqual(['close']);
    expect(controller.status()).toMatchObject({ running: true, healthy: true, generation: 1 });
    // Host-side shutdown and profile reset remain the only paths that close it.
    await controller.close();
    expect(calls).toContainEqual(['close']);
  });

  test('uses accessibility refs for interaction and invalidates them on page change', async () => {
    const { controller, calls, pageChanged } = fixture();
    await controller.execute('navigate', { url: 'https://example.com/login' });
    const snapshot = await controller.execute('snapshot', {});
    await controller.execute('click', { ref: snapshot.nodes[0].ref });
    expect(calls).toContainEqual(['click', 12]);
    pageChanged();
    await expect(controller.execute('click', { ref: snapshot.nodes[0].ref }))
      .rejects.toMatchObject({ code: 'DEVRYAN_BOT_REF_STALE' });
  });

  test('routes upload/download through the workspace gateway and returns bounded screenshots', async () => {
    const { controller, calls } = fixture();
    const snapshot = await controller.execute('snapshot', {});
    await controller.execute('upload', {
      ref: snapshot.nodes[0].ref,
      artifactId: 'artifact-01',
      filename: 'input.txt',
    });
    expect(calls).toContainEqual(['upload', 12, '/workspace/input.txt']);
    expect(await controller.execute('download', { filename: 'out.txt' })).toMatchObject({
      artifactId: 'artifact-01',
    });
    expect(await controller.execute('screenshot', { format: 'jpeg', quality: 70 })).toMatchObject({
      mimeType: 'image/jpeg',
      bytes: jpeg.byteLength,
    });
  });

  test('fences agent commands before execution during human control and closes before profile reset', async () => {
    const { controller, control, calls } = fixture();
    const lease = control.take({ actorId: 'user-01', actorType: 'user' });
    await expect(controller.execute('snapshot', {})).rejects.toMatchObject({
      code: 'DEVRYAN_BOT_CONTROL_HELD',
    });
    expect(calls).not.toContainEqual(['snapshot']);
    await control.returnControl({ actorId: 'user-01', actorType: 'user', leaseId: lease.leaseId });
    await controller.execute('snapshot', {});
    await controller.resetProfile();
    expect(calls).toContainEqual(['close']);
  });

  test('resets navigation diagnostics on relaunch, explicit navigation, and profile reset', async () => {
    const resets = [];
    const { controller } = fixture({
      diagnostics: { snapshot: () => null, reset: (reason) => resets.push(reason) },
    });
    await controller.execute('snapshot', {});
    await controller.execute('navigate', { url: 'https://example.com/login' });
    await controller.resetProfile();
    expect(resets).toEqual(['relaunch', 'navigate', 'profile_reset']);
  });

  test('dispatches bounded full-fidelity input only for a human controller', async () => {
    const { controller, control, calls } = fixture();
    control.take({ actorId: 'user-01', actorType: 'user' });
    const events = [
      { type: 'pointer', phase: 'move', x: 40, y: 50, button: 'none', buttons: 0, clickCount: 0 },
      { type: 'pointer', phase: 'down', x: 40, y: 50, button: 'right', buttons: 2, clickCount: 2 },
      { type: 'pointer', phase: 'up', x: 40, y: 50, button: 'right', buttons: 0, clickCount: 2 },
      { type: 'wheel', x: 40, y: 50, deltaX: 0, deltaY: 120 },
      {
        type: 'key',
        phase: 'down',
        key: 'a',
        code: 'KeyA',
        modifiers: ['Meta'],
        location: 0,
        repeat: false,
      },
      { type: 'text', text: 'pasted text' },
    ];

    expect(validateHumanInputArgs({ events })).toHaveLength(events.length);
    await expect(controller.executeHuman('input', { events })).resolves.toEqual({
      dispatched: events.length,
    });
    expect(calls).toContainEqual(['input', events]);
    await expect(controller.execute('input', { events }))
      .rejects.toMatchObject({ code: 'DEVRYAN_BOT_BROWSER_COMMAND_DENIED' });
    expect(() => validateHumanInputArgs({
      events: [{ ...events[0], x: 1281 }],
    })).toThrow(/Pointer x/i);
    expect(REVIEWED_BROWSER_COMMANDS).not.toContain('input');
  });

  test('maps ordered human batches to Chromium CDP input events', async () => {
    const calls = [];
    const events = validateHumanInputArgs({
      events: [
        { type: 'pointer', phase: 'down', x: 12, y: 24, button: 'middle', buttons: 4, clickCount: 1 },
        { type: 'pointer', phase: 'up', x: 12, y: 24, button: 'middle', buttons: 0, clickCount: 1 },
        { type: 'wheel', x: 12, y: 24, deltaX: 4, deltaY: -8 },
        {
          type: 'key', phase: 'down', key: 'k', code: 'KeyK',
          modifiers: ['Control', 'Meta'], location: 0, repeat: true,
        },
        {
          type: 'key', phase: 'down', key: 'x', code: 'KeyX',
          modifiers: [], location: 0, repeat: false,
        },
        {
          type: 'key', phase: 'up', key: 'x', code: 'KeyX',
          modifiers: [], location: 0, repeat: false,
        },
        {
          type: 'key', phase: 'down', key: 'Enter', code: 'Enter',
          modifiers: [], location: 0, repeat: false,
        },
        {
          type: 'key', phase: 'down', key: 'Backspace', code: 'Backspace',
          modifiers: [], location: 0, repeat: false,
        },
        {
          type: 'key', phase: 'down', key: 'ArrowLeft', code: 'ArrowLeft',
          modifiers: [], location: 0, repeat: false,
        },
        { type: 'text', text: 'hello' },
      ],
    });
    await dispatchHumanInputEvents({
      events,
      send: async (method, params) => calls.push([method, params]),
    });

    expect(calls[0]).toEqual(['Input.dispatchMouseEvent', expect.objectContaining({
      type: 'mousePressed', button: 'middle', buttons: 4, clickCount: 1,
    })]);
    expect(calls[1]).toEqual(['Input.dispatchMouseEvent', expect.objectContaining({
      type: 'mouseReleased', button: 'middle', buttons: 0,
    })]);
    expect(calls[2]).toEqual(['Input.dispatchMouseEvent', expect.objectContaining({
      type: 'mouseWheel', deltaX: 4, deltaY: -8,
    })]);
    expect(calls[3]).toEqual(['Input.dispatchKeyEvent', expect.objectContaining({
      type: 'keyDown', modifiers: 6, autoRepeat: true,
    })]);
    expect(calls[4]).toEqual(['Input.dispatchKeyEvent', expect.objectContaining({
      type: 'keyDown', text: 'x', unmodifiedText: 'x',
      windowsVirtualKeyCode: 88, nativeVirtualKeyCode: 88,
    })]);
    expect(calls[5]).toEqual(['Input.dispatchKeyEvent', expect.objectContaining({
      type: 'keyUp', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88,
    })]);
    expect(calls[6]).toEqual(['Input.dispatchKeyEvent', expect.objectContaining({
      type: 'keyDown', key: 'Enter', text: '\r', unmodifiedText: '\r',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    })]);
    expect(calls[7]).toEqual(['Input.dispatchKeyEvent', expect.objectContaining({
      type: 'keyDown', key: 'Backspace', windowsVirtualKeyCode: 8,
    })]);
    expect('text' in calls[7][1]).toBe(false);
    expect(calls[8]).toEqual(['Input.dispatchKeyEvent', expect.objectContaining({
      type: 'keyDown', key: 'ArrowLeft', windowsVirtualKeyCode: 37,
    })]);
    expect(calls[9]).toEqual(['Input.insertText', { text: 'hello' }]);
  });

  test('seeds every viewer with a current frame and stops capture after the last viewer', async () => {
    const { controller, calls, screencast } = fixture();
    expect(controller.status().running).toBe(false);
    expect(calls).not.toContainEqual(['startScreencast']);

    const firstFrames = [];
    const secondFrames = [];
    const closeFirst = await controller.subscribeScreencast((frame) => firstFrames.push(frame));
    const closeSecond = await controller.subscribeScreencast((frame) => secondFrames.push(frame));

    expect(calls.filter(([kind]) => kind === 'launch')).toHaveLength(1);
    expect(controller.status().running).toBe(true);
    expect(calls.filter(([kind]) => kind === 'startScreencast')).toHaveLength(1);
    expect(screencast.snapshot().subscribers).toBe(2);
    expect(firstFrames).toHaveLength(3);
    expect(secondFrames).toHaveLength(1);
    await closeFirst();
    expect(calls).not.toContainEqual(['stopScreencast']);
    await closeSecond();
    expect(calls.filter(([kind]) => kind === 'stopScreencast')).toHaveLength(1);
    expect(screencast.snapshot().subscribers).toBe(0);
  });

  test('rolls back the first viewer when the current-frame capture fails', async () => {
    const calls = [];
    const refs = createAccessibilityRefStore({ randomBytes: () => Buffer.alloc(8, 7) });
    const control = createControlLeaseManager();
    const screencast = createScreencastBroker();
    const controller = createBrowserController({
      launchDriver: async () => ({
        isHealthy: () => true,
        onTerminated: () => () => undefined,
        setPageChangeHandler: () => undefined,
        startScreencast: async () => {
          calls.push('start');
          return async () => calls.push('stop');
        },
        screenshot: async () => {
          throw new ComputerBrowserError(
            'fixture capture failed',
            'DEVRYAN_BOT_BROWSER_COMMAND_FAILED',
            502,
          );
        },
        navigate: async () => {},
        close: async () => {},
      }),
      refs,
      control,
      workspace: {},
      profiles: {},
      screencast,
    });

    await expect(controller.subscribeScreencast(() => undefined))
      .rejects.toMatchObject({ code: 'DEVRYAN_BOT_BROWSER_COMMAND_FAILED' });
    expect(calls).toEqual(['start', 'stop']);
    expect(controller.status().screencastSubscribers).toBe(0);
    expect(screencast.snapshot().subscribers).toBe(0);
  });

  test('rejects arbitrary commands and unexpected argument fields', async () => {
    const { controller } = fixture();
    await expect(controller.execute('evaluate', { script: 'document.cookie' }))
      .rejects.toMatchObject({ code: 'DEVRYAN_BOT_BROWSER_COMMAND_DENIED' });
    await expect(controller.execute('navigate', { url: 'https://example.com', script: 'x' }))
      .rejects.toMatchObject({ code: 'DEVRYAN_BOT_BROWSER_INPUT_INVALID' });
  });

  test('fails an already-aborted wait without starting a timer', async () => {
    const { controller } = fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(controller.execute('wait', { milliseconds: 30_000 }, { signal: abort.signal }))
      .rejects.toMatchObject({ code: 'DEVRYAN_BOT_COMMAND_ABORTED', statusCode: 499 });
  });

  test('relaunches once for a safe read after unexpected CDP closure', async () => {
    const harness = recoveryFixture();
    await harness.controller.execute('snapshot', {});
    harness.drivers[0].failNextSnapshot();

    const recovered = await harness.controller.execute('snapshot', {});

    expect(recovered.nodes[0].name).toBe('Save 2');
    expect(harness.calls.filter(([kind]) => kind === 'launch')).toHaveLength(2);
    expect(harness.controller.status()).toMatchObject({
      running: true,
      healthy: true,
      launching: false,
      generation: 2,
      lastFailureCode: null,
    });
    harness.drivers[0].notifyLateTermination();
    expect(harness.controller.status()).toMatchObject({ running: true, healthy: true, generation: 2 });
  });

  test('never replays a mutating command after browser transport loss', async () => {
    const harness = recoveryFixture();
    const snapshot = await harness.controller.execute('snapshot', {});
    harness.drivers[0].failNextClick();

    await expect(harness.controller.execute('click', { ref: snapshot.nodes[0].ref }))
      .rejects.toMatchObject({ code: 'DEVRYAN_BOT_BROWSER_CLOSED' });
    expect(harness.calls.filter(([kind]) => kind === 'click')).toHaveLength(1);
    expect(harness.calls.filter(([kind]) => kind === 'launch')).toHaveLength(1);

    await harness.controller.execute('snapshot', {});
    expect(harness.calls.filter(([kind]) => kind === 'launch')).toHaveLength(2);
    expect(harness.calls.filter(([kind]) => kind === 'click')).toHaveLength(1);
  });

  test('keeps the same Chromium process and resets only the page after a command timeout', async () => {
    const harness = recoveryFixture();
    await harness.controller.execute('snapshot', {});
    harness.drivers[0].timeoutNextSnapshot();

    const recovered = await harness.controller.execute('snapshot', {});

    expect(recovered.nodes[0].name).toBe('Save 1');
    expect(harness.drivers).toHaveLength(1);
    expect(harness.calls.filter(([kind]) => kind === 'launch')).toHaveLength(1);
    expect(harness.calls).toContainEqual(['resetPage', 1]);
    expect(harness.calls).not.toContainEqual(['close', 1]);
    expect(harness.controller.status()).toMatchObject({
      running: true,
      healthy: true,
      generation: 1,
      lastFailureCode: null,
    });

    const snapshot = await harness.controller.execute('snapshot', {});
    harness.drivers[0].timeoutNextClick();
    await expect(harness.controller.execute('click', { ref: snapshot.nodes[0].ref }))
      .rejects.toMatchObject({ code: 'DEVRYAN_BOT_BROWSER_COMMAND_TIMEOUT' });
    expect(harness.calls.filter(([kind]) => kind === 'click')).toHaveLength(1);
    expect(harness.calls.filter(([kind]) => kind === 'resetPage')).toHaveLength(2);
    expect(harness.calls.filter(([kind]) => kind === 'launch')).toHaveLength(1);
    expect(harness.controller.status()).toMatchObject({ running: true, healthy: true, generation: 1 });
  });

  test('relaunches only when the page reset itself fails after a timeout', async () => {
    const harness = recoveryFixture();
    await harness.controller.execute('snapshot', {});
    harness.drivers[0].timeoutNextSnapshot();
    harness.drivers[0].failNextPageReset();

    const recovered = await harness.controller.execute('snapshot', {});

    expect(recovered.nodes[0].name).toBe('Save 2');
    expect(harness.calls).toContainEqual(['resetPage', 1]);
    expect(harness.calls).toContainEqual(['close', 1]);
    expect(harness.calls.filter(([kind]) => kind === 'launch')).toHaveLength(2);
    expect(harness.controller.status()).toMatchObject({ running: true, healthy: true, generation: 2 });
  });

  test('singleflights relaunch when concurrent reads arrive after a crash', async () => {
    const harness = recoveryFixture();
    await harness.controller.execute('snapshot', {});
    harness.holdSecondLaunch();
    harness.drivers[0].terminate();

    const reads = Promise.all(Array.from({ length: 4 }, () => (
      harness.controller.execute('snapshot', {})
    )));
    await Promise.resolve();
    expect(harness.calls.filter(([kind]) => kind === 'launch')).toHaveLength(2);
    harness.releaseSecondLaunch();
    await reads;

    expect(harness.calls.filter(([kind]) => kind === 'launch')).toHaveLength(2);
    expect(harness.controller.status()).toMatchObject({ running: true, healthy: true, generation: 2 });
  });
});

if (process.env.DEVRYAN_RUN_BROWSER_TESTS === '1') {
  const execFileAsync = promisify(execFile);
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const integrationToken = 'fixture-runtime-token-0123456789abcdef0123456789';
  const browserEgressToken = 'drb1.fixture.browser-egress';

  const docker = async (...args) => execFileAsync('docker', args, {
    cwd: repositoryRoot,
    maxBuffer: 50 * 1024 * 1024,
  });

  const readBody = async (request) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return Buffer.concat(chunks);
  };

  const startFixtureSite = async () => {
    let publishedDownload = null;
    const server = http.createServer(async (request, response) => {
      const target = new URL(request.url, 'http://fixture.invalid');
      const authorized = request.headers.authorization === `Bearer ${integrationToken}`;
      if (request.method === 'GET'
        && target.pathname === '/api/bots/private/artifacts/artifact-upload/content') {
        if (!authorized) {
          response.writeHead(401).end();
          return;
        }
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('private upload bytes');
        return;
      }
      if (request.method === 'POST' && target.pathname === '/api/bots/private/artifacts') {
        if (!authorized || request.headers['x-devryan-filename'] !== 'browser-download.txt') {
          response.writeHead(401).end();
          return;
        }
        publishedDownload = await readBody(request);
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, artifact: { id: 'artifact-download' } }));
        return;
      }
      if (request.method === 'POST' && target.pathname === '/login') {
        await readBody(request);
        response.writeHead(303, {
          location: '/private',
          'set-cookie': [
            'fixture_session=accepted; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax',
            // No Max-Age/Expires: a browser-session cookie that only survives a
            // Chromium restart when session restore keeps it on disk.
            'fixture_ephemeral=accepted; Path=/; HttpOnly; SameSite=Lax',
          ],
        });
        response.end();
        return;
      }
      if (request.method === 'GET' && target.pathname === '/private') {
        const cookies = String(request.headers.cookie || '');
        const signedIn = cookies.includes('fixture_session=accepted');
        const sessionCookieKept = cookies.includes('fixture_ephemeral=accepted');
        response.writeHead(signedIn ? 200 : 302, {
          'content-type': 'text/html; charset=utf-8',
          ...(signedIn ? {} : { location: '/login' }),
        });
        response.end(signedIn
          ? `<!doctype html><title>Private</title><h1>Signed in</h1>${sessionCookieKept ? '<h2>Session cookie kept</h2>' : ''}`
          : '');
        return;
      }
      if (request.method === 'GET' && target.pathname === '/login') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><title>Login</title><form method="post" action="/login"><label for="username">Username</label><input id="username" name="username" autocomplete="username"><button type="submit">Sign in</button></form>');
        return;
      }
      if (request.method === 'GET' && target.pathname === '/next') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><title>Next</title><h1>Next page</h1>');
        return;
      }
      if (request.method === 'GET' && target.pathname === '/popup-parent') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(`<!doctype html>
          <title>Popup parent</title><h1>Popup parent</h1>
          <button id="scripted" onclick="window.open('/popup-child?source=scripted', '_blank')">Open scripted popup</button>
          <a href="/popup-child?source=linked" target="_blank">Open linked popup</a>`);
        return;
      }
      if (request.method === 'GET' && target.pathname === '/popup-child') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(`<!doctype html>
          <title>Popup child</title><h1>Popup child</h1>
          <p>${target.searchParams.get('source') || 'unknown'} target</p>
          <button onclick="window.close()">Close popup</button>`);
        return;
      }
      if (request.method === 'GET' && target.pathname === '/hold-challenge') {
        const accepted = String(request.headers.cookie || '').includes('hold_verified=accepted');
        if (accepted) {
          response.writeHead(302, { location: '/hold-destination' }).end();
          return;
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(`<!doctype html>
          <title>Verification</title>
          <style>html,body{margin:0}button{position:absolute;left:80px;top:100px;width:200px;height:60px}</style>
          <button id="hold">Press and hold</button><output id="status"></output>
          <script>
            let pressedAt=0;
            const button=document.querySelector('#hold');
            button.addEventListener('pointerdown',()=>{pressedAt=Date.now()});
            button.addEventListener('pointerup',()=>{
              if(pressedAt&&Date.now()-pressedAt>=600){
                document.cookie='hold_verified=accepted; Path=/; Max-Age=3600; SameSite=Lax';
                location.assign('/hold-destination');
              }else{
                document.querySelector('#status').textContent='Hold incomplete';
              }
            });
          </script>`);
        return;
      }
      if (request.method === 'GET' && target.pathname === '/hold-destination') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><title>Accepted</title><h1>Verification accepted</h1>');
        return;
      }
      if (request.method === 'GET' && target.pathname === '/files') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><title>Files</title><label for="upload">Upload file</label><input id="upload" type="file"><a href="/browser-download">Download fixture</a>');
        return;
      }
      if (request.method === 'GET' && target.pathname === '/interactive') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(`<!doctype html>
          <title>Human input fixture</title>
          <style>
            html,body{margin:0;width:100%;min-height:1400px;font:16px sans-serif}
            #text{position:absolute;left:80px;top:80px;width:240px;height:40px}
            #action{position:absolute;left:80px;top:150px;width:160px;height:50px}
            #drag{position:absolute;left:80px;top:230px;width:80px;height:80px;background:#58a}
            #drop{position:absolute;left:300px;top:230px;width:120px;height:80px;background:#8a5}
            #hover{position:absolute;left:80px;top:350px;width:160px;height:50px;background:#ddd}
            #status{position:fixed;left:20px;bottom:20px;background:white;padding:8px}
          </style>
          <input id="text" aria-label="Remote text">
          <button id="action">Remote action</button>
          <div id="drag">Drag</div><div id="drop">Drop</div><div id="hover">Hover</div>
          <output id="status" aria-live="polite"></output>
          <script>
            const state={click:0,double:0,right:0,middle:0,drag:0,hover:0,wheel:0,text:'',nav:0,shortcut:0};
            const status=document.querySelector('#status');
            const render=()=>{status.textContent='click='+state.click+' double='+state.double+' right='+state.right+' middle='+state.middle+' drag='+state.drag+' hover='+state.hover+' wheel='+state.wheel+' text='+state.text+' nav='+state.nav+' shortcut='+state.shortcut};
            const action=document.querySelector('#action');
            action.addEventListener('click',()=>{state.click+=1;render()});
            action.addEventListener('dblclick',()=>{state.double+=1;render()});
            action.addEventListener('contextmenu',(event)=>{event.preventDefault();state.right+=1;render()});
            action.addEventListener('auxclick',(event)=>{if(event.button===1)state.middle+=1;render()});
            document.querySelector('#hover').addEventListener('pointermove',()=>{state.hover=1;render()});
            let dragging=false;
            document.querySelector('#drag').addEventListener('pointerdown',()=>{dragging=true});
            document.addEventListener('pointerup',(event)=>{const bounds=document.querySelector('#drop').getBoundingClientRect();if(dragging&&event.clientX>=bounds.left&&event.clientX<=bounds.right&&event.clientY>=bounds.top&&event.clientY<=bounds.bottom)state.drag=1;dragging=false;render()});
            document.querySelector('#text').addEventListener('input',(event)=>{state.text=event.target.value;render()});
            window.addEventListener('scroll',()=>{state.wheel=window.scrollY>0?1:0;render()});
            window.addEventListener('keydown',(event)=>{if(event.key.startsWith('Arrow'))state.nav=1;if(event.ctrlKey&&event.altKey&&event.key.toLowerCase()==='k')state.shortcut=1;render()});
            render();
          </script>`);
        return;
      }
      if (request.method === 'GET' && target.pathname === '/web-capabilities') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(`<!doctype html>
          <title>Web capabilities</title>
          <h1 id="status">JavaScript disabled</h1>
          <script>
            document.cookie = 'script_cookie=accepted; Path=/; Max-Age=3600; SameSite=Lax';
            document.querySelector('#status').textContent = document.cookie.includes('script_cookie=accepted')
              ? 'JavaScript and cookies enabled'
              : 'Cookies disabled';
          </script>`);
        return;
      }
      if (request.method === 'GET' && target.pathname === '/third-party-top') {
        const address = server.address();
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(`<!doctype html>
          <title>Third-party cookie capability</title>
          <h1 id="status">Third-party cookies disabled</h1>
          <iframe src="http://localhost:${address.port}/third-party-frame"></iframe>
          <script>
            window.addEventListener('message', (event) => {
              if (event.origin === 'http://localhost:${address.port}' && event.data === 'third-party-cookie-enabled') {
                document.querySelector('#status').textContent = 'Third-party cookies enabled';
              }
            });
          </script>`);
        return;
      }
      if (request.method === 'GET' && target.pathname === '/third-party-frame') {
        const accepted = String(request.headers.cookie || '').includes('third_party_session=accepted');
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          ...(accepted ? {} : {
            'set-cookie': 'third_party_session=accepted; Path=/; Max-Age=3600; Secure; SameSite=None',
          }),
        });
        response.end(accepted
          ? `<!doctype html><script>parent.postMessage('third-party-cookie-enabled', '*')</script>`
          : '<!doctype html><meta http-equiv="refresh" content="0;url=/third-party-frame">');
        return;
      }
      if (request.method === 'GET' && target.pathname === '/browser-download') {
        response.writeHead(200, {
          'content-type': 'text/plain',
          'content-disposition': 'attachment; filename="browser-download.txt"',
        });
        response.end('browser download bytes');
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
    const address = server.address();
    return Object.freeze({
      port: address.port,
      gatewayUrl: `http://host.docker.internal:${address.port}`,
      thirdPartyUrl: `http://127.0.0.1:${address.port}/third-party-top`,
      publishedDownload: () => publishedDownload,
      close: () => new Promise((resolve, reject) => server.close((error) => (
        error ? reject(error) : resolve()
      ))),
    });
  };

  // The container has no route to the host, so it reaches the private gateway
  // through the egress service, which relays it. This fixture stands in for both
  // roles on the one in-network address the container knows.
  const startFixtureEgress = async (site) => {
    const server = http.createServer((request, response) => {
      if (request.url.startsWith('/api/bots/private/')) {
        const relayed = http.request({
          hostname: '127.0.0.1',
          port: site.port,
          method: request.method,
          path: request.url,
          headers: { ...request.headers, host: `host.docker.internal:${site.port}` },
        }, (relayedResponse) => {
          response.writeHead(relayedResponse.statusCode || 502, relayedResponse.headers);
          relayedResponse.pipe(response);
        });
        relayed.once('error', () => response.writeHead(502).end());
        request.pipe(relayed);
        return;
      }
      if (request.headers['proxy-authorization'] !== `Bearer ${browserEgressToken}`) {
        response.writeHead(407).end();
        return;
      }
      let target;
      try {
        target = new URL(request.url);
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (target.protocol !== 'http:'
        || !['host.docker.internal', '127.0.0.1', 'localhost'].includes(target.hostname)) {
        response.writeHead(403).end();
        return;
      }
      const headers = { ...request.headers, host: target.host };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      const forwarded = http.request({
        hostname: '127.0.0.1',
        port: target.port,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers,
      }, (forwardedResponse) => {
        response.writeHead(forwardedResponse.statusCode || 502, forwardedResponse.headers);
        forwardedResponse.pipe(response);
      });
      forwarded.once('error', () => response.writeHead(502).end());
      request.pipe(forwarded);
    });
    server.on('connect', (_request, socket) => {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(43_121, '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });
    return Object.freeze({
      close: () => new Promise((resolve, reject) => server.close((error) => (
        error ? reject(error) : resolve()
      ))),
    });
  };

  const requestComputer = async ({ baseUrl, pathname = '/v1/command', body }) => {
    const transferCommand = ['upload', 'download'].includes(body?.command);
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${integrationToken}`,
        'content-type': 'application/json',
        ...(transferCommand ? { 'x-devryan-gateway-token': integrationToken } : {}),
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    return Object.freeze({ response, payload });
  };

  const commandComputer = async (baseUrl, command, args) => (
    requestComputer({ baseUrl, body: { command, args } })
  );

  const openScreencastViewer = (baseUrl) => new Promise((resolve, reject) => {
    const target = new URL('/v1/screencast', baseUrl);
    let settled = false;
    const timer = setTimeout(() => {
      request.destroy();
      reject(new Error('Timed out waiting for the first Docker screencast frame'));
    }, 15_000);
    const request = http.request({
      host: target.hostname,
      port: target.port,
      path: target.pathname,
      headers: { authorization: `Bearer ${integrationToken}` },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => {
        chunks.push(chunk);
        const received = Buffer.concat(chunks);
        if (!received.includes(Buffer.from('Content-Type: image/jpeg'))) return;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          chunk: received,
          close: () => response.destroy(),
        });
      });
    });
    request.once('error', (error) => {
      clearTimeout(timer);
      if (!settled) reject(error);
    });
    request.end();
  });

  const waitForScreencastStop = async (baseUrl) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const response = await fetch(`${baseUrl}/v1/status`, {
        headers: { authorization: `Bearer ${integrationToken}` },
      });
      const payload = await response.json();
      if (payload?.browser?.screencastSubscribers === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Docker screencast did not stop after viewer disconnect');
  };

  const findRef = (snapshot, name) => {
    const node = snapshot.payload.result.nodes.find((candidate) => candidate.name === name);
    if (!node) throw new Error(`Fixture accessibility node was not found: ${name}`);
    return node.ref;
  };

  describe('Docker fixture Chromium integration', () => {
    test('persists login, fences refs, arbitrates control, transfers files, resets, and flushes', async () => {
      const suffix = crypto.randomUUID().replaceAll('-', '');
      const image = `devryan/bot-computer:fixture-${suffix}`;
      const container = `devryan-bot-computer-fixture-${suffix}`;
      const profileVolume = `${container}-profile`;
      const scratchVolume = `${container}-scratch`;
      const fixtureSite = await startFixtureSite();
      let fixtureEgress = null;
      let containerExists = false;
      let imageExists = false;
      let volumesExist = false;

      const stopContainer = async () => {
        if (!containerExists) return null;
        await docker('stop', '--time', '15', container);
        const { stdout } = await docker('inspect', '--format', '{{.State.ExitCode}}', container);
        await docker('rm', container);
        containerExists = false;
        return Number(stdout.trim());
      };

      const startContainer = async (runId) => {
        await docker(
          'run', '--detach', '--name', container,
          '--init', '--read-only', '--user', '10001:10001',
          '--security-opt', 'no-new-privileges:true', '--cap-drop', 'ALL',
          '--pids-limit', '512', '--memory', '3g', '--cpus', '2', '--shm-size', '1g',
          '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m,mode=1777',
          '--tmpfs', '/run:rw,noexec,nosuid,size=16m,mode=755',
          '--add-host', 'host.docker.internal:host-gateway',
          '--add-host', 'egress:host-gateway',
          '--publish', '127.0.0.1::43122',
          '--volume', `${profileVolume}:/data/chromium:rw`,
          '--volume', `${scratchVolume}:/workspace:rw`,
          '--env', `DEVRYAN_BOT_RUNTIME_TOKEN=${integrationToken}`,
          '--env', `DEVRYAN_BOT_RUN_ID=${runId}`,
          '--env', 'DEVRYAN_BOT_SCOPE_MODE=team',
          '--env', 'DEVRYAN_BOT_GATEWAY_URL=http://egress:43121',
          '--env', 'DEVRYAN_BROWSER_EGRESS_URL=http://egress:43121/',
          '--env', `DEVRYAN_BROWSER_EGRESS_TOKEN=${browserEgressToken}`,
          image,
        );
        containerExists = true;
        const { stdout } = await docker('port', container, '43122/tcp');
        const port = Number(/:(\d+)\s*$/.exec(stdout)?.[1]);
        if (!Number.isInteger(port)) throw new Error('Fixture computer port was not published');
        const baseUrl = `http://127.0.0.1:${port}`;
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          try {
            if ((await fetch(`${baseUrl}/healthz`)).ok) return baseUrl;
          } catch {
            // Chromium is lazy, but the Node command service still needs a moment to bind.
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error('Fixture computer service did not become healthy');
      };

      const chromiumProcessCount = async () => {
        const script = [
          "const fs=require('node:fs')",
          "let count=0",
          "for(const name of fs.readdirSync('/proc')){",
          "if(!/^\\d+$/.test(name))continue",
          "try{const executable=fs.readlinkSync('/proc/'+name+'/exe')",
          "const value=fs.readFileSync('/proc/'+name+'/cmdline','utf8')",
          "if(executable.endsWith('/chromium')&&!value.includes('--type='))count+=1}catch{}",
          "}",
          "process.stdout.write(String(count))",
        ].join(';');
        const { stdout } = await docker('exec', container, 'node', '-e', script);
        return Number(stdout.trim());
      };

      const xvfbProcessCount = async () => {
        const script = [
          "const fs=require('node:fs')",
          'let count=0',
          "for(const name of fs.readdirSync('/proc')){",
          "if(!/^\\d+$/.test(name))continue",
          "try{const executable=fs.readlinkSync('/proc/'+name+'/exe')",
          "if(executable.endsWith('/Xvfb'))count+=1}catch{}",
          '}',
          'process.stdout.write(String(count))',
        ].join(';');
        const { stdout } = await docker('exec', container, 'node', '-e', script);
        return Number(stdout.trim());
      };

      const killXvfb = async () => {
        const script = [
          "const fs=require('node:fs')",
          'const targets=[]',
          "for(const name of fs.readdirSync('/proc')){",
          "if(!/^\\d+$/.test(name))continue",
          "try{const executable=fs.readlinkSync('/proc/'+name+'/exe')",
          "if(executable.endsWith('/Xvfb'))targets.push(Number(name))}catch{}",
          '}',
          "for(const pid of targets){try{process.kill(pid,'SIGKILL')}catch{}}",
          'if(targets.length<1)process.exit(2)',
        ].join(';');
        await docker('exec', container, 'node', '-e', script);
      };

      const killChromium = async () => {
        const script = [
          "const fs=require('node:fs')",
          "const targets=[]",
          "for(const name of fs.readdirSync('/proc')){",
          "if(!/^\\d+$/.test(name))continue",
          "try{const executable=fs.readlinkSync('/proc/'+name+'/exe')",
          "if(executable.endsWith('/chromium'))targets.push(Number(name))}catch{}",
          "}",
          "for(const pid of targets){try{process.kill(pid,'SIGKILL')}catch{}}",
          "if(targets.length<1)process.exit(2)",
        ].join(';');
        await docker('exec', container, 'node', '-e', script);
      };

      const computerStatus = async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/status`, {
          headers: { authorization: `Bearer ${integrationToken}` },
        });
        return response.json();
      };

      try {
        fixtureEgress = await startFixtureEgress(fixtureSite);
        await docker(
          'build', '--quiet', '--file', 'packages/bot-computer/Dockerfile',
          '--tag', image, '.',
        );
        imageExists = true;
        await docker('volume', 'create', profileVolume);
        await docker('volume', 'create', scratchVolume);
        volumesExist = true;

        let baseUrl = await startContainer('run-fixture-01');
        await commandComputer(baseUrl, 'navigate', { url: `${fixtureSite.gatewayUrl}/web-capabilities` });
        const webCapabilities = await commandComputer(baseUrl, 'snapshot', {});
        expect(webCapabilities.payload.result.nodes.some(
          (node) => node.name === 'JavaScript and cookies enabled',
        )).toBe(true);
        await commandComputer(baseUrl, 'navigate', { url: fixtureSite.thirdPartyUrl });
        await commandComputer(baseUrl, 'wait', { milliseconds: 500 });
        const thirdPartyCookies = await commandComputer(baseUrl, 'snapshot', {});
        expect(thirdPartyCookies.payload.result.nodes.some(
          (node) => node.name === 'Third-party cookies enabled',
        )).toBe(true);
        await commandComputer(baseUrl, 'navigate', { url: `${fixtureSite.gatewayUrl}/login` });
        const login = await commandComputer(baseUrl, 'snapshot', {});
        await commandComputer(baseUrl, 'fill', { ref: findRef(login, 'Username'), text: 'agent' });
        await commandComputer(baseUrl, 'click', { ref: findRef(login, 'Sign in') });
        await commandComputer(baseUrl, 'wait', { milliseconds: 500 });
        await commandComputer(baseUrl, 'navigate', { url: `${fixtureSite.gatewayUrl}/private` });
        const signedIn = await commandComputer(baseUrl, 'snapshot', {});
        expect(signedIn.payload.result.nodes.some((node) => node.name === 'Signed in')).toBe(true);
        expect(signedIn.payload.result.nodes.some((node) => node.name === 'Session cookie kept'))
          .toBe(true);
        // The agent can no longer close the persistent browser; the login survives.
        const closeDenied = await commandComputer(baseUrl, 'close', {});
        expect(closeDenied.response.status).toBe(400);
        expect(closeDenied.payload.error.code).toBe('DEVRYAN_BOT_BROWSER_COMMAND_DENIED');
        await commandComputer(baseUrl, 'navigate', { url: `${fixtureSite.gatewayUrl}/private` });
        const persistedBeforeCrash = await commandComputer(baseUrl, 'snapshot', {});
        expect(persistedBeforeCrash.payload.result.nodes.some((node) => node.name === 'Signed in'))
          .toBe(true);
        const beforeCrash = await computerStatus(baseUrl);
        expect(beforeCrash.browser).toMatchObject({
          running: true,
          healthy: true,
          generation: 1,
          mode: 'headed_virtual',
          displayReady: true,
          webCapabilities: {
            managedPolicy: 'enforced',
            javascript: 'enabled',
            firstPartyCookies: 'enabled',
            thirdPartyCookies: 'enabled',
          },
        });
        expect(await chromiumProcessCount()).toBe(1);
        expect(await xvfbProcessCount()).toBe(1);

        // Chromium commits its cookie database on a 30 s timer and nothing but a
        // graceful shutdown flushes it sooner. The agent can no longer close the
        // browser to force that flush, so a crash inside the window would lose the
        // login on disk; let the periodic commit run before simulating the crash.
        await new Promise((resolve) => setTimeout(resolve, 31_000));
        await killChromium();
        expect((await commandComputer(
          baseUrl,
          'navigate',
          { url: `${fixtureSite.gatewayUrl}/private` },
        )).response.status).toBe(200);
        const recovered = await commandComputer(baseUrl, 'snapshot', {});
        expect(recovered.payload.result.nodes.some((node) => node.name === 'Signed in')).toBe(true);
        // The browser-session cookie (no Max-Age) survived the Chromium relaunch.
        expect(recovered.payload.result.nodes.some((node) => node.name === 'Session cookie kept'))
          .toBe(true);
        expect((await computerStatus(baseUrl)).browser).toMatchObject({
          running: true,
          healthy: true,
          generation: 2,
          lastFailureCode: null,
          activeTargetCount: 1,
        });
        expect(await chromiumProcessCount()).toBe(1);

        await killChromium();
        const concurrentRecovery = await Promise.all(Array.from({ length: 4 }, () => (
          commandComputer(baseUrl, 'screenshot', { format: 'jpeg', quality: 60 })
        )));
        expect(concurrentRecovery.every(({ response }) => response.status === 200)).toBe(true);
        expect((await computerStatus(baseUrl)).browser).toMatchObject({
          running: true,
          healthy: true,
          generation: 3,
        });
        expect(await chromiumProcessCount()).toBe(1);
        await commandComputer(baseUrl, 'navigate', { url: `${fixtureSite.gatewayUrl}/private` });
        const persistedAfterRepeatedRecovery = await commandComputer(baseUrl, 'snapshot', {});
        expect(persistedAfterRepeatedRecovery.payload.result.nodes
          .some((node) => node.name === 'Signed in')).toBe(true);
        expect(persistedAfterRepeatedRecovery.payload.result.nodes
          .some((node) => node.name === 'Session cookie kept')).toBe(true);

        const firstViewer = await openScreencastViewer(baseUrl);
        expect(firstViewer.statusCode).toBe(200);
        expect(firstViewer.headers['content-type']).toContain('multipart/x-mixed-replace');
        expect(firstViewer.chunk.includes(Buffer.from('Content-Type: image/jpeg'))).toBe(true);
        const lateViewer = await openScreencastViewer(baseUrl);
        expect(lateViewer.statusCode).toBe(200);
        expect(lateViewer.chunk.includes(Buffer.from('Content-Type: image/jpeg'))).toBe(true);
        lateViewer.close();
        firstViewer.close();
        await waitForScreencastStop(baseUrl);

        const staleRef = findRef(signedIn, 'Signed in');
        await commandComputer(baseUrl, 'navigate', { url: `${fixtureSite.gatewayUrl}/next` });
        const stale = await commandComputer(baseUrl, 'click', { ref: staleRef });
        expect(stale.response.status).toBe(409);
        expect(stale.payload.error.code).toBe('DEVRYAN_BOT_REF_STALE');

        await commandComputer(baseUrl, 'navigate', { url: `${fixtureSite.gatewayUrl}/popup-parent` });
        let popupParent = await commandComputer(baseUrl, 'snapshot', {});
        await commandComputer(baseUrl, 'click', { ref: findRef(popupParent, 'Open scripted popup') });
        await commandComputer(baseUrl, 'wait', { milliseconds: 500 });
        expect((await computerStatus(baseUrl)).browser).toMatchObject({
          activeTargetCount: 2,
          popupOpen: true,
        });
        let popupChild = await commandComputer(baseUrl, 'snapshot', {});
        expect(popupChild.payload.result.nodes.some((node) => node.name === 'Popup child')).toBe(true);
        expect(popupChild.payload.result.nodes.some((node) => node.name === 'scripted target')).toBe(true);
        await commandComputer(baseUrl, 'click', { ref: findRef(popupChild, 'Close popup') });
        await commandComputer(baseUrl, 'wait', { milliseconds: 500 });
        expect((await computerStatus(baseUrl)).browser).toMatchObject({
          activeTargetCount: 1,
          popupOpen: false,
        });
        popupParent = await commandComputer(baseUrl, 'snapshot', {});
        expect(popupParent.payload.result.nodes.some((node) => node.name === 'Popup parent')).toBe(true);
        await commandComputer(baseUrl, 'click', { ref: findRef(popupParent, 'Open linked popup') });
        await commandComputer(baseUrl, 'wait', { milliseconds: 500 });
        popupChild = await commandComputer(baseUrl, 'snapshot', {});
        expect(popupChild.payload.result.nodes.some((node) => node.name === 'linked target')).toBe(true);
        await commandComputer(baseUrl, 'click', { ref: findRef(popupChild, 'Close popup') });
        await commandComputer(baseUrl, 'wait', { milliseconds: 500 });

        await commandComputer(baseUrl, 'navigate', { url: `${fixtureSite.gatewayUrl}/interactive` });

        const firstLease = await requestComputer({
          baseUrl,
          pathname: '/v1/control/take',
          body: { actorId: 'user-01', actorType: 'user' },
        });
        const concurrentLease = await requestComputer({
          baseUrl,
          pathname: '/v1/control/take',
          body: { actorId: 'user-02', actorType: 'user' },
        });
        expect(concurrentLease.response.status).toBe(409);
        for (let heartbeat = 0; heartbeat < 2; heartbeat += 1) {
          const renewed = await requestComputer({
            baseUrl,
            pathname: '/v1/control/heartbeat',
            body: {
              actorId: 'user-01',
              actorType: 'user',
              leaseId: firstLease.payload.lease.leaseId,
            },
          });
          expect(renewed.response.status).toBe(200);
          const fenced = await commandComputer(baseUrl, 'snapshot', {});
          expect(fenced.response.status).toBe(409);
          expect(fenced.payload.error.code).toBe('DEVRYAN_BOT_CONTROL_HELD');
        }
        const humanEvents = [
          { type: 'pointer', phase: 'move', x: 160, y: 375, button: 'none', buttons: 0, clickCount: 0 },
          { type: 'pointer', phase: 'down', x: 160, y: 175, button: 'left', buttons: 1, clickCount: 1 },
          { type: 'pointer', phase: 'up', x: 160, y: 175, button: 'left', buttons: 0, clickCount: 1 },
          { type: 'pointer', phase: 'down', x: 160, y: 175, button: 'left', buttons: 1, clickCount: 2 },
          { type: 'pointer', phase: 'up', x: 160, y: 175, button: 'left', buttons: 0, clickCount: 2 },
          { type: 'pointer', phase: 'down', x: 160, y: 175, button: 'right', buttons: 2, clickCount: 1 },
          { type: 'pointer', phase: 'up', x: 160, y: 175, button: 'right', buttons: 0, clickCount: 1 },
          { type: 'pointer', phase: 'down', x: 160, y: 175, button: 'middle', buttons: 4, clickCount: 1 },
          { type: 'pointer', phase: 'up', x: 160, y: 175, button: 'middle', buttons: 0, clickCount: 1 },
          { type: 'pointer', phase: 'move', x: 120, y: 270, button: 'none', buttons: 0, clickCount: 0 },
          { type: 'pointer', phase: 'down', x: 120, y: 270, button: 'left', buttons: 1, clickCount: 1 },
          { type: 'pointer', phase: 'move', x: 350, y: 270, button: 'none', buttons: 1, clickCount: 0 },
          { type: 'pointer', phase: 'up', x: 350, y: 270, button: 'left', buttons: 0, clickCount: 1 },
          { type: 'pointer', phase: 'down', x: 160, y: 100, button: 'left', buttons: 1, clickCount: 1 },
          { type: 'pointer', phase: 'up', x: 160, y: 100, button: 'left', buttons: 0, clickCount: 1 },
          { type: 'key', phase: 'down', key: 'h', code: 'KeyH', modifiers: [], location: 0, repeat: false },
          { type: 'key', phase: 'up', key: 'h', code: 'KeyH', modifiers: [], location: 0, repeat: false },
          { type: 'key', phase: 'down', key: 'i', code: 'KeyI', modifiers: [], location: 0, repeat: false },
          { type: 'key', phase: 'up', key: 'i', code: 'KeyI', modifiers: [], location: 0, repeat: false },
          { type: 'text', text: ' pasted' },
          { type: 'key', phase: 'down', key: 'ArrowLeft', code: 'ArrowLeft', modifiers: [], location: 0, repeat: false },
          { type: 'key', phase: 'up', key: 'ArrowLeft', code: 'ArrowLeft', modifiers: [], location: 0, repeat: false },
          { type: 'key', phase: 'down', key: 'k', code: 'KeyK', modifiers: ['Alt', 'Control'], location: 0, repeat: false },
          { type: 'key', phase: 'up', key: 'k', code: 'KeyK', modifiers: ['Alt', 'Control'], location: 0, repeat: false },
          { type: 'wheel', x: 600, y: 500, deltaX: 0, deltaY: 300 },
        ];
        const humanInput = await requestComputer({
          baseUrl,
          pathname: '/v1/control/command',
          body: {
            actorId: 'user-01',
            actorType: 'user',
            leaseId: firstLease.payload.lease.leaseId,
            command: 'input',
            args: { events: humanEvents },
          },
        });
        expect(humanInput.response.status).toBe(200);
        expect(humanInput.payload.result).toEqual({ dispatched: humanEvents.length });
        await new Promise((resolve) => setTimeout(resolve, 100));
        await requestComputer({
          baseUrl,
          pathname: '/v1/control/return',
          body: {
            actorId: 'user-01',
            actorType: 'user',
            leaseId: firstLease.payload.lease.leaseId,
          },
        });
        const afterHumanInput = await commandComputer(baseUrl, 'snapshot', {});
        expect(afterHumanInput.response.status).toBe(200);
        const inputStatus = afterHumanInput.payload.result.nodes
          .map((node) => node.name)
          .find((name) => typeof name === 'string' && name.includes('click='));
        expect(inputStatus).toContain('click=2');
        expect(inputStatus).toContain('double=1');
        expect(inputStatus).toContain('right=1');
        expect(inputStatus).toContain('middle=1');
        expect(inputStatus).toContain('drag=1');
        expect(inputStatus).toContain('hover=1');
        expect(inputStatus).toContain('wheel=1');
        expect(inputStatus).toContain('text=hi pasted');
        expect(inputStatus).toContain('nav=1');
        expect(inputStatus).toContain('shortcut=1');

        await commandComputer(baseUrl, 'navigate', { url: `${fixtureSite.gatewayUrl}/hold-challenge` });
        const challenge = await commandComputer(baseUrl, 'snapshot', {});
        expect(challenge.payload.result.nodes.some((node) => node.name === 'Press and hold')).toBe(true);
        const holdLease = await requestComputer({
          baseUrl,
          pathname: '/v1/control/take',
          body: { actorId: 'user-01', actorType: 'user' },
        });
        const holdInput = (phase, buttons) => requestComputer({
          baseUrl,
          pathname: '/v1/control/command',
          body: {
            actorId: 'user-01',
            actorType: 'user',
            leaseId: holdLease.payload.lease.leaseId,
            command: 'input',
            args: {
              events: [{
                type: 'pointer', phase, x: 180, y: 130,
                button: 'left', buttons, clickCount: 1,
              }],
            },
          },
        });
        expect((await holdInput('down', 1)).response.status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 700));
        expect((await holdInput('up', 0)).response.status).toBe(200);
        await requestComputer({
          baseUrl,
          pathname: '/v1/control/return',
          body: {
            actorId: 'user-01',
            actorType: 'user',
            leaseId: holdLease.payload.lease.leaseId,
          },
        });
        await commandComputer(baseUrl, 'wait', { milliseconds: 500 });
        const acceptedChallenge = await commandComputer(baseUrl, 'snapshot', {});
        expect(acceptedChallenge.payload.result.nodes
          .some((node) => node.name === 'Verification accepted')).toBe(true);
        await commandComputer(baseUrl, 'navigate', { url: `${fixtureSite.gatewayUrl}/hold-challenge` });
        const acceptedReload = await commandComputer(baseUrl, 'snapshot', {});
        expect(acceptedReload.payload.result.nodes
          .some((node) => node.name === 'Verification accepted')).toBe(true);

        await commandComputer(baseUrl, 'navigate', { url: `${fixtureSite.gatewayUrl}/files` });
        const files = await commandComputer(baseUrl, 'snapshot', {});
        await commandComputer(baseUrl, 'upload', {
          ref: findRef(files, 'Upload file'),
          artifactId: 'artifact-upload',
          filename: 'private-upload.txt',
        });
        await commandComputer(baseUrl, 'click', { ref: findRef(files, 'Download fixture') });
        await commandComputer(baseUrl, 'wait', { milliseconds: 1_000 });
        const downloaded = await commandComputer(baseUrl, 'download', {
          filename: 'browser-download.txt',
        });
        expect(downloaded.response.status).toBe(200);
        expect(downloaded.payload.ok).toBe(true);
        expect(downloaded.payload.result.artifactId).toBe('artifact-download');
        expect(fixtureSite.publishedDownload()?.toString('utf8')).toBe('browser download bytes');

        expect(await stopContainer()).toBe(0);
        baseUrl = await startContainer('run-fixture-02');
        await commandComputer(baseUrl, 'navigate', { url: `${fixtureSite.gatewayUrl}/private` });
        const persisted = await commandComputer(baseUrl, 'snapshot', {});
        expect(persisted.payload.result.nodes.some((node) => node.name === 'Signed in')).toBe(true);
        // Graceful shutdown flushed the profile, so even the browser-session cookie
        // survived a full container stop/start.
        expect(persisted.payload.result.nodes.some((node) => node.name === 'Session cookie kept'))
          .toBe(true);
        expect((await computerStatus(baseUrl)).browser).toMatchObject({ activeTargetCount: 1 });
        await commandComputer(baseUrl, 'navigate', { url: `${fixtureSite.gatewayUrl}/hold-challenge` });
        const persistedChallenge = await commandComputer(baseUrl, 'snapshot', {});
        expect(persistedChallenge.payload.result.nodes
          .some((node) => node.name === 'Verification accepted')).toBe(true);
        expect((await commandComputer(baseUrl, 'download', {
          filename: 'browser-download.txt',
        })).response.status).toBe(200);

        const reset = await requestComputer({
          baseUrl,
          pathname: '/v1/profile/reset',
          body: { confirm: true },
        });
        expect(reset.response.status).toBe(200);
        await commandComputer(baseUrl, 'navigate', { url: `${fixtureSite.gatewayUrl}/private` });
        const loggedOut = await commandComputer(baseUrl, 'snapshot', {});
        expect(loggedOut.payload.result.nodes.some((node) => node.name === 'Username')).toBe(true);
        await killXvfb();
        const displayDeadline = Date.now() + 5_000;
        while (Date.now() < displayDeadline && (await fetch(`${baseUrl}/healthz`)).status !== 503) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect((await fetch(`${baseUrl}/healthz`)).status).toBe(503);
        expect(await stopContainer()).toBe(0);
      } finally {
        if (containerExists) await docker('rm', '--force', container).catch(() => undefined);
        if (volumesExist) {
          await docker('volume', 'rm', '--force', profileVolume, scratchVolume).catch(() => undefined);
        }
        if (imageExists) await docker('image', 'rm', '--force', image).catch(() => undefined);
        await fixtureEgress?.close().catch(() => undefined);
        await fixtureSite.close();
      }
    }, 420_000);
  });
}
