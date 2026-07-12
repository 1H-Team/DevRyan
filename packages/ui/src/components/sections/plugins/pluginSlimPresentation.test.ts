import { describe, expect, test } from 'bun:test';
import type { PluginEntry, PluginFile, SlimSetupStatus } from '@/lib/api/types';
import { getSlimActions, isSlimPlugin } from './pluginSlimPresentation';

const entry = (spec: string): PluginEntry => ({
  id: spec,
  spec,
  scope: 'user',
  kind: 'config',
  parsedKind: 'npm',
  sourcePath: '/tmp/opencode.json',
});

const file = (fileName: string): PluginFile => ({
  id: fileName,
  fileName,
  scope: 'user',
  kind: 'file',
  absolutePath: `/tmp/${fileName}`,
});

describe('Slim plugin presentation', () => {
  test('identifies only raw or DevRyan-wrapped Slim entries and files', () => {
    expect(isSlimPlugin(entry('opencode-with-claude'))).toBe(false);
    expect(isSlimPlugin(file('github-copilot-models.mjs'))).toBe(false);
    expect(isSlimPlugin(entry('oh-my-opencode-slim@2.0.5'))).toBe(true);
    expect(isSlimPlugin(entry('./plugins/devryan-oh-my-opencode-slim.mjs'))).toBe(true);
    expect(isSlimPlugin(file('devryan-oh-my-opencode-slim.mjs'))).toBe(true);
  });

  test('offers install only for missing setup and repair for existing setup', () => {
    expect(getSlimActions(null)).toEqual({ install: true, repair: false });
    expect(getSlimActions({ runtimeEnabled: false, wrapperConfigured: false } as SlimSetupStatus)).toEqual({ install: true, repair: false });
    expect(getSlimActions({ runtimeEnabled: true, wrapperConfigured: true } as SlimSetupStatus)).toEqual({ install: false, repair: true });
    expect(getSlimActions({ runtimeEnabled: true, wrapperConfigured: false } as SlimSetupStatus)).toEqual({ install: false, repair: true });
  });
});
