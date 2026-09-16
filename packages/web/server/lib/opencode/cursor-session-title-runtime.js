import { createHash } from 'node:crypto';

const CURSOR_PROVIDER_ID = 'cursor-acp';
const GENERATED_NEW_SESSION_TITLE_PATTERN = /^new session\s*-\s*\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z$/i;
const CURSOR_ERROR_TITLE_PATTERN = /^cursor-acp\s+error\s*:/i;
const DEFAULT_SESSION_TITLE = 'Untitled Session';

const trimString = (value) => (typeof value === 'string' ? value.trim() : '');
const normalizeWhitespace = (value) => trimString(value).replace(/\s+/g, ' ');

const getFirstCursorUserText = (records) => {
  if (!Array.isArray(records)) return '';
  for (const record of records) {
    if (record?.info?.role !== 'user' || record?.info?.providerID !== CURSOR_PROVIDER_ID) continue;
    const text = (Array.isArray(record.parts) ? record.parts : [])
      .filter((part) => part?.type === 'text' && part?.synthetic !== true)
      .map((part) => trimString(part.text ?? part.content ?? part.value))
      .filter(Boolean)
      .join(' ');
    if (text) return normalizeWhitespace(text);
  }
  return '';
};

const isLegacyRawPromptTitle = (title, firstUserText) => {
  const normalizedTitle = normalizeWhitespace(title);
  const normalizedPrompt = normalizeWhitespace(firstUserText);
  if (!normalizedTitle || !normalizedPrompt) return false;
  if (normalizedTitle === normalizedPrompt) return true;
  if (!normalizedTitle.endsWith('...')) return false;
  const prefix = normalizedTitle.slice(0, -3).trimEnd();
  return Boolean(prefix && normalizedPrompt.startsWith(prefix));
};

const isEligibleCursorTitle = (title, firstUserText) => {
  const normalized = normalizeWhitespace(title);
  return !normalized
    || normalized === DEFAULT_SESSION_TITLE
    || GENERATED_NEW_SESSION_TITLE_PATTERN.test(normalized)
    || CURSOR_ERROR_TITLE_PATTERN.test(normalized)
    || isLegacyRawPromptTitle(normalized, firstUserText);
};

export const createCursorSessionTitleRuntime = ({
  cursorSdkRuntime,
  fetchImpl = fetch,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders = () => ({}),
  logger = console,
} = {}) => {
  const pendingBySession = new Map();
  const generatedBySession = new Map();

  const buildSessionUrl = (sessionID, directory) => {
    if (typeof buildOpenCodeUrl !== 'function') return null;
    const query = trimString(directory) ? `?directory=${encodeURIComponent(trimString(directory))}` : '';
    return buildOpenCodeUrl(`/session/${encodeURIComponent(sessionID)}${query}`, '');
  };

  const readSession = async (sessionID, directory) => {
    const url = buildSessionUrl(sessionID, directory);
    if (!url) return null;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...getOpenCodeAuthHeaders(),
      },
    });
    if (!response?.ok) return null;
    const payload = await response.json().catch(() => null);
    return payload && typeof payload === 'object' ? payload : null;
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

  const run = async ({ sessionID, directory }) => {
    if (!trimString(sessionID)
      || typeof cursorSdkRuntime?.getSessionMessages !== 'function'
      || typeof cursorSdkRuntime?.generateTitle !== 'function') {
      return false;
    }

    const records = await cursorSdkRuntime.getSessionMessages(sessionID);
    const firstUserText = getFirstCursorUserText(records);
    if (!firstUserText) return false;

    const before = await readSession(sessionID, directory);
    const observedTitle = trimString(before?.title);
    if (!before) return false;
    if (!isEligibleCursorTitle(observedTitle, firstUserText)) {
      generatedBySession.delete(sessionID);
      return false;
    }

    const fingerprint = createHash('sha256').update(JSON.stringify([trimString(directory), firstUserText])).digest('hex');
    const retained = generatedBySession.get(sessionID);
    const generatedTitle = retained?.fingerprint === fingerprint ? retained.title
      : trimString(await cursorSdkRuntime.generateTitle({
        sessionID,
        text: firstUserText,
        directory: trimString(directory) || undefined,
      }));
    if (!generatedTitle || generatedTitle === observedTitle) return false;

    // A failed read/PATCH must not purchase the same title again on the next
    // interaction. Retain only a bounded result and source hash until saved.
    generatedBySession.delete(sessionID);
    generatedBySession.set(sessionID, { fingerprint, title: generatedTitle });
    if (generatedBySession.size > 128) generatedBySession.delete(generatedBySession.keys().next().value);

    const current = await readSession(sessionID, directory);
    if (!current) return false;
    if (trimString(current.title) !== observedTitle) {
      generatedBySession.delete(sessionID);
      return false;
    }
    const saved = await updateSessionTitle(sessionID, directory, generatedTitle);
    if (saved) generatedBySession.delete(sessionID);
    return saved;
  };

  const schedule = (input = {}) => {
    const sessionID = trimString(input.sessionID);
    if (!sessionID) return Promise.resolve(false);
    const existing = pendingBySession.get(sessionID);
    if (existing) return existing;

    const job = run({ sessionID, directory: input.directory })
      .catch((error) => {
        logger.warn?.('[CursorSDK] Failed to generate session title:', error instanceof Error ? error.message : error);
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

  return { schedule };
};
