import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEVRYAN_MANAGED_PLUGIN_IDS,
  DEVRYAN_MANAGED_PLUGINS,
  DEVRYAN_MANAGED_PROFILE_DEPENDENCIES,
  DEVRYAN_MANAGED_PROFILE_PLUGIN_SPECS,
  getDevRyanManagedPluginRegistrationForConfigPath,
  inspectDevRyanManagedPluginInstallation,
  reconcileDevRyanManagedPluginSpecs,
  removeDevRyanManagedLegacyPluginSpecs,
} from './managed-plugins.js';

let temporaryRoot = null;
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDefaultConfigRoot = path.resolve(moduleDirectory, '..', '..', 'default-config');
const tauriDefaultConfigRoot = path.resolve(
  moduleDirectory,
  '..',
  '..',
  '..',
  '..',
  'desktop',
  'src-tauri',
  'resources',
  'default-config',
);
afterEach(() => {
  if (temporaryRoot) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = null;
  }
});

describe('managed plugin manifest', () => {
  it('pins every dependency plugin and registers managed defaults by local path', () => {
    expect(DEVRYAN_MANAGED_PROFILE_DEPENDENCIES).toEqual({
      '@opencode-ai/plugin': '1.18.23',
      'adm-zip': '0.6.0',
      'mammoth': '1.12.1',
      'unpdf': '1.8.0',
      'opencode-antigravity-auth': '1.6.0',
      '@rama_nigg/open-cursor': '2.5.4',
      'opencode-with-claude': '1.8.0',
      'opencode-gpt-imagegen': '0.1.10',
      'context-mode': '1.0.169',
      'oh-my-opencode-slim': '2.2.15',
    });
    expect(DEVRYAN_MANAGED_PROFILE_PLUGIN_SPECS).toEqual([
      './node_modules/opencode-antigravity-auth/dist/index.js',
      './node_modules/@rama_nigg/open-cursor/dist/plugin-entry.js',
      './node_modules/opencode-with-claude/dist/index.js',
      './node_modules/opencode-gpt-imagegen/dist/index.js',
      './node_modules/context-mode/build/adapters/opencode/plugin.js',
      './plugins/devryan-oh-my-opencode-slim.mjs',
      './plugins/devryan-superpowers.mjs',
      './plugins/devryan-skill-context.mjs',
      './plugins/devryan-document-reader.mjs',
    ]);
    expect(DEVRYAN_MANAGED_PROFILE_PLUGIN_SPECS.every((spec) => (
      spec.startsWith('./') && !spec.includes('@latest') && !spec.includes('git+')
    ))).toBe(true);
  });

  it('keeps forward managed profiles local-only while leaving released Tauri assets frozen', () => {
    const webProfileConfig = JSON.parse(fs.readFileSync(
      path.join(webDefaultConfigRoot, 'user-profile', 'opencode.json'),
      'utf8',
    ));
    const webRootConfig = JSON.parse(fs.readFileSync(
      path.join(webDefaultConfigRoot, 'opencode.json'),
      'utf8',
    ));
    const webPackage = JSON.parse(fs.readFileSync(
      path.join(webDefaultConfigRoot, 'user-profile', 'package.json'),
      'utf8',
    ));
    const tauriProfileConfig = JSON.parse(fs.readFileSync(
      path.join(tauriDefaultConfigRoot, 'user-profile', 'opencode.json'),
      'utf8',
    ));
    const tauriRootConfig = JSON.parse(fs.readFileSync(
      path.join(tauriDefaultConfigRoot, 'opencode.json'),
      'utf8',
    ));
    const tauriPackage = JSON.parse(fs.readFileSync(
      path.join(tauriDefaultConfigRoot, 'user-profile', 'package.json'),
      'utf8',
    ));

    expect(webProfileConfig.plugin).toEqual(DEVRYAN_MANAGED_PROFILE_PLUGIN_SPECS);
    expect(tauriRootConfig).toEqual(webRootConfig);
    expect(webPackage.dependencies).toMatchObject(DEVRYAN_MANAGED_PROFILE_DEPENDENCIES);
    expect(tauriProfileConfig.plugin).not.toContain('./plugins/devryan-document-reader.mjs');
    expect(tauriProfileConfig.plugin).not.toContain('./plugins/devryan-skill-context.mjs');
    expect(tauriPackage.dependencies).not.toHaveProperty('unpdf');
    expect(tauriPackage.dependencies).not.toHaveProperty('mammoth');
    expect(tauriPackage.dependencies['oh-my-opencode-slim']).toBe('2.0.5');
    for (const config of [webProfileConfig, webRootConfig, tauriProfileConfig, tauriRootConfig]) {
      for (const spec of config.plugin || []) {
        expect(spec).toMatch(/^\.\//);
        expect(spec).not.toContain('@latest');
        expect(spec).not.toContain('git+');
        expect(spec).not.toBe('cursor-acp');
      }
    }

    for (const fileName of ['devryan-oh-my-opencode-slim.mjs']) {
      expect(fs.readFileSync(path.join(tauriDefaultConfigRoot, 'plugins', fileName), 'utf8')).toBe(
        fs.readFileSync(path.join(webDefaultConfigRoot, 'plugins', fileName), 'utf8'),
      );
    }
    expect(fs.readFileSync(path.join(webDefaultConfigRoot, 'plugins', 'devryan-superpowers.mjs'), 'utf8'))
      .not.toContain('experimental.chat.messages.transform');
    expect(fs.readFileSync(path.join(tauriDefaultConfigRoot, 'plugins', 'devryan-superpowers.mjs'), 'utf8'))
      .toContain('experimental.chat.messages.transform');
    expect(fs.existsSync(path.join(webDefaultConfigRoot, 'plugins', 'devryan-document-reader.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(tauriDefaultConfigRoot, 'plugins', 'devryan-document-reader.mjs'))).toBe(false);
    expect(fs.existsSync(path.join(webDefaultConfigRoot, 'plugins', 'devryan-skill-context.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(tauriDefaultConfigRoot, 'plugins', 'devryan-skill-context.mjs'))).toBe(false);
  });

  it('migrates only known managed legacy specs and preserves user plugins and custom pins', () => {
    expect(reconcileDevRyanManagedPluginSpecs([
      'custom-plugin@4.2.0',
      'opencode-antigravity-auth@latest',
      '@rama_nigg/open-cursor@latest',
      'cursor-acp',
      ['opencode-with-claude@1.6.18', { enabled: true }],
      'opencode-gpt-imagegen@latest',
      'context-mode@1.0.169',
      'oh-my-opencode-slim@2.0.5',
      'superpowers@git+https://github.com/obra/superpowers.git',
      './plugins/devryan-oh-my-opencode-slim.mjs',
    ])).toEqual([
      'custom-plugin@4.2.0',
      './node_modules/opencode-antigravity-auth/dist/index.js',
      './node_modules/@rama_nigg/open-cursor/dist/plugin-entry.js',
      ['./node_modules/opencode-with-claude/dist/index.js', { enabled: true }],
      './node_modules/opencode-gpt-imagegen/dist/index.js',
      './node_modules/context-mode/build/adapters/opencode/plugin.js',
      './plugins/devryan-oh-my-opencode-slim.mjs',
      './plugins/devryan-superpowers.mjs',
      './plugins/devryan-skill-context.mjs',
      './plugins/devryan-document-reader.mjs',
    ]);

    const customPin = reconcileDevRyanManagedPluginSpecs(['context-mode@1.0.168']);
    expect(customPin).toContain('context-mode@1.0.168');
    expect(customPin).not.toContain('./node_modules/context-mode/build/adapters/opencode/plugin.js');
  });

  it('removes only DevRyan-owned legacy specs from older user config layers', () => {
    expect(removeDevRyanManagedLegacyPluginSpecs([
      'user-plugin@4.2.0',
      'opencode-with-claude@1.6.17',
      'opencode-with-claude@1.6.18',
      'context-mode@1.0.169',
      'superpowers@git+https://github.com/obra/superpowers.git',
      'cursor-acp',
    ])).toEqual([
      'user-plugin@4.2.0',
      'opencode-with-claude@1.6.17',
    ]);
  });

  it('uses a file URL when a managed entrypoint is registered from a project config', () => {
    const configDirectory = path.join('/Users', 'test', '.config', 'opencode');
    const projectConfigPath = path.join('/tmp', 'project', '.opencode', 'opencode.json');
    expect(getDevRyanManagedPluginRegistrationForConfigPath(
      DEVRYAN_MANAGED_PLUGIN_IDS.CLAUDE,
      { configDirectory, configPath: projectConfigPath },
    )).toBe(
      'file:///Users/test/.config/opencode/node_modules/opencode-with-claude/dist/index.js',
    );
  });

  it('reports missing, mismatched, and incomplete installed packages', () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-managed-plugins-'));
    const antigravity = DEVRYAN_MANAGED_PLUGINS.find(
      (plugin) => plugin.id === DEVRYAN_MANAGED_PLUGIN_IDS.ANTIGRAVITY,
    );
    const packageRoot = path.join(temporaryRoot, 'node_modules', antigravity.packageName);
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: antigravity.packageName, version: '0.0.1' }),
      'utf8',
    );

    const issues = inspectDevRyanManagedPluginInstallation({
      configDirectory: temporaryRoot,
      fs,
      path,
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: DEVRYAN_MANAGED_PLUGIN_IDS.ANTIGRAVITY,
        kind: 'version-mismatch',
      }),
      expect.objectContaining({
        pluginId: DEVRYAN_MANAGED_PLUGIN_IDS.ANTIGRAVITY,
        kind: 'missing-entrypoint',
      }),
      expect.objectContaining({
        pluginId: DEVRYAN_MANAGED_PLUGIN_IDS.OPEN_CURSOR,
        kind: 'missing-package',
      }),
      expect.objectContaining({
        pluginId: DEVRYAN_MANAGED_PLUGIN_IDS.DOCUMENT_READER,
        packageName: 'unpdf',
        kind: 'missing-package',
      }),
    ]));
  });
});
