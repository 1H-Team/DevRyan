import { describe, expect, it } from 'vitest';
import { createDiagnosticSanitizer } from '@openchamber/harness-runtime';
import { buildGitGenerationTimingRecord } from './generation-diagnostics.js';

describe('Git generation journal records', () => {
  it.each(['git_commit_message_model_attempt', 'git_pr_description_model_attempt'])('retains attempt evidence for %s through sanitization', (event) => {
    const record = buildGitGenerationTimingRecord(null, {
      event, model: 'free-a', attempt: 2, providerMs: 594, totalMs: 594,
      outcome: 'failed', source: 'free_zen', providerOutcome: 'unauthorized', statusCode: 401,
      catalogState: 'stale', retried: true, prompt: 'private diff', error: 'private upstream error',
    });
    const sanitized = createDiagnosticSanitizer().sanitizeRecord({ ...record, at: 1 });
    expect(sanitized).toMatchObject({ mark: event, payload: {
      model: 'free-a', attempt: 2, durationMs: 594, outcome: 'failed', source: 'free_zen',
      reason: 'unauthorized', statusCode: 401, state: 'stale', retry: true,
    } });
    expect(JSON.stringify(sanitized)).not.toContain('private');
  });

  it.each(['complete', 'exhausted', 'catalog_unavailable', 'no_free_models'])('retains the %s overall outcome', (providerOutcome) => {
    const record = buildGitGenerationTimingRecord(null, { event: 'git_commit_message_generation', providerOutcome });
    expect(createDiagnosticSanitizer().sanitizeRecord({ ...record, at: 1 }).payload.reason).toBe(providerOutcome);
  });
});
