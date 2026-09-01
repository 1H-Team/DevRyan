import { describe, expect, it, vi } from 'vitest';

import { createBotWarmRuntimeLeases } from './warm-runtime-leases.js';

const ids = Array.from({ length: 20 }, (_, index) => (
  `f0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
));

const binding = (overrides = {}) => ({
  principalId: 'a0000000-0000-4000-8000-000000000001',
  botId: 'b0000000-0000-4000-8000-000000000001',
  channelId: 'c0000000-0000-4000-8000-000000000001',
  revisionId: 'd0000000-0000-4000-8000-000000000001',
  ownerUserId: 'a0000000-0000-4000-8000-000000000001',
  updatedAt: '2026-08-26T10:00:00.000Z',
  contract: {},
  libraryVersionIds: [],
  librarySnapshotKey: '',
  ...overrides,
});

describe('Production Bot warm runtime leases', () => {
  it('claims an in-flight lease atomically and adopts its preallocated run id', async () => {
    let finish;
    const prepare = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const stop = vi.fn(async () => {});
    const marks = [];
    let index = 0;
    const leases = createBotWarmRuntimeLeases({
      prepare, stop, uuid: () => ids[index++], record: (mark) => marks.push(mark),
    });
    const lease = leases.begin(binding());
    expect(lease).toMatchObject({ state: 'warming', leaseId: ids[0] });
    const claim = leases.claim({
      leaseId: lease.leaseId,
      principalId: binding().principalId,
      channelId: binding().channelId,
      revisionId: binding().revisionId,
      librarySnapshotKey: binding().librarySnapshotKey,
      messageId: 'e0000000-0000-4000-8000-000000000001',
    });
    await Promise.resolve();
    finish();
    expect(await claim).toEqual({ hit: true, runId: ids[1] });
    expect(await leases.claim({
      leaseId: lease.leaseId,
      principalId: binding().principalId,
      channelId: binding().channelId,
      revisionId: binding().revisionId,
      librarySnapshotKey: binding().librarySnapshotKey,
      messageId: 'e0000000-0000-4000-8000-000000000001',
    })).toEqual({ hit: true, runId: ids[1] });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(marks).toContain('lease_adopted');
    leases.settle(ids[1]);
    expect(leases.size).toBe(0);
  });

  it('binds release to the principal and cleans the runtime on a valid release', async () => {
    const stop = vi.fn(async () => {});
    let index = 0;
    const leases = createBotWarmRuntimeLeases({
      prepare: vi.fn(async () => {}), stop, uuid: () => ids[index++],
    });
    const lease = leases.begin(binding());
    expect(await leases.release({
      leaseId: lease.leaseId,
      principalId: 'a0000000-0000-4000-8000-000000000002',
      channelId: binding().channelId,
    })).toBe(false);
    expect(await leases.release({
      leaseId: lease.leaseId,
      principalId: binding().principalId,
      channelId: binding().channelId,
    })).toBe(true);
    expect(stop).toHaveBeenCalledWith(ids[1]);
  });

  it('evicts the least-recently-used unclaimed runtime above the two-lease bound', async () => {
    const stop = vi.fn(async () => {});
    let index = 0;
    const leases = createBotWarmRuntimeLeases({
      prepare: vi.fn(async () => {}), stop, uuid: () => ids[index++], maxLeases: 2,
    });
    leases.begin(binding());
    leases.begin(binding({ channelId: 'c0000000-0000-4000-8000-000000000002' }));
    leases.begin(binding({ channelId: 'c0000000-0000-4000-8000-000000000003' }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(leases.size).toBe(2);
    expect(stop).toHaveBeenCalledWith(ids[1]);
    await leases.shutdown();
  });

  it('expires an idle lease and rejects adoption after its TTL', async () => {
    let current = 0;
    let index = 0;
    const stop = vi.fn(async () => {});
    const leases = createBotWarmRuntimeLeases({
      prepare: vi.fn(async () => {}),
      stop,
      uuid: () => ids[index++],
      now: () => current,
      idleTtlMs: 1_000,
    });
    const lease = leases.begin(binding());
    await Promise.resolve();
    current = 1_001;
    expect(await leases.claim({
      leaseId: lease.leaseId,
      principalId: binding().principalId,
      channelId: binding().channelId,
      revisionId: binding().revisionId,
      librarySnapshotKey: binding().librarySnapshotKey,
      messageId: 'e0000000-0000-4000-8000-000000000003',
    })).toEqual({ hit: false, runId: null });
    expect(stop).toHaveBeenCalledWith(ids[1]);
  });

  it('never shares a channel lease across principals', async () => {
    let index = 0;
    const stop = vi.fn(async () => {});
    const prepare = vi.fn(async () => {});
    const leases = createBotWarmRuntimeLeases({ prepare, stop, uuid: () => ids[index++] });
    const first = leases.begin(binding());
    await Promise.resolve();
    await Promise.resolve();
    const secondBinding = binding({ principalId: 'a0000000-0000-4000-8000-000000000002' });
    const second = leases.begin(secondBinding);
    expect(await leases.claim({
      leaseId: first.leaseId,
      principalId: binding().principalId,
      channelId: binding().channelId,
      revisionId: binding().revisionId,
      librarySnapshotKey: binding().librarySnapshotKey,
      messageId: 'e0000000-0000-4000-8000-000000000004',
    })).toEqual({ hit: false, runId: null });
    expect(await leases.claim({
      leaseId: second.leaseId,
      principalId: secondBinding.principalId,
      channelId: secondBinding.channelId,
      revisionId: secondBinding.revisionId,
      librarySnapshotKey: secondBinding.librarySnapshotKey,
      messageId: 'e0000000-0000-4000-8000-000000000005',
    })).toEqual({ hit: true, runId: ids[3] });
    expect(stop).toHaveBeenCalledWith(ids[1]);
    expect(prepare).toHaveBeenCalledTimes(2);
    await leases.shutdown();
  });

  it('records content-free preparation stage and error code diagnostics', async () => {
    let index = 0;
    const error = Object.assign(new Error('provider detail must stay out of diagnostics'), {
      code: 'bot_opencode_start_timeout',
      botRuntimeStage: 'readiness',
    });
    const record = vi.fn();
    const leases = createBotWarmRuntimeLeases({
      prepare: vi.fn(async () => { throw error; }),
      stop: vi.fn(async () => {}),
      uuid: () => ids[index++],
      record,
      logger: { warn: vi.fn() },
    });
    const lease = leases.begin(binding());
    await expect(leases.claim({
      leaseId: lease.leaseId,
      principalId: binding().principalId,
      channelId: binding().channelId,
      revisionId: binding().revisionId,
      librarySnapshotKey: binding().librarySnapshotKey,
      messageId: 'e0000000-0000-4000-8000-000000000006',
    })).resolves.toEqual({ hit: false, runId: null });
    const failure = record.mock.calls.find(([mark]) => mark === 'warm_miss');
    expect(failure?.[1]).toMatchObject({
      reason: 'prepare_failed',
      stage: 'readiness',
      errorCode: 'bot_opencode_start_timeout',
    });
    expect(JSON.stringify(failure)).not.toContain(error.message);
  });
});
