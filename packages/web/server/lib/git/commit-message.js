import { generateZenText, isUnavailableZenModelError } from '../text/summarization.js';

export const COMMIT_SUBJECT_MAX_LENGTH = 72;
export const COMMIT_GENERATION_DEFAULT_ZEN_MODEL = 'deepseek-v4-flash-free';
export const COMMIT_GENERATION_TIMEOUT_MS = 60_000;
export const COMMIT_GENERATION_CHAT_MAX_TOKENS = 64;
export const COMMIT_GENERATION_RESPONSES_MAX_OUTPUT_TOKENS = 128;
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

const SUBJECT_PATTERN = new RegExp(
  `^(?:${ALLOWED_COMMIT_TYPES.join('|')})(?:\\([a-z0-9][a-z0-9_-]*\\))?(!)?:\\s+\\S.*$`,
);

const readJsonSubject = (value) => {
  try {
    const parsed = JSON.parse(value);
    const candidate = Array.isArray(parsed) ? parsed[0] : parsed;
    return typeof candidate?.subject === 'string' ? candidate.subject : '';
  } catch {
    return '';
  }
};

export function normalizeGeneratedCommitSubject(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    throw new Error('Commit generator returned an empty response');
  }

  const withoutFence = raw
    .replace(/^```(?:json|text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const jsonSubject = readJsonSubject(withoutFence);
  const firstLine = (jsonSubject || withoutFence)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
  const subject = firstLine
    .replace(/^commit message\s*:\s*/i, '')
    .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '')
    .trim();

  if (!subject) {
    throw new Error('Commit generator returned an empty subject');
  }
  if (subject.length > COMMIT_SUBJECT_MAX_LENGTH) {
    throw new Error(`Generated commit subject exceeds ${COMMIT_SUBJECT_MAX_LENGTH} characters`);
  }
  if (!SUBJECT_PATTERN.test(subject)) {
    throw new Error('Generated commit subject is not a valid conventional commit');
  }
  if (/\.$/.test(subject)) {
    throw new Error('Generated commit subject must not end with a period');
  }
  return subject;
}

export function buildCommitMessagePrompt(context, guidance) {
  if (!context || typeof context !== 'object' || !Array.isArray(context.selectedFiles) || context.selectedFiles.length === 0) {
    throw new Error('Worktree context with at least one changed file is required');
  }

  const optionalGuidance = typeof guidance === 'string' && guidance.trim()
    ? `\nOptional wording guidance:\n${guidance.trim()}\nThe Git context and output rules remain authoritative.`
    : '';

  return `Generate one Git commit subject for the supplied worktree changes.

Rules:
1. Output only the subject line, with no markdown, quotes, JSON, or explanation.
2. Use Conventional Commits: type(scope): summary, or type: summary when no clear scope fits.
3. Allowed types: ${ALLOWED_COMMIT_TYPES.join(', ')}.
4. Keep the complete subject at or below ${COMMIT_SUBJECT_MAX_LENGTH} characters.
5. Use imperative mood and do not end with punctuation.
6. Describe only the supplied changes. Respect the staged-only scope when present.
${optionalGuidance}

Git context:
${JSON.stringify(context, null, 2)}`;
}

export async function generateCommitMessageDirect({
  context,
  guidance,
  zenModel,
  fallbackZenModel,
  onTiming,
  requestText = generateZenText,
}) {
  const prompt = buildCommitMessagePrompt(context, guidance);
  const model = typeof zenModel === 'string' && zenModel.trim()
    ? zenModel.trim()
    : COMMIT_GENERATION_DEFAULT_ZEN_MODEL;
  const request = (selectedModel) => requestText({
    prompt,
    zenModel: selectedModel,
    timeoutMs: COMMIT_GENERATION_TIMEOUT_MS,
    chatMaxTokens: COMMIT_GENERATION_CHAT_MAX_TOKENS,
    ...(selectedModel === COMMIT_GENERATION_DEFAULT_ZEN_MODEL
      ? { chatReasoningEffort: 'none' }
      : {}),
    responsesMaxOutputTokens: COMMIT_GENERATION_RESPONSES_MAX_OUTPUT_TOKENS,
    stop: ['\n'],
  });
  const providerStartedAt = Date.now();
  let output;
  let retried = false;
  let providerCompleted = false;
  try {
    try {
      output = await request(model);
    } catch (error) {
      const fallback = typeof fallbackZenModel === 'string' ? fallbackZenModel.trim() : '';
      if (!fallback || fallback === model || !isUnavailableZenModelError(error)) throw error;
      retried = true;
      output = await request(fallback);
    }
    providerCompleted = true;
  } finally {
    if (!providerCompleted) {
      onTiming?.({
        providerMs: Date.now() - providerStartedAt,
        parseMs: 0,
        retried,
      });
    }
  }
  const providerMs = Date.now() - providerStartedAt;
  const parseStartedAt = Date.now();
  let subject;
  try {
    subject = normalizeGeneratedCommitSubject(output);
  } finally {
    onTiming?.({
      providerMs,
      parseMs: Date.now() - parseStartedAt,
      retried,
    });
  }
  return {
    subject,
    highlights: [],
  };
}
