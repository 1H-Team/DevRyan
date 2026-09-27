import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBotActivationHold } from './activation-hold.js';
import {
  BOT_RESTORE_CONFIRMATION,
  BOT_START_EMPTY_CONFIRMATION,
  BotCatalogMaintenanceError,
  createBotCatalogMaintenance,
} from './catalog-maintenance.js';
import { messageAssociatedData } from './channels.js';
import { encryptBotJson } from './encryption.js';

const KEY = Buffer.alloc(32, 0x42);
const OTHER_KEY = Buffer.alloc(32, 0x24);
const BACKUP_ID = '20260926T010203Z-0a1b2c3d';
const START = Date.parse('2026-09-26T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const temporaryDirectory = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-bot-catalog-maintenance-'));
  directories.push(directory);
  return directory;
};

const manualTimers = () => {
  const pending = [];
  return {
    setTimer: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      pending.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = pending.indexOf(timer);
      if (index >= 0) pending.splice(index, 1);
    },
    pending,
  };
};

const settle = async (condition = () => true) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (condition()) return;
  }
  throw new Error('The maintenance schedule did not settle');
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const messageRow = (key = KEY) => {
  const id = randomUUID();
  const channelId = randomUUID();
  return {
    id,
    channel_id: channelId,
    body_envelope: encryptBotJson({ key, keyId: 'deployment-v1', value: { text: 'restored' }, associatedData: messageAssociatedData(channelId, id) }),
  };
};

// Throws synchronously or rejects: callers only observe a rejected await.
const attempt = (operation) => Promise.resolve().then(operation);

const setup = ({ usable = true, backups = [], candidateTables = {}, maintenanceHost, ...overrides } = {}) => {
  const root = temporaryDirectory();
  const events = [];
  const diagnostics = [];
  const timers = manualTimers();
  const clock = { now: START };
  const activationHold = createBotActivationHold({ dataDirectory: root });
  const candidate = Object.freeze({
    operationId: randomUUID(),
    objectsDirectory: path.join(root, 'candidate', 'objects'),
    hostStateDirectory: path.join(root, 'candidate', 'host-state'),
  });
  const state = { usable, holdAtCommit: undefined, holdFileAtCommit: undefined };

  const host = {
    backup: vi.fn(async ({ kind }) => {
      events.push(`backup:${kind}`);
      return { id: BACKUP_ID, kind, createdAt: new Date(clock.now).toISOString(), verifiedAt: new Date(clock.now).toISOString() };
    }),
    listBackups: vi.fn(async () => structuredClone(backups)),
    prepareRestore: vi.fn(async (backupId) => {
      events.push(`prepareRestore:${backupId}`);
      return candidate;
    }),
    readCandidate: vi.fn(async (operationId, { table, afterId }) => {
      events.push(`read:${table}`);
      if (operationId !== candidate.operationId) throw new Error('unexpected candidate');
      return afterId === null ? structuredClone(candidateTables[table] || []) : [];
    }),
    commitRestore: vi.fn(async (operationId) => {
      events.push('commitRestore');
      state.holdAtCommit = activationHold.get();
      state.holdFileAtCommit = fs.existsSync(activationHold.path)
        ? JSON.parse(fs.readFileSync(activationHold.path, 'utf8'))
        : null;
      return { operationId, retiredDatabase: 'devryan_bots_retired_fixture' };
    }),
    discardCandidate: vi.fn(async (operationId) => {
      events.push(`discardCandidate:${operationId}`);
    }),
    startEmpty: vi.fn(async () => {
      events.push('startEmpty');
      return { operationId: randomUUID(), retiredDatabase: 'devryan_bots_retired_empty' };
    }),
  };

  const maintenanceCalls = [];
  const runMaintenance = vi.fn(async (kind, operation, options) => {
    const call = { kind, options, replaced: false };
    maintenanceCalls.push(call);
    events.push(`maintenance:${kind}`);
    return operation({
      markReplaced: () => {
        call.replaced = true;
        events.push('markReplaced');
      },
    });
  });
  const resumeAutonomousWork = vi.fn(async () => {});

  const maintenance = createBotCatalogMaintenance({
    maintenance: maintenanceHost === undefined ? host : maintenanceHost,
    runMaintenance,
    activationHold,
    encryption: { getKey: async () => Buffer.from(KEY) },
    isCatalogUsable: () => state.usable,
    resumeAutonomousWork,
    recordDiagnostic: (entry) => diagnostics.push(entry),
    now: () => clock.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides,
  });

  const fire = async () => {
    const timer = timers.pending.shift();
    if (!timer) throw new Error('No scheduled maintenance check');
    timer.callback();
    await settle(() => timers.pending.length === 1);
    return timers.pending[0];
  };

  return {
    root, events, diagnostics, timers, clock, activationHold, candidate, state, host,
    runMaintenance, maintenanceCalls, resumeAutonomousWork, maintenance, fire,
  };
};

describe('Bot catalog maintenance', () => {
  it('requires its runtime collaborators', () => {
    const activationHold = createBotActivationHold({ dataDirectory: temporaryDirectory() });
    const valid = { runMaintenance: async () => {}, activationHold, isCatalogUsable: () => true };
    expect(() => createBotCatalogMaintenance()).toThrow(TypeError);
    expect(() => createBotCatalogMaintenance({ ...valid, runMaintenance: null })).toThrow(TypeError);
    expect(() => createBotCatalogMaintenance({ ...valid, activationHold: {} })).toThrow(TypeError);
    expect(() => createBotCatalogMaintenance({ ...valid, isCatalogUsable: true })).toThrow(TypeError);
    expect(() => createBotCatalogMaintenance(valid)).not.toThrow();
  });

  it('reports a frozen status snapshot', async () => {
    const { maintenance, clock } = setup();
    const initial = maintenance.status();
    expect(initial).toEqual({
      backupsAvailable: true,
      lastDailyAt: null,
      lastResult: null,
      running: false,
      activationHold: null,
    });
    expect(Object.isFrozen(initial)).toBe(true);
    expect(maintenance.available()).toBe(true);

    await maintenance.backupNow({ kind: 'daily' });
    expect(maintenance.status()).toEqual({
      backupsAvailable: true,
      lastDailyAt: new Date(clock.now).toISOString(),
      lastResult: { kind: 'daily', outcome: 'verified', code: null, at: new Date(clock.now).toISOString() },
      running: false,
      activationHold: null,
    });
  });

  it('reports backups as unavailable without an Electron maintenance host', async () => {
    const { maintenance, runMaintenance } = setup({ maintenanceHost: null });
    expect(maintenance.available()).toBe(false);
    expect(maintenance.status().backupsAvailable).toBe(false);
    await expect(attempt(() => maintenance.backupNow())).rejects.toMatchObject({
      code: 'bot_backup_unavailable', statusCode: 503,
    });
    await expect(maintenance.listBackups()).rejects.toMatchObject({ code: 'bot_backup_unavailable' });
    expect(runMaintenance).not.toHaveBeenCalled();
  });

  describe('backups', () => {
    it('takes a manual backup under the maintenance fence without touching the daily clock', async () => {
      const { maintenance, host, maintenanceCalls, diagnostics } = setup();
      const backup = await maintenance.backupNow();
      expect(backup).toMatchObject({ id: BACKUP_ID, kind: 'manual' });
      expect(host.backup).toHaveBeenCalledWith({ kind: 'manual' });
      expect(maintenanceCalls).toEqual([{ kind: 'backup', options: { drainTimeoutMs: 30_000 }, replaced: false }]);
      expect(maintenance.status().lastDailyAt).toBeNull();
      expect(maintenance.status().lastResult).toMatchObject({ kind: 'manual', outcome: 'verified' });
      expect(diagnostics).toContainEqual({
        type: 'lifecycle', event: 'bot.catalog.maintenance', payload: { kind: 'manual', outcome: 'verified', code: null },
      });
    });

    it('refuses to back up an unusable catalog', async () => {
      const { maintenance, runMaintenance } = setup({ usable: false });
      await expect(attempt(() => maintenance.backupNow())).rejects.toMatchObject({
        name: 'BotCatalogMaintenanceError', code: 'bot_database_unavailable', statusCode: 503,
      });
      expect(runMaintenance).not.toHaveBeenCalled();
    });

    it('records a failed backup with its code and frees the operation slot', async () => {
      const { maintenance, runMaintenance } = setup();
      runMaintenance.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'bots_maintenance_busy' }));
      await expect(maintenance.backupNow()).rejects.toMatchObject({ code: 'bots_maintenance_busy' });
      expect(maintenance.status()).toMatchObject({
        running: false, lastResult: { kind: 'manual', outcome: 'failed', code: 'bots_maintenance_busy' },
      });

      runMaintenance.mockRejectedValueOnce(new Error('no code'));
      await expect(maintenance.backupNow()).rejects.toThrow('no code');
      expect(maintenance.status().lastResult).toMatchObject({ outcome: 'failed', code: 'bot_backup_failed' });

      await expect(maintenance.backupNow()).resolves.toMatchObject({ kind: 'manual' });
    });

    it('learns the most recent daily backup from the host listing', async () => {
      const newest = new Date(START - 2 * HOUR).toISOString();
      const { maintenance } = setup({
        backups: [
          { id: BACKUP_ID, kind: 'manual', createdAt: new Date(START - HOUR).toISOString() },
          { id: BACKUP_ID, kind: 'daily', createdAt: newest },
          { id: BACKUP_ID, kind: 'daily', createdAt: new Date(START - 3 * DAY).toISOString() },
        ],
      });
      await expect(maintenance.listBackups()).resolves.toHaveLength(3);
      expect(maintenance.status().lastDailyAt).toBe(newest);
    });
  });

  describe('single flight', () => {
    it('refuses a second catalog operation while one is running', async () => {
      const { maintenance, runMaintenance, host } = setup();
      const gate = deferred();
      runMaintenance.mockImplementationOnce(async (_kind, operation) => {
        await gate.promise;
        return operation({ markReplaced: () => {} });
      });

      const first = maintenance.backupNow();
      expect(maintenance.status().running).toBe(true);
      for (const second of [
        () => maintenance.backupNow(),
        () => maintenance.restore({ backupId: BACKUP_ID, confirmation: BOT_RESTORE_CONFIRMATION }),
        () => maintenance.startEmpty({ confirmation: BOT_START_EMPTY_CONFIRMATION }),
      ]) {
        const failure = await attempt(second).catch((error) => error);
        expect(failure).toBeInstanceOf(BotCatalogMaintenanceError);
        expect(failure).toMatchObject({ code: 'bots_maintenance_busy', statusCode: 409 });
      }
      expect(runMaintenance).toHaveBeenCalledTimes(1);

      gate.resolve();
      await expect(first).resolves.toMatchObject({ kind: 'manual' });
      expect(maintenance.status().running).toBe(false);
      expect(host.prepareRestore).not.toHaveBeenCalled();
      expect(host.startEmpty).not.toHaveBeenCalled();
      await expect(maintenance.backupNow()).resolves.toMatchObject({ kind: 'manual' });
    });
  });

  describe('restore', () => {
    it('requires the exact RESTORE confirmation and a valid backup id', async () => {
      const { maintenance, runMaintenance, host } = setup();
      for (const confirmation of [undefined, '', 'restore', 'RESTORE ', 'START EMPTY']) {
        await expect(maintenance.restore({ backupId: BACKUP_ID, confirmation })).rejects.toMatchObject({
          code: 'bot_restore_confirmation_required', statusCode: 400,
        });
      }
      await expect(maintenance.restore()).rejects.toMatchObject({ code: 'bot_restore_confirmation_required' });
      for (const backupId of [undefined, 'latest', '../20260926T010203Z-0a1b2c3d', '20260926T010203Z-0A1B2C3D']) {
        await expect(maintenance.restore({ backupId, confirmation: BOT_RESTORE_CONFIRMATION })).rejects.toMatchObject({
          code: 'bot_backup_request_invalid', statusCode: 400,
        });
      }
      expect(runMaintenance).not.toHaveBeenCalled();
      expect(host.backup).not.toHaveBeenCalled();
      expect(maintenance.status().running).toBe(false);
    });

    it('backs up, validates, persists the hold, then commits a restore', async () => {
      const context = setup({ candidateTables: { bot_messages: [messageRow()] } });
      const { maintenance, events, host, candidate, state, activationHold, maintenanceCalls, clock } = context;

      const result = await maintenance.restore({ backupId: BACKUP_ID, confirmation: BOT_RESTORE_CONFIRMATION });

      const firstRead = events.findIndex((event) => event.startsWith('read:'));
      const lastRead = events.findLastIndex((event) => event.startsWith('read:'));
      const commit = events.indexOf('commitRestore');
      expect(events.slice(0, firstRead)).toEqual(['maintenance:restore', 'backup:pre_restore', `prepareRestore:${BACKUP_ID}`]);
      expect(events.slice(firstRead, lastRead + 1)).toContain('read:bot_telegram_connections');
      expect(events.slice(lastRead + 1)).toEqual(['commitRestore', 'markReplaced']);
      expect(firstRead).toBeLessThan(commit);
      expect(host.commitRestore).toHaveBeenCalledWith(candidate.operationId);
      expect(host.discardCandidate).not.toHaveBeenCalled();
      expect(maintenanceCalls).toEqual([{
        kind: 'restore', options: { drainTimeoutMs: 120_000, replacesDatabase: true }, replaced: true,
      }]);

      // The hold was durable before the swap and survives a restart.
      expect(state.holdAtCommit).toMatchObject({ version: 1, reason: 'restore' });
      expect(state.holdAtCommit.operationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(state.holdFileAtCommit).toEqual({ ...state.holdAtCommit });
      expect(createBotActivationHold({ dataDirectory: context.root }).get()).toEqual(state.holdAtCommit);

      expect(result).toEqual({
        operationId: candidate.operationId,
        retiredDatabase: 'devryan_bots_retired_fixture',
        activationHold: activationHold.get(),
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(maintenance.status()).toMatchObject({
        running: false,
        activationHold: state.holdAtCommit,
        lastResult: { kind: 'restore', outcome: 'completed', code: null, at: new Date(clock.now).toISOString() },
      });
    });

    it('skips the pre-restore backup when the live catalog is unusable', async () => {
      const { maintenance, host, events } = setup({ usable: false });
      await maintenance.restore({ backupId: BACKUP_ID, confirmation: BOT_RESTORE_CONFIRMATION });
      expect(host.backup).not.toHaveBeenCalled();
      expect(events.slice(0, 2)).toEqual(['maintenance:restore', `prepareRestore:${BACKUP_ID}`]);
      expect(host.commitRestore).toHaveBeenCalledTimes(1);
    });

    it('discards a candidate that fails validation and never commits or holds', async () => {
      const { maintenance, events, host, candidate, activationHold, maintenanceCalls } = setup({
        candidateTables: { bot_messages: [messageRow(OTHER_KEY)] },
      });

      await expect(maintenance.restore({ backupId: BACKUP_ID, confirmation: BOT_RESTORE_CONFIRMATION })).rejects.toMatchObject({
        name: 'BotCatalogValidationError', code: 'bot_catalog_envelope_invalid', statusCode: 422,
      });

      expect(host.commitRestore).not.toHaveBeenCalled();
      expect(host.discardCandidate).toHaveBeenCalledWith(candidate.operationId);
      expect(events.at(-1)).toBe(`discardCandidate:${candidate.operationId}`);
      expect(events).not.toContain('markReplaced');
      expect(maintenanceCalls[0].replaced).toBe(false);
      expect(activationHold.isHeld()).toBe(false);
      expect(fs.existsSync(activationHold.path)).toBe(false);
      expect(maintenance.status()).toMatchObject({
        running: false, lastResult: { kind: 'restore', outcome: 'failed', code: 'bot_catalog_envelope_invalid' },
      });
    });

    it('releases its own hold and discards the candidate when the commit fails', async () => {
      const { maintenance, host, candidate, state, activationHold, maintenanceCalls } = setup();
      host.commitRestore.mockImplementationOnce(async () => {
        state.holdAtCommit = activationHold.get();
        throw Object.assign(new Error('swap failed'), { code: 'bot_restore_swap_failed' });
      });

      await expect(maintenance.restore({ backupId: BACKUP_ID, confirmation: BOT_RESTORE_CONFIRMATION }))
        .rejects.toMatchObject({ code: 'bot_restore_swap_failed' });

      expect(state.holdAtCommit).toMatchObject({ reason: 'restore' });
      expect(activationHold.isHeld()).toBe(false);
      expect(fs.existsSync(activationHold.path)).toBe(false);
      expect(host.discardCandidate).toHaveBeenCalledWith(candidate.operationId);
      expect(maintenanceCalls[0].replaced).toBe(false);
      expect(maintenance.status().lastResult).toMatchObject({ outcome: 'failed', code: 'bot_restore_swap_failed' });
    });

    // A hold that already protected the live catalog (for example an import
    // awaiting the owner's resume) survives a restore that fails after holding.
    it('keeps a pre-existing activation hold when a restore fails after holding', async () => {
      const { maintenance, host, activationHold } = setup();
      const importOperationId = randomUUID();
      await activationHold.hold({ reason: 'import', operationId: importOperationId });
      host.commitRestore.mockRejectedValueOnce(Object.assign(new Error('swap failed'), { code: 'bot_restore_swap_failed' }));

      await expect(maintenance.restore({ backupId: BACKUP_ID, confirmation: BOT_RESTORE_CONFIRMATION }))
        .rejects.toMatchObject({ code: 'bot_restore_swap_failed' });

      expect(activationHold.get()).toMatchObject({ reason: 'import', operationId: importOperationId });
    });

    it('does not touch the candidate when the pre-restore backup fails', async () => {
      const { maintenance, host } = setup();
      host.backup.mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'bot_backup_failed' }));
      await expect(maintenance.restore({ backupId: BACKUP_ID, confirmation: BOT_RESTORE_CONFIRMATION }))
        .rejects.toMatchObject({ code: 'bot_backup_failed' });
      expect(host.prepareRestore).not.toHaveBeenCalled();
      expect(host.commitRestore).not.toHaveBeenCalled();
    });
  });

  describe('start empty', () => {
    it('requires the exact START EMPTY confirmation', async () => {
      const { maintenance, runMaintenance } = setup();
      for (const confirmation of [undefined, 'start empty', 'START_EMPTY', 'RESTORE']) {
        await expect(maintenance.startEmpty({ confirmation })).rejects.toMatchObject({
          code: 'bot_start_empty_confirmation_required', statusCode: 400,
        });
      }
      await expect(maintenance.startEmpty()).rejects.toMatchObject({ code: 'bot_start_empty_confirmation_required' });
      expect(runMaintenance).not.toHaveBeenCalled();
    });

    it('backs up a usable catalog before starting empty and marks it replaced', async () => {
      const { maintenance, events, maintenanceCalls, activationHold } = setup();
      const result = await maintenance.startEmpty({ confirmation: BOT_START_EMPTY_CONFIRMATION });
      expect(result).toMatchObject({ retiredDatabase: 'devryan_bots_retired_empty' });
      expect(events).toEqual(['maintenance:start_empty', 'backup:pre_start_empty', 'startEmpty', 'markReplaced']);
      expect(maintenanceCalls).toEqual([{
        kind: 'start_empty', options: { drainTimeoutMs: 120_000, replacesDatabase: true }, replaced: true,
      }]);
      expect(activationHold.isHeld()).toBe(false);
      expect(maintenance.status().lastResult).toMatchObject({ kind: 'start_empty', outcome: 'completed' });
    });

    it('skips the pre-change backup for an unusable catalog and records failures', async () => {
      const { maintenance, events, host } = setup({ usable: false });
      host.startEmpty.mockRejectedValueOnce(new Error('retire failed'));
      await expect(maintenance.startEmpty({ confirmation: BOT_START_EMPTY_CONFIRMATION })).rejects.toThrow('retire failed');
      expect(events).toEqual(['maintenance:start_empty']);
      expect(maintenance.status().lastResult).toMatchObject({
        kind: 'start_empty', outcome: 'failed', code: 'bot_start_empty_failed',
      });
    });
  });

  describe('activation resume', () => {
    it('releases a persisted hold once and resumes autonomous work', async () => {
      const { maintenance, activationHold, resumeAutonomousWork, diagnostics, root } = setup();
      await activationHold.hold({ reason: 'import', operationId: randomUUID() });
      expect(maintenance.status().activationHold).toMatchObject({ reason: 'import' });

      await expect(maintenance.resumeActivation()).resolves.toEqual({ resumed: true });
      expect(activationHold.isHeld()).toBe(false);
      expect(fs.existsSync(activationHold.path)).toBe(false);
      expect(createBotActivationHold({ dataDirectory: root }).isHeld()).toBe(false);
      expect(resumeAutonomousWork).toHaveBeenCalledTimes(1);
      expect(diagnostics).toContainEqual({ type: 'lifecycle', event: 'bot.catalog.activation_resumed', payload: {} });
      expect(maintenance.status().activationHold).toBeNull();

      await expect(maintenance.resumeActivation()).resolves.toEqual({ resumed: false });
      expect(resumeAutonomousWork).toHaveBeenCalledTimes(1);
    });

    it('refuses to resume while a catalog operation holds the maintenance fence', async () => {
      let active = true;
      const { maintenance, activationHold, resumeAutonomousWork } = setup({ isMaintenanceActive: () => active });
      await activationHold.hold({ reason: 'import', operationId: randomUUID() });
      await expect(maintenance.resumeActivation()).rejects.toMatchObject({ code: 'bots_maintenance_busy' });
      expect(activationHold.isHeld()).toBe(true);
      expect(resumeAutonomousWork).not.toHaveBeenCalled();
      active = false;
      await expect(maintenance.resumeActivation()).resolves.toEqual({ resumed: true });
    });

    it('releases the hold left by a restore', async () => {
      const { maintenance, activationHold } = setup();
      await maintenance.restore({ backupId: BACKUP_ID, confirmation: BOT_RESTORE_CONFIRMATION });
      expect(activationHold.isHeld()).toBe(true);
      await expect(maintenance.resumeActivation()).resolves.toEqual({ resumed: true });
      expect(activationHold.isHeld()).toBe(false);
    });
  });

  describe('candidate validation', () => {
    it('reads the candidate through the host and honours the missing-vault policy', async () => {
      const missingSecretRow = {
        id: randomUUID(), local_vault_reference: `bot-environment-secret:${randomUUID()}`, status: 'active',
      };
      const { maintenance, host, candidate } = setup({
        candidateTables: { bot_messages: [messageRow()], bot_environment_secrets: [missingSecretRow] },
      });

      await expect(maintenance.validateCandidate(candidate)).rejects.toMatchObject({
        code: 'bot_catalog_vault_record_invalid', report: { bucket: 'environmentSecrets' },
      });
      const report = await maintenance.validateCandidate(candidate, { missingVaultRecord: 'disconnect' });
      expect(report).toMatchObject({ envelopes: 1, disconnected: { environmentSecrets: [missingSecretRow.id] } });
      expect(host.readCandidate.mock.calls.every(([operationId]) => operationId === candidate.operationId)).toBe(true);
    });
  });

  describe('daily schedule', () => {
    it('takes a daily backup when none exists, then waits a day', async () => {
      const { maintenance, timers, host, clock, fire, maintenanceCalls } = setup();
      maintenance.start();
      expect(timers.pending.map((timer) => timer.delay)).toEqual([5 * 60 * 1000]);

      const next = await fire();
      expect(host.listBackups).toHaveBeenCalledTimes(1);
      expect(host.backup).toHaveBeenCalledWith({ kind: 'daily' });
      expect(maintenanceCalls).toEqual([{ kind: 'backup', options: { drainTimeoutMs: 30_000 }, replaced: false }]);
      expect(next.delay).toBe(HOUR);
      expect(maintenance.status().lastDailyAt).toBe(new Date(START).toISOString());

      clock.now = START + HOUR;
      expect((await fire()).delay).toBe(HOUR);
      clock.now = START + DAY - 30 * 60 * 1000;
      expect((await fire()).delay).toBe(30 * 60 * 1000 + 60_000);
      expect(host.backup).toHaveBeenCalledTimes(1);
      expect(host.listBackups).toHaveBeenCalledTimes(1);

      clock.now = START + DAY;
      expect((await fire()).delay).toBe(HOUR);
      expect(host.backup).toHaveBeenCalledTimes(2);
      expect(maintenance.status().lastDailyAt).toBe(new Date(START + DAY).toISOString());
      maintenance.stop();
    });

    it('does not back up when the host already has a recent daily backup', async () => {
      const { maintenance, host, fire } = setup({
        backups: [{ id: BACKUP_ID, kind: 'daily', createdAt: new Date(START - DAY + 30 * 60 * 1000).toISOString() }],
      });
      maintenance.start();
      expect((await fire()).delay).toBe(30 * 60 * 1000 + 60_000);
      expect(host.backup).not.toHaveBeenCalled();
      maintenance.stop();
    });

    it('backs up when the newest daily backup is older than a day', async () => {
      const { maintenance, host, fire } = setup({
        backups: [{ id: BACKUP_ID, kind: 'daily', createdAt: new Date(START - DAY - 1).toISOString() }],
      });
      maintenance.start();
      await fire();
      expect(host.backup).toHaveBeenCalledWith({ kind: 'daily' });
      maintenance.stop();
    });

    it('still backs up when the backup listing fails', async () => {
      const { maintenance, host, fire } = setup();
      host.listBackups.mockRejectedValueOnce(new Error('manifest unreadable'));
      maintenance.start();
      expect((await fire()).delay).toBe(HOUR);
      expect(host.backup).toHaveBeenCalledWith({ kind: 'daily' });
      maintenance.stop();
    });

    it('retries after fifteen minutes when the runtime is busy, never forcing the backup', async () => {
      const { maintenance, runMaintenance, host, fire } = setup();
      runMaintenance.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'bots_maintenance_busy' }));
      maintenance.start();

      expect((await fire()).delay).toBe(15 * 60 * 1000);
      expect(host.backup).not.toHaveBeenCalled();
      expect(maintenance.status().lastResult).toMatchObject({ kind: 'daily', outcome: 'failed', code: 'bots_maintenance_busy' });
      expect(maintenance.status().lastDailyAt).toBeNull();

      expect((await fire()).delay).toBe(HOUR);
      expect(host.backup).toHaveBeenCalledWith({ kind: 'daily' });
      expect(runMaintenance.mock.calls.every(([, , options]) => options.drainTimeoutMs === 30_000 && !options.replacesDatabase)).toBe(true);
      maintenance.stop();
    });

    it('retries hourly after any other backup failure', async () => {
      const { maintenance, host, fire } = setup();
      host.backup.mockRejectedValueOnce(Object.assign(new Error('verify failed'), { code: 'bot_backup_verification_failed' }));
      maintenance.start();
      expect((await fire()).delay).toBe(HOUR);
      expect(maintenance.status().lastResult).toMatchObject({ code: 'bot_backup_verification_failed' });
      maintenance.stop();
    });

    it('waits while an owner operation runs or the catalog is unusable', async () => {
      const { maintenance, runMaintenance, host, fire, state } = setup();
      const gate = deferred();
      runMaintenance.mockImplementationOnce(async (_kind, operation) => {
        await gate.promise;
        return operation({ markReplaced: () => {} });
      });
      const manual = maintenance.backupNow();
      maintenance.start();

      expect((await fire()).delay).toBe(HOUR);
      expect(host.listBackups).not.toHaveBeenCalled();
      expect(runMaintenance).toHaveBeenCalledTimes(1);
      gate.resolve();
      await manual;

      state.usable = false;
      expect((await fire()).delay).toBe(HOUR);
      expect(host.listBackups).not.toHaveBeenCalled();
      expect(host.backup).toHaveBeenCalledTimes(1);
      expect(host.backup).toHaveBeenCalledWith({ kind: 'manual' });
      maintenance.stop();
    });

    it('stops scheduling after stop and restarts cleanly', async () => {
      const { maintenance, timers, host } = setup();
      maintenance.start();
      const [scheduled] = timers.pending;
      maintenance.stop();
      expect(timers.pending).toEqual([]);

      scheduled.callback();
      await settle();
      expect(timers.pending).toEqual([]);
      expect(host.backup).not.toHaveBeenCalled();

      maintenance.start();
      expect(timers.pending.map((timer) => timer.delay)).toEqual([5 * 60 * 1000]);
      maintenance.stop();
    });
  });
});
