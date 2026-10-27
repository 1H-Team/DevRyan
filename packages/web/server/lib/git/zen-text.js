import { generateTextWithSessionModel } from '../opencode/session-model-text.js';
import { randomUUID } from 'node:crypto';

// Default remains paid Flash; settings select the exact shared helper tuple,
// including its reasoning variant (absent means provider Default).
export const GIT_GENERATION_ZEN_MODEL = 'deepseek-v4.1-flash';

/** Each draft attempt uses the admitted native helper and awaits its actual
 * settlement before repair or another model can start. */
export const createGitZenTextTransport = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, openCodeClient, generateHelperText, cursorRuntime, directory, sessionID, selection, agent }) => {
  let pending;
  const operationID = randomUUID();
  return {
    requestText({ prompt, zenModel, timeoutMs, signal }) {
      pending = generateTextWithSessionModel({
        buildOpenCodeUrl, getOpenCodeAuthHeaders, generateHelperText, cursorRuntime, directory, operationID,
        ...(openCodeClient ? { openCodeClient } : {}),
        selection: selection ?? { providerID: 'opencode', modelID: zenModel },
        ...(sessionID ? { sessionID } : {}), agent, prompt, timeoutMs, signal,
        recoverOnError: false, denyTools: true,
      }).then((result) => {
        if (result.ok) return result.text;
        // Bounded identifiers only: never the prompt, diff or provider text.
        console.warn('[git] Helper draft attempt failed:', JSON.stringify({ agent, reason: result.reason,
          status: Number.isFinite(result.status) ? result.status : undefined,
          code: typeof result.code === 'string' && /^native_[a-z0-9_]{1,96}$/.test(result.code) ? result.code : undefined }));
        const error = new Error(result.reason === 'timeout' ? 'Zen generation timed out' : `Zen generation ${result.reason}`);
        error.status = result.status;
        error.reason = result.reason;
        error.code = result.code;
        throw error;
      });
      return pending;
    },
    // An unsettled result ends rotation while its owner retains the permit.
    async afterAttempt() { await pending?.catch(error => { if (['unsettled', 'selection_changed', 'authorization_revoked'].includes(error.reason)) throw error; }); },
  };
};
