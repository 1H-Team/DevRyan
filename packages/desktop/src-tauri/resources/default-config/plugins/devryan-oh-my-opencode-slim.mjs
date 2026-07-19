import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const cloneValue = (value) => {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
};

const loadSlimPlugin = async () => {
  const roots = [
    process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR,
    process.env.OPENCODE_CONFIG_DIR,
    process.cwd(),
  ].filter(Boolean);

  let lastError = null;
  for (const root of roots) {
    try {
      const pluginEntrypoint = path.join(root, 'node_modules', 'oh-my-opencode-slim', 'dist', 'index.js');
      if (!fs.existsSync(pluginEntrypoint)) {
        continue;
      }
      const module = await import(pathToFileURL(pluginEntrypoint).href);
      return module.default || module;
    } catch (error) {
      lastError = error;
    }
  }

  try {
    const module = await import('oh-my-opencode-slim');
    return module.default || module;
  } catch (error) {
    throw lastError || error;
  }
};

export const DevRyanOhMyOpenCodeSlimPlugin = async (context) => {
  const slimPlugin = await loadSlimPlugin();
  const plugin = await slimPlugin(context);
  if (!isRecord(plugin)) {
    return plugin;
  }

  const slimConfigHook = typeof plugin.config === 'function' ? plugin.config : null;
  delete plugin.agent;
  delete plugin['experimental.chat.system.transform'];

  return {
    ...plugin,
    name: 'devryan-oh-my-opencode-slim',
    async config(config) {
      if (!slimConfigHook || !isRecord(config)) {
        return;
      }

      const hadAgent = Object.prototype.hasOwnProperty.call(config, 'agent');
      const previousAgent = hadAgent ? cloneValue(config.agent) : undefined;
      const hadDefaultAgent = Object.prototype.hasOwnProperty.call(config, 'default_agent');
      const previousDefaultAgent = hadDefaultAgent ? config.default_agent : undefined;

      await slimConfigHook(config);

      if (hadAgent) {
        config.agent = previousAgent;
      } else {
        delete config.agent;
      }

      if (hadDefaultAgent) {
        config.default_agent = previousDefaultAgent;
      } else {
        delete config.default_agent;
      }
    },
  };
};

export default DevRyanOhMyOpenCodeSlimPlugin;
