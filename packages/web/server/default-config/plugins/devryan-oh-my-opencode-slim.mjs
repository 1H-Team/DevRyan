import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const cloneValue = (value) => {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
};

// Slim's native background scheduler and foreground fallback submit through
// these APIs. In a DevRyan-owned runtime only the managed host may submit a
// continuation. Capability absence also disables Slim's periodic wake timer.
// Keep the original SDK receiver for every other method (including getters).
const managedSlimContext = (context) => {
  if (!process.env.DEVRYAN_ORCHESTRATION_URL && !process.env.DEVRYAN_ORCHESTRATION_TOKEN) return context;
  if (!context?.client?.session) return context;
  const session = new Proxy(context.client.session, {
    get(target, key) {
      if (key === 'prompt' || key === 'promptAsync') return undefined;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const client = new Proxy(context.client, {
    get(target, key) {
      if (key === 'session') return session;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...context, client };
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
  // Slim 2.2.18 uses the OpenCode plugin descriptor. Its server factory
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
  const plugin = await slimPlugin(managedSlimContext(context));
  const factories = globalThis[Symbol.for('devryan.plugin-factories.v1')] ??= new Map();
  const factoryKey = `slim:${context?.directory}:${import.meta.url}`;
  factories.set(factoryKey, { name: 'devryan-oh-my-opencode-slim', directory: context?.directory,
    contentHash: (() => {
      try { return crypto.createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex'); }
      catch { return null; } // Missing diagnostic source must not disable the plugin.
    })(),
    factoryCalls: (factories.get(factoryKey)?.factoryCalls ?? 0) + 1,
    ownership: process.env.DEVRYAN_ORCHESTRATION_URL || process.env.DEVRYAN_ORCHESTRATION_TOKEN ? 'deferred' : 'standalone' });
  while (factories.size > 256) factories.delete(factories.keys().next().value);
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

      try {
        await slimConfigHook(config);
      } finally {
        // Slim 2.2.18 retains this object for background-task model admission.
        // Restore it in place so those hooks see the same effective host agents
        // as OpenCode, including when Slim replaced the original config object.
        if (isRecord(config.agent)) {
          const retainedAgents = config.agent;
          for (const key of Object.keys(retainedAgents)) delete retainedAgents[key];
          if (isRecord(previousAgent)) Object.assign(retainedAgents, previousAgent);
          if (hadAgent && isRecord(previousAgent)) {
            config.agent = retainedAgents;
          } else if (hadAgent) {
            config.agent = previousAgent;
          } else {
            delete config.agent;
          }
        } else if (hadAgent) {
          config.agent = previousAgent;
        } else {
          delete config.agent;
        }

        if (hadDefaultAgent) {
          config.default_agent = previousDefaultAgent;
        } else {
          delete config.default_agent;
        }
      }
    },
  };
};

export default DevRyanOhMyOpenCodeSlimPlugin;
