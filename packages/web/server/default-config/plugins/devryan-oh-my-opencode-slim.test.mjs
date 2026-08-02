import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DevRyanOhMyOpenCodeSlimPlugin } from './devryan-oh-my-opencode-slim.mjs';

const originalConfigDirectory = process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR;
let temporaryRoot = null;

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
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-slim-missing-'));
    process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR = temporaryRoot;

    await expect(DevRyanOhMyOpenCodeSlimPlugin({})).rejects.toThrow(
      'Installed Oh My OpenCode Slim entrypoint is missing',
    );
  });

  it('imports the exact installed entrypoint and preserves DevRyan agent ownership', async () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-slim-installed-'));
    process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR = temporaryRoot;
    const packageRoot = path.join(temporaryRoot, 'node_modules', 'oh-my-opencode-slim');
    const entrypointPath = path.join(packageRoot, 'dist', 'index.js');
    fs.mkdirSync(path.dirname(entrypointPath), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'oh-my-opencode-slim', version: '2.0.5', type: 'module' }),
      'utf8',
    );
    fs.writeFileSync(entrypointPath, `
      export default async () => ({
        agent: { slim: {} },
        'experimental.chat.system.transform': async () => {},
        config: async (config) => {
          config.agent = { slim: {} };
          config.default_agent = 'slim';
          config.marker = true;
        },
      });
    `, 'utf8');

    const plugin = await DevRyanOhMyOpenCodeSlimPlugin({});
    expect(plugin).not.toHaveProperty('agent');
    expect(plugin).not.toHaveProperty('experimental.chat.system.transform');

    const config = { agent: { builder: {} }, default_agent: 'builder' };
    await plugin.config(config);
    expect(config).toEqual({
      agent: { builder: {} },
      default_agent: 'builder',
      marker: true,
    });
  });
});
