export const COMMIT_DRAFT_DEADLINE_MS = 20_000;
export const COMMIT_DRAFT_SUBJECT_MAX_LENGTH = 72;
export const COMMIT_DRAFT_DETAIL_MIN_COUNT = 2;
export const COMMIT_DRAFT_DETAIL_MAX_COUNT = 4;
export const COMMIT_DRAFT_DETAIL_MAX_LENGTH = 120;
export const COMMIT_DRAFT_MODEL_COOLDOWN_MS = 5 * 60 * 1_000;

export const COMMIT_DRAFT_ALLOWED_TYPES = Object.freeze([
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
]);

const SUBJECT_PATTERN = new RegExp(
  `^(${COMMIT_DRAFT_ALLOWED_TYPES.join('|')})(?:\\(([a-z0-9][a-z0-9_-]*)\\))?(!)?:\\s+(\\S.*)$`,
);
const SUBJECT_PREFIX_PATTERN = new RegExp(
  `^(?:${COMMIT_DRAFT_ALLOWED_TYPES.join('|')})(?:\\([a-z0-9][a-z0-9_-]*\\))?!?:\\s+`,
);

const normalizePath = (value) => String(value || '')
  .replace(/\\/g, '/')
  .replace(/^\.\/+/, '')
  .trim();

const sanitizeDetail = (value) => String(value || '')
  .replace(/^[-*+]\s+/, '')
  .replace(/^#+\s*/, '')
  .replace(/[\r\n]+/g, ' ')
  .replace(/\s+/g, ' ')
  .replace(/[.!?;:]+$/g, '')
  .trim();

const truncateAtWord = (value, maxLength) => {
  const normalized = String(value || '').trim();
  if (normalized.length <= maxLength) return normalized;
  const sliced = normalized.slice(0, Math.max(0, maxLength + 1));
  const wordBoundary = sliced.lastIndexOf(' ');
  const truncated = wordBoundary >= Math.floor(maxLength * 0.55)
    ? sliced.slice(0, wordBoundary)
    : sliced.slice(0, maxLength);
  return truncated.replace(/[\s,.;:!?-]+$/g, '').trim();
};

const normalizeDetails = (values) => {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const detail = truncateAtWord(sanitizeDetail(value), COMMIT_DRAFT_DETAIL_MAX_LENGTH);
    const key = detail.toLowerCase();
    if (!detail || seen.has(key)) continue;
    seen.add(key);
    result.push(detail);
    if (result.length >= COMMIT_DRAFT_DETAIL_MAX_COUNT) break;
  }
  return result;
};

const fileAction = (file) => {
  const status = `${file?.index || ''}${file?.workingDir || ''}`.toUpperCase();
  if (status.includes('A') || status.includes('?')) return 'Add';
  if (status.includes('D')) return 'Remove';
  if (status.includes('R')) return 'Rename';
  return 'Update';
};

const inferFallbackType = (files) => {
  const paths = files.map((file) => normalizePath(file?.path).toLowerCase()).filter(Boolean);
  if (paths.length > 0 && paths.every((filePath) => /(?:^|\/)(?:docs?|documentation)(?:\/|$)|\.(?:md|mdx|rst|txt)$/.test(filePath))) return 'docs';
  if (paths.length > 0 && paths.every((filePath) => /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/.test(filePath))) return 'test';
  if (paths.length > 0 && paths.every((filePath) => filePath.startsWith('.github/') || /(?:^|\/)(?:ci|workflows)(?:\/|$)/.test(filePath))) return 'ci';
  if (paths.length > 0 && paths.every((filePath) => /(?:^|\/)(?:package\.json|bun\.lock|cargo\.(?:toml|lock)|dockerfile|vite\.config\.|tsconfig\.)/.test(filePath))) return 'build';
  return 'chore';
};

const inferFallbackScope = (files) => {
  const paths = files.map((file) => normalizePath(file?.path)).filter(Boolean);
  if (paths.length === 0) return '';
  const candidates = paths.map((filePath) => {
    const parts = filePath.split('/').filter(Boolean);
    if (parts[0] === 'packages' && parts[1]) return parts[1];
    if (parts[0] === 'apps' && parts[1]) return parts[1];
    return parts.length > 1 ? parts[0] : '';
  });
  const first = candidates[0];
  if (!first || !candidates.every((candidate) => candidate === first)) return '';
  return first.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
};

const formatLineStats = (file) => {
  const insertions = Number(file?.insertions);
  const deletions = Number(file?.deletions);
  if (!Number.isFinite(insertions) && !Number.isFinite(deletions)) return '';
  const added = Number.isFinite(insertions) ? Math.max(0, Math.trunc(insertions)) : 0;
  const removed = Number.isFinite(deletions) ? Math.max(0, Math.trunc(deletions)) : 0;
  return `Change ${added + removed} lines (+${added}/-${removed})`;
};

export function createDeterministicCommitDraft(context) {
  const files = Array.isArray(context?.selectedFiles) ? context.selectedFiles : [];
  if (files.length === 0) {
    throw new Error('Worktree context with at least one changed file is required');
  }

  const type = inferFallbackType(files);
  const scope = inferFallbackScope(files);
  const prefix = `${type}${scope ? `(${scope})` : ''}: `;
  const firstPath = normalizePath(files[0]?.path);
  const firstName = firstPath.split('/').filter(Boolean).pop() || 'selected changes';
  const summary = files.length === 1
    ? `${fileAction(files[0]).toLowerCase()} ${firstName}`
    : `update ${files.length} selected files`;
  const subject = `${prefix}${truncateAtWord(summary, COMMIT_DRAFT_SUBJECT_MAX_LENGTH - prefix.length)}`;

  const details = [];
  const visibleFiles = files.slice(0, 3);
  for (const file of visibleFiles) {
    const filePath = normalizePath(file?.path);
    if (filePath) details.push(`${fileAction(file)} ${filePath}`);
  }
  if (files.length > visibleFiles.length) {
    details.push(`Include ${files.length - visibleFiles.length} additional selected files`);
  }
  const totalInsertions = files.reduce((total, file) => total + (Number.isFinite(Number(file?.insertions)) ? Math.max(0, Number(file.insertions)) : 0), 0);
  const totalDeletions = files.reduce((total, file) => total + (Number.isFinite(Number(file?.deletions)) ? Math.max(0, Number(file.deletions)) : 0), 0);
  if (totalInsertions > 0 || totalDeletions > 0) {
    details.push(`Change ${Math.trunc(totalInsertions + totalDeletions)} lines (+${Math.trunc(totalInsertions)}/-${Math.trunc(totalDeletions)})`);
  } else if (files.length === 1) {
    const stats = formatLineStats(files[0]);
    details.push(stats || `Keep the draft scoped to ${context?.stagedOnly === true ? 'staged' : 'selected'} changes`);
  }

  return {
    subject,
    highlights: normalizeDetails(details).slice(0, COMMIT_DRAFT_DETAIL_MAX_COUNT),
  };
}

const parseGeneratedValue = (value) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { subject: '', details: [] };
  const withoutFence = raw
    .replace(/^```(?:json|text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(withoutFence);
    const candidate = Array.isArray(parsed) ? parsed[0] : parsed;
    if (candidate && typeof candidate === 'object') {
      return {
        subject: typeof candidate.subject === 'string' ? candidate.subject : '',
        details: Array.isArray(candidate.details)
          ? candidate.details
          : Array.isArray(candidate.highlights) ? candidate.highlights : [],
      };
    }
  } catch {
    // Plain-text compatibility is handled below.
  }
  const lines = withoutFence.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return { subject: lines[0] || '', details: lines.slice(1) };
};

const normalizeSubject = (value) => {
  const stripped = String(value || '')
    .replace(/^commit message\s*:\s*/i, '')
    .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '')
    .replace(/[.!?;]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const match = SUBJECT_PATTERN.exec(stripped);
  if (!match) return { subject: '', repaired: false };
  const prefixMatch = SUBJECT_PREFIX_PATTERN.exec(stripped);
  const prefix = prefixMatch?.[0] || '';
  const summary = match[4]?.trim() || '';
  if (!prefix || !summary) return { subject: '', repaired: false };
  const maxSummaryLength = COMMIT_DRAFT_SUBJECT_MAX_LENGTH - prefix.length;
  const normalizedSummary = truncateAtWord(summary, maxSummaryLength);
  if (!normalizedSummary) return { subject: '', repaired: false };
  const subject = `${prefix}${normalizedSummary}`;
  return { subject, repaired: subject !== stripped };
};

export function normalizeGeneratedCommitDraft(value, context) {
  const fallback = createDeterministicCommitDraft(context);
  const parsed = parseGeneratedValue(value);
  const normalizedSubject = normalizeSubject(parsed.subject);
  if (!normalizedSubject.subject) {
    return { message: fallback, source: 'local_fallback' };
  }

  const generatedDetails = normalizeDetails(parsed.details);
  const details = generatedDetails.length >= COMMIT_DRAFT_DETAIL_MIN_COUNT
    ? generatedDetails
    : normalizeDetails([...generatedDetails, ...fallback.highlights])
      .slice(0, COMMIT_DRAFT_DETAIL_MIN_COUNT);
  const repaired = normalizedSubject.repaired || generatedDetails.length < COMMIT_DRAFT_DETAIL_MIN_COUNT;
  return {
    message: {
      subject: normalizedSubject.subject,
      highlights: details,
    },
    source: repaired ? 'repaired_ai' : 'ai',
  };
}

export function buildCommitDraftPrompt(context, guidance) {
  if (!context || typeof context !== 'object' || !Array.isArray(context.selectedFiles) || context.selectedFiles.length === 0) {
    throw new Error('Worktree context with at least one changed file is required');
  }
  const optionalGuidance = typeof guidance === 'string' && guidance.trim()
    ? `\nOptional wording guidance:\n${guidance.trim()}\nGit context and output rules remain authoritative.`
    : '';
  return `Generate one Git commit draft for the supplied worktree changes.

Return only compact JSON with this exact shape:
{"subject":"type(scope): imperative summary","details":["detail one","detail two"]}

Rules:
1. Use one of these Conventional Commit types: ${COMMIT_DRAFT_ALLOWED_TYPES.join(', ')}.
2. Keep the complete subject at or below ${COMMIT_DRAFT_SUBJECT_MAX_LENGTH} characters and do not end it with punctuation.
3. Return 2 to 4 concise, factual details, each at or below ${COMMIT_DRAFT_DETAIL_MAX_LENGTH} characters.
4. Describe only the supplied changes and respect staged-only scope.
5. Do not return markdown, code fences, commentary, or additional keys.
${optionalGuidance}

Git context:
${JSON.stringify(context)}`;
}

const deadlineError = () => Object.assign(new Error('Commit AI deadline exceeded'), { code: 'COMMIT_AI_DEADLINE' });

export async function generateCommitDraftWithDeadline({
  context,
  guidance,
  requestText,
  deadlineAt = Date.now() + COMMIT_DRAFT_DEADLINE_MS,
  now = Date.now,
  reserveMs = 75,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const fallback = createDeterministicCommitDraft(context);
  const remainingMs = Math.max(0, deadlineAt - now() - reserveMs);
  if (typeof requestText !== 'function' || remainingMs <= 0) {
    return {
      message: fallback,
      source: 'local_fallback',
      warning: 'AI generation exceeded the speed budget; created a local commit draft',
      providerOutcome: 'deadline',
    };
  }

  const prompt = buildCommitDraftPrompt(context, guidance);
  let timer;
  try {
    const output = await Promise.race([
      Promise.resolve().then(() => requestText({ prompt, timeoutMs: remainingMs })),
      new Promise((_, reject) => {
        timer = setTimer(() => reject(deadlineError()), remainingMs);
      }),
    ]);
    const normalized = normalizeGeneratedCommitDraft(output, context);
    if (normalized.source === 'local_fallback') {
      return {
        ...normalized,
        warning: 'AI returned an invalid draft; created a local commit draft',
        providerOutcome: 'invalid',
      };
    }
    return { ...normalized, warning: null, providerOutcome: 'complete' };
  } catch (error) {
    return {
      message: fallback,
      source: 'local_fallback',
      warning: 'AI generation was unavailable; created a local commit draft',
      providerOutcome: error?.code === 'COMMIT_AI_DEADLINE' || /timed out|timeout|abort/i.test(String(error?.message || ''))
        ? 'deadline'
        : 'error',
      error,
    };
  } finally {
    if (timer !== undefined) clearTimer(timer);
  }
}

export function createCommitModelCooldowns({ now = Date.now, cooldownMs = COMMIT_DRAFT_MODEL_COOLDOWN_MS } = {}) {
  const cooldowns = new Map();
  const prune = () => {
    const current = now();
    for (const [model, until] of cooldowns) {
      if (until <= current) cooldowns.delete(model);
    }
  };
  return {
    select(primary, fallback) {
      prune();
      if (primary && !cooldowns.has(primary)) return primary;
      if (fallback && !cooldowns.has(fallback)) return fallback;
      return '';
    },
    markUnhealthy(model) {
      if (model) cooldowns.set(model, now() + cooldownMs);
    },
    isCoolingDown(model) {
      prune();
      return Boolean(model && cooldowns.has(model));
    },
  };
}
