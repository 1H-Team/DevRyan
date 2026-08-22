import { isPlanControlTitle, summarizeText } from '../text/summarization.js';

const GENERATED_NEW_SESSION_TITLE_PATTERN = /^new session\s*-\s*\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z$/i;
const DEFAULT_SESSION_TITLE = 'Untitled Session';
const SESSION_TITLE_MAX_LENGTH = 80;
const SESSION_IDLE_POLL_INTERVAL_MS = 250;
const SESSION_IDLE_WAIT_TIMEOUT_MS = 120_000;
const DEFERRED_TITLE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFERRED_TITLE_MAX_SESSIONS = 500;
const XAI_PROVIDER_IDS = new Set(['xai', 'grok', 'xai-oauth']);
// Last-resort title model. The primary resolver falls back to `gpt-5-nano` when
// the free-model catalog is cold or unreachable, and that model is served but
// not free, so it answers 401 and no title is ever produced. Matches the known
// free model the commit-message route defaults to.
export const DEFAULT_TITLE_FALLBACK_ZEN_MODEL = 'deepseek-v4-flash-free';

// Ordered rotation of free OpenCode Zen models for title generation.
// `deepseek-v4-flash-free` stays first by preference; the rest exist so a single
// model leaving the free tier or hitting a rate limit no longer takes title
// generation down with it. On 2026-08-21 every one of 23 title generations
// failed because the primary answered 400/401 ("Free promotion has ended") and
// the lone fallback answered 429.
// What resolveZenModel returns when the free-model catalog is cold/unreachable.
const COLD_CATALOG_PLACEHOLDER_ZEN_MODEL = 'gpt-5-nano';

export const TITLE_ZEN_MODEL_ROTATION = Object.freeze([
  'deepseek-v4-flash-free',
  'big-pickle',
  'grok-code-fast-free',
  'qwen3-coder-free',
  'gpt-5-nano',
]);

const trimString = (value) => (typeof value === 'string' ? value.trim() : '');
const normalizeWhitespace = (value) => trimString(value).replace(/\s+/g, ' ');

const getFirstUserText = (records) => {
  if (!Array.isArray(records)) return '';
  for (const record of records) {
    if (record?.info?.role !== 'user') continue;
    const text = (Array.isArray(record.parts) ? record.parts : [])
      .filter((part) => part?.type === 'text' && part?.synthetic !== true)
      .map((part) => trimString(part.text ?? part.content ?? part.value))
      .filter(Boolean)
      .join(' ');
    if (text) return normalizeWhitespace(text);
  }
  return '';
};

const isEligibleStandardTitle = (title) => {
  const normalized = normalizeWhitespace(title);
  return !normalized
    || normalized === DEFAULT_SESSION_TITLE
    || GENERATED_NEW_SESSION_TITLE_PATTERN.test(normalized)
    || isPlanControlTitle(normalized);
};

// Only a real model-generated summary may become a session title. Every
// non-summarized result carries the user's own prompt text as its fallback, so
// persisting one would name the session after the prompt. Returning null leaves
// the placeholder in place, and `schedule()` runs again on the next prompt.
const generateDefaultTitle = async ({ text, zenModel, fallbackZenModel, zenModelRotation }) => {
  const result = await summarizeText({
    text,
    threshold: 0,
    maxLength: SESSION_TITLE_MAX_LENGTH,
    zenModel,
    fallbackZenModel,
    zenModelRotation,
    mode: 'title',
  });
  if (result.summarized !== true) return null;
  return trimString(result.summary) || null;
};

const canPatchTitleWhileBusy = (providerID) => XAI_PROVIDER_IDS.has(trimString(providerID).toLowerCase());

export const createStandardSessionTitleRuntime = ({
  generateTitle = null,
  resolveZenModel = async () => 'gpt-5-nano',
  resolveZenFallbackModel = () => DEFAULT_TITLE_FALLBACK_ZEN_MODEL,
  zenModelRotation = TITLE_ZEN_MODEL_ROTATION,
  fetchImpl = fetch,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders = () => ({}),
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  now = () => Date.now(),
  sessionIdlePollIntervalMs = SESSION_IDLE_POLL_INTERVAL_MS,
  sessionIdleWaitTimeoutMs = SESSION_IDLE_WAIT_TIMEOUT_MS,
  deferredTitleTtlMs = DEFERRED_TITLE_TTL_MS,
  deferredTitleMaxSessions = DEFERRED_TITLE_MAX_SESSIONS,
  logger = console,
} = {}) => {
  const pendingBySession = new Map();
  const pendingBackfillByDirectory = new Map();
  const deferredBySession = new Map();
  const finalizingBySession = new Map();
  const titleGenerator = typeof generateTitle === 'function'
    ? generateTitle
    : async ({ text, directory }) => {
        const resolved = trimString(await resolveZenModel());
        const rotation = Array.isArray(zenModelRotation) ? zenModelRotation : [];
        // `gpt-5-nano` is what the resolver returns when the free-model catalog
        // is cold or unreachable — it is not a real choice, it is served but not
        // free, and it 401s every time. Only that one placeholder is demoted;
        // any genuinely configured model keeps its position at the front.
        const demoteResolved = resolved === COLD_CATALOG_PLACEHOLDER_ZEN_MODEL;
        const primary = demoteResolved ? (rotation[0] || resolved) : resolved;
        return generateDefaultTitle({
          text,
          directory,
          zenModel: primary,
          fallbackZenModel: await resolveZenFallbackModel(primary),
          zenModelRotation: demoteResolved ? [...rotation, resolved] : rotation,
        });
      };

  const buildSessionUrl = (sessionID, directory, suffix = '') => {
    if (typeof buildOpenCodeUrl !== 'function') return null;
    const query = trimString(directory) ? `?directory=${encodeURIComponent(trimString(directory))}` : '';
    return buildOpenCodeUrl(`/session/${encodeURIComponent(sessionID)}${suffix}${query}`, '');
  };

  const buildSessionListUrl = (directory) => {
    if (typeof buildOpenCodeUrl !== 'function') return null;
    const query = trimString(directory) ? `?directory=${encodeURIComponent(trimString(directory))}` : '';
    return buildOpenCodeUrl(`/session${query}`, '');
  };

  const buildSessionStatusUrl = (directory) => {
    if (typeof buildOpenCodeUrl !== 'function') return null;
    const query = trimString(directory) ? `?directory=${encodeURIComponent(trimString(directory))}` : '';
    return buildOpenCodeUrl(`/session/status${query}`, '');
  };

  const readJson = async (url) => {
    if (!url) return null;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...getOpenCodeAuthHeaders(),
      },
    });
    if (!response?.ok) return null;
    return response.json().catch(() => null);
  };

  const updateSessionTitle = async (sessionID, directory, title) => {
    const url = buildSessionUrl(sessionID, directory);
    if (!url) return false;
    const response = await fetchImpl(url, {
      method: 'PATCH',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...getOpenCodeAuthHeaders(),
      },
      body: JSON.stringify({ title }),
    });
    if (!response?.ok) {
      logger.warn?.(`[SessionTitle] Title PATCH failed for ${sessionID} (status ${response?.status ?? 'unknown'})`);
      return false;
    }
    return true;
  };

  const waitForSessionIdle = async (sessionID, directory) => {
    const timeoutMs = Math.max(0, Number(sessionIdleWaitTimeoutMs) || 0);
    const pollIntervalMs = Math.max(1, Number(sessionIdlePollIntervalMs) || 1);
    const deadline = now() + timeoutMs;

    while (true) {
      const statuses = await readJson(buildSessionStatusUrl(directory));
      if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) return false;
      const status = statuses[sessionID];
      if (!status || status.type === 'idle') return true;
      if (now() >= deadline) return false;
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
    }
  };

  const clearDeferredTitle = (sessionID, expected = null) => {
    if (!expected || deferredBySession.get(sessionID) === expected) {
      deferredBySession.delete(sessionID);
    }
  };

  const pruneDeferredTitles = () => {
    const ttlMs = Math.max(1, Number(deferredTitleTtlMs) || DEFERRED_TITLE_TTL_MS);
    const cutoff = now() - ttlMs;
    for (const [sessionID, candidate] of deferredBySession) {
      if (candidate.deferredAt <= cutoff) {
        deferredBySession.delete(sessionID);
      }
    }
  };

  const deferTitle = (candidate) => {
    pruneDeferredTitles();
    const sessionID = trimString(candidate?.sessionID);
    if (!sessionID) return null;

    const limit = Math.max(1, Number(deferredTitleMaxSessions) || DEFERRED_TITLE_MAX_SESSIONS);
    deferredBySession.delete(sessionID);
    while (deferredBySession.size >= limit) {
      const oldestSessionID = deferredBySession.keys().next().value;
      if (!oldestSessionID) break;
      deferredBySession.delete(oldestSessionID);
    }

    const deferred = {
      ...candidate,
      sessionID,
      directory: trimString(candidate.directory) || undefined,
      deferredAt: now(),
    };
    deferredBySession.set(sessionID, deferred);
    return deferred;
  };

  const finalizeDeferredTitle = (sessionID) => {
    const normalizedSessionID = trimString(sessionID);
    if (!normalizedSessionID) return Promise.resolve(false);

    pruneDeferredTitles();
    const candidate = deferredBySession.get(normalizedSessionID);
    if (!candidate) return Promise.resolve(false);

    const existing = finalizingBySession.get(normalizedSessionID);
    if (existing) return existing;

    const job = (async () => {
      const current = await readJson(buildSessionUrl(
        normalizedSessionID,
        candidate.directory,
      ));
      if (deferredBySession.get(normalizedSessionID) !== candidate) {
        return true;
      }
      const currentTitle = trimString(current?.title);
      if (!current) return false;

      if (currentTitle === candidate.generatedTitle) {
        clearDeferredTitle(normalizedSessionID, candidate);
        return true;
      }

      if (currentTitle !== candidate.observedTitle && !isEligibleStandardTitle(currentTitle)) {
        // A manual rename or another authoritative title appeared while the
        // provider turn was active. It always wins over the deferred summary.
        clearDeferredTitle(normalizedSessionID, candidate);
        return true;
      }

      if (candidate.patchedWhileBusy) {
        logger.warn?.(`[SessionTitle] Re-applying title for ${normalizedSessionID}: busy-turn write reverted it to "${currentTitle}"`);
      }
      const updated = await updateSessionTitle(
        normalizedSessionID,
        candidate.directory,
        candidate.generatedTitle,
      );
      if (updated) {
        clearDeferredTitle(normalizedSessionID, candidate);
      }
      return updated;
    })()
      .catch((error) => {
        logger.warn?.('[SessionTitle] Failed to finalize deferred session title:', error instanceof Error ? error.message : error);
        return false;
      })
      .finally(() => {
        if (finalizingBySession.get(normalizedSessionID) === job) {
          finalizingBySession.delete(normalizedSessionID);
        }
      });
    finalizingBySession.set(normalizedSessionID, job);
    return job;
  };

  const run = async ({ sessionID, directory, text, providerID }) => {
    if (!trimString(sessionID)) return false;

    const records = await readJson(buildSessionUrl(sessionID, directory, '/message'));
    const firstUserText = getFirstUserText(records) || normalizeWhitespace(text);
    if (!firstUserText) {
      logger.warn?.(`[SessionTitle] Skipped ${sessionID}: no user text to summarize`);
      return false;
    }

    const before = await readJson(buildSessionUrl(sessionID, directory));
    const observedTitle = trimString(before?.title);
    if (!before) {
      logger.warn?.(`[SessionTitle] Skipped ${sessionID}: session fetch failed`);
      return false;
    }
    if (!isEligibleStandardTitle(observedTitle)) return false;

    const generatedTitle = trimString(await titleGenerator({
      text: firstUserText,
      directory: trimString(directory) || undefined,
    }));
    if (!generatedTitle || isPlanControlTitle(generatedTitle) || generatedTitle === observedTitle) {
      logger.warn?.(`[SessionTitle] Skipped ${sessionID}: generator produced no usable title`);
      return false;
    }

    const deferred = deferTitle({
      sessionID,
      directory,
      generatedTitle,
      observedTitle,
      patchedWhileBusy: false,
    });
    if (!deferred) return false;

    // A title PATCH advances OpenCode's session revision. Wait for the active
    // provider turn to settle so session-keyed transports (notably Claude via
    // Meridian) do not reject the in-flight request as stale. xAI tolerates a
    // mid-turn PATCH, so it gets its title immediately — but OpenCode's own
    // session writes race that busy PATCH and can revert the title, so the busy
    // path must re-verify at idle and re-apply if the title was clobbered.
    if (canPatchTitleWhileBusy(providerID)) {
      if (!await updateSessionTitle(sessionID, directory, generatedTitle)) {
        clearDeferredTitle(sessionID, deferred);
        return false;
      }
      deferred.patchedWhileBusy = true;
      if (!await waitForSessionIdle(sessionID, directory)) {
        if (deferredBySession.get(sessionID) !== deferred) return true;
        logger.warn?.(`[SessionTitle] Idle wait timed out for ${sessionID}; deferring busy-title verification until the authoritative idle event`);
        return true;
      }
      return finalizeDeferredTitle(sessionID);
    }

    if (!await waitForSessionIdle(sessionID, directory)) {
      if (deferredBySession.get(sessionID) !== deferred) return true;
      logger.warn?.(`[SessionTitle] Deferred ${sessionID}: session remained busy beyond ${sessionIdleWaitTimeoutMs}ms`);
      return false;
    }
    return finalizeDeferredTitle(sessionID);
  };

  const schedule = (input = {}) => {
    const sessionID = trimString(input.sessionID);
    if (!sessionID) return Promise.resolve(false);
    const existing = pendingBySession.get(sessionID);
    if (existing) return existing;

    const job = run({
      sessionID,
      directory: input.directory,
      text: input.text,
      providerID: input.providerID,
    })
      .catch((error) => {
        logger.warn?.('[SessionTitle] Failed to generate standard-provider session title:', error instanceof Error ? error.message : error);
        return false;
      })
      .finally(() => {
        if (pendingBySession.get(sessionID) === job) {
          pendingBySession.delete(sessionID);
        }
      });
    pendingBySession.set(sessionID, job);
    return job;
  };

  const scheduleMarkerBackfill = (input = {}) => {
    const directory = trimString(input.directory);
    const key = directory || '__global__';
    const existing = pendingBackfillByDirectory.get(key);
    if (existing) return existing;

    const job = readJson(buildSessionListUrl(directory))
      .then(async (sessions) => {
        if (!Array.isArray(sessions)) return false;
        const markerSessions = sessions.filter((session) => (
          trimString(session?.id) && isPlanControlTitle(session?.title)
        ));
        if (markerSessions.length === 0) return false;

        const results = await Promise.allSettled(markerSessions.map((session) => schedule({
          sessionID: session.id,
          directory,
        })));
        return results.some((result) => result.status === 'fulfilled' && result.value === true);
      })
      .catch((error) => {
        logger.warn?.('[SessionTitle] Failed to scan for historical plan-control titles:', error instanceof Error ? error.message : error);
        return false;
      })
      .finally(() => {
        if (pendingBackfillByDirectory.get(key) === job) {
          pendingBackfillByDirectory.delete(key);
        }
      });
    pendingBackfillByDirectory.set(key, job);
    return job;
  };

  const processOpenCodeEvent = (payload) => {
    pruneDeferredTitles();
    if (!payload || typeof payload !== 'object') return Promise.resolve(false);

    if (payload.type === 'session.deleted') {
      const sessionID = trimString(payload?.properties?.info?.id ?? payload?.properties?.sessionID);
      if (!sessionID) return Promise.resolve(false);
      deferredBySession.delete(sessionID);
      return Promise.resolve(true);
    }

    if (payload.type === 'session.updated') {
      const info = payload?.properties?.info;
      const sessionID = trimString(info?.id ?? payload?.properties?.sessionID);
      const candidate = deferredBySession.get(sessionID);
      const updatedTitle = trimString(info?.title);
      if (
        candidate
        && updatedTitle
        && updatedTitle !== candidate.generatedTitle
        && updatedTitle !== candidate.observedTitle
        && !isEligibleStandardTitle(updatedTitle)
      ) {
        clearDeferredTitle(sessionID, candidate);
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    }

    if (payload.type !== 'session.status') return Promise.resolve(false);
    const sessionID = trimString(payload?.properties?.sessionID);
    const statusType = trimString(
      payload?.properties?.status?.type ?? payload?.properties?.info?.type,
    ).toLowerCase();
    if (!sessionID || statusType !== 'idle') return Promise.resolve(false);
    return finalizeDeferredTitle(sessionID);
  };

  return { schedule, scheduleMarkerBackfill, processOpenCodeEvent };
};

export { canPatchTitleWhileBusy };
