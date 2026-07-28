import { describe, expect, it } from 'vitest';

import {
  DEVRYAN_DEFAULT_PLUGINS,
  buildDevRyanDefaultPluginInventory,
  getDevRyanDefaultPluginIdForFile,
  getDevRyanDefaultPluginIdForSpec,
} from './default-plugins.js';

describe('DevRyan default plugin catalog', () => {
  it('exposes exactly the four public defaults in deterministic order', () => {
    expect(DEVRYAN_DEFAULT_PLUGINS.map((plugin) => ({
      pluginId: plugin.pluginId,
      shippedSpec: plugin.shippedSpec,
    }))).toEqual([
      { pluginId: 'oh-my-opencode-slim', shippedSpec: 'oh-my-opencode-slim@2.0.5' },
      { pluginId: 'opencode-with-claude', shippedSpec: 'opencode-with-claude@1.6.18' },
      { pluginId: 'context-mode', shippedSpec: 'context-mode@1.0.169' },
      { pluginId: 'openai-tool-schema-sanitizer', shippedSpec: './plugins/openai-tool-schema-sanitizer.mjs' },
    ]);
  });

  it('classifies default registrations and files without exposing internal helpers', () => {
    expect(getDevRyanDefaultPluginIdForSpec('./plugins/devryan-oh-my-opencode-slim.mjs')).toBe('oh-my-opencode-slim');
    expect(getDevRyanDefaultPluginIdForSpec('opencode-with-claude@1.6.17')).toBe('opencode-with-claude');
    expect(getDevRyanDefaultPluginIdForSpec('context-mode@1.0.168')).toBe('context-mode');
    expect(getDevRyanDefaultPluginIdForFile('openai-tool-schema-sanitizer.mjs')).toBe('openai-tool-schema-sanitizer');
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

    expect(inventory.defaults[0]).toMatchObject({
      effectiveSpec: './plugins/devryan-oh-my-opencode-slim.mjs',
      configuredSourcePath: '/tmp/project/opencode.json',
    });
    expect(inventory.defaults[1]).toMatchObject({
      effectiveSpec: 'opencode-with-claude@1.6.17',
      configuredSourcePath: '/tmp/opencode.json',
    });
    expect(inventory.defaults[2]).toMatchObject({
      effectiveSpec: 'context-mode@1.0.168',
      configuredSourcePath: '/tmp/context-mode.json',
    });
    expect(inventory.defaults[3]).toMatchObject({
      configuredSourcePath: '/tmp/plugins/openai-tool-schema-sanitizer.mjs',
    });
  });
});
