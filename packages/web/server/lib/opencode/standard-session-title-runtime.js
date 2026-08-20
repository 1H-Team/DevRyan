import { isPlanControlTitle, summarizeText } from '../text/summarization.js';

const GENERATED_NEW_SESSION_TITLE_PATTERN = /^new session\s*-\s*\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z$/i;
const DEFAULT_SESSION_TITLE = 'Untitled Session';
const SESSION_TITLE_MAX_LENGTH = 80;
const SESSION_IDLE_POLL_INTERVAL_MS = 250;
const SESSION_IDLE_WAIT_TIMEOUT_MS = 120_000;

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

const generateDefaultTitle = async ({ text, zenModel }) => {
  const result = await summarizeText({
    text,
    threshold: 0,
    maxLength: SESSION_TITLE_MAX_LENGTH,
    zenModel,
    mode: 'title',
  });
  return trimString(result.summary) || null;
};

export const createStandardSessionTitleRuntime = ({
  generateTitle = null,
  resolveZenModel = async () => 'gpt-5-nano',
  fetchImpl = fetch,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders = () => ({}),
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  now = () => Date.now(),
  sessionIdlePollIntervalMs = SESSION_IDLE_POLL_INTERVAL_MS,
  sessionIdleWaitTimeoutMs = SESSION_IDLE_WAIT_TIMEOUT_MS,
  logger = console,
} = {}) => {
  const pendingBySession = new Map();
  const pendingBackfillByDirectory = new Map();
  const titleGenerator = typeof generateTitle === 'function'
    ? generateTitle
    : async ({ text, directory }) => generateDefaultTitle({
        text,
        directory,
        zenModel: await resolveZenModel(),
      });

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
    return Boolean(response?.ok);
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

  const run = async ({ sessionID, directory, text }) => {
    if (!trimString(sessionID)) return false;

    const records = await readJson(buildSessionUrl(sessionID, directory, '/message'));
    const firstUserText = getFirstUserText(records) || normalizeWhitespace(text);
    if (!firstUserText) return false;

    const before = await readJson(buildSessionUrl(sessionID, directory));
    const observedTitle = trimString(before?.title);
    if (!before || !isEligibleStandardTitle(observedTitle)) return false;

    const generatedTitle = trimString(await titleGenerator({
      text: firstUserText,
      directory: trimString(directory) || undefined,
    }));
    if (!generatedTitle || isPlanControlTitle(generatedTitle) || generatedTitle === observedTitle) return false;

    // A title PATCH advances OpenCode's session revision. Wait for the active
    // provider turn to settle so session-keyed transports (notably Claude via
    // Meridian) do not reject the in-flight request as stale.
    if (!await waitForSessionIdle(sessionID, directory)) return false;

    const current = await readJson(buildSessionUrl(sessionID, directory));
    const currentTitle = trimString(current?.title);
    if (!current || (currentTitle !== observedTitle && !isEligibleStandardTitle(currentTitle))) return false;
    return updateSessionTitle(sessionID, directory, generatedTitle);
  };

  const schedule = (input = {}) => {
    const sessionID = trimString(input.sessionID);
    if (!sessionID) return Promise.resolve(false);
    const existing = pendingBySession.get(sessionID);
    if (existing) return existing;

    const job = run({ sessionID, directory: input.directory, text: input.text })
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

  return { schedule, scheduleMarkerBackfill };
};
