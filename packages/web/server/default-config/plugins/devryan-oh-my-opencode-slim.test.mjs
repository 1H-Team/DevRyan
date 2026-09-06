import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { DevRyanOhMyOpenCodeSlimPlugin } from './devryan-oh-my-opencode-slim.mjs';

const originalConfigDirectory = process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR;
const testCache = fileURLToPath(new URL('../../../../../.cache/slim-wrapper-tests/', import.meta.url));
let temporaryRoot = null;

const createInstalledPlugin = (source) => {
  fs.mkdirSync(testCache, { recursive: true });
  temporaryRoot = fs.mkdtempSync(path.join(testCache, 'installed-'));
  process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR = temporaryRoot;
  const packageRoot = path.join(temporaryRoot, 'node_modules', 'oh-my-opencode-slim');
  const entrypointPath = path.join(packageRoot, 'dist', 'index.js');
  fs.mkdirSync(path.dirname(entrypointPath), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'oh-my-opencode-slim', version: '2.2.15', type: 'module' }));
  fs.writeFileSync(entrypointPath, source);
};

afterEach(() => {
  if (originalConfigDirectory === undefined) {
    delete process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR;
  } else {
    process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR = originalConfigDirectory;
  }
  if (temporaryRoot) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = null;
  }
});

describe('DevRyan Oh My OpenCode Slim wrapper', () => {
  it('fails visibly instead of falling back to package resolution', async () => {
    fs.mkdirSync(testCache, { recursive: true });
    temporaryRoot = fs.mkdtempSync(path.join(testCache, 'missing-'));
    process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR = temporaryRoot;

    await expect(DevRyanOhMyOpenCodeSlimPlugin({})).rejects.toThrow(
      'Installed Oh My OpenCode Slim entrypoint is missing',
    );
  });

  it.each([
    ['legacy function', 'factory'],
    ['2.2.15 descriptor', "{ id: 'oh-my-opencode-slim', server: factory, setup: () => { throw new Error('Native setup is not the server hook'); } }"],
  ])('preserves runtime hooks and DevRyan agent ownership for the %s', async (_shape, exported) => {
    createInstalledPlugin(`
      const factory = async (context) => ({
        agent: { slim: {} },
        'experimental.chat.system.transform': async () => {},
        tool: { task_status: { description: 'preserve runtime tool hooks', execute: async () => context.marker } },
        event: async () => context.events.push('event'),
        'chat.params': async () => context.events.push('params'),
        'experimental.chat.messages.transform': async () => context.events.push('messages'),
        'tool.execute.before': async () => context.events.push('before'),
        'tool.execute.after': async () => context.events.push('after'),
        config: async (config) => {
          if (config.agent?.builder) config.agent.builder.description = 'changed by Slim';
          config.agent = { slim: {} };
          config.default_agent = 'slim';
          config.marker = true;
        },
      });
      export default ${exported};
    `);

    const events = [];
    const plugin = await DevRyanOhMyOpenCodeSlimPlugin({ marker: 'context passed through', events });
    expect(plugin).not.toHaveProperty('agent');
    expect(plugin).not.toHaveProperty('experimental.chat.system.transform');
    expect(await plugin.tool.task_status.execute()).toBe('context passed through');
    for (const hook of ['event', 'chat.params', 'experimental.chat.messages.transform', 'tool.execute.before', 'tool.execute.after']) await plugin[hook]();
    expect(events).toEqual(['event', 'params', 'messages', 'before', 'after']);

    const config = { agent: { builder: { description: 'DevRyan prompt' } }, default_agent: 'builder' };
    await plugin.config(config);
    expect(config).toEqual({
      agent: { builder: { description: 'DevRyan prompt' } },
      default_agent: 'builder',
      marker: true,
    });

    const emptyConfig = {};
    await plugin.config(emptyConfig);
    expect(emptyConfig).toEqual({ marker: true });
  });

  it('rejects an installed descriptor without a callable server', async () => {
    createInstalledPlugin("export default { id: 'oh-my-opencode-slim', server: {} };");
    await expect(DevRyanOhMyOpenCodeSlimPlugin({})).rejects.toThrow('does not export a plugin');
  });
});
