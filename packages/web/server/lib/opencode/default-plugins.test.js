import { describe, expect, it } from 'vitest';

import {
  DEVRYAN_DEFAULT_PLUGINS,
  buildDevRyanDefaultPluginInventory,
  getDevRyanDefaultPluginIdForFile,
  getDevRyanDefaultPluginIdForSpec,
} from './default-plugins.js';

describe('DevRyan default plugin catalog', () => {
  it('exposes every public managed plugin with local-only registrations', () => {
    expect(DEVRYAN_DEFAULT_PLUGINS.map((plugin) => ({
      pluginId: plugin.pluginId,
      shippedSpec: plugin.shippedSpec,
      version: plugin.version,
      delivery: plugin.delivery,
    }))).toEqual([
      {
        pluginId: 'opencode-antigravity-auth',
        shippedSpec: './node_modules/opencode-antigravity-auth/dist/index.js',
        version: '1.6.0',
        delivery: 'installed-local',
      },
      {
        pluginId: '@rama_nigg/open-cursor',
        shippedSpec: './node_modules/@rama_nigg/open-cursor/dist/plugin-entry.js',
        version: '2.5.4',
        delivery: 'installed-local',
      },
      {
        pluginId: 'opencode-with-claude',
        shippedSpec: './node_modules/opencode-with-claude/dist/index.js',
        version: '1.6.18',
        delivery: 'installed-local',
      },
      {
        pluginId: 'context-mode',
        shippedSpec: './node_modules/context-mode/build/adapters/opencode/plugin.js',
        version: '1.0.169',
        delivery: 'installed-local',
      },
      {
        pluginId: 'oh-my-opencode-slim',
        shippedSpec: './plugins/devryan-oh-my-opencode-slim.mjs',
        version: '2.0.5',
        delivery: 'installed-local',
      },
      {
        pluginId: 'superpowers',
        shippedSpec: './plugins/devryan-superpowers.mjs',
        version: null,
        delivery: 'bundled-file',
      },
      {
        pluginId: 'devryan-skill-context',
        shippedSpec: './plugins/devryan-skill-context.mjs',
        version: null,
        delivery: 'bundled-file',
      },
      {
        pluginId: 'devryan-document-reader',
        shippedSpec: './plugins/devryan-document-reader.mjs',
        version: null,
        delivery: 'bundled-file',
      },
      {
        pluginId: 'openai-tool-schema-sanitizer',
        shippedSpec: './plugins/openai-tool-schema-sanitizer.mjs',
        version: null,
        delivery: 'bundled-file',
      },
    ]);
  });

  it('classifies default registrations and files without exposing internal helpers', () => {
    expect(getDevRyanDefaultPluginIdForSpec('./plugins/devryan-oh-my-opencode-slim.mjs')).toBe('oh-my-opencode-slim');
    expect(getDevRyanDefaultPluginIdForSpec('opencode-with-claude@1.6.17')).toBe('opencode-with-claude');
    expect(getDevRyanDefaultPluginIdForSpec('context-mode@1.0.168')).toBe('context-mode');
    expect(getDevRyanDefaultPluginIdForSpec('./plugins/devryan-superpowers.mjs')).toBe('superpowers');
    expect(getDevRyanDefaultPluginIdForSpec('./plugins/devryan-skill-context.mjs')).toBe('devryan-skill-context');
    expect(getDevRyanDefaultPluginIdForSpec('./plugins/devryan-document-reader.mjs')).toBe('devryan-document-reader');
    expect(getDevRyanDefaultPluginIdForSpec('./node_modules/@rama_nigg/open-cursor/dist/plugin-entry.js'))
      .toBe('@rama_nigg/open-cursor');
    expect(getDevRyanDefaultPluginIdForFile('openai-tool-schema-sanitizer.mjs')).toBe('openai-tool-schema-sanitizer');
    expect(getDevRyanDefaultPluginIdForFile('devryan-skill-context.mjs')).toBe('devryan-skill-context');
    expect(getDevRyanDefaultPluginIdForFile('devryan-managed-orchestration.mjs')).toBeNull();
  });

  it('preserves effective overrides and their configured source', () => {
    const inventory = buildDevRyanDefaultPluginInventory({
      entries: [
        { spec: 'opencode-with-claude@1.6.17', sourcePath: '/tmp/opencode.json' },
        { spec: 'context-mode@1.0.168', sourcePath: '/tmp/context-mode.json' },
        { spec: './plugins/devryan-oh-my-opencode-slim.mjs', sourcePath: '/tmp/project/opencode.json' },
      ],
      files: [
        { fileName: 'openai-tool-schema-sanitizer.mjs', absolutePath: '/tmp/plugins/openai-tool-schema-sanitizer.mjs' },
      ],
    });

    expect(inventory.defaults.find((plugin) => plugin.pluginId === 'oh-my-opencode-slim')).toMatchObject({
      effectiveSpec: './plugins/devryan-oh-my-opencode-slim.mjs',
      configuredSourcePath: '/tmp/project/opencode.json',
    });
    expect(inventory.defaults.find((plugin) => plugin.pluginId === 'opencode-with-claude')).toMatchObject({
      effectiveSpec: 'opencode-with-claude@1.6.17',
      configuredSourcePath: '/tmp/opencode.json',
    });
    expect(inventory.defaults.find((plugin) => plugin.pluginId === 'context-mode')).toMatchObject({
      effectiveSpec: 'context-mode@1.0.168',
      configuredSourcePath: '/tmp/context-mode.json',
    });
    expect(inventory.defaults.find((plugin) => plugin.pluginId === 'openai-tool-schema-sanitizer')).toMatchObject({
      configuredSourcePath: '/tmp/plugins/openai-tool-schema-sanitizer.mjs',
    });
  });
});
