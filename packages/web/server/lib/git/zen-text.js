import { generateTextWithSessionModel } from '../opencode/session-model-text.js';
import { randomUUID } from 'node:crypto';

// Commit and PR drafts use one paid OpenCode Zen model instead of rotating the
// free catalog, whose models routinely timed out before a local fallback.
export const GIT_GENERATION_ZEN_MODEL = 'deepseek-v4.1-flash';
// Drafts are short, so low reasoning effort keeps the sparkles button fast.
export const GIT_GENERATION_ZEN_VARIANT = 'low';

/** Each draft attempt uses the admitted native helper and awaits its actual
 * settlement before repair or another model can start. */
export const createGitZenTextTransport = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, openCodeClient, generateHelperText, cursorRuntime, directory, agent }) => {
  let pending;
  const operationID = randomUUID();
  return {
    requestText({ prompt, zenModel, timeoutMs, signal }) {
      pending = generateTextWithSessionModel({
        buildOpenCodeUrl, getOpenCodeAuthHeaders, generateHelperText, cursorRuntime, directory, operationID,
        ...(openCodeClient ? { openCodeClient } : {}),
        providerID: 'opencode', modelID: zenModel, variant: GIT_GENERATION_ZEN_VARIANT, agent, prompt, timeoutMs, signal,
        recoverOnError: false, denyTools: true,
      }).then((result) => {
        if (result.ok) return result.text;
        const error = new Error(result.reason === 'timeout' ? 'Zen generation timed out' : `Zen generation ${result.reason}`);
        error.status = result.status;
        error.reason = result.reason;
        error.code = result.code;
        throw error;
      });
      return pending;
    },
    // An unsettled result ends rotation while its owner retains the permit.
    async afterAttempt() { await pending?.catch(error => { if (error.reason === 'unsettled') throw error; }); },
  };
};
