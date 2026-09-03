const trimString = (value) => (typeof value === 'string' ? value.trim() : '');

const modelIdOf = (value) => trimString(value?.id ?? value);

export const classifyFreeZenFailure = (error) => {
  const status = Number(error?.status);
  const message = String(error?.message || error || '');
  if (status === 429 || /rate limit/i.test(message)) return 'rate_limited';
  if ([400, 404].includes(status) && /model.*(?:unavailable|not found|unsupported|unknown|invalid)/i.test(message)) {
    return 'model_unavailable';
  }
  if ([401, 402, 403].includes(status)) return 'unauthorized';
  if (status >= 500) return 'upstream_error';
  if (/timed out|timeout|AbortError/i.test(message)) return 'timeout';
  if (/no text|empty/i.test(message)) return 'empty_output';
  if (/invalid/i.test(message)) return 'invalid_output';
  return 'request_failed';
};

const resolveModelLimit = (maxModels, fallback) => {
  const parsed = Number(maxModels);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : fallback;
};

export async function runFreeZenModelRotation({
  models,
  timeoutMs,
  request,
  accept = (value) => value,
  onAttempt,
  cooldowns = null,
  maxModels,
  deadlineMs,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof request !== 'function') throw new Error('Free Zen request function is required');
  const perModelTimeoutMs = Math.max(1, Math.trunc(Number(timeoutMs) || 1));
  const orderedModels = [];
  for (const candidate of Array.isArray(models) ? models : []) {
    const model = modelIdOf(candidate);
    if (model && !orderedModels.includes(model)) orderedModels.push(model);
  }

  const skipped = [];
  let candidates = orderedModels;
  // A model in cooldown is skipped unless every model is cooling down: a
  // whole-catalog outage must not make the caller give up without trying.
  if (cooldowns && typeof cooldowns.isCoolingDown === 'function') {
    const warm = orderedModels.filter((model) => !cooldowns.isCoolingDown(model));
    if (warm.length > 0 && warm.length < orderedModels.length) {
      for (const model of orderedModels) {
        if (!warm.includes(model)) skipped.push({ model, reason: 'cooling_down' });
      }
      candidates = warm;
    }
  }
  const limit = resolveModelLimit(maxModels, candidates.length);
  if (candidates.length > limit) {
    for (const model of candidates.slice(limit)) skipped.push({ model, reason: 'max_models' });
    candidates = candidates.slice(0, limit);
  }

  const startedAt = now();
  const totalBudgetMs = Number(deadlineMs);
  const deadlineAt = Number.isFinite(totalBudgetMs) && totalBudgetMs > 0
    ? startedAt + Math.trunc(totalBudgetMs)
    : Number.POSITIVE_INFINITY;
  let deadlineExceeded = false;

  const failures = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const model = candidates[index];
    const attempt = index + 1;
    const attemptStartedAt = now();
    const remainingMs = deadlineAt - attemptStartedAt;
    if (remainingMs <= 0) {
      deadlineExceeded = true;
      for (const rest of candidates.slice(index)) skipped.push({ model: rest, reason: 'deadline' });
      break;
    }
    const attemptTimeoutMs = Math.max(1, Math.min(perModelTimeoutMs, remainingMs));
    const timeoutError = Object.assign(new Error(`Free Zen model timed out after ${attemptTimeoutMs}ms`), {
      code: 'FREE_ZEN_TIMEOUT',
    });
    let timer;
    try {
      const raw = await Promise.race([
        Promise.resolve(request({ model, timeoutMs: attemptTimeoutMs })),
        new Promise((_, reject) => {
          timer = setTimer(() => reject(timeoutError), attemptTimeoutMs);
          timer?.unref?.();
        }),
      ]);
      const value = await accept(raw, { model, attempt });
      const durationMs = Math.max(0, now() - attemptStartedAt);
      if (value !== null && value !== undefined && value !== false && value !== '') {
        onAttempt?.({ model, attempt, durationMs, outcome: 'complete' });
        return { ok: true, value, model, attempts: attempt, failures, skipped, deadlineExceeded };
      }
      const failure = { model, attempt, durationMs, reason: 'invalid_output' };
      failures.push(failure);
      cooldowns?.mark?.(model, failure.reason);
      onAttempt?.({ ...failure, outcome: 'failed' });
    } catch (error) {
      const failure = {
        model,
        attempt,
        durationMs: Math.max(0, now() - attemptStartedAt),
        reason: error === timeoutError ? 'timeout' : classifyFreeZenFailure(error),
        status: Number.isFinite(Number(error?.status)) ? Number(error.status) : undefined,
      };
      failures.push(failure);
      cooldowns?.mark?.(model, failure.reason);
      onAttempt?.({ ...failure, outcome: 'failed' });
    } finally {
      if (timer !== undefined) clearTimer(timer);
    }
  }

  return { ok: false, value: null, model: null, attempts: failures.length, failures, skipped, deadlineExceeded };
}

const parseJsonObject = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const text = trimString(value);
  if (!text) return null;
  const candidates = [
    ...Array.from(text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi), (match) => match[1]?.trim()),
    text,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    if (start < 0) continue;
    for (let end = candidate.length; end > start; end -= 1) {
      if (candidate[end - 1] !== '}') continue;
      try {
        const parsed = JSON.parse(candidate.slice(start, end));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {
      }
    }
  }
  return null;
};

export const PULL_REQUEST_TITLE_MAX_LENGTH = 80;

const TITLE_QUOTE_PAIRS = [['"', '"'], ["'", "'"], ['`', '`'], ['“', '”'], ['‘', '’'], ['«', '»']];

const stripPullRequestTitleDecorations = (value) => {
  let title = trimString(value).replace(/\s+/g, ' ');
  for (let pass = 0; pass < 4 && title; pass += 1) {
    const before = title;
    title = title.replace(/^#{1,6}\s+/, '');
    title = title.replace(/^(?:pr\s+|pull\s+request\s+)?title\s*[:\-–—]\s*/i, '');
    for (const [open, close] of TITLE_QUOTE_PAIRS) {
      if (title.length >= 2 && title.startsWith(open) && title.endsWith(close)) {
        title = title.slice(open.length, title.length - close.length);
        break;
      }
    }
    title = title.trim();
    if (title === before) break;
  }
  return title;
};

/**
 * Clean up a generated PR title and shorten it to `maxLength` at a word
 * boundary instead of rejecting the whole draft. An ellipsis marks the cut
 * whenever it still fits within the limit.
 */
export const shortenPullRequestTitle = (value, maxLength = PULL_REQUEST_TITLE_MAX_LENGTH) => {
  const limit = Math.max(1, Math.trunc(Number(maxLength)) || PULL_REQUEST_TITLE_MAX_LENGTH);
  const title = stripPullRequestTitleDecorations(value);
  if (title.length <= limit) return title;

  const window = title.slice(0, limit + 1);
  const boundary = window.lastIndexOf(' ');
  if (boundary >= Math.ceil(limit / 2)) {
    const prefix = title.slice(0, boundary).replace(/[\s,;:\-–—.(\[{]+$/u, '').trim();
    if (prefix) return prefix.length < limit ? `${prefix}…` : prefix;
  }
  // A single giant token (or a boundary too early to be useful): hard cut.
  return `${title.slice(0, limit - 1).trim()}…`;
};

const normalizePullRequestBody = (value) => {
  let body = typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '';
  if (!body) return '';
  const fenced = body.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  if (fenced) body = fenced[1].trim();
  return body;
};

// Non-JSON output (typical for session models that ignore the format rule):
// first non-empty line is the title, the rest is the body.
const parsePlainTextDraft = (value) => {
  let text = typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '';
  if (!text) return null;
  const fenced = text.match(/^```[a-z]*\s*\n([\s\S]*?)\n```$/i);
  if (fenced) text = fenced[1].trim();
  if (text.startsWith('{')) return null;
  const lines = text.split('\n');
  const titleIndex = lines.findIndex((line) => line.trim());
  if (titleIndex < 0) return null;
  const title = lines[titleIndex].trim();
  const body = lines.slice(titleIndex + 1).join('\n').trim();
  if (!title || title.length > 200 || !body) return null;
  if (!/^#{1,6}\s/m.test(body) && body.length < 40) return null;
  return { title, body };
};

export const normalizePullRequestDraft = (value, { maxTitleLength = PULL_REQUEST_TITLE_MAX_LENGTH } = {}) => {
  const parsed = parseJsonObject(value);
  let rawTitle;
  let rawBody;
  if (parsed) {
    rawTitle = parsed.title ?? parsed.name ?? parsed.subject;
    rawBody = parsed.body ?? parsed.description ?? parsed.summary;
  } else {
    const plain = parsePlainTextDraft(value);
    if (!plain) return null;
    rawTitle = plain.title;
    rawBody = plain.body;
  }
  const title = shortenPullRequestTitle(typeof rawTitle === 'string' ? rawTitle : '', maxTitleLength);
  const body = normalizePullRequestBody(rawBody);
  if (!title || !body) return null;
  return { title, body };
};

export const PULL_REQUEST_DIFF_MAX_CHARS = 40_000;
const DIFF_STAT_MAX_CHARS = 4_000;
const DIFF_TRUNCATION_RESERVE = 48;
const DIFF_NOTE_MAX_PATHS = 20;

const parseDiffFilePath = (chunk) => {
  const header = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
  return header ? header[2].trim() : '';
};

const isBinaryDiffChunk = (chunk) => /^Binary files .* differ$/m.test(chunk) || /^GIT binary patch$/m.test(chunk);

const truncateDiffChunk = (chunk, budget) => {
  if (chunk.length <= budget) return chunk;
  const room = Math.max(0, budget - DIFF_TRUNCATION_RESERVE);
  let head = chunk.slice(0, room);
  const lastNewline = head.lastIndexOf('\n');
  if (lastNewline > room / 2) head = head.slice(0, lastNewline);
  return `${head}\n… [truncated ${chunk.length - head.length} chars]`;
};

const describePaths = (paths) => (
  paths.length > DIFF_NOTE_MAX_PATHS
    ? `${paths.slice(0, DIFF_NOTE_MAX_PATHS).join(', ')} (+${paths.length - DIFF_NOTE_MAX_PATHS} more)`
    : paths.join(', ')
);

/**
 * Turn a unified diff (plus optional `--stat` output) into a prompt section
 * capped at `maxChars`. Binary files are skipped; when the cap bites, the
 * largest files absorb the truncation so small files stay intact.
 */
export const buildPullRequestDiffContext = ({ diff, stat, maxChars = PULL_REQUEST_DIFF_MAX_CHARS } = {}) => {
  const cap = Math.max(1, Math.trunc(Number(maxChars)) || PULL_REQUEST_DIFF_MAX_CHARS);
  const rawDiff = typeof diff === 'string' ? diff.replace(/\r\n/g, '\n') : '';
  const rawStat = typeof stat === 'string' ? stat.replace(/\r\n/g, '\n').trim() : '';
  const statText = rawStat.length > DIFF_STAT_MAX_CHARS
    ? `${rawStat.slice(0, DIFF_STAT_MAX_CHARS)}\n… [stat truncated]`
    : rawStat;

  const files = [];
  const skippedBinary = [];
  for (const chunk of rawDiff.split(/^(?=diff --git )/m).map((entry) => entry.trimEnd()).filter((entry) => entry.trim())) {
    const path = parseDiffFilePath(chunk) || '(unknown)';
    if (isBinaryDiffChunk(chunk)) {
      skippedBinary.push(path);
      continue;
    }
    files.push({ path, chunk });
  }

  const totalChars = files.reduce((sum, file) => sum + file.chunk.length, 0);
  if (files.length === 0 && !statText) {
    return { text: '', truncated: false, totalChars: 0, includedChars: 0, fileCount: 0, skippedBinary, omitted: [] };
  }

  const budget = Math.max(0, cap - statText.length);
  const order = files.map((file, index) => ({ ...file, index })).sort((a, b) => a.chunk.length - b.chunk.length);
  const kept = new Array(files.length).fill('');
  const omitted = [];
  let remainingBudget = budget;
  let remainingCount = order.length;
  let truncated = false;
  for (const entry of order) {
    const share = remainingCount > 0 ? Math.floor(remainingBudget / remainingCount) : 0;
    let text = '';
    if (entry.chunk.length <= share) {
      text = entry.chunk;
    } else if (share <= DIFF_TRUNCATION_RESERVE + 16) {
      omitted.push(entry.path);
    } else {
      text = truncateDiffChunk(entry.chunk, share);
      truncated = true;
    }
    kept[entry.index] = text;
    remainingBudget -= text.length;
    remainingCount -= 1;
  }

  const includedChars = kept.reduce((sum, text) => sum + text.length, 0);
  const wasCut = truncated || omitted.length > 0;
  const label = wasCut
    ? `Diff (truncated to ${includedChars} of ${totalChars} chars)`
    : `Diff (${totalChars} chars)`;
  const notes = [];
  if (skippedBinary.length > 0) notes.push(`binary files skipped: ${describePaths(skippedBinary)}`);
  if (omitted.length > 0) notes.push(`files omitted for size: ${describePaths(omitted)}`);
  const sections = [];
  if (statText) sections.push(`Diff stat:\n${statText}`);
  const body = kept.filter(Boolean).join('\n');
  sections.push(`${label}${notes.length > 0 ? ` — ${notes.join('; ')}` : ''}:\n${body || '(no textual changes)'}`);

  return {
    text: sections.join('\n\n'),
    truncated: wasCut,
    totalChars,
    includedChars,
    fileCount: files.length,
    skippedBinary,
    omitted,
  };
};
