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

export async function runFreeZenModelRotation({
  models,
  timeoutMs,
  request,
  accept = (value) => value,
  onAttempt,
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

  const failures = [];
  for (let index = 0; index < orderedModels.length; index += 1) {
    const model = orderedModels[index];
    const attempt = index + 1;
    const startedAt = now();
    const timeoutError = Object.assign(new Error(`Free Zen model timed out after ${perModelTimeoutMs}ms`), {
      code: 'FREE_ZEN_TIMEOUT',
    });
    let timer;
    try {
      const raw = await Promise.race([
        Promise.resolve(request({ model, timeoutMs: perModelTimeoutMs })),
        new Promise((_, reject) => {
          timer = setTimer(() => reject(timeoutError), perModelTimeoutMs);
          timer?.unref?.();
        }),
      ]);
      const value = await accept(raw, { model, attempt });
      const durationMs = Math.max(0, now() - startedAt);
      if (value !== null && value !== undefined && value !== false && value !== '') {
        onAttempt?.({ model, attempt, durationMs, outcome: 'complete' });
        return { ok: true, value, model, attempts: attempt, failures };
      }
      const failure = { model, attempt, durationMs, reason: 'invalid_output' };
      failures.push(failure);
      onAttempt?.({ ...failure, outcome: 'failed' });
    } catch (error) {
      const failure = {
        model,
        attempt,
        durationMs: Math.max(0, now() - startedAt),
        reason: error === timeoutError ? 'timeout' : classifyFreeZenFailure(error),
        status: Number.isFinite(Number(error?.status)) ? Number(error.status) : undefined,
      };
      failures.push(failure);
      onAttempt?.({ ...failure, outcome: 'failed' });
    } finally {
      if (timer !== undefined) clearTimer(timer);
    }
  }

  return { ok: false, value: null, model: null, attempts: orderedModels.length, failures };
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

export const normalizePullRequestDraft = (value) => {
  const parsed = parseJsonObject(value);
  const title = trimString(parsed?.title);
  const body = trimString(parsed?.body);
  if (!title || title.length > 80 || !body) return null;
  return { title, body };
};
