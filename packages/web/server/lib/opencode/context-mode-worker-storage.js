import fs from 'node:fs';

// Atomic hard links elect one owner without overwriting another process's
// lock. Each owner token has a distinct inode. Only its owner, or the parent
// after confirmed process exit, may remove the corresponding lock.
export class ContextModeWorkerStorage {
  constructor({ remainingMs, onContention = () => {} }) {
    Object.assign(this, { remainingMs, onContention });
    this.locks = new Map();
    this.depth = new Set();
    this.sleeper = new Int32Array(new SharedArrayBuffer(4));
  }

  configure({ locks, ownerToken, cancellationPath }) {
    this.ownerToken = ownerToken;
    this.cancellationPath = cancellationPath;
    for (const { path, lockPath } of locks) this.locks.set(path, lockPath);
  }

  check() {
    if (this.cancellationPath && fs.existsSync(this.cancellationPath)) throw new Error('Context Mode worker: CANCELLED: storage operation cancelled; outcome may be unknown');
    if (this.remainingMs() <= 0) throw new Error('Context Mode worker: TIMEOUT: storage execution budget exhausted; outcome may be unknown');
  }

  wait() { Atomics.wait(this.sleeper, 0, 0, Math.min(20, this.remainingMs())); }

  run(path, operation, once = 0) {
    const lock = this.locks.get(path);
    if (!lock) throw new Error('Context Mode worker storage path was not initialized');
    this.check();
    const flag = `${lock}.${once}`;
    const invoke = () => {
      this.check();
      if (once && fs.existsSync(flag)) return;
      const result = operation();
      if (result && typeof result.then === 'function') throw new TypeError('Storage critical sections must be synchronous');
      if (once) fs.writeFileSync(flag, '', { mode: 0o600 });
      return result;
    };
    if (this.depth.has(lock)) return invoke();
    const start = performance.now();
    let contended = false;
    for (;;) {
      try { fs.linkSync(this.ownerToken, lock); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!contended) this.onContention('storage_contended', 0);
        contended = true;
        this.check();
        this.wait();
      }
    }
    this.depth.add(lock);
    try {
      if (contended) this.onContention('storage_acquired', Math.round(performance.now() - start));
      return invoke();
    } finally {
      this.depth.delete(lock);
      fs.unlinkSync(lock);
    }
  }

  // Only use around a transaction whose adapter has completed rollback before
  // throwing. Never use around a tool handler or a post-commit callback.
  transaction(path, operation) {
    return this.run(path, () => {
      for (;;) {
        this.check();
        try { return operation(); }
        catch (error) {
          if (!/\bSQLITE_BUSY\b|database is locked/.test(error?.message || '')) throw error;
          this.check();
          this.wait();
        }
      }
    });
  }
}
