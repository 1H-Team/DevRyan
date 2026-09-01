import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const REVIEWED_BROWSER_COMMANDS = Object.freeze([
  'navigate',
  'snapshot',
  'click',
  'fill',
  'select',
  'key',
  'scroll',
  'wait',
  'upload',
  'download',
  'screenshot',
  'close',
]);

const COMMANDS = new Set(REVIEWED_BROWSER_COMMANDS);
const KEY_NAMES = new Set([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Space',
]);
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const MAX_CDP_MESSAGE_BYTES = 8 * 1024 * 1024;
const HUMAN_VIEWPORT_WIDTH = 1280;
const HUMAN_VIEWPORT_HEIGHT = 720;
const HUMAN_DEVICE_SCALE_FACTOR = 1;
const MAX_HUMAN_INPUT_EVENTS = 32;
const HUMAN_POINTER_PHASES = new Set(['move', 'down', 'up']);
const HUMAN_POINTER_BUTTONS = new Set(['none', 'left', 'middle', 'right']);
const HUMAN_KEY_PHASES = new Set(['down', 'up']);
const HUMAN_KEY_MODIFIERS = new Set(['Alt', 'Control', 'Meta', 'Shift']);
const CDP_COMMAND_TIMEOUT_MS = 30_000;
const CDP_CONNECT_TIMEOUT_MS = 10_000;
const RECOVERABLE_BROWSER_CODES = new Set([
  'DEVRYAN_BOT_BROWSER_CLOSED',
  'DEVRYAN_BOT_BROWSER_COMMAND_TIMEOUT',
  'DEVRYAN_BOT_BROWSER_START_FAILED',
]);
const RETRYABLE_BROWSER_COMMANDS = new Set([
  'navigate',
  'snapshot',
  'scroll',
  'screenshot',
]);
const CHROMIUM_STARTUP_ARTIFACTS = Object.freeze([
  'DevToolsActivePort',
  'SingletonCookie',
  'SingletonLock',
  'SingletonSocket',
]);

export const chromiumLaunchArguments = ({ profileDirectory, proxyUrl } = {}) => Object.freeze([
  '--no-sandbox',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-quic',
  '--disable-sync',
  `--window-size=${HUMAN_VIEWPORT_WIDTH},${HUMAN_VIEWPORT_HEIGHT}`,
  `--force-device-scale-factor=${HUMAN_DEVICE_SCALE_FACTOR}`,
  `--proxy-server=${proxyUrl}`,
  '--proxy-bypass-list=<-loopback>',
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=0',
  `--user-data-dir=${profileDirectory}`,
  'about:blank',
]);

export class ComputerBrowserError extends Error {
  constructor(message, code, statusCode = 400, options = {}) {
    super(message, options);
    this.name = 'ComputerBrowserError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode, options) => {
  throw new ComputerBrowserError(message, code, statusCode, options);
};

export async function clearStaleChromiumStartupArtifacts({
  profileDirectory,
  fsPromises = fs,
} = {}) {
  if (typeof profileDirectory !== 'string' || !path.isAbsolute(profileDirectory)
    || typeof fsPromises?.unlink !== 'function') {
    fail('Chromium launch configuration is invalid', 'DEVRYAN_BOT_BROWSER_CONFIG_INVALID', 500);
  }
  await Promise.all(CHROMIUM_STARTUP_ARTIFACTS.map(async (filename) => {
    try {
      await fsPromises.unlink(path.join(profileDirectory, filename));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }));
}

const exactKeys = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    fail('Browser command arguments are invalid', 'DEVRYAN_BOT_BROWSER_INPUT_INVALID');
  }
};

const boundedText = (value, field, max) => {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) {
    fail(`${field} is invalid`, 'DEVRYAN_BOT_BROWSER_INPUT_INVALID');
  }
  return value;
};

const boundedCoordinate = (value, field, maximum) => {
  if (!Number.isFinite(value) || value < 0 || value > maximum) {
    fail(`${field} is invalid`, 'DEVRYAN_BOT_BROWSER_INPUT_INVALID');
  }
  return value;
};

export const validateHumanInputArgs = (args) => {
  exactKeys(args, ['events']);
  if (!Array.isArray(args.events) || args.events.length < 1
    || args.events.length > MAX_HUMAN_INPUT_EVENTS
    || Buffer.byteLength(JSON.stringify(args), 'utf8') > 64 * 1024) {
    fail('Human input batch is invalid', 'DEVRYAN_BOT_BROWSER_INPUT_INVALID');
  }
  return Object.freeze(args.events.map((event) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      fail('Human input event is invalid', 'DEVRYAN_BOT_BROWSER_INPUT_INVALID');
    }
    if (event.type === 'pointer') {
      exactKeys(event, ['type', 'phase', 'x', 'y', 'button', 'buttons', 'clickCount']);
      if (!HUMAN_POINTER_PHASES.has(event.phase) || !HUMAN_POINTER_BUTTONS.has(event.button)
        || !Number.isInteger(event.buttons) || event.buttons < 0 || event.buttons > 31
        || !Number.isInteger(event.clickCount) || event.clickCount < 0 || event.clickCount > 3
        || (event.phase !== 'move' && event.button === 'none')) {
        fail('Human pointer event is invalid', 'DEVRYAN_BOT_BROWSER_INPUT_INVALID');
      }
      return Object.freeze({
        ...event,
        x: boundedCoordinate(event.x, 'Pointer x', HUMAN_VIEWPORT_WIDTH),
        y: boundedCoordinate(event.y, 'Pointer y', HUMAN_VIEWPORT_HEIGHT),
      });
    }
    if (event.type === 'wheel') {
      exactKeys(event, ['type', 'x', 'y', 'deltaX', 'deltaY']);
      if (![event.deltaX, event.deltaY].every((value) => (
        Number.isFinite(value) && Math.abs(value) <= 100_000
      ))) {
        fail('Human wheel event is invalid', 'DEVRYAN_BOT_BROWSER_INPUT_INVALID');
      }
      return Object.freeze({
        ...event,
        x: boundedCoordinate(event.x, 'Wheel x', HUMAN_VIEWPORT_WIDTH),
        y: boundedCoordinate(event.y, 'Wheel y', HUMAN_VIEWPORT_HEIGHT),
      });
    }
    if (event.type === 'key') {
      exactKeys(event, ['type', 'phase', 'key', 'code', 'modifiers', 'location', 'repeat']);
      if (!HUMAN_KEY_PHASES.has(event.phase) || !Array.isArray(event.modifiers)
        || event.modifiers.length > HUMAN_KEY_MODIFIERS.size
        || new Set(event.modifiers).size !== event.modifiers.length
        || event.modifiers.some((modifier) => !HUMAN_KEY_MODIFIERS.has(modifier))
        || !Number.isInteger(event.location) || event.location < 0 || event.location > 3
        || typeof event.repeat !== 'boolean') {
        fail('Human key event is invalid', 'DEVRYAN_BOT_BROWSER_INPUT_INVALID');
      }
      return Object.freeze({
        ...event,
        key: boundedText(event.key, 'Key', 128),
        code: boundedText(event.code, 'Key code', 128),
        modifiers: Object.freeze([...event.modifiers]),
      });
    }
    if (event.type === 'text') {
      exactKeys(event, ['type', 'text']);
      const text = boundedText(event.text, 'Input text', 32 * 1024);
      if (!text) fail('Input text is invalid', 'DEVRYAN_BOT_BROWSER_INPUT_INVALID');
      return Object.freeze({ type: 'text', text });
    }
    fail('Human input event type is invalid', 'DEVRYAN_BOT_BROWSER_INPUT_INVALID');
  }));
};

const cdpModifiers = (modifiers) => modifiers.reduce((mask, modifier) => (
  mask | ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 }[modifier] || 0)
), 0);

// Blink maps non-printable keys to editing commands via the Windows virtual key
// code; without it Enter/Backspace/arrows dispatch but edit nothing.
const VIRTUAL_KEY_CODES = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Pause: 19, CapsLock: 20,
  Escape: 27, ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46,
  Meta: 91, ContextMenu: 93,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
  F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
};

const virtualKeyCode = (key, code) => {
  if (VIRTUAL_KEY_CODES[key] !== undefined) return VIRTUAL_KEY_CODES[key];
  if (/^[0-9]$/u.test(key)) return key.charCodeAt(0);
  if (/^[a-zA-Z]$/u.test(key)) return key.toUpperCase().charCodeAt(0);
  if (/^Numpad[0-9]$/u.test(code)) return 96 + Number(code.slice(6));
  return null;
};

export const dispatchHumanInputEvents = async ({ events, send } = {}) => {
  if (!Array.isArray(events) || typeof send !== 'function') {
    fail('Human input dispatcher is invalid', 'DEVRYAN_BOT_BROWSER_CONFIG_INVALID', 500);
  }
  for (const event of events) {
    if (event.type === 'pointer') {
      await send('Input.dispatchMouseEvent', {
        type: event.phase === 'move'
          ? 'mouseMoved'
          : event.phase === 'down' ? 'mousePressed' : 'mouseReleased',
        x: event.x,
        y: event.y,
        button: event.button,
        buttons: event.buttons,
        clickCount: event.clickCount,
        pointerType: 'mouse',
      });
    } else if (event.type === 'wheel') {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: event.x,
        y: event.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        pointerType: 'mouse',
      });
    } else if (event.type === 'key') {
      const printableText = event.phase === 'down'
        && !event.modifiers.some((modifier) => ['Alt', 'Control', 'Meta'].includes(modifier))
        ? (event.key.length === 1 ? event.key : event.key === 'Enter' ? '\r' : '')
        : '';
      const keyCode = virtualKeyCode(event.key, event.code);
      await send('Input.dispatchKeyEvent', {
        type: event.phase === 'down' ? 'keyDown' : 'keyUp',
        key: event.key,
        code: event.code,
        modifiers: cdpModifiers(event.modifiers),
        location: event.location,
        autoRepeat: event.repeat,
        ...(printableText ? { text: printableText, unmodifiedText: printableText } : {}),
        ...(keyCode === null ? {} : { windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }),
      });
    } else {
      await send('Input.insertText', { text: event.text });
    }
  }
  return Object.freeze({ dispatched: events.length });
};

// Held input is ephemeral and belongs to this exact CDP driver. Never expose
// these maps through status, logging, diagnostics, or persisted history.
export const createHumanInputDispatcher = ({ send, releaseTimeoutMs = 2_000 } = {}) => {
  if (typeof send !== 'function' || !Number.isInteger(releaseTimeoutMs) || releaseTimeoutMs < 1) {
    fail('Human input dispatcher is invalid', 'DEVRYAN_BOT_BROWSER_CONFIG_INVALID', 500);
  }
  let generation = 0;
  let queue = Promise.resolve();
  let queuedBatches = 0;
  const heldKeys = new Map();
  const heldButtons = new Map();
  const dispatch = (events, { assertAuthorized = () => undefined } = {}) => {
    if (queuedBatches >= 8) fail('Human input backlog is full', 'DEVRYAN_BOT_BROWSER_INPUT_INVALID', 429);
    queuedBatches += 1;
    const expectedGeneration = generation;
    const operation = queue.then(() => dispatchHumanInputEvents({ events, send: async (method, params) => {
      if (generation !== expectedGeneration) {
        fail('Human input was revoked', 'DEVRYAN_BOT_CONTROL_NOT_OWNER', 409);
      }
      assertAuthorized();
      if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown') {
        if (heldKeys.size >= 256 && !heldKeys.has(params.code)) {
          fail('Too many held keys', 'DEVRYAN_BOT_BROWSER_INPUT_INVALID');
        }
        heldKeys.set(params.code, params);
      }
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') heldButtons.set(params.button, params);
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') {
        for (const [button, held] of heldButtons) heldButtons.set(button, { ...held, x: params.x, y: params.y });
      }
      await send(method, params);
      if (generation !== expectedGeneration) return;
      if (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp') heldKeys.delete(params.code);
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') heldButtons.delete(params.button);
    } }));
    queue = operation.catch(() => undefined).finally(() => {
      if (generation === expectedGeneration) queuedBatches -= 1;
    });
    return operation;
  };
  const release = async () => {
    // Do not await an old HTTP/CDP acknowledgment. The same ordered CDP socket
    // receives releases after its already-issued downs, and the generation
    // fence prevents any later event from that batch from being dispatched.
    generation += 1;
    queue = Promise.resolve();
    queuedBatches = 0;
    const releases = [
      ...[...heldKeys].map(async ([key, held]) => {
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: held.key, code: held.code, location: held.location, modifiers: 0 });
        if (heldKeys.get(key) === held) heldKeys.delete(key);
      }),
      ...[...heldButtons].map(async ([button, held]) => {
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: held.x, y: held.y, button, buttons: 0, clickCount: 1, pointerType: 'mouse' });
        if (heldButtons.get(button) === held) heldButtons.delete(button);
      }),
    ];
    let timer;
    try {
      await Promise.race([Promise.all(releases), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ComputerBrowserError(
          'Held computer input release timed out', 'DEVRYAN_BOT_CONTROL_RELEASE_FAILED', 503,
        )), releaseTimeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  };
  return Object.freeze({ dispatch, release });
};

const safeUrl = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('Navigation URL is invalid', 'DEVRYAN_BOT_BROWSER_INPUT_INVALID');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    fail('Navigation URL is invalid', 'DEVRYAN_BOT_BROWSER_INPUT_INVALID');
  }
  return url.toString();
};

const cdpValue = (value) => {
  const candidate = value?.value;
  if (typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean') {
    return String(candidate);
  }
  return '';
};

const propertyBoolean = (node, name) => node.properties?.find((property) => property.name === name)?.value?.value === true;

export function createCdpConnection(webSocketUrl, { WebSocketImpl = globalThis.WebSocket } = {}) {
  if (typeof webSocketUrl !== 'string' || !/^ws:\/\/127\.0\.0\.1:\d+\//.test(webSocketUrl)
    || typeof WebSocketImpl !== 'function') {
    fail('Chromium debugging endpoint is invalid', 'DEVRYAN_BOT_BROWSER_START_FAILED', 500);
  }
  const socket = new WebSocketImpl(webSocketUrl);
  let nextId = 1;
  let opened = false;
  let closed = false;
  const pending = new Map();
  const listeners = new Map();
  const closeListeners = new Set();

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new ComputerBrowserError(
        'Chromium debugging connection timed out',
        'DEVRYAN_BOT_BROWSER_START_FAILED',
        500,
      ));
    }, CDP_CONNECT_TIMEOUT_MS);
    socket.addEventListener('open', () => {
      opened = true;
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new ComputerBrowserError(
        'Chromium debugging connection failed',
        'DEVRYAN_BOT_BROWSER_START_FAILED',
        500,
      ));
    }, { once: true });
  });

  const rejectPending = () => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new ComputerBrowserError(
        'Chromium debugging connection closed',
        'DEVRYAN_BOT_BROWSER_CLOSED',
        503,
      ));
    }
    pending.clear();
    for (const callback of closeListeners) callback();
    closeListeners.clear();
  };
  socket.addEventListener('close', rejectPending);
  socket.addEventListener('message', (event) => {
    const raw = typeof event.data === 'string' ? event.data : '';
    if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_CDP_MESSAGE_BYTES) return;
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (Number.isInteger(message.id)) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new ComputerBrowserError(
          'Chromium rejected a reviewed browser command',
          'DEVRYAN_BOT_BROWSER_COMMAND_FAILED',
          502,
        ));
      } else {
        entry.resolve(message.result || {});
      }
      return;
    }
    const callbacks = listeners.get(message.method);
    if (!callbacks) return;
    for (const callback of callbacks) callback(message.params || {}, message.sessionId);
  });

  const send = async (method, params = {}, sessionId) => {
    await ready;
    if (!opened || closed) fail('Chromium connection is closed', 'DEVRYAN_BOT_BROWSER_CLOSED', 503);
    const id = nextId++;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new ComputerBrowserError(
          'Chromium command timed out',
          'DEVRYAN_BOT_BROWSER_COMMAND_TIMEOUT',
          504,
        ));
      }, CDP_COMMAND_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
    });
    try {
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    } catch {
      const entry = pending.get(id);
      pending.delete(id);
      clearTimeout(entry?.timer);
      entry?.reject(new ComputerBrowserError(
        'Chromium connection is closed',
        'DEVRYAN_BOT_BROWSER_CLOSED',
        503,
      ));
    }
    return response;
  };

  const on = (method, callback) => {
    const callbacks = listeners.get(method) || new Set();
    callbacks.add(callback);
    listeners.set(method, callbacks);
    return () => callbacks.delete(callback);
  };

  const onClose = (callback) => {
    if (typeof callback !== 'function') return () => undefined;
    if (closed) {
      queueMicrotask(callback);
      return () => undefined;
    }
    closeListeners.add(callback);
    return () => closeListeners.delete(callback);
  };

  return Object.freeze({
    ready,
    send,
    on,
    onClose,
    isClosed: () => closed,
    close: () => socket.close(),
  });
}

const waitForDevToolsEndpoint = async ({
  profileDirectory,
  child,
  fsPromises,
  spawnError,
  timeoutMs = 15_000,
}) => {
  const portFile = path.join(profileDirectory, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError() || child.exitCode !== null) {
      fail('Chromium exited during startup', 'DEVRYAN_BOT_BROWSER_START_FAILED', 500);
    }
    try {
      const [portLine, pathLine] = (await fsPromises.readFile(portFile, 'utf8')).trim().split(/\r?\n/);
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && port <= 65535 && pathLine?.startsWith('/devtools/browser/')) {
        return `ws://127.0.0.1:${port}${pathLine}`;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        fail('Chromium debugging endpoint is invalid', 'DEVRYAN_BOT_BROWSER_START_FAILED', 500);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  fail('Chromium startup timed out', 'DEVRYAN_BOT_BROWSER_START_FAILED', 500);
};

const waitForExit = (child, timeoutMs) => new Promise((resolve) => {
  if (child.exitCode !== null) {
    resolve(true);
    return;
  }
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    resolve(false);
  }, timeoutMs);
  child.once('exit', () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(true);
  });
});

export async function launchChromiumDriver({
  executablePath = '/usr/bin/chromium-browser',
  profileDirectory,
  scratchDirectory,
  proxyUrl,
  display = ':99',
  diagnostics = null,
  spawnImpl = spawn,
  fsPromises = fs,
  WebSocketImpl = globalThis.WebSocket,
} = {}) {
  if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath)
    || !['chromium', 'chromium-browser'].includes(path.basename(executablePath))
    || typeof profileDirectory !== 'string' || !path.isAbsolute(profileDirectory)
    || typeof scratchDirectory !== 'string' || !path.isAbsolute(scratchDirectory)
    || typeof proxyUrl !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(proxyUrl)
    || typeof display !== 'string' || !/^:[1-9]\d{0,3}$/u.test(display)
    || (diagnostics !== null && typeof diagnostics?.recordRequest !== 'function')
    || typeof spawnImpl !== 'function') {
    fail('Chromium launch configuration is invalid', 'DEVRYAN_BOT_BROWSER_CONFIG_INVALID', 500);
  }
  await fsPromises.mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  await fsPromises.mkdir(scratchDirectory, { recursive: true, mode: 0o700 });
  await clearStaleChromiumStartupArtifacts({ profileDirectory, fsPromises });
  const child = spawnImpl(executablePath, chromiumLaunchArguments({
    profileDirectory,
    proxyUrl,
  }), {
    cwd: scratchDirectory,
    env: {
      DISPLAY: display,
      HOME: profileDirectory,
      LANG: 'C.UTF-8',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      TMPDIR: '/tmp',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
    shell: false,
  });
  let childSpawnError = null;
  child.once('error', (error) => { childSpawnError = error; });
  const connection = createCdpConnection(await waitForDevToolsEndpoint({
    profileDirectory,
    child,
    fsPromises,
    spawnError: () => childSpawnError,
  }), { WebSocketImpl });
  await connection.ready;
  const version = await connection.send('Browser.getVersion');
  const engineVersion = typeof version.product === 'string' && version.product.length <= 128
    ? version.product
    : null;
  const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank' });
  const attached = await connection.send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attached.sessionId;
  await Promise.all([
    connection.send('Page.enable', {}, sessionId),
    connection.send('DOM.enable', {}, sessionId),
    connection.send('Accessibility.enable', {}, sessionId),
    connection.send('Network.enable', {}, sessionId),
    connection.send('Emulation.setDeviceMetricsOverride', {
      width: HUMAN_VIEWPORT_WIDTH,
      height: HUMAN_VIEWPORT_HEIGHT,
      deviceScaleFactor: HUMAN_DEVICE_SCALE_FACTOR,
      mobile: false,
    }, sessionId),
    connection.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: scratchDirectory,
      eventsEnabled: true,
    }),
  ]);
  const frameTree = await connection.send('Page.getFrameTree', {}, sessionId);
  let mainFrameId = frameTree.frameTree?.frame?.id || null;

  let terminated = false;
  const terminationListeners = new Set();
  const markTerminated = (code = 'DEVRYAN_BOT_BROWSER_CLOSED') => {
    if (terminated) return;
    terminated = true;
    for (const callback of terminationListeners) callback(code);
    terminationListeners.clear();
  };
  connection.onClose(() => markTerminated());
  child.once('exit', () => markTerminated());

  let pageChangeHandler = () => undefined;
  connection.on('Page.frameNavigated', (event, eventSessionId) => {
    if (eventSessionId !== sessionId || event.frame?.parentId) return;
    mainFrameId = event.frame?.id || mainFrameId;
    pageChangeHandler();
  });
  connection.on('Network.requestWillBeSent', (event, eventSessionId) => {
    if (eventSessionId !== sessionId) return;
    diagnostics?.recordRequest({
      requestId: event.requestId,
      url: event.request?.url,
      type: event.type,
      mainFrame: event.type === 'Document' && event.frameId === mainFrameId,
      redirected: Boolean(event.redirectResponse),
    });
  });
  connection.on('Network.responseReceived', (event, eventSessionId) => {
    if (eventSessionId !== sessionId) return;
    diagnostics?.recordResponse({
      requestId: event.requestId,
      url: event.response?.url,
      statusCode: event.response?.status,
    });
  });
  connection.on('Network.requestWillBeSentExtraInfo', (event, eventSessionId) => {
    if (eventSessionId !== sessionId) return;
    const reasons = (event.associatedCookies || []).flatMap((entry) => entry.blockedReasons || []);
    diagnostics?.recordCookieBlock({ requestId: event.requestId, reasons });
  });
  connection.on('Network.responseReceivedExtraInfo', (event, eventSessionId) => {
    if (eventSessionId !== sessionId) return;
    const reasons = (event.blockedCookies || []).flatMap((entry) => entry.blockedReasons || []);
    diagnostics?.recordCookieBlock({ requestId: event.requestId, reasons });
  });
  connection.on('Network.loadingFailed', (event, eventSessionId) => {
    if (eventSessionId !== sessionId) return;
    diagnostics?.recordFailure({
      requestId: event.requestId,
      errorText: event.errorText,
      blockedReason: event.blockedReason,
    });
  });

  const waitForPageLoad = () => {
    let settled = false;
    let timer;
    let unsubscribe = () => undefined;
    const promise = new Promise((resolve, reject) => {
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        if (error) reject(error);
        else resolve();
      };
      unsubscribe = connection.on('Page.loadEventFired', (_event, eventSessionId) => {
        if (eventSessionId === sessionId) finish();
      });
      timer = setTimeout(() => finish(new ComputerBrowserError(
        'Navigation timed out',
        'DEVRYAN_BOT_NAVIGATION_FAILED',
        504,
      )), 30_000);
    });
    return Object.freeze({
      promise,
      cancel: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
      },
    });
  };

  const pointForNode = async (node) => {
    const box = await connection.send('DOM.getBoxModel', {
      backendNodeId: node.backendNodeId,
    }, sessionId);
    const quad = box.model?.content || box.model?.border;
    if (!Array.isArray(quad) || quad.length !== 8) {
      fail('Accessibility target is not visible', 'DEVRYAN_BOT_TARGET_NOT_VISIBLE', 409);
    }
    return {
      x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
      y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
    };
  };

  const clickPoint = async ({ x, y }) => {
    await connection.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1,
    }, sessionId);
    await connection.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
    }, sessionId);
  };

  const dispatchKey = async (key, modifiers = 0) => {
    await connection.send('Input.dispatchKeyEvent', { type: 'keyDown', key, modifiers }, sessionId);
    await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key, modifiers }, sessionId);
  };

  let stopScreencast = null;
  const humanInput = createHumanInputDispatcher({ send: (method, params) => connection.send(method, params, sessionId) });
  return Object.freeze({
    status: () => Object.freeze({
      mode: 'headed_virtual',
      engineVersion,
    }),
    isHealthy: () => !terminated && child.exitCode === null && !connection.isClosed(),
    onTerminated(callback) {
      if (typeof callback !== 'function') return () => undefined;
      if (terminated) {
        queueMicrotask(() => callback('DEVRYAN_BOT_BROWSER_CLOSED'));
        return () => undefined;
      }
      terminationListeners.add(callback);
      return () => terminationListeners.delete(callback);
    },
    setPageChangeHandler(callback) {
      pageChangeHandler = typeof callback === 'function' ? callback : () => undefined;
    },
    async navigate(url) {
      const load = waitForPageLoad();
      try {
        const result = await connection.send('Page.navigate', { url }, sessionId);
        if (result.errorText) fail('Navigation failed', 'DEVRYAN_BOT_NAVIGATION_FAILED', 502);
        await load.promise;
        return { frameId: result.frameId || null };
      } finally {
        load.cancel();
      }
    },
    async snapshot() {
      const { nodes = [] } = await connection.send('Accessibility.getFullAXTree', {}, sessionId);
      return nodes.filter((node) => Number.isInteger(node.backendDOMNodeId) && node.backendDOMNodeId > 0)
        .slice(0, 5_000)
        .map((node) => ({
          backendNodeId: node.backendDOMNodeId,
          role: cdpValue(node.role),
          name: cdpValue(node.name),
          value: cdpValue(node.value),
          disabled: propertyBoolean(node, 'disabled'),
          focused: propertyBoolean(node, 'focused'),
        }));
    },
    async click(node) {
      await clickPoint(await pointForNode(node));
    },
    async fill(node, text) {
      await clickPoint(await pointForNode(node));
      await dispatchKey('a', 2);
      await dispatchKey('Backspace');
      await connection.send('Input.insertText', { text }, sessionId);
    },
    async select(node, value) {
      await clickPoint(await pointForNode(node));
      await dispatchKey('Home');
      await connection.send('Input.insertText', { text: value }, sessionId);
      await dispatchKey('Enter');
    },
    key: (key) => dispatchKey(key === 'Space' ? ' ' : key),
    scroll: ({ deltaX, deltaY }) => connection.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: 0, y: 0, deltaX, deltaY,
    }, sessionId),
    input: humanInput.dispatch,
    releaseInput: humanInput.release,
    upload: (node, filePath) => connection.send('DOM.setFileInputFiles', {
      backendNodeId: node.backendNodeId,
      files: [filePath],
    }, sessionId),
    async screenshot({ format, quality }) {
      const result = await connection.send('Page.captureScreenshot', {
        format,
        ...(format === 'jpeg' ? { quality } : {}),
        fromSurface: true,
      }, sessionId);
      return Buffer.from(result.data || '', 'base64');
    },
    async startScreencast(onFrame) {
      if (stopScreencast) return stopScreencast;
      const unsubscribe = connection.on('Page.screencastFrame', (event, eventSessionId) => {
        if (eventSessionId !== sessionId) return;
        const frame = Buffer.from(event.data || '', 'base64');
        try {
          onFrame(frame, {
            width: Math.round(event.metadata?.deviceWidth || HUMAN_VIEWPORT_WIDTH),
            height: Math.round(event.metadata?.deviceHeight || HUMAN_VIEWPORT_HEIGHT),
            deviceScaleFactor: HUMAN_DEVICE_SCALE_FACTOR,
          });
        } catch {
          // A malformed/oversized frame is dropped without crashing the browser service.
        }
        void connection.send('Page.screencastFrameAck', { sessionId: event.sessionId }, sessionId)
          .catch(() => undefined);
      });
      await connection.send('Page.startScreencast', {
        format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1,
      }, sessionId);
      stopScreencast = async () => {
        unsubscribe();
        await connection.send('Page.stopScreencast', {}, sessionId).catch(() => undefined);
        stopScreencast = null;
      };
      return stopScreencast;
    },
    async close({ force = false } = {}) {
      await stopScreencast?.().catch(() => undefined);
      if (!force) await connection.send('Browser.close').catch(() => undefined);
      if (force && child.exitCode === null) child.kill('SIGTERM');
      if (!await waitForExit(child, force ? 2_000 : 5_000)) child.kill('SIGTERM');
      if (!await waitForExit(child, 2_000)) child.kill('SIGKILL');
      connection.close();
    },
  });
}

export function createBrowserController({
  launchDriver,
  refs,
  control,
  workspace,
  profiles,
  screencast,
  environmentStatus = () => ({
    mode: 'headed_virtual',
    engineVersion: null,
    displayReady: true,
    webCapabilities: {
      managedPolicy: 'enforced',
      javascript: 'enabled',
      firstPartyCookies: 'enabled',
      thirdPartyCookies: 'enabled',
    },
  }),
  diagnostics = null,
} = {}) {
  if (typeof launchDriver !== 'function' || !refs || !control || !workspace || !profiles || !screencast
    || typeof environmentStatus !== 'function'
    || (diagnostics !== null && typeof diagnostics?.snapshot !== 'function')) {
    fail('Browser controller configuration is invalid', 'DEVRYAN_BOT_BROWSER_CONFIG_INVALID', 500);
  }
  let driver = null;
  let launching = null;
  let stopScreencast = null;
  let screencastSubscriberCount = 0;
  let screencastTransition = Promise.resolve();
  let generation = 0;
  let lastFailureCode = null;
  control.setInputReleaseHandler(() => driver?.releaseInput?.());

  const publishScreencast = (frame, metadata) => {
    screencast.publishJpeg(frame, metadata);
  };

  const clearDriver = (active, code) => {
    if (!active || driver !== active) return false;
    driver = null;
    lastFailureCode = typeof code === 'string' ? code : 'DEVRYAN_BOT_BROWSER_CLOSED';
    const stop = stopScreencast;
    stopScreencast = null;
    refs.beginPage();
    void stop?.().catch(() => undefined);
    return true;
  };

  const retireDriver = async (active, code) => {
    if (!clearDriver(active, code)) return false;
    await active.close({ force: true }).catch(() => undefined);
    return true;
  };

  const ensureDriver = async () => {
    const environment = environmentStatus();
    if (environment?.displayReady !== true) {
      fail('Virtual display is unavailable', 'DEVRYAN_BOT_DISPLAY_CLOSED', 503);
    }
    if (environment?.webCapabilities?.managedPolicy !== 'enforced') {
      fail('Managed Chromium policy is unavailable', 'DEVRYAN_BOT_BROWSER_POLICY_INVALID', 503);
    }
    if (driver && driver.isHealthy()) return driver;
    if (driver) await retireDriver(driver, 'DEVRYAN_BOT_BROWSER_CLOSED');
    if (launching) return launching;
    launching = (async () => {
      const next = await launchDriver();
      if (!next || typeof next.navigate !== 'function' || typeof next.close !== 'function'
        || typeof next.isHealthy !== 'function' || typeof next.onTerminated !== 'function') {
        fail('Chromium driver is invalid', 'DEVRYAN_BOT_BROWSER_START_FAILED', 500);
      }
      next.setPageChangeHandler?.(() => refs.beginPage());
      next.onTerminated((code) => clearDriver(next, code));
      if (!next.isHealthy()) {
        await next.close().catch(() => undefined);
        fail('Chromium exited during startup', 'DEVRYAN_BOT_BROWSER_START_FAILED', 500);
      }
      driver = next;
      generation += 1;
      lastFailureCode = null;
      if (screencastSubscriberCount > 0 && !stopScreencast) {
        stopScreencast = await next.startScreencast?.(publishScreencast);
      }
      return next;
    })().finally(() => {
      launching = null;
    });
    return launching;
  };

  const ensureDriverForRead = async () => {
    try {
      return await ensureDriver();
    } catch (error) {
      if (!RECOVERABLE_BROWSER_CODES.has(error?.code)) throw error;
      lastFailureCode = error.code;
      return ensureDriver();
    }
  };

  const close = async () => {
    await screencastTransition.catch(() => undefined);
    const active = driver || (launching ? await launching.catch(() => null) : null);
    driver = null;
    const stop = stopScreencast;
    stopScreencast = null;
    screencastSubscriberCount = 0;
    await stop?.().catch(() => undefined);
    await active?.close();
    refs.beginPage();
    return Object.freeze({ closed: true });
  };

  const executeCommand = async (command, args, { signal, human = false, gatewayToken = null, assertAuthorized = () => undefined } = {}) => {
    const isHumanInput = human && command === 'input';
    if (!COMMANDS.has(command) && !isHumanInput) {
      fail('Browser command is not reviewed', 'DEVRYAN_BOT_BROWSER_COMMAND_DENIED');
    }
    if (!human) control.assertAgentAvailable();
    if (command === 'wait') {
      exactKeys(args, ['milliseconds']);
      if (!Number.isInteger(args.milliseconds) || args.milliseconds < 0 || args.milliseconds > 30_000) {
        fail('Wait duration is invalid', 'DEVRYAN_BOT_BROWSER_INPUT_INVALID');
      }
      if (signal?.aborted) {
        fail('Wait was aborted', 'DEVRYAN_BOT_COMMAND_ABORTED', 499);
      }
      await new Promise((resolve, reject) => {
        const finish = (error) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          if (error) reject(error);
          else resolve();
        };
        const onAbort = () => finish(new ComputerBrowserError(
          'Wait was aborted',
          'DEVRYAN_BOT_COMMAND_ABORTED',
          499,
        ));
        const timer = setTimeout(() => finish(), args.milliseconds);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      return Object.freeze({ waitedMs: args.milliseconds });
    }
    if (command === 'download') {
      exactKeys(args, ['filename']);
      return workspace.publishDownload({ filename: args.filename, runtimeToken: gatewayToken });
    }
    if (command === 'close') {
      exactKeys(args, []);
      return close();
    }
    const perform = async (active) => {
      if (human) assertAuthorized();
      else control.assertAgentAvailable();
      if (isHumanInput) {
        const events = validateHumanInputArgs(args);
        return active.input(events, { assertAuthorized });
      }
      if (command === 'navigate') {
        exactKeys(args, ['url']);
        refs.beginPage();
        await active.navigate(safeUrl(args.url));
        return Object.freeze({ navigated: true });
      }
      if (command === 'snapshot') {
        exactKeys(args, []);
        return Object.freeze({ nodes: refs.recordSnapshot(await active.snapshot()), ...refs.snapshot() });
      }
      if (command === 'click') {
        exactKeys(args, ['ref']);
        await active.click(refs.resolve(args.ref));
        return Object.freeze({ clicked: true });
      }
      if (command === 'fill') {
        exactKeys(args, ['ref', 'text']);
        await active.fill(refs.resolve(args.ref), boundedText(args.text, 'Fill text', 100_000));
        return Object.freeze({ filled: true });
      }
      if (command === 'select') {
        exactKeys(args, ['ref', 'value']);
        await active.select(refs.resolve(args.ref), boundedText(args.value, 'Select value', 2_048));
        return Object.freeze({ selected: true });
      }
      if (command === 'key') {
        exactKeys(args, ['key']);
        if (!KEY_NAMES.has(args.key)) fail('Key is not reviewed', 'DEVRYAN_BOT_BROWSER_INPUT_INVALID');
        await active.key(args.key);
        return Object.freeze({ pressed: true });
      }
      if (command === 'scroll') {
        exactKeys(args, ['deltaX', 'deltaY']);
        if (![args.deltaX, args.deltaY].every((value) => Number.isInteger(value) && Math.abs(value) <= 100_000)) {
          fail('Scroll delta is invalid', 'DEVRYAN_BOT_BROWSER_INPUT_INVALID');
        }
        await active.scroll({ deltaX: args.deltaX, deltaY: args.deltaY });
        return Object.freeze({ scrolled: true });
      }
      if (command === 'upload') {
        exactKeys(args, ['ref', 'artifactId', 'filename']);
        const staged = await workspace.stageUpload({
          artifactId: args.artifactId,
          filename: args.filename,
          runtimeToken: gatewayToken,
        });
        await active.upload(refs.resolve(args.ref), staged.path);
        return Object.freeze({ uploaded: true, filename: staged.filename, size: staged.size });
      }
      if (command === 'screenshot') {
        exactKeys(args, ['format', 'quality']);
        if (!['jpeg', 'png'].includes(args.format)
          || !Number.isInteger(args.quality) || args.quality < 1 || args.quality > 100) {
          fail('Screenshot options are invalid', 'DEVRYAN_BOT_BROWSER_INPUT_INVALID');
        }
        const image = await active.screenshot({ format: args.format, quality: args.quality });
        if (!Buffer.isBuffer(image) || image.byteLength === 0 || image.byteLength > MAX_SCREENSHOT_BYTES) {
          fail('Screenshot output is invalid', 'DEVRYAN_BOT_SCREENSHOT_INVALID', 502);
        }
        return Object.freeze({
          mimeType: args.format === 'jpeg' ? 'image/jpeg' : 'image/png',
          data: image.toString('base64'),
          bytes: image.byteLength,
        });
      }
      fail('Browser command is not implemented', 'DEVRYAN_BOT_BROWSER_COMMAND_DENIED');
    };

    const maximumAttempts = RETRYABLE_BROWSER_COMMANDS.has(command) ? 2 : 1;
    let active = null;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        active = await ensureDriver();
        return await perform(active);
      } catch (error) {
        if (error?.code?.startsWith('DEVRYAN_BOT_CONTROL_')) throw error;
        const recoverable = RECOVERABLE_BROWSER_CODES.has(error?.code);
        if (active) await retireDriver(active, error?.code);
        else if (recoverable) lastFailureCode = error.code;
        if (!recoverable || attempt === maximumAttempts) throw error;
        active = null;
      }
    }
    fail('Browser command recovery failed', 'DEVRYAN_BOT_BROWSER_START_FAILED', 500);
  };

  const resetProfile = () => profiles.resetProfile({ closeBrowser: close });

  const subscribeScreencast = async (subscriber) => {
    if (typeof subscriber !== 'function') {
      fail('Screencast subscriber is invalid', 'DEVRYAN_BOT_SCREENCAST_INVALID');
    }
    let unsubscribe = null;
    screencastTransition = screencastTransition.catch(() => undefined).then(async () => {
      const active = await ensureDriverForRead();
      unsubscribe = screencast.subscribe(subscriber);
      try {
        if (screencastSubscriberCount === 0) {
          stopScreencast = await active.startScreencast?.(publishScreencast);
        }
        // CDP only emits screencast frames when the page is damaged. A viewer
        // joining an already-running screencast would otherwise remain blank
        // until the page changes. Capture one current frame for every new
        // subscriber and fan it out transiently through the existing broker.
        // The broker deliberately retains no frame bytes.
        const firstFrame = await active.screenshot({ format: 'jpeg', quality: 60 });
        publishScreencast(firstFrame, {
          width: HUMAN_VIEWPORT_WIDTH,
          height: HUMAN_VIEWPORT_HEIGHT,
          deviceScaleFactor: HUMAN_DEVICE_SCALE_FACTOR,
        });
        screencastSubscriberCount += 1;
      } catch (error) {
        unsubscribe();
        unsubscribe = null;
        if (screencastSubscriberCount === 0) {
          const stop = stopScreencast;
          stopScreencast = null;
          await stop?.().catch(() => undefined);
        }
        throw error;
      }
    });
    await screencastTransition;
    let closed = false;
    return async () => {
      if (closed) return;
      closed = true;
      screencastTransition = screencastTransition.catch(() => undefined).then(async () => {
        unsubscribe?.();
        unsubscribe = null;
        screencastSubscriberCount = Math.max(0, screencastSubscriberCount - 1);
        if (screencastSubscriberCount !== 0) return;
        const stop = stopScreencast;
        stopScreencast = null;
        await stop?.().catch(() => undefined);
      });
      await screencastTransition;
    };
  };

  return Object.freeze({
    execute: (command, args, options) => executeCommand(command, args, options),
    executeHuman: (command, args, options = {}) => executeCommand(command, args, {
      ...options,
      human: true,
    }),
    close,
    resetProfile,
    subscribeScreencast,
    status: () => Object.freeze({
      running: Boolean(driver),
      healthy: Boolean(driver?.isHealthy()) && environmentStatus()?.displayReady === true,
      launching: Boolean(launching),
      lifecycleState: driver ? 'running' : launching ? 'launching' : 'stopped',
      generation,
      lastFailureCode,
      screencastSubscribers: screencastSubscriberCount,
      ...environmentStatus(),
      ...driver?.status?.(),
      lastNavigationDiagnostic: diagnostics?.snapshot?.() || null,
    }),
  });
}
