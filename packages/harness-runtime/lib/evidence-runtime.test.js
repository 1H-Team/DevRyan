import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createEvidenceLedger, validateEvidenceRecord } from './evidence-ledger.js';
import { createTurnEvidenceRuntime } from './evidence-runtime.js';
import { createRecordStore } from './record-store.js';

const temporaryDirectories = [];

const makeFixture = async ({
  gitOverrides = {},
  resolveSessionState = async () => 'unknown',
} = {}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-evidence-runtime-'));
  temporaryDirectories.push(directory);
  const store = createRecordStore({
    directory,
    validateRecord: validateEvidenceRecord,
    logger: { warn() {} },
  });
  const ledger = createEvidenceLedger({ store });
  const git = {
    captureBefore: async ({ directory: repository, turnID }) => ({
      directory: repository,
      ref: `refs/devryan/evidence/session/${turnID}/before`,
      commit: `before-${turnID}`,
      contended: false,
    }),
    captureAfter: async ({ directory: repository, turnID }) => ({
      directory: repository,
      ref: `refs/devryan/evidence/session/${turnID}/after`,
      commit: `after-${turnID}`,
      contended: false,
    }),
    diffSummary: async () => '',
    diffFile: async () => '',
    fileMetadata: async () => ({
      size: 0,
      beforeSize: 0,
      afterSize: 0,
      sha256: '0'.repeat(64),
    }),
    ...gitOverrides,
  };
  const gaps = [];
  const runtime = createTurnEvidenceRuntime({
    ledger,
    git,
    isEnabled: async () => true,
    resolveSessionState,
    onGap: (gap) => gaps.push(gap),
  });
  return { directory, ledger, runtime, gaps };
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe('turn evidence runtime', () => {
  test('settles successful and aborted turns and marks overlapping captures', async () => {
    const { runtime } = await makeFixture();
    const base = { directory: '/repo', sessionID: 'ses_1' };
    runtime.processLifecycleEvent({
      type: 'turn_started',
      ...base,
      turnID: 'turn_1',
      userMessageID: 'msg_1',
    });
    runtime.processLifecycleEvent({
      type: 'turn_started',
      ...base,
      turnID: 'turn_2',
      userMessageID: 'msg_2',
    });
    runtime.processLifecycleEvent({ type: 'turn_completed', ...base, turnID: 'turn_1' });
    runtime.processLifecycleEvent({ type: 'turn_aborted', ...base, turnID: 'turn_2' });
    await runtime.drain();

    const records = await runtime.listBySession({ sessionID: 'ses_1' });
    expect(records.map((record) => record.status)).toEqual(['complete', 'complete']);
    expect(records.some((record) => record.contended)).toBe(true);
    expect(records.find((record) => record.turnID === 'turn_1')?.userMessageID).toBe('msg_1');
  });

  test('persists an explicit evidence gap when the before checkpoint fails', async () => {
    const { runtime, gaps } = await makeFixture({
      gitOverrides: {
        captureBefore: async () => {
          const error = new Error('capture failed');
          error.code = 'EVIDENCE_GIT_FAILED';
          throw error;
        },
      },
    });
    runtime.processLifecycleEvent({
      type: 'turn_started',
      directory: '/repo',
      sessionID: 'ses_2',
      turnID: 'turn_1',
    });
    await runtime.drain();

    expect(await runtime.listBySession({ sessionID: 'ses_2' })).toMatchObject([
      { status: 'gap', gapReason: 'EVIDENCE_GIT_FAILED' },
    ]);
    expect(gaps).toHaveLength(1);
  });

  test('keeps unknown restart state resumable and settles from a later lifecycle event', async () => {
    const { ledger, runtime } = await makeFixture();
    const record = await ledger.begin({
      directory: '/repo',
      sessionID: 'ses_restart',
      turnID: 'turn_restart',
    });
    await ledger.setBefore(record.checkpointID, {
      directory: '/repo',
      ref: 'refs/devryan/evidence/ses_restart/turn_restart/before',
      commit: 'before-restart',
    });

    await runtime.initialize();
    runtime.processLifecycleEvent({
      type: 'turn_completed',
      directory: '/repo',
      sessionID: 'ses_restart',
      turnID: 'turn_restart',
    });
    await runtime.drain();

    expect(await runtime.listBySession({ sessionID: 'ses_restart' })).toMatchObject([
      { status: 'complete', after: { commit: 'after-turn_restart' } },
    ]);
  });

  test('settles an idle accepted turn during startup reconciliation', async () => {
    const { ledger, runtime } = await makeFixture({
      resolveSessionState: async () => 'idle',
    });
    const record = await ledger.begin({
      directory: '/repo',
      sessionID: 'ses_idle',
      turnID: 'turn_idle',
    });
    await ledger.setBefore(record.checkpointID, {
      directory: '/repo',
      ref: 'refs/devryan/evidence/ses_idle/turn_idle/before',
      commit: 'before-idle',
    });

    await runtime.initialize();

    expect(await runtime.listBySession({ sessionID: 'ses_idle' })).toMatchObject([
      { status: 'complete', after: { commit: 'after-turn_idle' } },
    ]);
  });
});
