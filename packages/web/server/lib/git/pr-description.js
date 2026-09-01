import { normalizePullRequestDraft, runFreeZenModelRotation } from '@openchamber/shared-runtime';
import { generateZenText } from '../text/summarization.js';

export const PR_GENERATION_MODEL_TIMEOUT_MS = 15_000;
export const PR_GENERATION_MAX_TOKENS = 1_200;

export async function generatePullRequestDescriptionDirect({
  prompt,
  models,
  timeoutMs = PR_GENERATION_MODEL_TIMEOUT_MS,
  requestText = generateZenText,
  onAttempt,
}) {
  const result = await runFreeZenModelRotation({
    models,
    timeoutMs,
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
    const error = new Error('Unable to generate a pull request description with the available free Zen models');
    error.code = 'FREE_ZEN_EXHAUSTED';
    error.attempts = result.attempts;
    error.failures = result.failures;
    throw error;
  }
  return {
    ...result.value,
    _generation: { model: result.model, attempts: result.attempts, failures: result.failures },
  };
}
