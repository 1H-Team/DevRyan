import { BOT_MEMORY_EXTRACTION_VERSION } from './memory-classifier.js';

// Must match the service-only recovery RPC. Permanent source/encryption/config
// failures are inspected once but never automatically replayed.
const RECOVERABLE_CODES = new Set([
  'bot_memory_extraction_invalid', 'bot_opencode_request_invalid', 'bot_opencode_response_invalid',
  'bot_opencode_request_timeout', 'bot_opencode_request_failed', 'bot_memory_provider_failed',
  'bot_memory_reasoning_unavailable', 'bot_indexer_unavailable', 'bot_memory_index_sync_failed',
  'bot_memory_commit_failed', 'bot_memory_candidate_persistence_failed',
  'bot_revision_conflict', 'bot_memory_version_conflict', 'bot_summary_checkpoint_conflict', '40001',
  'bot_runtime_scope_busy', 'bot_opencode_request_aborted', 'bot_opencode_run_not_found',
]);

export async function recoverBotMemoryExtractions({ store, decryptCandidates, onRecovered, signal }) {
  const jobs = await store.listMemoryExtractionRecoveryCandidates({ version: BOT_MEMORY_EXTRACTION_VERSION, limit: 100 });
  const changedBots = new Set();
  for (const job of jobs) {
    signal?.throwIfAborted();
    let decision = 'retain';
    if (job.state === 'terminal' && RECOVERABLE_CODES.has(job.last_error_code)) decision = 'requeue';
    else if (job.state === 'succeeded' && job.candidate_envelope) {
      try {
        const candidates = await decryptCandidates(job);
        if (candidates.accepted.length === 0 && candidates.rejectedCount > 0) decision = 'reextract';
      } catch (error) {
        // A temporarily locked OS key is not evidence of corrupt ciphertext.
        if (error?.code !== 'bot_memory_candidate_envelope_invalid') throw error;
        decision = 'unreadable';
      }
    }
    const updated = await store.recoverMemoryExtractionJob({
      runId: job.run_id, expectedUpdatedAt: job.updated_at,
      version: BOT_MEMORY_EXTRACTION_VERSION, decision,
    });
    if (updated && decision !== 'retain') {
      changedBots.add(job.bot_id);
      await onRecovered(updated, decision);
    }
  }
  return { hasMore: jobs.length === 100, changedBots };
}
