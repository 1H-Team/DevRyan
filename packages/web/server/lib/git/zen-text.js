import { generateTextWithSessionModel } from '../opencode/session-model-text.js';

/** Zen's free tier requires OpenCode's native provider transport. */
export const createGitZenTextTransport = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, directory, agent }) => {
  let pending;
  return {
    requestText({ prompt, zenModel, timeoutMs, signal }) {
      pending = generateTextWithSessionModel({
        buildOpenCodeUrl, getOpenCodeAuthHeaders, directory,
        providerID: 'opencode', modelID: zenModel, agent, prompt, timeoutMs, signal,
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
