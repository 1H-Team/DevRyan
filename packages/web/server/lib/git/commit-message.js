import {
  COMMIT_DRAFT_DEADLINE_MS,
  buildCommitDraftPrompt,
  generateCommitDraftWithDeadline,
  normalizeGeneratedCommitDraft,
} from '@openchamber/shared-runtime';
import { generateZenText } from '../text/summarization.js';

export const COMMIT_SUBJECT_MAX_LENGTH = 72;
export const COMMIT_GENERATION_DEFAULT_ZEN_MODEL = 'nemotron-3.5-lightning-free';
export const COMMIT_GENERATION_TIMEOUT_MS = COMMIT_DRAFT_DEADLINE_MS;
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
  context,
  guidance,
  zenModel,
  fallbackZenModel,
  deadlineAt,
  skipProvider = false,
  onTiming,
  requestText = generateZenText,
}) {
  const model = typeof zenModel === 'string' && zenModel.trim()
    ? zenModel.trim()
    : COMMIT_GENERATION_DEFAULT_ZEN_MODEL;
  const providerStartedAt = Date.now();
  const result = await generateCommitDraftWithDeadline({
    context,
    guidance,
    deadlineAt,
    requestText: skipProvider ? undefined : ({ prompt, timeoutMs }) => requestText({
      prompt,
      zenModel: model,
      timeoutMs,
      chatMaxTokens: COMMIT_GENERATION_CHAT_MAX_TOKENS,
      chatReasoningEffort: 'none',
      responsesMaxOutputTokens: COMMIT_GENERATION_RESPONSES_MAX_OUTPUT_TOKENS,
    }),
  });
  const providerMs = Date.now() - providerStartedAt;
  onTiming?.({
    providerMs,
    parseMs: 0,
    retried: false,
    source: result.source,
    providerOutcome: result.providerOutcome,
  });
  return {
    ...result.message,
    _generation: {
      source: result.source,
      warning: result.warning,
      providerOutcome: result.providerOutcome,
      model,
      fallbackModel: typeof fallbackZenModel === 'string' ? fallbackZenModel.trim() : '',
    },
  };
}
