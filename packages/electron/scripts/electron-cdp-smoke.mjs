import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const electronDirectory = path.resolve(scriptDirectory, '..');
const requireElectronDependency = createRequire(path.join(electronDirectory, 'package.json'));
const WebSocket = requireElectronDependency('ws');

export const wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

export const reserveLoopbackPort = async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to reserve a loopback port');
  }
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};

export class ElectronCdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.eventListeners = new Map();
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString('utf8'));
      if (typeof message.method === 'string') {
        for (const listener of this.eventListeners.get(message.method) || []) {
          listener(message.params || {});
        }
      }
      if (typeof message.id !== 'number') return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || 'CDP command failed'));
      } else {
        pending.resolve(message.result || {});
      }
    });
    socket.on('close', () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error('Electron CDP connection closed'));
      }
      this.pending.clear();
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return new ElectronCdpConnection(socket);
  }

  send(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
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
    const listeners = this.eventListeners.get(method) || new Set();
    listeners.add(listener);
    this.eventListeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.eventListeners.delete(method);
    };
  }

  close() {
    this.socket.close();
  }
}

export const discoverElectronPage = async (debugPort, timeoutMs = 45_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => (
          target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string'
        ));
        if (page) return page;
      }
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Electron CDP page did not appear${suffix}`);
};

export const evaluate = async (cdp, expression) => {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    const message = response.exceptionDetails.exception?.description
      || response.exceptionDetails.text
      || 'Renderer evaluation failed';
    throw new Error(message);
  }
  return response.result?.value;
};

export const waitForEvaluation = async (cdp, expression, {
  timeoutMs = 30_000,
  label = 'renderer condition',
} = {}) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(cdp, expression);
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${label}${suffix}`);
};
