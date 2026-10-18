import {
  ERROR_CODES,
  OPERATIONS,
  createPlugin,
  executeGatewayOperation,
  fail,
  validateEnvironment,
  validateImageInput,
  validateInput,
  workspaceWriteInput,
} from './devryan-bot-gateway.mjs';

const DevRyanBotPlugin = async (pluginInput) => {
  const { tool } = await import('@opencode-ai/plugin');
  const { default: oauthPlugin } = await import('/opt/devryan/devryan-openai-oauth.mjs');
  const oauthHooks = await oauthPlugin(pluginInput);
  const tools = await createPlugin({
    toolApi: tool,
    beforeImage: () => oauthHooks['tool.execute.before']?.({ tool: 'devryan_image' }),
    imageToolFactory: async () => {
      const { default: imagePlugin } = await import('opencode-gpt-imagegen');
      if (!imagePlugin || typeof imagePlugin.server !== 'function') {
        fail(ERROR_CODES.configInvalid, 'reviewed image generation plugin is unavailable');
      }
      const loaded = await imagePlugin.server(pluginInput);
      if (!loaded?.tool?.gpt_imagegen) {
        fail(ERROR_CODES.configInvalid, 'reviewed image generation tool is unavailable');
      }
      return loaded.tool.gpt_imagegen;
    },
  });
  return { ...tools, ...(oauthHooks.config ? { config: oauthHooks.config } : {}) };
};

export default DevRyanBotPlugin;

// OpenCode invokes every ESM export as a plugin factory. Keep the test surface
// callable while attaching dependency-free helpers for contract tests.
export const __test = Object.assign(() => ({}), {
  ERROR_CODES,
  OPERATIONS,
  createPlugin,
  executeGatewayOperation,
  validateEnvironment,
  validateImageInput,
  validateInput,
  workspaceWriteInput,
});
