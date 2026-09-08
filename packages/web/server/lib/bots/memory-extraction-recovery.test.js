import { describe, expect, it, vi } from 'vitest';
import { recoverBotMemoryExtractions } from './memory-extraction-recovery.js';

const harness = (overrides = []) => {
  const jobs = overrides.map((job, index) => ({
    run_id: `run-${index}`, bot_id: 'bot', updated_at: `timestamp-${index}`,
    recovery_version: 1, state: 'terminal', last_error_code: 'bot_opencode_request_invalid', ...job,
  }));
  const store = {
    listMemoryExtractionRecoveryCandidates: vi.fn(async ({ limit, version }) => jobs
      .filter((job) => job.recovery_version < version && ['terminal', 'succeeded'].includes(job.state))
      .slice(0, limit).map((job) => ({ ...job }))),
    recoverMemoryExtractionJob: vi.fn(async ({ runId, expectedUpdatedAt, version, decision }) => {
      const job = jobs.find((entry) => entry.run_id === runId);
      if (job.updated_at !== expectedUpdatedAt || job.recovery_version >= version) return null;
      job.recovery_version = version;
      if (['requeue', 'reextract'].includes(decision)) job.state = 'queued';
      if (decision === 'reextract') job.candidate_envelope = null;
      return { ...job };
    }),
  };
  return { jobs, store, decryptCandidates: vi.fn(async () => ({ accepted: [], rejectedCount: 1 })), onRecovered: vi.fn() };
};

describe('versioned Bot memory recovery', () => {
  it('recovers more than 100 jobs in bounded batches once across concurrent workers and restarts', async () => {
    const input = harness(Array.from({ length: 235 }, () => ({})));
    await Promise.all([recoverBotMemoryExtractions(input), recoverBotMemoryExtractions(input)]);
    while ((await recoverBotMemoryExtractions(input)).hasMore) { /* next bounded batch */ }
    await recoverBotMemoryExtractions(input);
    expect(input.jobs.every((job) => job.state === 'queued' && job.recovery_version === 2)).toBe(true);
    expect(input.onRecovered).toHaveBeenCalledTimes(235);
    expect(input.store.listMemoryExtractionRecoveryCandidates.mock.calls.every(([call]) => call.limit === 100)).toBe(true);
  });

  it('re-extracts rejected-only legacy success and retains checkpoints, legitimate empty results and permanent failures', async () => {
    const checkpoint = { ciphertext: 'opaque' };
    const input = harness([
      { candidate_envelope: checkpoint },
      { state: 'succeeded', candidate_envelope: checkpoint },
      { state: 'succeeded', candidate_envelope: checkpoint },
      { state: 'terminal', last_error_code: 'bot_message_not_found' },
      { state: 'succeeded', candidate_envelope: checkpoint },
    ]);
    input.decryptCandidates.mockImplementation(async (job) => {
      if (job.run_id === 'run-4') throw Object.assign(new Error('unreadable'), { code: 'bot_memory_candidate_envelope_invalid' });
      return { accepted: [], rejectedCount: job.run_id === 'run-1' ? 2 : 0 };
    });
    await recoverBotMemoryExtractions(input);
    expect(input.store.recoverMemoryExtractionJob.mock.calls.map(([call]) => call.decision))
      .toEqual(['requeue', 'reextract', 'retain', 'retain', 'unreadable']);
    expect(input.jobs[0].candidate_envelope).toBe(checkpoint);
    expect(input.jobs[1].candidate_envelope).toBeNull();
    expect(input.jobs[2].state).toBe('succeeded');
    expect(input.jobs[3].state).toBe('terminal');
  });

  it('leaves temporarily inaccessible keys eligible for the next recovery scan', async () => {
    const input = harness([{ state: 'succeeded', candidate_envelope: { ciphertext: 'opaque' } }]);
    input.decryptCandidates.mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'bot_os_encryption_unavailable' }));
    await expect(recoverBotMemoryExtractions(input)).rejects.toMatchObject({ code: 'bot_os_encryption_unavailable' });
    expect(input.jobs[0].recovery_version).toBe(1);
    await recoverBotMemoryExtractions(input);
    expect(input.jobs[0].state).toBe('queued');
  });
});
