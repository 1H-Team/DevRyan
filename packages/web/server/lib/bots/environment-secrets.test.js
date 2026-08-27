import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBotEnvironmentSecretVault } from './environment-secret-vault.js';
import {
  createBotEnvironmentSecrets,
  validateBotEnvironmentSecretName,
} from './environment-secrets.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const SECRET_ID = 'c0000000-0000-4000-8000-000000000001';
const PRINCIPAL_ID = 'a0000000-0000-4000-8000-000000000001';
const RUN_ONE = 'd0000000-0000-4000-8000-000000000001';
const RUN_TWO = 'd0000000-0000-4000-8000-000000000002';
const KEY = Buffer.alloc(32, 0x72);
const directories = [];

afterEach(async () => Promise.all(directories.splice(0).map((directory) => (
  fs.rm(directory, { recursive: true, force: true })
))));

const createHarness = async () => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-env-service-'));
  directories.push(dataDirectory);
  const rows = new Map();
  let revision = 0;
  const timestamp = () => `2026-08-26T12:00:0${revision}.000Z`;
  const repository = {
    list: vi.fn(async ({ filters }) => ({
      items: [...rows.values()].filter((row) => row.bot_id === filters.bot_id),
      nextCursor: null,
    })),
    get: vi.fn(async (filters) => [...rows.values()].find((row) => (
      Object.entries(filters).every(([key, value]) => row[key] === value)
    )) || null),
    insert: vi.fn(async (input) => {
      revision += 1;
      const row = { ...input, created_at: timestamp(), updated_at: timestamp() };
      rows.set(row.id, row);
      return row;
    }),
    updateIfRevision: vi.fn(async (filters, changes, expectedUpdatedAt) => {
      const row = [...rows.values()].find((candidate) => (
        Object.entries(filters).every(([key, value]) => candidate[key] === value)
      ));
      if (!row || row.updated_at !== expectedUpdatedAt) {
        throw Object.assign(new Error('conflict'), { code: 'bot_revision_conflict' });
      }
      revision += 1;
      const next = { ...row, ...changes, updated_at: timestamp() };
      rows.set(next.id, next);
      return next;
    }),
  };
  const store = {
    repositories: { bot_environment_secrets: repository },
    deleteCreated: vi.fn(async (_table, filters) => {
      for (const row of rows.values()) {
        if (Object.entries(filters).every(([key, value]) => row[key] === value)) rows.delete(row.id);
      }
    }),
  };
  const vault = await createBotEnvironmentSecretVault({
    dataDirectory,
    getBotEncryptionKey: () => Buffer.from(KEY),
  });
  const audit = vi.fn(async () => {});
  const service = createBotEnvironmentSecrets({
    store,
    authorization: { requireManager: vi.fn(async () => ({ decision: { allowed: true } })) },
    vault,
    audit,
    dataDirectory,
    uuid: () => SECRET_ID,
  });
  return { service, repository, rows, audit, dataDirectory, store, vault };
};

describe('Bot environment secrets service', () => {
  it('keeps values write-only and snapshots rotations for new reasoning runs only', async () => {
    const harness = await createHarness();
    const principal = { id: PRINCIPAL_ID, role: 'developer' };
    const created = await harness.service.put(principal, BOT_ID, 'SERVICE_TOKEN', {
      value: 'first-value',
      expectedUpdatedAt: null,
    });
    expect(Object.keys(created.environmentSecret).sort()).toEqual([
      'createdAt', 'name', 'status', 'updatedAt',
    ]);
    expect(JSON.stringify(created)).not.toContain('first-value');
    expect(JSON.stringify(await harness.service.list(principal, BOT_ID))).not.toContain('first-value');
    expect(JSON.stringify(harness.audit.mock.calls)).not.toContain('first-value');

    const first = await harness.service.prepareRun({ id: RUN_ONE, botId: BOT_ID });
    expect(first.path).toBe(path.join(
      harness.dataDirectory, 'bots', 'runtime', 'environment', RUN_ONE, 'environment.json',
    ));
    expect(JSON.parse(await fs.readFile(first.path, 'utf8')).variables.SERVICE_TOKEN).toBe('first-value');
    expect((await fs.stat(first.path)).mode & 0o777).toBe(0o400);

    const updatedAt = created.environmentSecret.updatedAt;
    await harness.service.put(principal, BOT_ID, 'SERVICE_TOKEN', {
      value: 'second-value',
      expectedUpdatedAt: updatedAt,
    });
    expect(JSON.parse(await fs.readFile(first.path, 'utf8')).variables.SERVICE_TOKEN).toBe('first-value');
    const second = await harness.service.prepareRun({ id: RUN_TWO, botId: BOT_ID });
    expect(JSON.parse(await fs.readFile(second.path, 'utf8')).variables.SERVICE_TOKEN).toBe('second-value');

    await harness.service.finalizeRun(RUN_ONE);
    await expect(fs.stat(first.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects reserved names, stale writes, and removes both metadata and vault material', async () => {
    expect(() => validateBotEnvironmentSecretName('DEVRYAN_TOKEN')).toThrowError(
      expect.objectContaining({ code: 'bot_environment_secret_reserved' }),
    );
    expect(() => validateBotEnvironmentSecretName('https_proxy')).toThrowError(
      expect.objectContaining({ code: 'bot_environment_secret_reserved' }),
    );
    const harness = await createHarness();
    const principal = { id: PRINCIPAL_ID, role: 'developer' };
    const created = await harness.service.put(principal, BOT_ID, 'TOKEN', {
      value: 'value', expectedUpdatedAt: null,
    });
    await expect(harness.service.put(principal, BOT_ID, 'TOKEN', {
      value: 'replacement', expectedUpdatedAt: '2026-08-26T00:00:00.000Z',
    })).rejects.toMatchObject({ code: 'bot_environment_secret_conflict' });
    await harness.service.remove(principal, BOT_ID, 'TOKEN', {
      expectedUpdatedAt: created.environmentSecret.updatedAt,
    });
    expect(harness.rows.size).toBe(0);
    expect(JSON.stringify(harness.audit.mock.calls)).not.toContain('value');
  });

  it('restores vault material when metadata deletion fails', async () => {
    const harness = await createHarness();
    const principal = { id: PRINCIPAL_ID, role: 'developer' };
    const created = await harness.service.put(principal, BOT_ID, 'TOKEN', {
      value: 'still-present', expectedUpdatedAt: null,
    });
    harness.store.deleteCreated.mockRejectedValueOnce(Object.assign(
      new Error('database unavailable'),
      { code: 'bot_store_unavailable' },
    ));

    await expect(harness.service.remove(principal, BOT_ID, 'TOKEN', {
      expectedUpdatedAt: created.environmentSecret.updatedAt,
    })).rejects.toMatchObject({ code: 'bot_store_unavailable' });
    expect((await harness.vault.read(SECRET_ID)).value).toBe('still-present');
    expect(harness.rows.has(SECRET_ID)).toBe(true);
  });
});
