import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFileSessionTitleOutbox } from './session-title-outbox.js';

const roots = [];
const job = (overrides = {}) => ({
  key: 'a'.repeat(64),
  sessionID: 'ses_1',
  directory: '/tmp/project',
  sourceHash: 'b'.repeat(64),
  candidateTitle: 'Reliable Session Title Summaries',
  source: 'free_zen',
  state: 'pending_idle',
  attemptCount: 0,
  nextAttemptAt: 1,
  createdAt: 1,
  updatedAt: 1,
  idleConfirmedAt: 0,
  inactiveObservationCount: 0,
  lastInactiveObservedAt: 0,
  providerID: 'openai',
  modelID: 'gpt-5.6-sol',
  ...overrides,
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('session title outbox', () => {
  it('atomically persists, reloads, and removes private jobs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-title-outbox-'));
    roots.push(root);
    const filePath = path.join(root, 'session-title-outbox.json');
    const first = createFileSessionTitleOutbox({ filePath });
    await first.upsert(job());
    await first.dispose();

    const stored = await fs.readFile(filePath, 'utf8');
    expect(stored).toContain('Reliable Session Title Summaries');
    expect(stored).not.toContain('raw prompt');
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(root)).some((name) => name.endsWith('.tmp'))).toBe(false);

    const second = createFileSessionTitleOutbox({ filePath });
    expect(await second.list()).toEqual([job()]);
    await second.remove(job().key);
    expect(await second.list()).toEqual([]);
    await second.dispose();
  });

  it('quarantines corrupt state and recovers with an empty outbox', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-title-corrupt-'));
    roots.push(root);
    const filePath = path.join(root, 'session-title-outbox.json');
    await fs.writeFile(filePath, '{not-json', { mode: 0o600 });
    const onCorrupt = vi.fn();
    const outbox = createFileSessionTitleOutbox({
      filePath,
      onCorrupt,
      logger: { warn: vi.fn() },
      now: () => 42,
    });
    expect(await outbox.list()).toEqual([]);
    expect(onCorrupt).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(root)).toContain('session-title-outbox.json.corrupt-42');
    await outbox.upsert(job());
    expect(await outbox.list()).toEqual([job()]);
    await outbox.dispose();
  });

  it('rejects malformed jobs without overwriting valid state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-title-invalid-'));
    roots.push(root);
    const filePath = path.join(root, 'session-title-outbox.json');
    const outbox = createFileSessionTitleOutbox({ filePath });
    await outbox.upsert(job());
    await expect(outbox.upsert(job({ sourceHash: 'raw prompt' }))).rejects.toThrow('Invalid session title outbox job');
    expect(await outbox.list()).toEqual([job()]);
    await outbox.dispose();
  });

  it('keeps same-ID jobs from different directories isolated', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-title-directories-'));
    roots.push(root);
    const filePath = path.join(root, 'session-title-outbox.json');
    const outbox = createFileSessionTitleOutbox({ filePath });
    const first = job({ directory: '/tmp/project-a' });
    const second = job({
      key: 'c'.repeat(64),
      directory: '/tmp/project-b',
      sourceHash: 'd'.repeat(64),
    });
    await outbox.upsert(first);
    await outbox.upsert(second);
    expect(await outbox.list()).toEqual([first, second]);
    await outbox.remove(first.key);
    expect(await outbox.list()).toEqual([second]);
    await outbox.dispose();
  });
});
