import { cursorRunUsageObservation } from './cursor-usage.js';

/** A one-shot helper: no agent history, workspace settings, or tool authority. */
export async function generateCursorHelperText({ Agent, apiKey, text, directory, model, maxOutputBytes = 262144, onUsage }) {
  if (typeof text !== 'string' || !text.trim() || !apiKey || typeof Agent?.prompt !== 'function'
    || !model?.id || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 262144) {
    throw Object.assign(new Error('Cursor helper input is invalid.'), { code: 'cursor_helper_invalid' });
  }
  let result;
  try {
    result = await Agent.prompt(text, { apiKey, model, tools: [],
      local: { ...(directory ? { cwd: directory } : {}), settingSources: [] },
      ...(directory ? { platform: { workspaceRef: directory } } : {}) });
  } catch (error) {
    try { onUsage?.(cursorRunUsageObservation({ model, status: 'error' })); } catch { /* Never repeat inference for accounting. */ }
    throw error;
  }
  try { onUsage?.(cursorRunUsageObservation(null, result)); } catch { /* Never repeat inference for accounting. */ }
  if (typeof result?.result !== 'string' || Buffer.byteLength(result.result) > maxOutputBytes) {
    throw Object.assign(new Error('Cursor helper output is invalid.'), { code: 'cursor_helper_output_invalid' });
  }
  return result.result;
}
