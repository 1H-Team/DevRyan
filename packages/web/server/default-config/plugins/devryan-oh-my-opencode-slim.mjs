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
  const configuredRoot = typeof process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR === 'string'
    && process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR.trim()
    ? path.resolve(process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR.trim())
    : path.resolve(import.meta.dirname, '..');
  const pluginEntrypoint = path.join(
    configuredRoot,
    'node_modules',
    'oh-my-opencode-slim',
    'dist',
    'index.js',
  );
  if (!fs.existsSync(pluginEntrypoint)) {
    throw new Error(
      `[DevRyan] Installed Oh My OpenCode Slim entrypoint is missing: ${pluginEntrypoint}. `
      + 'Repair the managed OpenCode profile before starting OpenCode.',
    );
  }

  const module = await import(pathToFileURL(pluginEntrypoint).href);
  const exported = module.default || module;
  // Slim 2.2.15 uses the OpenCode plugin descriptor. Its server factory
  // supplies the same runtime hooks as the legacy function export; setup is
  // the native descriptor integration and must not replace DevRyan ownership.
  const plugin = isRecord(exported) ? exported.server : exported;
  if (typeof plugin !== 'function') {
    throw new Error(
      `[DevRyan] Installed Oh My OpenCode Slim entrypoint does not export a plugin: ${pluginEntrypoint}`,
    );
  }
  return plugin;
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
