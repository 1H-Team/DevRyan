import { generateTextWithSessionModel } from '../opencode/session-model-text.js';

// Commit and PR drafts use one paid OpenCode Zen model instead of rotating the
// free catalog, whose models routinely timed out before a local fallback.
export const GIT_GENERATION_ZEN_MODEL = 'deepseek-v4.1-flash';
// Drafts are short, so low reasoning effort keeps the sparkles button fast.
export const GIT_GENERATION_ZEN_VARIANT = 'low';

/**
 * Git helpers call OpenCode's native `opencode` (Zen) provider in a temporary
 * helper session whose permission denies and hides every tool. Only Zen's free
 * tier requires advertised OpenCode tool definitions; the paid model does not.
 */
export const createGitZenTextTransport = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, directory, agent }) => {
  let pending;
  return {
    requestText({ prompt, zenModel, timeoutMs, signal }) {
      pending = generateTextWithSessionModel({
        buildOpenCodeUrl, getOpenCodeAuthHeaders, directory,
        providerID: 'opencode', modelID: zenModel, variant: GIT_GENERATION_ZEN_VARIANT, agent, prompt, timeoutMs, signal,
        recoverOnError: false, denyTools: true,
      }).then((result) => {
        if (result.ok) return result.text;
        const error = new Error(result.reason === 'timeout' ? 'Zen generation timed out' : `Zen generation ${result.reason}`);
        error.status = result.status;
        error.reason = result.reason;
        throw error;
      });
      return pending;
    },
    // Abort and delete the native helper before starting another model, even
    // when the rotation's outer deadline wins the HTTP response race.
    async afterAttempt() { await pending?.catch(() => {}); },
  };
};
