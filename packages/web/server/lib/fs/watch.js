// Scoped filesystem change notifications for the Files view (`GET /api/fs/watch`).
//
// The hub owns shared, reference-counted, nonrecursive `fs.watch` handles keyed
// by canonical directory. The handler streams slot hints over SSE: a hint names
// only the scope slot the client sent (root, an expanded index, or the selected
// file), never a file name or contents. A selected file is observed through its
// parent directory, filtered by basename, because on macOS a watch on the file
// itself goes silent after an atomic save replaces its inode.
import { watch as nodeWatch } from 'node:fs';

import { createBoundedEventQueue } from '../event-stream/bounded-event-queue.js';
import { MESSAGE_STREAM_WS_HEARTBEAT_INTERVAL_MS } from '../event-stream/protocol.js';
import { isProtectedDotenvPath, shouldHideProtectedDotenv } from '../multi-user/dotenv-visibility.js';

export const FS_WATCH_MAX_DIRECTORIES = 64;
export const FS_WATCH_MAX_HANDLES = 512;
export const FS_WATCH_MAX_HANDLES_PER_PRINCIPAL = 128;
export const FS_WATCH_COALESCE_MS = 200;
// Raw events in one coalescing window beyond which slot hints collapse to resync.
export const FS_WATCH_BURST_LIMIT = 512;
const FS_WATCH_QUEUE_MAX_BYTES = 64 * 1024;
const FS_WATCH_QUEUE_MAX_ENTRIES = 256;
const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR']);

/** On by default except on win32, where ReadDirectoryChangesW holds directory handles. */
export const isFsWatchEnabled = ({ env = process.env, platform = process.platform } = {}) => {
  const raw = typeof env.DEVRYAN_FS_WATCH === 'string' ? env.DEVRYAN_FS_WATCH.trim().toLowerCase() : '';
  if (raw) return !['0', 'false', 'off'].includes(raw);
  return platform !== 'win32';
};

const capacityError = () => Object.assign(new Error('File watch capacity reached'), { code: 'fs_watch_capacity' });

export const createFsWatchHub = ({
  watch = nodeWatch,
  fsPromises,
  maxHandles = FS_WATCH_MAX_HANDLES,
  maxHandlesPerPrincipal = FS_WATCH_MAX_HANDLES_PER_PRINCIPAL,
} = {}) => {
  if (!fsPromises || typeof fsPromises.realpath !== 'function' || typeof fsPromises.lstat !== 'function') {
    throw new TypeError('createFsWatchHub requires fsPromises.realpath and fsPromises.lstat');
  }
  /** @type {Map<string, { directory: string, watcher: import('node:fs').FSWatcher | null, identity: { dev: number, ino: number } | null, refs: number, listeners: Set<Function>, verifying: Promise<void> | null }>} */
  const handles = new Map();
  /** @type {Map<string, Map<string, number>>} */
  const principalShares = new Map();

  const notify = (handle, signal) => {
    for (const listener of [...handle.listeners]) {
      try { listener(handle.directory, signal); } catch { /* A subscriber failure must not stop others. */ }
    }
  };

  const closeWatcher = (handle) => {
    const watcher = handle.watcher;
    handle.watcher = null;
    if (!watcher) return;
    try { watcher.close(); } catch { /* Already closed by the platform. */ }
  };

  // Returns 'open' or 'missing'; any other failure throws to the caller.
  const openWatcher = (handle) => {
    let watcher;
    try {
      watcher = watch(handle.directory, { persistent: false, recursive: false, encoding: 'utf8' }, (_eventType, filename) => {
        if (handle.watcher !== watcher) return;
        notify(handle, { kind: 'change', filename: typeof filename === 'string' && filename ? filename : null });
      });
    } catch (error) {
      if (MISSING_CODES.has(error?.code)) { handle.watcher = null; return 'missing'; }
      throw error;
    }
    handle.watcher = watcher;
    watcher.on?.('error', () => {
      if (handle.watcher !== watcher) return;
      closeWatcher(handle);
      if (!handles.has(handle.directory)) return;
      try {
        openWatcher(handle);
        notify(handle, { kind: 'resync' });
      } catch {
        notify(handle, { kind: 'unavailable' });
      }
    });
    return 'open';
  };

  const readIdentity = async (directory) => {
    try {
      const real = await fsPromises.realpath(directory);
      const stats = await fsPromises.lstat(real);
      return { real, dev: stats.dev, ino: stats.ino, isDirectory: stats.isDirectory() };
    } catch (error) {
      if (MISSING_CODES.has(error?.code)) return null;
      throw error;
    }
  };

  const releaseDirectory = (principalKey, directory, listener) => {
    const handle = handles.get(directory);
    if (handle) {
      handle.listeners.delete(listener);
      handle.refs -= 1;
      if (handle.refs <= 0) {
        handles.delete(directory);
        closeWatcher(handle);
      }
    }
    const share = principalShares.get(principalKey);
    if (!share) return;
    const count = (share.get(directory) ?? 0) - 1;
    if (count > 0) share.set(directory, count);
    else share.delete(directory);
    if (share.size === 0) principalShares.delete(principalKey);
  };

  /**
   * Reserve and open every directory synchronously (capacity cannot race), then
   * record identities. Any open failure other than a missing directory rolls the
   * whole lease back and throws.
   */
  const acquire = async (principalKey, directories, listener) => {
    const unique = [...new Set(directories)];
    const share = principalShares.get(principalKey) ?? new Map();
    const newHandles = unique.filter((directory) => !handles.has(directory)).length;
    const newShare = unique.filter((directory) => !share.has(directory)).length;
    if (handles.size + newHandles > maxHandles || share.size + newShare > maxHandlesPerPrincipal) throw capacityError();

    const acquired = [];
    const opened = [];
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      for (const directory of acquired) releaseDirectory(principalKey, directory, listener);
    };
    try {
      for (const directory of unique) {
        let handle = handles.get(directory);
        if (!handle) {
          handle = { directory, watcher: null, identity: null, refs: 0, listeners: new Set(), verifying: null };
          openWatcher(handle);
          handles.set(directory, handle);
          opened.push(handle);
        }
        handle.refs += 1;
        handle.listeners.add(listener);
        share.set(directory, (share.get(directory) ?? 0) + 1);
        principalShares.set(principalKey, share);
        acquired.push(directory);
      }
    } catch (error) {
      release();
      throw error;
    }
    try {
      await Promise.all(opened.map(async (handle) => {
        const identity = await readIdentity(handle.directory);
        if (handles.get(handle.directory) === handle && !handle.identity) {
          handle.identity = identity ? { dev: identity.dev, ino: identity.ino } : null;
        }
      }));
    } catch (error) {
      release();
      throw error;
    }
    return { directories: unique, release };
  };

  // Compare each root's (dev, ino) from realpath + lstat with the recorded one.
  // A replaced or reappearing directory gets a fresh watcher and a resync.
  const verifyHandle = async (handle) => {
    let identity;
    try {
      identity = await readIdentity(handle.directory);
    } catch {
      notify(handle, { kind: 'unavailable' });
      return;
    }
    if (handles.get(handle.directory) !== handle) return;
    if (!identity) {
      if (handle.watcher || handle.identity) {
        closeWatcher(handle);
        handle.identity = null;
        notify(handle, { kind: 'resync' });
      }
      return;
    }
    if (identity.real !== handle.directory || !identity.isDirectory) {
      notify(handle, { kind: 'unavailable' });
      return;
    }
    const recorded = handle.identity;
    if (recorded && handle.watcher && recorded.dev === identity.dev && recorded.ino === identity.ino) return;
    closeWatcher(handle);
    try {
      openWatcher(handle);
    } catch {
      notify(handle, { kind: 'unavailable' });
      return;
    }
    handle.identity = { dev: identity.dev, ino: identity.ino };
    notify(handle, { kind: 'resync' });
  };

  const verify = async (directories) => {
    await Promise.all([...new Set(directories)].map((directory) => {
      const handle = handles.get(directory);
      if (!handle) return undefined;
      if (!handle.verifying) {
        handle.verifying = verifyHandle(handle).finally(() => { handle.verifying = null; });
      }
      return handle.verifying;
    }));
  };

  const getStats = () => ({
    handles: handles.size,
    openWatchers: [...handles.values()].filter((handle) => handle.watcher).length,
    principals: Object.fromEntries([...principalShares.entries()].map(([key, share]) => [key, share.size])),
  });

  const close = () => {
    for (const handle of handles.values()) closeWatcher(handle);
    handles.clear();
    principalShares.clear();
  };

  return { acquire, verify, getStats, close };
};

const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

const sameScope = (left, right) => left.root === right.root
  && left.watches.length === right.watches.length
  && left.watches.every((entry, index) => {
    const other = right.watches[index];
    return other && other.directory === entry.directory && other.selectedBasename === entry.selectedBasename
      && other.slots.length === entry.slots.length
      && other.slots.every((slot, slotIndex) => JSON.stringify(slot) === JSON.stringify(entry.slots[slotIndex]));
  });

const principalKeyFor = (principal) => (
  principal && typeof principal.id === 'string' && principal.id ? `${principal.scope ?? 'local'}:${principal.id}` : 'local'
);

const writeUnavailableStream = (res, epoch, reason) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.end(frame({ type: 'unavailable', epoch, retryable: false, reason }));
};

/**
 * `authorizeScope(req)` resolves the whole scope or rejects it:
 * `{ ok: true, root, watches: [{ directory, slots, selectedBasename }] }` or
 * `{ ok: false, status, error, code? }`. It runs again on every heartbeat.
 */
export const createFsWatchHandler = ({
  hub,
  authorizeScope,
  isEnabled = () => isFsWatchEnabled(),
  heartbeatIntervalMs = MESSAGE_STREAM_WS_HEARTBEAT_INTERVAL_MS,
  coalesceMs = FS_WATCH_COALESCE_MS,
  burstLimit = FS_WATCH_BURST_LIMIT,
  queueMaxBytes = FS_WATCH_QUEUE_MAX_BYTES,
}) => {
  if (!hub || typeof authorizeScope !== 'function') throw new TypeError('createFsWatchHandler requires a hub and authorizeScope');
  let lastEpoch = 0;

  return async (req, res) => {
    const epoch = ++lastEpoch;
    if (!isEnabled()) return writeUnavailableStream(res, epoch, 'disabled');

    let closed = false;
    let lease = null;
    let heartbeat = null;
    let flushTimer = null;
    let queue = null;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(flushTimer);
      lease?.release();
      queue?.close();
      req.off?.('aborted', cleanup);
      res.off?.('close', cleanup);
      res.off?.('error', cleanup);
    };
    // Listen before any await so a disconnect during authorization or watcher
    // installation still releases everything.
    req.once?.('aborted', cleanup);
    res.once?.('close', cleanup);
    res.once?.('error', cleanup);

    let scope;
    try {
      scope = await authorizeScope(req);
    } catch {
      cleanup();
      if (!res.headersSent && !res.destroyed) res.status(500).json({ error: 'Failed to authorize file watch' });
      return;
    }
    if (closed || res.destroyed) { cleanup(); return; }
    if (!scope?.ok) {
      cleanup();
      return res.status(scope?.status || 403).json({ error: scope?.error || 'Access denied', ...(scope?.code ? { code: scope.code } : {}) });
    }

    const hideDotenv = shouldHideProtectedDotenv(req.principal);
    const byDirectory = new Map(scope.watches.map((entry) => [entry.directory, entry]));
    const pendingSlots = new Map();
    let pendingResync = false;
    let rawEvents = 0;

    const send = (payload) => queue?.enqueue(frame(payload)) ?? Promise.resolve(false);
    const finishUnavailable = (retryable, reason) => {
      if (closed) return;
      clearInterval(heartbeat);
      clearTimeout(flushTimer);
      flushTimer = null;
      void send({ type: 'unavailable', epoch, retryable, reason }).then(() => {
        cleanup();
        if (!res.writableEnded && !res.destroyed) res.end();
      });
    };
    const flush = () => {
      flushTimer = null;
      if (closed) return;
      const resync = pendingResync || rawEvents > burstLimit;
      const slots = [...pendingSlots.values()];
      pendingSlots.clear();
      pendingResync = false;
      rawEvents = 0;
      if (resync) { void send({ type: 'resync', epoch }); return; }
      for (const slot of slots) void send({ type: 'invalidate', epoch, slot });
    };
    const schedule = () => {
      if (!flushTimer && !closed) flushTimer = setTimeout(flush, coalesceMs);
    };
    const onSignal = (directory, signal) => {
      if (closed) return;
      if (signal.kind === 'unavailable') { finishUnavailable(true, 'watcher_failed'); return; }
      if (signal.kind === 'resync') { pendingResync = true; schedule(); return; }
      const entry = byDirectory.get(directory);
      if (!entry) return;
      const { filename } = signal;
      // Per subscriber: restricted roles never learn that a protected file changed.
      if (hideDotenv && filename && isProtectedDotenvPath(filename)) return;
      rawEvents += 1;
      for (const slot of entry.slots) pendingSlots.set(JSON.stringify(slot), slot);
      if (entry.selectedBasename && (filename === null || filename === entry.selectedBasename)) {
        pendingSlots.set('selected', { kind: 'selected' });
      }
      schedule();
    };

    try {
      lease = await hub.acquire(principalKeyFor(req.principal), scope.watches.map((entry) => entry.directory), onSignal);
    } catch (error) {
      const capacity = error?.code === 'fs_watch_capacity';
      cleanup();
      if (!res.headersSent && !res.destroyed) {
        res.status(503).json({
          error: capacity ? 'File watch capacity reached' : 'File watching is unavailable',
          code: capacity ? 'fs_watch_capacity' : 'fs_watch_unavailable',
          retryable: true,
        });
      }
      return;
    }
    if (closed || res.destroyed) { lease.release(); cleanup(); return; }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.socket?.setNoDelay?.(true);

    queue = createBoundedEventQueue({
      maxBytes: queueMaxBytes,
      maxEntries: FS_WATCH_QUEUE_MAX_ENTRIES,
      sizeOf: (value) => Buffer.byteLength(value, 'utf8'),
      getBufferedBytes: () => res.writableLength ?? res.socket?.writableLength ?? 0,
      deliver: async (value, signal) => {
        if (closed || signal.aborted || res.destroyed) return false;
        if (res.write(value)) return true;
        await new Promise((resolve) => {
          const done = () => {
            res.off('drain', done); res.off('close', done); res.off('error', done);
            signal.removeEventListener('abort', done); resolve();
          };
          res.once('drain', done); res.once('close', done); res.once('error', done);
          signal.addEventListener('abort', done, { once: true });
          if (signal.aborted || res.destroyed) done();
        });
        return !closed && !signal.aborted && !res.destroyed;
      },
      // Backpressure beyond the bound closes the stream; the client falls back and retries.
      onClose: (reason) => { cleanup(); if (reason !== 'cancelled' && !res.destroyed) res.destroy(); },
    });

    // Every watcher is installed before ready.
    void send({ type: 'ready', epoch });

    let heartbeatRunning = false;
    heartbeat = setInterval(async () => {
      if (closed || heartbeatRunning) return;
      heartbeatRunning = true;
      try {
        let current;
        try { current = await authorizeScope(req); } catch { current = null; }
        if (closed) return;
        if (!current?.ok || !sameScope(current, scope)) { finishUnavailable(false, 'unauthorized'); return; }
        try {
          await hub.verify(lease.directories);
        } catch {
          finishUnavailable(true, 'watcher_failed');
          return;
        }
        if (closed) return;
        if (!res.writableNeedDrain) res.write(':heartbeat\n\n');
      } finally {
        heartbeatRunning = false;
      }
    }, heartbeatIntervalMs);
    heartbeat.unref?.();
  };
};
