// ---------------------------------------------------------------------------
// Native session archive state (OpenCode 2.1) and the one-time backfill of
// DevRyan's legacy archive override.
//
// Archive truth is DevRyan's owned override `metadata.devryan.archive =
// {sessionID, at}` (the commit point, still written for one release so the
// kill switch can roll back losslessly). Native `time.archived` is the index
// that lets OpenCode filter and paginate `GET /api/session?archived=` itself.
// Readers accept both: an owned override wins, otherwise native state.
//
// The index can be trusted for a filtered native list only after every legacy
// override has been copied into native state. This module owns that proof:
// a durable receipt per native store, written only after a complete pass in
// which every disagreeing session was aligned. The pass is idempotent (it
// rereads current state and writes only disagreements) and so resumes after a
// restart or a partial failure by running again. It never writes the override,
// so archive state cannot be lost. Running with the kill switch invalidates
// the receipt, because legacy writes leave native state behind.
//
// Kill switch, read on each use: DEVRYAN_NATIVE_ARCHIVE=0 restores the legacy
// metadata-only reads and writes.
// ---------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

export const NATIVE_ARCHIVE_ENV = 'DEVRYAN_NATIVE_ARCHIVE';
export const NATIVE_ARCHIVE_RECEIPT_FILE = 'native-archive-backfill.json';
export const NATIVE_ARCHIVE_RECEIPT_VERSION = 1;
/** After a failed or partial pass, the next one starts no sooner than this. */
export const NATIVE_ARCHIVE_RETRY_MS = 60_000;
/** One session is repaired from a list disagreement at most this often. */
export const NATIVE_ARCHIVE_REPAIR_COOLDOWN_MS = 60_000;
const REPAIR_QUEUE_LIMIT = 64;
const REPAIR_HISTORY_LIMIT = 1_024;
const RECEIPT_MAX_BYTES = 64 * 1024;
const RECEIPT_STATES = new Set(['running', 'incomplete', 'complete', 'invalidated']);

/** @param {Record<string, string | undefined>} [env] */
export const isNativeArchiveEnabled = (env = process.env) => env[NATIVE_ARCHIVE_ENV] !== '0';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const errorCode = (error) => (typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,95}$/.test(error.code) ? error.code : 'native_archive_failed');

/**
 * @typedef {{ sessionID: string, directory: string, archived: boolean, updated?: number }} NativeArchiveTarget
 *   a session whose native state must become `archived` (its owned override's state)
 * @typedef {'migrated' | 'aligned' | 'changed' | 'none'} NativeArchiveAlignment
 * @typedef {{ version: 1, identity: string, state: 'running' | 'incomplete' | 'complete' | 'invalidated',
 *   at: number, migrated?: number, failed?: number }} NativeArchiveReceipt
 */

/** @param {unknown} value @returns {NativeArchiveReceipt | null} */
const parseReceipt = (value) => {
  if (!isRecord(value) || value.version !== NATIVE_ARCHIVE_RECEIPT_VERSION || typeof value.identity !== 'string'
    || !RECEIPT_STATES.has(/** @type {string} */ (value.state)) || !Number.isFinite(value.at)) return null;
  return /** @type {NativeArchiveReceipt} */ (value);
};

/**
 * @param {object} deps
 * @param {string} deps.receiptPath durable receipt file (DevRyan data directory)
 * @param {() => string} deps.storeIdentity the native store the receipt proves (its database path)
 * @param {() => Promise<NativeArchiveTarget[]>} deps.listDisagreements every session whose native state differs from its owned override
 * @param {(target: NativeArchiveTarget) => Promise<NativeArchiveAlignment>} deps.align copy one override's state into native state
 * @param {Pick<typeof fsPromises, 'readFile' | 'writeFile' | 'rename' | 'mkdir' | 'rm'>} [deps.fs]
 * @param {() => number} [deps.now]
 * @param {Record<string, string | undefined>} [deps.env]
 * @param {(diagnostic: Record<string, unknown>) => void} [deps.recordDiagnostic]
 * @param {number} [deps.retryMs]
 * @param {number} [deps.repairCooldownMs]
 */
export const createNativeArchiveMigration = (deps) => {
  const fs = deps.fs ?? fsPromises;
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const recordDiagnostic = typeof deps.recordDiagnostic === 'function' ? deps.recordDiagnostic : () => {};
  const retryMs = deps.retryMs ?? NATIVE_ARCHIVE_RETRY_MS;
  const repairCooldownMs = deps.repairCooldownMs ?? NATIVE_ARCHIVE_REPAIR_COOLDOWN_MS;

  /** @type {NativeArchiveReceipt | null} */
  let receipt = null;
  let loaded = false;
  /** @type {Promise<unknown> | null} */
  let loading = null;
  /** @type {Promise<unknown> | null} */
  let running = null;
  let nextAttemptAt = 0;
  let legacyNoted = false;
  /** @type {Promise<void>} */
  let receiptWrites = Promise.resolve();
  /** @type {Map<string, NativeArchiveTarget>} */
  const repairs = new Map();
  /** @type {Map<string, number>} */
  const repairedAt = new Map();
  let repairing = false;

  const enabled = () => isNativeArchiveEnabled(env);
  const identity = () => {
    const value = deps.storeIdentity();
    if (typeof value !== 'string' || !value) throw Object.assign(new Error('native archive store identity unavailable'), { code: 'native_archive_identity_unavailable' });
    return value;
  };
  const diagnostic = (event, payload = {}, sessionID = undefined) => {
    try { recordDiagnostic({ type: 'lifecycle', event, ...(sessionID ? { sessionID } : {}), payload }); }
    catch { /* Diagnostics never change archive state. */ }
  };

  const readReceipt = async () => {
    let text;
    try { text = await fs.readFile(deps.receiptPath, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    if (text.length > RECEIPT_MAX_BYTES) return null;
    try { return parseReceipt(JSON.parse(text)); } catch { return null; }
  };

  /** Atomic replace; serialized so a later state never loses to an earlier write. */
  const writeReceipt = (value) => {
    const write = receiptWrites.then(async () => {
      await fs.mkdir(path.dirname(deps.receiptPath), { recursive: true });
      const temporary = `${deps.receiptPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temporary, deps.receiptPath);
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    });
    receiptWrites = write.catch(() => {});
    return write;
  };

  const complete = () => {
    if (receipt?.state !== 'complete') return false;
    try { return receipt.identity === identity(); } catch { return false; }
  };

  const load = () => {
    if (loaded) return Promise.resolve();
    loading ??= readReceipt().then((value) => {
      // A receipt written in this process (invalidation) is newer than the file.
      if (!loaded && receipt === null) receipt = value;
      loaded = true;
    }, (error) => {
      diagnostic('native_archive_receipt_unreadable', { code: errorCode(error) });
      loaded = true;
    }).finally(() => { loading = null; });
    return loading;
  };

  /** Legacy writes leave native state behind: the next native run must backfill again. */
  const noteLegacyMode = () => {
    if (legacyNoted) return;
    legacyNoted = true;
    let current = '';
    try { current = identity(); } catch { /* Invalidate whichever store comes next. */ }
    receipt = { version: NATIVE_ARCHIVE_RECEIPT_VERSION, identity: current, state: 'invalidated', at: now() };
    loaded = true;
    writeReceipt(receipt).catch((error) => diagnostic('native_archive_receipt_write_failed', { code: errorCode(error) }));
  };

  const fail = async (store, counts) => {
    nextAttemptAt = now() + retryMs;
    receipt = { version: NATIVE_ARCHIVE_RECEIPT_VERSION, identity: store, state: 'incomplete', at: now(), ...counts };
    await writeReceipt(receipt).catch((error) => diagnostic('native_archive_receipt_write_failed', { code: errorCode(error) }));
  };

  const run = async () => {
    await load();
    if (!enabled()) { noteLegacyMode(); return; }
    if (complete()) return;
    // A later kill-switch run must invalidate this pass's receipt again.
    legacyNoted = false;
    const store = identity();
    await writeReceipt({ version: NATIVE_ARCHIVE_RECEIPT_VERSION, identity: store, state: 'running', at: now() });
    let targets;
    try { targets = await deps.listDisagreements(); }
    catch (error) {
      diagnostic('native_archive_backfill_failed', { stage: 'scan', code: errorCode(error) });
      await fail(store, { migrated: 0, failed: 0 });
      return;
    }
    // Oldest first: native archive moves `time.updated`, so this keeps the
    // relative order of the sessions it touches.
    targets = [...targets].sort((left, right) => (left.updated ?? 0) - (right.updated ?? 0) || (left.sessionID < right.sessionID ? -1 : 1));
    let migrated = 0, failed = 0;
    for (const target of targets) {
      if (!enabled()) { noteLegacyMode(); return; }
      try {
        if (await deps.align(target) === 'migrated') migrated += 1;
      } catch (error) {
        failed += 1;
        diagnostic('native_archive_backfill_failed', { stage: 'align', code: errorCode(error) }, target.sessionID);
      }
    }
    if (!enabled()) { noteLegacyMode(); return; }
    if (failed > 0) {
      await fail(store, { migrated, failed });
      diagnostic('native_archive_backfill', { outcome: 'incomplete', migrated, failed, scanned: targets.length });
      return;
    }
    // Trusted only once durable: a failed write leaves the pass to run again.
    const done = { version: NATIVE_ARCHIVE_RECEIPT_VERSION, identity: store, state: 'complete', at: now(), migrated };
    await writeReceipt(done);
    receipt = done;
    diagnostic('native_archive_backfill', { outcome: 'complete', migrated, scanned: targets.length });
  };

  /** Starts a backfill pass unless one runs, the receipt is complete or the retry delay holds. */
  const schedule = () => {
    if (running || !enabled() || now() < nextAttemptAt) return running;
    running = run().catch((error) => {
      nextAttemptAt = now() + retryMs;
      diagnostic('native_archive_backfill_failed', { stage: 'receipt', code: errorCode(error) });
    }).finally(() => { running = null; });
    return running;
  };

  const drainRepairs = async () => {
    if (repairing) return;
    repairing = true;
    try {
      while (repairs.size > 0) {
        const [sessionID, target] = repairs.entries().next().value;
        repairs.delete(sessionID);
        if (!enabled()) continue;
        try { await deps.align(target); }
        catch (error) { diagnostic('native_archive_repair_failed', { code: errorCode(error) }, sessionID); }
      }
    } finally { repairing = false; }
  };

  return Object.freeze({
    /** Loads the receipt (or invalidates it under the kill switch); never scans. */
    start() {
      if (!enabled()) { noteLegacyMode(); return Promise.resolve(); }
      return load();
    },
    /**
     * True when a filtered native list matches the projected archive state.
     * Otherwise it starts the backfill in the background and returns false.
     */
    filterReady() {
      if (!enabled()) { noteLegacyMode(); return false; }
      if (!loaded) { void load().then(() => { if (!complete()) schedule(); }); return false; }
      if (complete()) return true;
      schedule();
      return false;
    },
    /** A list row whose native state differs from its projected (override) state. */
    reportDisagreement(target) {
      if (!enabled() || !isRecord(target) || typeof target.sessionID !== 'string' || typeof target.directory !== 'string'
        || typeof target.archived !== 'boolean') return;
      const last = repairedAt.get(target.sessionID);
      if ((last !== undefined && now() - last < repairCooldownMs) || repairs.size >= REPAIR_QUEUE_LIMIT) return;
      repairedAt.delete(target.sessionID);
      repairedAt.set(target.sessionID, now());
      if (repairedAt.size > REPAIR_HISTORY_LIMIT) repairedAt.delete(repairedAt.keys().next().value);
      repairs.set(target.sessionID, { sessionID: target.sessionID, directory: target.directory, archived: target.archived });
      void drainRepairs();
    },
    noteLegacyMode,
    /** Test and diagnostics hook: settles the current backfill pass and receipt writes. */
    async settle() {
      await loading;
      await running;
      await receiptWrites;
      while (repairing || repairs.size > 0) await new Promise((resolve) => setTimeout(resolve, 1));
    },
    /** Runs one backfill pass now (ignores the retry delay) and returns the resulting receipt. */
    async backfill() {
      nextAttemptAt = 0;
      await (schedule() ?? Promise.resolve());
      await receiptWrites;
      return receipt;
    },
  });
};
