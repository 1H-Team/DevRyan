/** Bounded model text through the existing native provider or read-only Cursor owner. */

import { OPENCODE_CAPABILITY_ABSENT, resolveOpenCodeGeneration } from './opencode-generation.js';
import { randomUUID } from 'node:crypto';

export const SESSION_MODEL_TEXT_TIMEOUT_MS = 60_000;

const FREE_TIER_REJECTED_PATTERN = /free tier can only be used/i;

export const sessionModelFailureReasonForStatus = (status) => {
  const code = Number(status);
  if (code === 429) return 'rate_limited';
  if ([401, 402, 403].includes(code)) return 'unauthorized';
  if (code === 404) return 'model_unavailable';
  if (code >= 500) return 'upstream_error';
  return 'request_failed';
};

export const classifySessionModelProviderError = (error) => {
  const status = Number.isFinite(error?.data?.statusCode) ? error.data.statusCode : undefined;
  const reason = error?.name === 'ProviderModelNotFoundError' ? 'model_unavailable'
    : FREE_TIER_REJECTED_PATTERN.test(String(error?.data?.message ?? '')) ? 'free_tier_rejected'
      : sessionModelFailureReasonForStatus(status);
  return { reason, status };
};

/** Every attempt settles its admitted provider/worker before repair or model rotation. */
export async function generateTextWithSessionModel({ openCodeClient, generateHelperText, cursorRuntime, directory, sessionID,
  providerID, modelID, variant, agent, prompt, repairPrompt, system, maxOutputTokens = 2048, operationID = randomUUID(),
  accept = text => text.trim() || null, timeoutMs = SESSION_MODEL_TEXT_TIMEOUT_MS, signal, now = () => Date.now() } = {}) {
  const startedAt = now(); let attempts = 0;
  const finish = fields => ({ ok: false, value: null, text: '', status: undefined, attempts,
    ...fields, durationMs: Math.max(0, now() - startedAt) });
  try { resolveOpenCodeGeneration(openCodeClient); }
  catch (error) { return finish({ reason: 'runtime_unavailable', error }); }
  const cursor = providerID === 'cursor-acp';
  if (cursor ? typeof cursorRuntime?.generateText !== 'function' : typeof generateHelperText !== 'function') {
    return finish({ reason: OPENCODE_CAPABILITY_ABSENT, capability: 'session_model_text' });
  }
  if (!providerID || !modelID) return finish({ reason: 'model_unavailable' });
  if (typeof prompt !== 'string' || !prompt.trim() || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) return finish({ reason: 'invalid_input' });
  const deadline = startedAt + timeoutMs;
  for (const text of [prompt, repairPrompt].filter(value => typeof value === 'string' && value.trim())) {
    if (signal?.aborted || now() >= deadline) return finish({ reason: 'timeout' });
    attempts += 1;
    try {
      const remaining = Math.max(1, Math.ceil(deadline - now()));
      const generated = cursor ? { text: await cursorRuntime.generateText({ text: system ? `${system}\n\n${text}` : text,
        directory, ...(sessionID ? { sessionID } : {}), ...(agent === 'devryan-title' ? { titleHelper: true } : {}), modelID, ...(variant ? { variant } : {}), timeoutMs: remaining, signal }) }
        : await generateHelperText({ operationID, directory, ...(sessionID ? { sessionID } : {}), providerID, modelID, agent,
          ...(variant ? { variant } : {}), prompt: text, ...(system ? { system } : {}), timeoutMs: remaining, maxOutputTokens, signal });
      signal?.throwIfAborted();
      const output = typeof generated?.text === 'string' ? generated.text : '';
      const value = output ? await accept(output) : null;
      if (value) return finish({ ok: true, value, text: output, reason: null });
      if (text === repairPrompt || !repairPrompt) return finish({ reason: output ? 'invalid_output' : 'empty_output' });
    } catch (error) {
      const status = error?.statusCode ?? error?.status ?? error?.data?.statusCode;
      if (error?.code === 'native_helper_unsettled' || error?.code === 'native_helper_operation_pending') {
        return finish({ reason: 'unsettled', status, code: error.code, error });
      }
      const reason = signal?.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError' || /timeout|cancelled/i.test(error?.code ?? error?.message ?? '')
        ? 'timeout' : classifySessionModelProviderError({ ...error, data: { ...error?.data, statusCode: status } }).reason;
      return finish({ reason, status, error });
    }
  }
  return finish({ reason: 'empty_output' });
}
