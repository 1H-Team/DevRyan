import {
  buildCommitDraftPrompt,
  createDeterministicCommitDraft,
  runFreeZenModelRotation,
  sharedFreeZenCooldowns,
  normalizeGeneratedCommitDraft,
} from '@openchamber/shared-runtime';
import { generateZenText, resolveZenSessionID } from '../text/summarization.js';

export const COMMIT_SUBJECT_MAX_LENGTH = 72;
export const COMMIT_GENERATION_DEFAULT_ZEN_MODEL = 'nemotron-3.5-lightning-free';
export const COMMIT_GENERATION_TIMEOUT_MS = 15_000;
export const COMMIT_GENERATION_MAX_FREE_MODELS = 3;
export const COMMIT_GENERATION_CHAT_MAX_TOKENS = 220;
export const COMMIT_GENERATION_RESPONSES_MAX_OUTPUT_TOKENS = 256;
export const ALLOWED_COMMIT_TYPES = [
  'feat',
  'fix',
  'refactor',
  'perf',
  'docs',
  'test',
  'build',
  'ci',
  'chore',
  'style',
  'revert',
];

export function normalizeGeneratedCommitSubject(value) {
  const normalized = normalizeGeneratedCommitDraft(value, {
    selectedFiles: [{ path: 'changes', index: 'M', workingDir: ' ' }],
  });
  if (normalized.source === 'local_fallback') {
    throw new Error('Generated commit subject is not a valid conventional commit');
  }
  return normalized.message.subject;
}

export function buildCommitMessagePrompt(context, guidance) {
  return buildCommitDraftPrompt(context, guidance);
}

export async function generateCommitMessageDirect({
  sessionID,
  context,
  guidance,
  models = [],
  catalogState = 'empty',
  cooldowns = sharedFreeZenCooldowns,
  timeoutMs = COMMIT_GENERATION_TIMEOUT_MS,
  onTiming,
  onAttempt,
  afterAttempt,
  requestText = generateZenText,
}) {
  const providerStartedAt = Date.now();
  const prompt = buildCommitDraftPrompt(context, guidance);
  const requestSessionID = resolveZenSessionID(sessionID);
  const result = await runFreeZenModelRotation({
    models,
    timeoutMs,
    maxModels: COMMIT_GENERATION_MAX_FREE_MODELS,
    cooldowns,
    cooldownPolicy: 'prioritize',
    request: ({ model, timeoutMs: attemptTimeoutMs, signal }) => requestText({
      prompt,
      sessionID: requestSessionID,
      zenModel: model,
      timeoutMs: attemptTimeoutMs,
      signal,
      chatMaxTokens: COMMIT_GENERATION_CHAT_MAX_TOKENS,
      chatReasoningEffort: 'none',
      responsesMaxOutputTokens: COMMIT_GENERATION_RESPONSES_MAX_OUTPUT_TOKENS,
    }),
    accept: (output) => {
      const normalized = normalizeGeneratedCommitDraft(output, context);
      return normalized.source === 'local_fallback' ? null : normalized;
    },
    onAttempt,
    afterAttempt,
  });
  const source = result.ok ? result.value.source : 'local_fallback';
  const providerOutcome = result.ok ? 'complete'
    : result.attempts > 0 ? 'exhausted'
      : catalogState === 'unavailable' ? 'catalog_unavailable' : 'no_free_models';
  const warning = result.ok ? null : result.attempts > 0
    ? 'Free Zen AI attempts were exhausted; created a local commit draft'
    : catalogState === 'unavailable'
      ? 'Free Zen model catalog was unavailable; created a local commit draft'
      : 'No free Zen models were available; created a local commit draft';
  onTiming?.({
    providerMs: Date.now() - providerStartedAt,
    parseMs: 0,
    retried: result.attempts > 1,
    source,
    providerOutcome,
  });
  return {
    ...(result.ok ? result.value.message : createDeterministicCommitDraft(context)),
    _generation: {
      source,
      warning,
      providerOutcome,
      model: result.model,
      attempts: result.attempts,
      failures: result.failures,
      skipped: result.skipped,
    },
  };
}
