/**
 * Generate text with a session-backed model (a provider the user has actually
 * configured) through a hidden OpenCode helper session.
 *
 * Modelled on the session-title helper: create a hidden session, post one
 * message with tools disabled, optionally post a repair prompt when the first
 * reply is unusable, recover a completed reply after a transport timeout, and
 * always delete the helper session again.
 */

export const SESSION_MODEL_TEXT_TIMEOUT_MS = 60_000;
export const SESSION_MODEL_TEXT_RECOVERY_TIMEOUT_MS = 2_500;
export const SESSION_MODEL_TEXT_SESSION_TITLE = 'DevRyan text generation (internal)';

const trimString = (value) => (typeof value === 'string' ? value.trim() : '');

// Unlike the title helper this keeps line breaks: the callers expect markdown.
const extractAssistantText = (payload) => {
  const records = Array.isArray(payload) ? payload : [payload];
  for (const record of records) {
    const parts = Array.isArray(record?.parts) ? record.parts : [];
    const text = parts
      .filter((part) => part?.type === 'text')
      .map((part) => trimString(part.text ?? part.content ?? part.value))
      .filter(Boolean)
      .join('\n')
      .trim();
    if (text) return text;
  }
  return '';
};

const isAssistantRecord = (record) => (
  trimString(record?.info?.role ?? record?.role).toLowerCase() === 'assistant'
);

const reasonForStatus = (status) => {
  const code = Number(status);
  if (code === 429) return 'rate_limited';
  if ([401, 402, 403].includes(code)) return 'unauthorized';
  if (code === 404) return 'model_unavailable';
  if (code >= 500) return 'upstream_error';
  return 'request_failed';
};

const reasonForError = (error) => {
  const name = String(error?.name || '');
  const message = String(error?.message || error || '');
  if (name === 'TimeoutError' || name === 'AbortError' || /timed out|timeout/i.test(message)) return 'timeout';
  return 'request_failed';
};

export async function generateTextWithSessionModel({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders = () => ({}),
  fetchImpl = fetch,
  directory,
  providerID,
  modelID,
  agent,
  prompt,
  repairPrompt,
  accept = (text) => trimString(text) || null,
  timeoutMs = SESSION_MODEL_TEXT_TIMEOUT_MS,
  recoveryTimeoutMs = SESSION_MODEL_TEXT_RECOVERY_TIMEOUT_MS,
  sessionTitle = SESSION_MODEL_TEXT_SESSION_TITLE,
  now = () => Date.now(),
  logger = console,
} = {}) {
  const provider = trimString(providerID);
  const model = trimString(modelID);
  const promptText = trimString(prompt);
  const startedAt = now();
  const helperAgent = trimString(agent);
  let attempts = 0;
  const finish = (fields) => ({
    ok: false,
    value: null,
    text: '',
    reason: 'request_failed',
    status: undefined,
    attempts,
    ...fields,
    durationMs: Math.max(0, now() - startedAt),
  });

  if (typeof buildOpenCodeUrl !== 'function') return finish({ reason: 'runtime_unavailable' });
  if (!provider || !model) return finish({ reason: 'model_unavailable' });
  if (!promptText) return finish({ reason: 'invalid_input' });

  const deadlineAt = startedAt + Math.max(1, Math.trunc(Number(timeoutMs)) || SESSION_MODEL_TEXT_TIMEOUT_MS);
  const remainingMs = () => Math.max(1, deadlineAt - now());
  const recoveryMs = Math.max(1, Math.trunc(Number(recoveryTimeoutMs)) || SESSION_MODEL_TEXT_RECOVERY_TIMEOUT_MS);
  const query = trimString(directory) ? `?directory=${encodeURIComponent(trimString(directory))}` : '';
  const buildUrl = (requestPath) => {
    try {
      return buildOpenCodeUrl(requestPath, '') || '';
    } catch {
      return '';
    }
  };
  const headers = () => ({
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(getOpenCodeAuthHeaders?.() || {}),
  });

  let helperSessionID = '';
  try {
    const createUrl = buildUrl(`/session${query}`);
    if (!createUrl) return finish({ reason: 'runtime_unavailable' });
    let createResponse;
    try {
      createResponse = await fetchImpl(createUrl, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ title: sessionTitle }),
        signal: AbortSignal.timeout(remainingMs()),
      });
    } catch (error) {
      return finish({ reason: reasonForError(error), error });
    }
    if (!createResponse?.ok) {
      return finish({ reason: 'session_create_failed', status: createResponse?.status });
    }
    const created = await createResponse.json().catch(() => null);
    helperSessionID = trimString(created?.id ?? created?.data?.id);
    if (!helperSessionID) return finish({ reason: 'session_create_failed' });

    const messageUrl = buildUrl(`/session/${encodeURIComponent(helperSessionID)}/message${query}`);
    if (!messageUrl) return finish({ reason: 'runtime_unavailable' });

    const succeed = (text, value) => ({
      ok: true,
      value,
      text,
      reason: null,
      status: undefined,
      attempts,
      durationMs: Math.max(0, now() - startedAt),
    });

    // After a transport timeout the model may still have finished: read the
    // session back once before giving up on it.
    const recoverCompletedReply = async () => {
      try {
        const response = await fetchImpl(messageUrl, {
          headers: { Accept: 'application/json', ...(getOpenCodeAuthHeaders?.() || {}) },
          signal: AbortSignal.timeout(recoveryMs),
        });
        if (!response?.ok) return null;
        const records = await response.json().catch(() => null);
        const assistants = (Array.isArray(records) ? records : [records]).filter(isAssistantRecord).reverse();
        for (const record of assistants) {
          const text = extractAssistantText(record);
          const value = text ? await accept(text) : null;
          if (value) return succeed(text, value);
        }
      } catch {
      }
      return null;
    };

    let lastReason = 'request_failed';
    let lastStatus;
    let lastError = null;
    for (const text of [promptText, trimString(repairPrompt)].filter(Boolean)) {
      if (now() >= deadlineAt) {
        lastReason = 'timeout';
        break;
      }
      attempts += 1;
      try {
        const response = await fetchImpl(messageUrl, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({
            ...(helperAgent ? { agent: helperAgent } : {}),
            model: { providerID: provider, modelID: model },
            tools: {},
            parts: [{ type: 'text', text }],
          }),
          signal: AbortSignal.timeout(remainingMs()),
        });
        if (!response?.ok) {
          lastReason = reasonForStatus(response?.status);
          lastStatus = response?.status;
          break;
        }
        const result = await response.json().catch(() => null);
        const replyText = extractAssistantText(result?.data ?? result);
        const value = replyText ? await accept(replyText) : null;
        if (value) return succeed(replyText, value);
        lastReason = replyText ? 'invalid_output' : 'empty_output';
      } catch (error) {
        lastError = error;
        lastReason = reasonForError(error);
        const recovered = await recoverCompletedReply();
        if (recovered) return recovered;
        break;
      }
    }
    return finish({ reason: lastReason, status: lastStatus, error: lastError });
  } finally {
    if (helperSessionID) {
      const deleteUrl = buildUrl(`/session/${encodeURIComponent(helperSessionID)}${query}`);
      if (deleteUrl) {
        await fetchImpl(deleteUrl, {
          method: 'DELETE',
          headers: { Accept: 'application/json', ...(getOpenCodeAuthHeaders?.() || {}) },
          signal: AbortSignal.timeout(recoveryMs),
        }).catch((error) => {
          logger?.warn?.('[SessionModelText] Failed to clean up internal helper session:', error instanceof Error ? error.message : error);
        });
      }
    }
  }
}
