import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const COUNTERS = ['bytesIndexed', 'bytesSandboxed', 'cacheHits', 'cacheMisses', 'cacheBytesSaved'];
const number = (value) => Number.isFinite(value) && value >= 0 ? value : 0;
const toolName = (name) => /^ctx_[a-z_]{1,64}$/.test(name);
export const emptyStats = () => ({ calls: {}, bytesReturned: {}, bytesIndexed: 0, bytesSandboxed: 0,
  cacheHits: 0, cacheMisses: 0, cacheBytesSaved: 0, sessionStart: Date.now() });

export function statsDelta(before, after) {
  const delta = emptyStats();
  for (const field of COUNTERS) delta[field] = Math.max(0, number(after[field]) - number(before[field]));
  for (const field of ['calls', 'bytesReturned']) {
    for (const [tool, value] of Object.entries(after[field] || {})) {
      if (toolName(tool)) delta[field][tool] = Math.max(0, number(value) - number(before[field]?.[tool]));
    }
  }
  return delta;
}

const restoreStats = (payload) => {
  const stats = emptyStats();
  for (const [tool, row] of Object.entries(payload?.by_tool || {})) {
    if (!toolName(tool)) continue;
    stats.calls[tool] = number(row?.calls);
    stats.bytesReturned[tool] = number(row?.bytes);
  }
  for (const [field, key] of Object.entries({ bytesIndexed: 'bytes_indexed', bytesSandboxed: 'bytes_sandboxed',
    cacheHits: 'cache_hits', cacheMisses: 'cache_misses', cacheBytesSaved: 'cache_bytes_saved' })) stats[field] = number(payload?.[key]);
  stats.sessionStart = number(payload?.session_start) || stats.sessionStart;
  return stats;
};

export function statsPayload(stats, { version = '1.0.169', price = 0.000015, lifetimeTokens = 0 } = {}) {
  const totalCalls = Object.values(stats.calls).reduce((sum, value) => sum + value, 0);
  const returned = Object.values(stats.bytesReturned).reduce((sum, value) => sum + value, 0);
  const kept = stats.bytesIndexed + stats.bytesSandboxed + stats.cacheBytesSaved;
  const tokens = Math.round(kept / 4);
  const now = Date.now();
  return { schemaVersion: 2, version, updated_at: now, session_start: stats.sessionStart,
    uptime_ms: now - stats.sessionStart, total_calls: totalCalls, bytes_returned: returned,
    bytes_indexed: stats.bytesIndexed, bytes_sandboxed: stats.bytesSandboxed, cache_hits: stats.cacheHits,
    cache_misses: stats.cacheMisses, cache_bytes_saved: stats.cacheBytesSaved, kept_out: kept,
    total_processed: kept + returned, reduction_pct: kept + returned > 0 ? Math.round(100 * kept / (kept + returned)) : 0,
    tokens_saved: tokens, dollars_saved_session: +(tokens * price).toFixed(2),
    tokens_saved_lifetime: lifetimeTokens, dollars_saved_lifetime: +(lifetimeTokens * price).toFixed(2),
    by_tool: Object.fromEntries(Object.keys({ ...stats.calls, ...stats.bytesReturned }).map((tool) =>
      [tool, { calls: stats.calls[tool] || 0, bytes: stats.bytesReturned[tool] || 0 }])) };
}

// One owner for statistics files and lock identities per real database path.
// Workers hold file locks only for storage operations, never complete calls.
export class ContextModeWorkerState {
  constructor({ flushMs = 500, maxStats = 256, directory = tmpdir(), fsApi = fs, onError = () => {} } = {}) {
    Object.assign(this, { flushMs, maxStats, directory, fsApi, onError });
    this.storage = new Map();
    this.stats = new Map();
    this.closed = false;
  }

  async canonicalPath(file) {
    if (!path.isAbsolute(file)) throw new Error('Worker storage path must be absolute');
    try { return await this.fsApi.realpath(file); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return path.join(await this.fsApi.realpath(path.dirname(file)), path.basename(file));
    }
  }

  async prepare(slot, { storagePaths, statsPath }) {
    const paths = await Promise.all(storagePaths.map((file) => this.canonicalPath(file)));
    const statsFile = await this.canonicalPath(statsPath);
    if (this.closed || slot.exited || slot.terminating) throw new Error('Worker state is closed');
    this.root ??= this.fsApi.mkdtemp(path.join(this.directory, 'devryan-worker-locks-'));
    const root = await this.root;
    if (!slot.ownerToken) {
      slot.ownerToken = path.join(root, `owner-${slot.owner}`);
      await this.fsApi.writeFile(slot.ownerToken, '', { mode: 0o600 });
    }
    if (slot.cancellationPath) await this.fsApi.unlink(slot.cancellationPath).catch(() => {});
    slot.cancellationPath = path.join(root, `cancel-${slot.owner}-${randomUUID()}`);
    if (this.closed || slot.exited || slot.terminating) {
      await this.release(slot);
      throw new Error('Worker state is closed');
    }
    const locks = paths.map((file, index) => {
      let entry = this.storage.get(file);
      if (!entry) {
        entry = { lockPath: path.join(root, `lock-${randomUUID()}`), owners: new Set() };
        this.storage.set(file, entry);
      }
      entry.owners.add(slot);
      slot.storageEntries ??= new Map();
      slot.storageEntries.set(file, entry);
      return { path: storagePaths[index], lockPath: entry.lockPath };
    });
    let entry = this.stats.get(statsFile);
    if (slot.statsEntry) slot.statsEntry.owners.delete(slot);
    if (!entry) {
      entry = { stats: emptyStats(), owners: new Set(), used: Date.now(), revision: 0, persisted: 0 };
      this.stats.set(statsFile, entry);
      entry.ready = this.fsApi.readFile(statsFile, 'utf8').then((raw) => {
        const payload = JSON.parse(raw);
        entry.stats = restoreStats(payload);
        entry.lifetimeTokens = number(payload.tokens_saved_lifetime);
      }).catch((error) => { if (error.code !== 'ENOENT') this.onError(); });
    }
    entry.owners.add(slot);
    await entry.ready;
    if (this.closed || slot.exited || slot.terminating) {
      await this.release(slot);
      throw new Error('Worker state is closed');
    }
    slot.statsEntry = entry;
    slot.statsPath = statsFile;
    entry.used = Date.now();
    this.trimStats();
    return { locks, ownerToken: slot.ownerToken, cancellationPath: slot.cancellationPath, stats: structuredClone(entry.stats) };
  }

  update(slot, delta, options = {}) {
    const entry = slot.statsEntry;
    if (!entry || !delta) return;
    for (const field of COUNTERS) entry.stats[field] += number(delta[field]);
    for (const field of ['calls', 'bytesReturned']) {
      for (const [tool, value] of Object.entries(delta[field] || {})) {
        if (toolName(tool)) entry.stats[field][tool] = (entry.stats[field][tool] || 0) + number(value);
      }
    }
    entry.price = Number.isFinite(options.price) && options.price >= 0 ? options.price : 0.000015;
    if (Number.isFinite(options.lifetimeTokens) && options.lifetimeTokens >= 0) entry.lifetimeTokens = options.lifetimeTokens;
    entry.revision++;
    entry.used = Date.now();
    if (!entry.timer && !this.closed) {
      const file = slot.statsPath;
      entry.timer = setTimeout(() => {
        entry.timer = null;
        void this.flush(file, entry);
      }, this.flushMs);
      entry.timer.unref?.();
    }
  }

  flush(file, entry) {
    if (entry.writing) return entry.writing;
    entry.writing = (async () => {
      while (entry.persisted < entry.revision) {
        const revision = entry.revision;
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          await this.fsApi.writeFile(temporary, JSON.stringify(statsPayload(entry.stats, entry)), { mode: 0o600 });
          await this.fsApi.rename(temporary, file);
          entry.persisted = revision;
        } catch {
          await this.fsApi.unlink(temporary).catch(() => {});
          this.onError();
          break;
        }
      }
    })().finally(() => { entry.writing = null; this.trimStats(); });
    return entry.writing;
  }

  release(slot) {
    for (const entry of this.stats.values()) entry.owners.delete(slot);
    this.trimStats();
    if (!slot.exited || !slot.ownerToken) return;
    return (async () => {
      const token = await this.fsApi.stat(slot.ownerToken, { bigint: true }).catch(() => null);
      for (const [file, entry] of slot.storageEntries ?? []) {
        entry.owners.delete(slot);
        const lock = await this.fsApi.stat(entry.lockPath, { bigint: true }).catch(() => null);
        // A dead process cannot release or reacquire this link between the
        // identity check and unlink. Never clear a surviving sibling's lock.
        if (token && lock && lock.dev === token.dev && lock.ino === token.ino) {
          await this.fsApi.unlink(entry.lockPath).catch(() => {});
        }
        if (!entry.owners.size && this.storage.get(file) === entry) this.storage.delete(file);
      }
      await this.fsApi.unlink(slot.ownerToken).catch(() => {});
      if (slot.cancellationPath) await this.fsApi.unlink(slot.cancellationPath).catch(() => {});
    })().catch(() => this.onError());
  }

  trimStats() {
    const idle = [...this.stats].filter(([, entry]) => !entry.owners.size && !entry.writing && !entry.timer
      && entry.persisted === entry.revision).sort((a, b) => a[1].used - b[1].used);
    while (this.stats.size > this.maxStats && idle.length) this.stats.delete(idle.shift()[0]);
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.stats].map(([file, entry]) => {
      clearTimeout(entry.timer);
      entry.timer = null;
      return this.flush(file, entry);
    }));
  }

  dispose() {
    this.disposal ??= (async () => {
      if (this.root) await this.fsApi.rm(await this.root, { recursive: true, force: true });
    })();
    return this.disposal;
  }
}
