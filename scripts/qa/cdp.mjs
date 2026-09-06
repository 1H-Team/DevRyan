import { createRequire } from 'node:module';
const requireElectron = createRequire(new URL('../../packages/electron/package.json', import.meta.url));
const WebSocket = requireElectron('ws');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextID = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString('utf8'));
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? 'CDP command failed'));
        else pending.resolve(message.result ?? {});
        return;
      }
      if (typeof message.method !== 'string') return;
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
    });
    socket.on('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('CDP connection closed'));
      this.pending.clear();
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url, { maxPayload: 256 * 1024 * 1024, handshakeTimeout: 5000 });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return new CdpConnection(socket);
  }

  send(method, params = {}) {
    const id = this.nextID;
    this.nextID += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP ${method}`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const current = this.listeners.get(method) ?? new Set();
    current.add(listener);
    this.listeners.set(method, current);
    return () => current.delete(listener);
  }

  waitFor(method, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting for CDP event ${method}`));
      }, timeoutMs);
      const unsubscribe = this.on(method, (params) => {
        clearTimeout(timeout);
        unsubscribe();
        resolve(params);
      });
    });
  }

  close() {
    this.socket.close();
  }
}

export const discoverPageTarget = async (debugPort, timeoutMs = 45_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
        if (page) return page;
      }
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw new Error(`Electron CDP target did not appear${lastError ? `: ${lastError.message}` : ''}`);
};

export const evaluate = async (cdp, expression) => {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Renderer evaluation failed');
  }
  return result.result?.value;
};
