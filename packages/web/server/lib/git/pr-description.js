import { normalizePullRequestDraft, runFreeZenModelRotation, sharedFreeZenCooldowns } from '@openchamber/shared-runtime';
import { generateZenText } from '../text/summarization.js';

export const PR_GENERATION_MODEL_TIMEOUT_MS = 15_000;
export const PR_GENERATION_MAX_TOKENS = 1_200;
// Tier 1 is bounded: at most three warm free models and 45 s in total before
// the route falls back to the user's session model.
export const PR_GENERATION_MAX_FREE_MODELS = 3;
export const PR_GENERATION_FREE_DEADLINE_MS = 45_000;

export async function generatePullRequestDescriptionDirect({
  prompt,
  models,
  timeoutMs = PR_GENERATION_MODEL_TIMEOUT_MS,
  maxModels = PR_GENERATION_MAX_FREE_MODELS,
  deadlineMs = PR_GENERATION_FREE_DEADLINE_MS,
  cooldowns = sharedFreeZenCooldowns,
  requestText = generateZenText,
  onAttempt,
  now,
}) {
  const result = await runFreeZenModelRotation({
    models,
    timeoutMs,
    maxModels,
    deadlineMs,
    cooldowns,
    now,
    request: ({ model, timeoutMs: modelTimeoutMs }) => requestText({
      prompt,
      zenModel: model,
      timeoutMs: modelTimeoutMs,
      chatMaxTokens: PR_GENERATION_MAX_TOKENS,
      chatReasoningEffort: 'none',
      responsesMaxOutputTokens: PR_GENERATION_MAX_TOKENS,
    }),
    accept: normalizePullRequestDraft,
    onAttempt,
  });
  if (!result.ok) {
    const error = new Error(result.deadlineExceeded
      ? 'Free Zen models ran out of time while generating the pull request description'
      : 'Unable to generate a pull request description with the available free Zen models');
    error.code = 'FREE_ZEN_EXHAUSTED';
    error.attempts = result.attempts;
    error.failures = result.failures;
    error.skipped = result.skipped;
    error.deadlineExceeded = result.deadlineExceeded;
    throw error;
  }
  return {
    ...result.value,
    _generation: {
      model: result.model,
      attempts: result.attempts,
      failures: result.failures,
      skipped: result.skipped,
    },
  };
}
