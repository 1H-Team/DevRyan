import path from 'node:path';

const PROVIDER_ID = 'anthropic';
const DIRECTORY_HEADER = 'x-devryan-directory';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const isLoopbackBaseURL = (value) => {
  if (typeof value !== 'string' || !value) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
};

/**
 * Meridian serves `anthropic/*` in-process and runs Claude in the directory
 * named by OpenCode's `<env>` block, which opencode-with-claude scrubs; its
 * fallback is the OpenCode process cwd, i.e. whichever project launched it.
 * This states the requesting instance's directory explicitly (URI-encoded
 * for non-ASCII paths), only to the loopback Meridian proxy. The patched
 * proxy refuses a DevRyan-bounded request without it
 * (resolveSessionWorkingDirectory in session-provider-spawn.js).
 */
export const DevRyanClaudeTransportPlugin = async ({ directory } = {}) => {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) return {};
  const encodedDirectory = encodeURIComponent(directory);
  return {
    'chat.headers': async (input, output) => {
      if (input?.model?.providerID !== PROVIDER_ID) return;
      if (!isLoopbackBaseURL(input?.provider?.options?.baseURL)) return;
      output.headers[DIRECTORY_HEADER] = encodedDirectory;
    },
  };
};

export default DevRyanClaudeTransportPlugin;
