import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BotActivationHoldError, createBotActivationHold } from './activation-hold.js';

const OPERATION = '3f0c5a52-9a1e-4c55-8d6b-2f3c1f6f0a11';
const OTHER_OPERATION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const CORRUPT_HOLD = {
  version: 1,
  reason: 'restore',
  createdAt: new Date(0).toISOString(),
  operationId: '00000000-0000-4000-8000-000000000000',
  corrupt: true,
};

let dataDirectory;

beforeEach(async () => {
  dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'devryan-activation-hold-'));
});

afterEach(async () => {
  await fs.promises.rm(dataDirectory, { recursive: true, force: true });
});

const holdFile = () => path.join(dataDirectory, 'bots', 'runtime', 'activation-hold.v1.json');

const writeRaw = async (contents) => {
  await fs.promises.mkdir(path.dirname(holdFile()), { recursive: true });
  await fs.promises.writeFile(holdFile(), contents, 'utf8');
};

const runtimeEntries = async () => fs.promises.readdir(path.dirname(holdFile()));

describe('Bot activation hold', () => {
  it('requires an absolute data directory', () => {
    for (const bad of [undefined, '', 'relative/data', './data', 42]) {
      let thrown = null;
      try {
        createBotActivationHold({ dataDirectory: bad });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(BotActivationHoldError);
      expect(thrown).toMatchObject({ name: 'BotActivationHoldError', code: 'bot_activation_hold_invalid' });
    }
    expect(() => createBotActivationHold()).toThrow(BotActivationHoldError);
  });

  it('starts released when no hold file exists and does not create one', async () => {
    const hold = createBotActivationHold({ dataDirectory });
    expect(hold.path).toBe(holdFile());
    expect(hold.get()).toBeNull();
    expect(hold.isHeld()).toBe(false);
    expect(fs.existsSync(path.join(dataDirectory, 'bots'))).toBe(false);
  });

  it('persists a hold privately and atomically at the documented path', async () => {
    const hold = createBotActivationHold({ dataDirectory });
    const before = Date.now();
    const value = await hold.hold({ reason: 'import', operationId: OPERATION });
    const after = Date.now();

    expect(value).toEqual({
      version: 1,
      reason: 'import',
      createdAt: expect.any(String),
      operationId: OPERATION,
    });
    expect(Date.parse(value.createdAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(value.createdAt)).toBeLessThanOrEqual(after);
    expect(Object.isFrozen(value)).toBe(true);
    expect(hold.get()).toBe(value);
    expect(hold.isHeld()).toBe(true);

    const raw = await fs.promises.readFile(holdFile(), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw)).toEqual(value);

    // Private file and directories; no temporary files left behind.
    expect((await fs.promises.stat(holdFile())).mode & 0o777).toBe(0o600);
    expect((await fs.promises.stat(path.dirname(holdFile()))).mode & 0o077).toBe(0);
    expect((await fs.promises.stat(path.join(dataDirectory, 'bots'))).mode & 0o077).toBe(0);
    expect(await runtimeEntries()).toEqual(['activation-hold.v1.json']);
  });

  it('accepts every documented reason', async () => {
    const hold = createBotActivationHold({ dataDirectory });
    for (const reason of ['import', 'restore', 'start_empty']) {
      await expect(hold.hold({ reason, operationId: OPERATION })).resolves.toMatchObject({ reason });
      expect(JSON.parse(await fs.promises.readFile(holdFile(), 'utf8')).reason).toBe(reason);
    }
  });

  it('survives a restart until an explicit release', async () => {
    const first = createBotActivationHold({ dataDirectory });
    const written = await first.hold({ reason: 'restore', operationId: OPERATION });

    const restarted = createBotActivationHold({ dataDirectory });
    expect(restarted.isHeld()).toBe(true);
    expect(restarted.get()).toEqual(written);
    expect(restarted.get().corrupt).toBeUndefined();

    await restarted.release();
    expect(restarted.isHeld()).toBe(false);
    expect(restarted.get()).toBeNull();
    expect(fs.existsSync(holdFile())).toBe(false);

    const again = createBotActivationHold({ dataDirectory });
    expect(again.isHeld()).toBe(false);
  });

  it('replaces an existing hold and releases idempotently', async () => {
    const hold = createBotActivationHold({ dataDirectory });
    await hold.hold({ reason: 'import', operationId: OPERATION });
    const replaced = await hold.hold({ reason: 'start_empty', operationId: OTHER_OPERATION });
    expect(replaced).toMatchObject({ reason: 'start_empty', operationId: OTHER_OPERATION });
    expect(createBotActivationHold({ dataDirectory }).get()).toEqual(replaced);
    expect(await runtimeEntries()).toEqual(['activation-hold.v1.json']);

    await hold.release();
    await expect(hold.release()).resolves.toBeUndefined();
    const fresh = createBotActivationHold({ dataDirectory });
    await expect(fresh.release()).resolves.toBeUndefined();
    expect(fresh.isHeld()).toBe(false);
  });

  it('rejects an invalid hold request without writing or changing state', async () => {
    const hold = createBotActivationHold({ dataDirectory });
    for (const request of [
      { reason: 'manual', operationId: OPERATION },
      { reason: undefined, operationId: OPERATION },
      { reason: 'import', operationId: 'not-a-uuid' },
      { reason: 'import', operationId: OPERATION.toUpperCase() },
      { reason: 'import', operationId: undefined },
    ]) {
      await expect(hold.hold(request)).rejects.toMatchObject({
        name: 'BotActivationHoldError', code: 'bot_activation_hold_invalid',
      });
    }
    expect(hold.isHeld()).toBe(false);
    expect(fs.existsSync(path.join(dataDirectory, 'bots'))).toBe(false);

    // An invalid request never replaces a valid persisted hold either.
    const valid = await hold.hold({ reason: 'import', operationId: OPERATION });
    await expect(hold.hold({ reason: 'bogus', operationId: OPERATION })).rejects.toMatchObject({
      code: 'bot_activation_hold_invalid',
    });
    expect(hold.get()).toBe(valid);
    expect(JSON.parse(await fs.promises.readFile(holdFile(), 'utf8'))).toEqual(valid);
  });

  it('fails closed on a corrupt or unknown hold file', async () => {
    const valid = { version: 1, reason: 'import', createdAt: new Date().toISOString(), operationId: OPERATION };
    for (const contents of [
      '',
      '{"version":1,',
      'not json at all',
      '[]',
      '"import"',
      '42',
      'null',
      JSON.stringify({ ...valid, version: 2 }),
      JSON.stringify({ ...valid, reason: 'unknown' }),
      JSON.stringify({ ...valid, createdAt: 'yesterday' }),
      JSON.stringify({ ...valid, createdAt: 12345 }),
      JSON.stringify({ ...valid, operationId: 'short' }),
      JSON.stringify({ ...valid, operationId: OPERATION.toUpperCase() }),
    ]) {
      await writeRaw(contents);
      const hold = createBotActivationHold({ dataDirectory });
      expect(hold.isHeld()).toBe(true);
      expect(hold.get()).toEqual(CORRUPT_HOLD);
      expect(Object.isFrozen(hold.get())).toBe(true);
    }
  });

  it('fails closed when the hold path cannot be read', async () => {
    // A directory where the file should be (EISDIR) is not "no hold".
    await fs.promises.mkdir(holdFile(), { recursive: true });
    const hold = createBotActivationHold({ dataDirectory });
    expect(hold.isHeld()).toBe(true);
    expect(hold.get()).toEqual(CORRUPT_HOLD);

    const denied = new Error('permission denied');
    denied.code = 'EACCES';
    const unreadable = createBotActivationHold({
      dataDirectory,
      fsImpl: { ...fs, readFileSync: () => { throw denied; } },
    });
    expect(unreadable.get()).toEqual(CORRUPT_HOLD);
  });

  it('keeps extra fields out of a loaded hold', async () => {
    await writeRaw(JSON.stringify({
      version: 1, reason: 'restore', createdAt: '2026-09-01T00:00:00.000Z', operationId: OPERATION, extra: 'x', corrupt: false,
    }));
    const hold = createBotActivationHold({ dataDirectory });
    expect(hold.get()).toEqual({
      version: 1, reason: 'restore', createdAt: '2026-09-01T00:00:00.000Z', operationId: OPERATION,
    });
  });

  it('replaces a corrupt hold with a valid one and can release it', async () => {
    await writeRaw('garbage');
    const hold = createBotActivationHold({ dataDirectory });
    expect(hold.get().corrupt).toBe(true);
    const replaced = await hold.hold({ reason: 'restore', operationId: OPERATION });
    expect(replaced.corrupt).toBeUndefined();
    expect(createBotActivationHold({ dataDirectory }).get()).toEqual(replaced);
    await hold.release();
    expect(createBotActivationHold({ dataDirectory }).isHeld()).toBe(false);
  });

  it('keeps the in-memory hold unchanged when persisting fails', async () => {
    const renameFailure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    const failing = {
      ...fs,
      promises: { ...fs.promises, rename: async () => { throw renameFailure; } },
    };
    const hold = createBotActivationHold({ dataDirectory, fsImpl: failing });
    await expect(hold.hold({ reason: 'import', operationId: OPERATION })).rejects.toBe(renameFailure);
    expect(hold.isHeld()).toBe(false);
    expect(fs.existsSync(holdFile())).toBe(false);
  });

  it('reinstates an earlier hold exactly, across a restart', async () => {
    const hold = createBotActivationHold({ dataDirectory });
    const earlier = await hold.hold({ reason: 'restore', operationId: OPERATION });
    await hold.hold({ reason: 'import', operationId: OTHER_OPERATION });

    const reinstated = await hold.reinstate(earlier);
    expect(reinstated).toEqual(earlier);
    expect(Object.isFrozen(reinstated)).toBe(true);
    expect(hold.get()).toEqual(earlier);
    const restarted = createBotActivationHold({ dataDirectory });
    expect(restarted.get()).toEqual(earlier);
    expect((await fs.promises.stat(holdFile())).mode & 0o777).toBe(0o600);
    expect(await runtimeEntries()).toEqual(['activation-hold.v1.json']);
  });

  it('reinstating no earlier hold releases the current one', async () => {
    const hold = createBotActivationHold({ dataDirectory });
    await hold.hold({ reason: 'import', operationId: OPERATION });
    for (const previous of [null, undefined]) {
      await expect(hold.reinstate(previous)).resolves.toBeNull();
      expect(hold.isHeld()).toBe(false);
      expect(fs.existsSync(holdFile())).toBe(false);
    }
  });

  it('reinstating a corrupt or invalid earlier hold stays held', async () => {
    await writeRaw('garbage');
    const corrupt = createBotActivationHold({ dataDirectory }).get();
    expect(corrupt.corrupt).toBe(true);

    const hold = createBotActivationHold({ dataDirectory });
    await hold.hold({ reason: 'import', operationId: OPERATION });
    await hold.reinstate(corrupt);
    expect(hold.isHeld()).toBe(true);
    expect(createBotActivationHold({ dataDirectory }).isHeld()).toBe(true);

    await hold.reinstate({ reason: 'bogus', operationId: 'x', createdAt: 'never' });
    expect(hold.isHeld()).toBe(true);
    expect(hold.get()).toMatchObject({ reason: 'restore', corrupt: true });
    expect(createBotActivationHold({ dataDirectory }).isHeld()).toBe(true);
  });

  it('keeps the current hold when reinstating fails to persist', async () => {
    const hold = createBotActivationHold({ dataDirectory });
    const current = await hold.hold({ reason: 'import', operationId: OPERATION });
    const renameFailure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    const failing = createBotActivationHold({
      dataDirectory,
      fsImpl: { ...fs, promises: { ...fs.promises, rename: async () => { throw renameFailure; } } },
    });
    await expect(failing.reinstate({ ...current, reason: 'restore' })).rejects.toBe(renameFailure);
    expect(failing.get()).toEqual(current);
    expect(createBotActivationHold({ dataDirectory }).get()).toEqual(current);
  });

  it('propagates release failures other than a missing file and stays held', async () => {
    const hold = createBotActivationHold({ dataDirectory });
    await hold.hold({ reason: 'import', operationId: OPERATION });
    const busy = Object.assign(new Error('busy'), { code: 'EBUSY' });
    const failing = createBotActivationHold({
      dataDirectory,
      fsImpl: { ...fs, promises: { ...fs.promises, unlink: async () => { throw busy; } } },
    });
    expect(failing.isHeld()).toBe(true);
    await expect(failing.release()).rejects.toBe(busy);
    expect(failing.isHeld()).toBe(true);
    expect(fs.existsSync(holdFile())).toBe(true);
  });
});
