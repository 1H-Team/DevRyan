import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

// A native SQLite/runtime fault must end only this worker. In particular, Bun
// 1.3.14's SQLite handle registry is shared unsafely by worker threads.
export class ContextModeWorkerProcess extends EventEmitter {
  constructor(url, { env, workerData, execPath = process.execPath }) {
    super();
    const bunCliMode = Boolean(process.versions.bun) && execPath === process.execPath;
    this.child = fork(fileURLToPath(url), [], {
      execPath, execArgv: [], env: bunCliMode ? { ...env, BUN_BE_BUN: '1' } : env, serialization: 'json',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
    this.child.on('message', (message) => this.emit('message', message));
    this.child.on('error', (error) => this.emit('error', error));
    this.exited = new Promise((resolve) => this.child.once('exit', (code) => {
      this.emit('exit', code);
      resolve(code);
    }));
    try {
      this.postMessage({ type: 'initialize', workerData: { ...workerData, bunCliMode, inheritedBunMode: env.BUN_BE_BUN } });
    } catch (error) {
      // Construction failed before the pool could own this process. Reap it
      // here, and consume any later IPC error from the discarded adapter.
      this.on('error', () => {});
      this.child.kill('SIGKILL');
      throw error;
    }
  }

  get pid() { return this.child.pid; }
  postMessage(message) {
    this.child.send(message, (error) => { if (error) this.emit('error', error); });
  }
  unref() { this.child.unref(); this.child.channel?.unref?.(); }
  terminate() { this.child.kill('SIGKILL'); return this.exited; }
}
