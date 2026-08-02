import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createEvidenceLedger, validateEvidenceRecord } from './evidence-ledger.js';
import { createRecordStore } from './record-store.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe('evidence ledger retention', () => {
  test('lists detached public records without forwarding Array.map callback arguments to structuredClone', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-evidence-ledger-list-'));
    temporaryDirectories.push(directory);
    const ledger = createEvidenceLedger({
      store: createRecordStore({
        directory,
        validateRecord: validateEvidenceRecord,
        logger: { warn() {} },
      }),
    });
    const created = await ledger.begin({
      directory: '/repo',
      sessionID: 'ses_list',
      turnID: 'turn_list',
    });

    const listed = await ledger.listBySession({ sessionID: 'ses_list' });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(created);
    listed[0].status = 'gap';
    expect((await ledger.get(created.checkpointID)).status).toBe('capturing_before');
  });

  test('prunes old records, deletes hidden refs, and clears all project worktrees', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-evidence-ledger-'));
    temporaryDirectories.push(directory);
    let now = 1_000;
    const deletedRefs = [];
    const ledger = createEvidenceLedger({
      store: createRecordStore({
        directory,
        validateRecord: validateEvidenceRecord,
        logger: { warn() {} },
      }),
      now: () => now,
      retentionMs: 100,
      maxTurnsPerRepository: 2,
      deleteRef: async (input) => deletedRefs.push(input),
    });
    const first = await ledger.begin({
      directory: '/repo/worktree-a',
      projectDirectory: '/repo',
      sessionID: 'ses_1',
      turnID: 'turn_1',
    });
    await ledger.setBefore(first.checkpointID, { ref: 'refs/devryan/evidence/a/before' });
    await ledger.settle(first.checkpointID, { ref: 'refs/devryan/evidence/a/after' });
    now += 10;
    const second = await ledger.begin({
      directory: '/repo/worktree-b',
      projectDirectory: '/repo',
      sessionID: 'ses_2',
      turnID: 'turn_2',
    });
    await ledger.setBefore(second.checkpointID, { ref: 'refs/devryan/evidence/b/before' });
    await ledger.settle(second.checkpointID, { ref: 'refs/devryan/evidence/b/after' });

    expect(await ledger.clearProject('/repo')).toBe(2);
    expect(await ledger.listBySession()).toEqual([]);
    expect(deletedRefs.map((entry) => entry.ref).sort()).toEqual([
      'refs/devryan/evidence/a/after',
      'refs/devryan/evidence/a/before',
      'refs/devryan/evidence/b/after',
      'refs/devryan/evidence/b/before',
    ]);
  });
});
