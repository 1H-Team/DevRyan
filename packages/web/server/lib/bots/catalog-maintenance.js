import { randomUUID } from 'node:crypto';

import { validateBotCatalogCandidate } from './catalog-validation.js';

// Owner-facing catalog maintenance: daily and pre-change backups, restore into
// a verified candidate, Start Empty and the post-import/restore activation
// hold. Every operation runs under the runtime's maintenance fence and the
// Electron lifecycle queue; scheduled backups never force-abort Bot work.

const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SCHEDULE_CHECK_MS = 60 * 60 * 1000;
const BUSY_RETRY_MS = 15 * 60 * 1000;
const RESTORE_DRAIN_MS = 120_000;
const BACKUP_DRAIN_MS = 30_000;
const BACKUP_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;

export const BOT_RESTORE_CONFIRMATION = 'RESTORE';
export const BOT_START_EMPTY_CONFIRMATION = 'START EMPTY';

export class BotCatalogMaintenanceError extends Error {
  constructor(message, code, statusCode = 409) {
    super(message);
    this.name = 'BotCatalogMaintenanceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotCatalogMaintenanceError(message, code, statusCode);
};

export function createBotCatalogMaintenance({
  maintenance,
  runMaintenance,
  activationHold,
  encryption,
  isCatalogUsable,
  resumeAutonomousWork = async () => {},
  // True while a runtime maintenance operation (for example an import) holds
  // the fence; resuming then would race its activation hold.
  isMaintenanceActive = () => false,
  recordDiagnostic = () => {},
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof runMaintenance !== 'function' || typeof activationHold?.hold !== 'function'
    || typeof isCatalogUsable !== 'function') {
    throw new TypeError('Bot catalog maintenance is misconfigured');
  }
  let lastDailyAt = null;
  let lastResult = null;
  let timer = null;
  let stopped = false;
  let running = null;

  const requireMaintenance = () => {
    if (!maintenance || typeof maintenance.backup !== 'function') {
      fail('Bot catalog maintenance is unavailable on this host', 'bot_backup_unavailable', 503);
    }
    return maintenance;
  };

  const record = (kind, outcome, code = null) => {
    lastResult = Object.freeze({ kind, outcome, code, at: new Date(now()).toISOString() });
    recordDiagnostic({ type: 'lifecycle', event: 'bot.catalog.maintenance', payload: { kind, outcome, code } });
  };

  const single = (operation) => {
    if (running) fail('Another catalog operation is running', 'bots_maintenance_busy', 409);
    running = (async () => operation())().finally(() => { running = null; });
    return running;
  };

  const backupNow = ({ kind = 'manual', drainTimeoutMs = BACKUP_DRAIN_MS } = {}) => single(async () => {
    const host = requireMaintenance();
    if (!isCatalogUsable()) fail('The local Bot catalog is not available to back up', 'bot_database_unavailable', 503);
    try {
      const backup = await runMaintenance('backup', () => host.backup({ kind }), { drainTimeoutMs });
      if (kind === 'daily') lastDailyAt = Date.parse(backup.createdAt) || now();
      record(kind, 'verified');
      return backup;
    } catch (error) {
      record(kind, 'failed', typeof error?.code === 'string' ? error.code : 'bot_backup_failed');
      throw error;
    }
  });

  const listBackups = async () => {
    const backups = await requireMaintenance().listBackups();
    const daily = backups.find((backup) => backup.kind === 'daily');
    if (daily) lastDailyAt = Math.max(lastDailyAt || 0, Date.parse(daily.createdAt) || 0);
    return backups;
  };

  const validateCandidate = async (candidate, { missingVaultRecord = 'reject' } = {}) => validateBotCatalogCandidate({
    readPage: (request) => requireMaintenance().readCandidate(candidate.operationId, request),
    encryption,
    objectsDirectory: candidate.objectsDirectory,
    hostStateDirectory: candidate.hostStateDirectory,
    missingVaultRecord,
  });

  // Restore: back up the current catalog when it is usable, restore the
  // chosen backup into an inaccessible candidate, authenticate every
  // envelope/object/vault record, persist the activation hold, then swap and
  // post-verify. The retained unit stays recoverable until then.
  const restore = ({ backupId, confirmation } = {}) => single(async () => {
    if (confirmation !== BOT_RESTORE_CONFIRMATION) {
      fail('Restoring requires explicit confirmation', 'bot_restore_confirmation_required', 400);
    }
    if (!BACKUP_ID_PATTERN.test(backupId || '')) fail('The backup identifier is invalid', 'bot_backup_request_invalid', 400);
    const host = requireMaintenance();
    const operationId = randomUUID();
    try {
      const result = await runMaintenance('restore', async ({ markReplaced }) => {
        if (isCatalogUsable()) await host.backup({ kind: 'pre_restore' });
        const candidate = await host.prepareRestore(backupId);
        const previousHold = activationHold.get();
        let held = false;
        try {
          await validateCandidate(candidate);
          await activationHold.hold({ reason: 'restore', operationId });
          held = true;
          const committed = await host.commitRestore(candidate.operationId);
          markReplaced();
          return committed;
        } catch (error) {
          await host.discardCandidate(candidate.operationId).catch(() => undefined);
          // The original catalog is still live and unchanged, and so is any
          // hold it already had.
          if (held) await activationHold.reinstate(previousHold).catch(() => undefined);
          throw error;
        }
      }, { drainTimeoutMs: RESTORE_DRAIN_MS, replacesDatabase: true });
      record('restore', 'completed');
      return Object.freeze({ ...result, activationHold: activationHold.get() });
    } catch (error) {
      record('restore', 'failed', typeof error?.code === 'string' ? error.code : 'bot_restore_failed');
      throw error;
    }
  });

  // Start Empty: owner-confirmed, preserves remaining recovery evidence (the
  // previous database and objects are retired, never deleted).
  const startEmpty = ({ confirmation } = {}) => single(async () => {
    if (confirmation !== BOT_START_EMPTY_CONFIRMATION) {
      fail('Starting empty requires explicit confirmation', 'bot_start_empty_confirmation_required', 400);
    }
    const host = requireMaintenance();
    try {
      const result = await runMaintenance('start_empty', async ({ markReplaced }) => {
        if (isCatalogUsable()) await host.backup({ kind: 'pre_start_empty' });
        const started = await host.startEmpty();
        markReplaced();
        return started;
      }, { drainTimeoutMs: RESTORE_DRAIN_MS, replacesDatabase: true });
      record('start_empty', 'completed');
      return result;
    } catch (error) {
      record('start_empty', 'failed', typeof error?.code === 'string' ? error.code : 'bot_start_empty_failed');
      throw error;
    }
  });

  const resumeActivation = () => single(async () => {
    if (isMaintenanceActive()) fail('Bots are busy with a catalog operation; try again when it finishes', 'bots_maintenance_busy', 409);
    if (!activationHold.isHeld()) return Object.freeze({ resumed: false });
    await activationHold.release();
    await resumeAutonomousWork();
    recordDiagnostic({ type: 'lifecycle', event: 'bot.catalog.activation_resumed', payload: {} });
    return Object.freeze({ resumed: true });
  });

  const scheduleNext = (delay) => {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void tick();
    }, delay);
    timer.unref?.();
  };

  const tick = async () => {
    if (stopped) return;
    try {
      if (!maintenance || !isCatalogUsable() || running) {
        scheduleNext(SCHEDULE_CHECK_MS);
        return;
      }
      if (lastDailyAt === null) await listBackups().catch(() => undefined);
      if (lastDailyAt !== null && now() - lastDailyAt < DAILY_INTERVAL_MS) {
        scheduleNext(Math.min(SCHEDULE_CHECK_MS, DAILY_INTERVAL_MS - (now() - lastDailyAt) + 60_000));
        return;
      }
      await backupNow({ kind: 'daily' });
      scheduleNext(SCHEDULE_CHECK_MS);
    } catch (error) {
      // Busy work is never interrupted; the backup waits for a quieter moment.
      scheduleNext(error?.code === 'bots_maintenance_busy' ? BUSY_RETRY_MS : SCHEDULE_CHECK_MS);
    }
  };

  return Object.freeze({
    available: () => Boolean(maintenance && typeof maintenance.backup === 'function'),
    status: () => Object.freeze({
      backupsAvailable: Boolean(maintenance && typeof maintenance.backup === 'function'),
      lastDailyAt: lastDailyAt ? new Date(lastDailyAt).toISOString() : null,
      lastResult,
      running: running !== null,
      activationHold: activationHold.get(),
    }),
    listBackups,
    backupNow,
    restore,
    startEmpty,
    resumeActivation,
    validateCandidate,
    start() {
      stopped = false;
      scheduleNext(5 * 60 * 1000);
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
  });
}
