import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_PROFILE_ROOT, createUserProfileProvisioningRuntime } from './user-profile-provisioning.js';
import { listDefaultConfigAssets } from './default-config-assets.js';
import {
  DEVRYAN_MANAGED_PLUGINS,
  DEVRYAN_MANAGED_PROFILE_PLUGIN_FILES,
} from './managed-plugins.js';

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const hashContent = (content) => crypto.createHash('sha256').update(content).digest('hex');
const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

describe('user profile provisioning', () => {
  let root;
  let home;
  let commands;

  const createRuntime = (overrides = {}) => createUserProfileProvisioningRuntime({
    fs,
    path,
    homedir: () => home,
    runCommand: async (command, args, options) => {
      commands.push({ command, args, cwd: options.cwd });
      const packageJson = readJson(path.join(options.cwd, 'package.json'));
      for (const name of Object.keys(packageJson.dependencies || {})) {
        fs.mkdirSync(path.join(options.cwd, 'node_modules', ...name.split('/')), { recursive: true });
      }
      for (const plugin of DEVRYAN_MANAGED_PLUGINS) {
        if (!plugin.packageName || !plugin.version || !plugin.entrypoint) continue;
        const packageRoot = path.join(options.cwd, 'node_modules', ...plugin.packageName.split('/'));
        writeJson(path.join(packageRoot, 'package.json'), {
          name: plugin.packageName,
          version: plugin.version,
        });
        const entrypointPath = path.join(packageRoot, ...plugin.entrypoint.split('/'));
        fs.mkdirSync(path.dirname(entrypointPath), { recursive: true });
        fs.writeFileSync(entrypointPath, 'export default async () => ({});\n', 'utf8');
      }
      return { ok: true, exitCode: 0, stdout: '', stderr: '' };
    },
    ...overrides,
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-user-profile-'));
    home = path.join(root, 'home');
    commands = [];
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('installs the complete sanitized baseline into a blank user profile', async () => {
    const result = await createRuntime().provision();
    const configDir = path.join(home, '.config', 'opencode');
    const config = readJson(path.join(configDir, 'opencode.json'));
    const packageJson = readJson(path.join(configDir, 'package.json'));
    const slim = readJson(path.join(configDir, 'oh-my-opencode-slim.json'));
    const meridianFeatures = readJson(path.join(home, '.config', 'meridian', 'sdk-features.json'));

    expect(result.ok).toBe(true);
    expect(config.plugin).toEqual([
      './node_modules/opencode-antigravity-auth/dist/index.js',
      './node_modules/@rama_nigg/open-cursor/dist/plugin-entry.js',
      './node_modules/opencode-with-claude/dist/index.js',
      './node_modules/context-mode/build/adapters/opencode/plugin.js',
      './plugins/devryan-oh-my-opencode-slim.mjs',
      './plugins/devryan-superpowers.mjs',
    ]);
    expect(config).not.toHaveProperty('mcp');
    expect(packageJson.dependencies).toMatchObject({
      '@ai-sdk/openai-compatible': '^2.0.47',
      '@opencode-ai/plugin': '1.17.11',
      '@rama_nigg/open-cursor': '2.5.4',
      '@rynfar/meridian': '1.57.0',
      'context-mode': '1.0.169',
      'oh-my-opencode-slim': '2.0.5',
      'opencode-antigravity-auth': '1.6.0',
      'opencode-with-claude': '1.6.18',
    });
    expect(JSON.stringify(slim)).not.toContain('"mcps"');
    expect(fs.existsSync(path.join(configDir, 'agents', 'orchestrator.md'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'plugins', 'devryan-oh-my-opencode-slim.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'plugins', 'devryan-superpowers.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'node_modules', 'oh-my-opencode-slim'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'node_modules', 'opencode-with-claude'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'node_modules', 'context-mode'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'node_modules', '@rynfar', 'meridian'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'skills'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, '.openchamber', 'user-profile-manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, '.openchamber', 'meridian-sdk-features-policy.json'))).toBe(true);
    expect(meridianFeatures.opencode).toEqual({
      codeSystemPrompt: false,
      clientSystemPrompt: true,
    });
    expect(result.meridianPolicy).toMatchObject({
      ok: true,
      promptMode: 'client-only',
      managedFields: ['codeSystemPrompt', 'clientSystemPrompt'],
    });
    expect(result.warnings).toContain(
      'Superpowers skills are not installed; the optional adapter will remain disabled.',
    );
    expect(commands).toEqual([{
      command: 'bun',
      args: ['install', '--ignore-scripts'],
      cwd: configDir,
    }]);

    const prohibitedSegments = new Set(['auth', 'credentials', 'credential', 'secrets', 'secret', 'cache', 'logs', 'log', 'backups', 'backup', 'node_modules']);
    for (const installedPath of result.written) {
      const relative = path.relative(configDir, installedPath);
      expect(relative).not.toContain('/Users/');
      expect(relative.endsWith('.lock')).toBe(false);
      expect(relative.endsWith('.DS_Store')).toBe(false);
      expect(relative.split(path.sep).some((segment) => prohibitedSegments.has(segment.toLowerCase()))).toBe(false);
    }

    const defaultConfigRoot = path.dirname(DEFAULT_PROFILE_ROOT);
    const expectedManagedFiles = (await listDefaultConfigAssets(defaultConfigRoot))
      .flatMap((relativePath) => {
        if (relativePath.startsWith('agents/')) return [relativePath];
        if (
          relativePath.startsWith('plugins/')
          && DEVRYAN_MANAGED_PROFILE_PLUGIN_FILES.includes(relativePath.slice('plugins/'.length))
        ) return [relativePath];
        if (relativePath.startsWith('user-profile/')) return [relativePath];
        return [];
      })
      .map((relativePath) => relativePath
        .replace(/^user-profile\//, '')
        .replace(/^plugins\//, 'plugins/'))
      .sort();
    const manifest = readJson(path.join(configDir, '.openchamber', 'user-profile-manifest.json'));

    expect(Object.keys(manifest.files).sort()).toEqual(expectedManagedFiles);
    expect(Object.keys(manifest.files).some((relativePath) => relativePath.startsWith('skills/')))
      .toBe(false);
    expect(result.written.some((filePath) => (
      path.relative(configDir, filePath).startsWith(`skills${path.sep}`)
    ))).toBe(false);
    for (const relativePath of expectedManagedFiles) {
      expect(fs.existsSync(path.join(configDir, relativePath))).toBe(true);
    }
  });

  it('preserves unrelated user configuration and is a no-op on the second run', async () => {
    const configPath = path.join(home, '.config', 'opencode', 'opencode.json');
    writeJson(configPath, {
      theme: 'custom',
      plugin: ['custom-plugin'],
      agent: { custom: { description: 'keep' } },
    });

    const runtime = createRuntime();
    const first = await runtime.provision();
    const second = await runtime.provision();
    const config = readJson(configPath);

    expect(first.changed).toBe(true);
    expect(second).toMatchObject({ ok: true, changed: false, conflicts: [] });
    expect(config.theme).toBe('custom');
    expect(config.agent.custom).toEqual({ description: 'keep' });
    expect(config.plugin).toContain('custom-plugin');
    expect(commands).toHaveLength(1);
  });

  it('reconciles legacy managed specs in a previously managed config without discarding later user edits', async () => {
    const runtime = createRuntime();
    await runtime.provision();
    const configPath = path.join(home, '.config', 'opencode', 'opencode.json');
    const staleConfig = readJson(configPath);
    staleConfig.theme = 'user-theme';
    staleConfig.plugin = [
      'user-plugin@4.2.0',
      'opencode-antigravity-auth@latest',
      '@rama_nigg/open-cursor@latest',
      'cursor-acp',
      'opencode-with-claude@1.6.18',
      'context-mode@1.0.169',
      'superpowers@git+https://github.com/obra/superpowers.git',
      './plugins/devryan-oh-my-opencode-slim.mjs',
    ];
    writeJson(configPath, staleConfig);

    const result = await runtime.provision();
    const reconciled = readJson(configPath);

    expect(result.ok).toBe(true);
    expect(result.conflicts).not.toContain(configPath);
    expect(reconciled.theme).toBe('user-theme');
    expect(reconciled.plugin).toEqual([
      'user-plugin@4.2.0',
      './node_modules/opencode-antigravity-auth/dist/index.js',
      './node_modules/@rama_nigg/open-cursor/dist/plugin-entry.js',
      './node_modules/opencode-with-claude/dist/index.js',
      './node_modules/context-mode/build/adapters/opencode/plugin.js',
      './plugins/devryan-superpowers.mjs',
      './plugins/devryan-oh-my-opencode-slim.mjs',
    ]);
    expect(commands).toHaveLength(1);
  });

  it('removes legacy managed registrations from older user config layers while preserving their other content', async () => {
    const configDirectory = path.join(home, '.config', 'opencode');
    const legacyConfigPath = path.join(configDirectory, 'config.json');
    const jsoncConfigPath = path.join(configDirectory, 'opencode.jsonc');
    writeJson(legacyConfigPath, {
      provider: { custom: { name: 'keep' } },
      plugin: [
        'user-plugin@4.2.0',
        'context-mode@1.0.169',
        'superpowers@git+https://github.com/obra/superpowers.git',
      ],
    });
    fs.writeFileSync(
      jsoncConfigPath,
      '{\n  // keep this comment\n  "plugin": ["cursor-acp", "opencode-with-claude@1.6.17"],\n}\n',
      'utf8',
    );

    const result = await createRuntime().provision();

    expect(result.ok).toBe(true);
    expect(readJson(legacyConfigPath)).toEqual({
      provider: { custom: { name: 'keep' } },
      plugin: ['user-plugin@4.2.0'],
    });
    const reconciledJsonc = fs.readFileSync(jsoncConfigPath, 'utf8');
    expect(reconciledJsonc).toContain('// keep this comment');
    expect(reconciledJsonc).toContain('opencode-with-claude@1.6.17');
    expect(reconciledJsonc).not.toContain('cursor-acp');
    expect(result.updated).toEqual(expect.arrayContaining([legacyConfigPath, jsoncConfigPath]));
  });

  it('migrates only the exact legacy Meridian prompt defaults and preserves explicit choices', async () => {
    const featuresPath = path.join(home, '.config', 'meridian', 'sdk-features.json');
    writeJson(featuresPath, {
      opencode: {
        codeSystemPrompt: true,
        clientSystemPrompt: true,
        claudeMd: 'off',
        memory: false,
        dreaming: false,
      },
      codex: { clientSystemPrompt: false },
    });

    const migrated = await createRuntime().provision();
    const migratedFeatures = readJson(featuresPath);

    expect(migrated.meridianPolicy).toMatchObject({
      ok: true,
      migrated: true,
      promptMode: 'client-only',
    });
    expect(migratedFeatures.opencode.codeSystemPrompt).toBe(false);
    expect(migratedFeatures.codex).toEqual({ clientSystemPrompt: false });

    const explicitHome = path.join(root, 'explicit-home');
    home = explicitHome;
    const explicitFeaturesPath = path.join(home, '.config', 'meridian', 'sdk-features.json');
    writeJson(explicitFeaturesPath, {
      opencode: {
        codeSystemPrompt: true,
        clientSystemPrompt: true,
        claudeMd: 'project',
        memory: false,
        dreaming: false,
      },
    });

    const preserved = await createRuntime().provision();

    expect(preserved.meridianPolicy).toMatchObject({
      ok: true,
      migrated: false,
      promptMode: 'combined',
      preservedFields: ['codeSystemPrompt', 'clientSystemPrompt'],
    });
    expect(preserved.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('both the Claude Code and client system prompts'),
      'Superpowers skills are not installed; the optional adapter will remain disabled.',
    ]));
    expect(readJson(explicitFeaturesPath).opencode.codeSystemPrompt).toBe(true);
  });

  it('fails visibly before installation when Meridian SDK features are malformed', async () => {
    const featuresPath = path.join(home, '.config', 'meridian', 'sdk-features.json');
    fs.mkdirSync(path.dirname(featuresPath), { recursive: true });
    fs.writeFileSync(featuresPath, '{invalid\n', 'utf8');

    const result = await createRuntime().provision();

    expect(result).toMatchObject({
      ok: false,
      changed: false,
      meridianPolicy: {
        ok: false,
        code: 'meridian_sdk_features_invalid_json',
      },
    });
    expect(result.error).toContain('not valid JSON');
    expect(commands).toEqual([]);
    expect(fs.readFileSync(featuresPath, 'utf8')).toBe('{invalid\n');
  });

  it('migrates the old managed Claude plugin while preserving explicit user pins', async () => {
    const configPath = path.join(home, '.config', 'opencode', 'opencode.json');
    writeJson(configPath, { plugin: ['opencode-with-claude'] });

    await createRuntime().provision();
    expect(readJson(configPath).plugin).toContain('./node_modules/opencode-with-claude/dist/index.js');
    expect(readJson(configPath).plugin).not.toContain('opencode-with-claude');

    const pinnedHome = path.join(root, 'pinned-home');
    const pinnedPath = path.join(pinnedHome, '.config', 'opencode', 'opencode.json');
    writeJson(pinnedPath, { plugin: ['opencode-with-claude@1.6.17'] });
    home = pinnedHome;

    await createRuntime().provision();
    const pinned = readJson(pinnedPath).plugin.filter((entry) => entry.startsWith('opencode-with-claude'));
    expect(pinned).toEqual(['opencode-with-claude@1.6.17']);
  });

  it('adds the Meridian pin while preserving an explicit user dependency pin', async () => {
    const packagePath = path.join(home, '.config', 'opencode', 'package.json');
    writeJson(packagePath, {
      dependencies: {
        '@rynfar/meridian': '1.56.0',
        'user-plugin': '3.2.1',
      },
    });

    const result = await createRuntime().provision();
    const dependencies = readJson(packagePath).dependencies;

    expect(result.ok).toBe(true);
    expect(dependencies['@rynfar/meridian']).toBe('1.56.0');
    expect(dependencies['user-plugin']).toBe('3.2.1');
    expect(dependencies['opencode-with-claude']).toBe('1.6.18');
  });

  it('adds a newly managed dependency to a modified package without losing user fields', async () => {
    const profileRoot = path.join(root, 'profile');
    fs.cpSync(DEFAULT_PROFILE_ROOT, profileRoot, { recursive: true });
    const profilePackagePath = path.join(profileRoot, 'package.json');
    const profilePackage = readJson(profilePackagePath);
    delete profilePackage.dependencies['@rynfar/meridian'];
    writeJson(profilePackagePath, profilePackage);

    const runtime = createRuntime({ profileRoot });
    await runtime.provision();

    const packagePath = path.join(home, '.config', 'opencode', 'package.json');
    const userPackage = readJson(packagePath);
    userPackage.private = false;
    userPackage.dependencies['user-plugin'] = '3.2.1';
    writeJson(packagePath, userPackage);

    profilePackage.dependencies['@rynfar/meridian'] = '1.57.0';
    writeJson(profilePackagePath, profilePackage);
    const result = await runtime.provision();
    const upgraded = readJson(packagePath);

    expect(result.ok).toBe(true);
    expect(result.conflicts).not.toContain(packagePath);
    expect(upgraded.private).toBe(false);
    expect(upgraded.dependencies['user-plugin']).toBe('3.2.1');
    expect(upgraded.dependencies['@rynfar/meridian']).toBe('1.57.0');
  });

  it('preserves and reports a user-modified managed file', async () => {
    const runtime = createRuntime();
    await runtime.provision();
    const agentPath = path.join(home, '.config', 'opencode', 'agents', 'orchestrator.md');
    fs.writeFileSync(agentPath, 'user-owned change\n', 'utf8');

    const result = await runtime.provision();

    expect(fs.readFileSync(agentPath, 'utf8')).toBe('user-owned change\n');
    expect(result.conflicts).toContain(agentPath);
  });

  it('keeps a user-installed Superpowers bootstrap active without warning', async () => {
    const bootstrapPath = path.join(
      home,
      '.config',
      'opencode',
      'skills',
      'superpowers',
      'using-superpowers',
      'SKILL.md',
    );
    fs.mkdirSync(path.dirname(bootstrapPath), { recursive: true });
    fs.writeFileSync(bootstrapPath, '---\nname: using-superpowers\n---\nUser-installed skill.\n', 'utf8');

    const result = await createRuntime().provision();

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(bootstrapPath, 'utf8')).toContain('User-installed skill.');
    expect(result.warnings).not.toContain(
      'Superpowers skills are not installed; the optional adapter will remain disabled.',
    );
  });

  it('retires previously managed skills without claiming user-modified files', async () => {
    const configDir = path.join(home, '.config', 'opencode');
    const legacySkillPath = path.join(configDir, 'skills', 'legacy', 'SKILL.md');
    const legacyReferencePath = path.join(configDir, 'skills', 'legacy', 'references', 'x.md');
    const adoptedSkillPath = path.join(configDir, 'skills', 'adopted', 'SKILL.md');
    const legacySkillContent = 'managed legacy skill\n';
    const legacyReferenceContent = 'managed legacy reference\n';
    fs.mkdirSync(path.dirname(legacyReferencePath), { recursive: true });
    fs.mkdirSync(path.dirname(adoptedSkillPath), { recursive: true });
    fs.writeFileSync(legacySkillPath, legacySkillContent, 'utf8');
    fs.writeFileSync(legacyReferencePath, legacyReferenceContent, 'utf8');
    fs.writeFileSync(path.join(configDir, 'skills', 'legacy', '.DS_Store'), '', 'utf8');
    fs.writeFileSync(adoptedSkillPath, 'user-adopted skill\n', 'utf8');
    writeJson(path.join(configDir, '.openchamber', 'user-profile-manifest.json'), {
      version: 1,
      files: {
        'skills/legacy/SKILL.md': { hash: hashContent(legacySkillContent) },
        'skills/legacy/references/x.md': { hash: hashContent(legacyReferenceContent) },
        'skills/adopted/SKILL.md': { hash: hashContent('former managed content\n') },
      },
    });

    const runtime = createRuntime();
    const result = await runtime.provision();
    const repeated = await runtime.provision();
    const manifest = readJson(path.join(configDir, '.openchamber', 'user-profile-manifest.json'));

    expect(result.removed).toEqual(expect.arrayContaining([
      legacySkillPath,
      legacyReferencePath,
    ]));
    expect(fs.existsSync(path.join(configDir, 'skills', 'legacy'))).toBe(false);
    expect(fs.readFileSync(adoptedSkillPath, 'utf8')).toBe('user-adopted skill\n');
    expect(result.conflicts).not.toContain(adoptedSkillPath);
    expect(Object.keys(manifest.files).some((relativePath) => relativePath.startsWith('skills/')))
      .toBe(false);
    expect(repeated).toMatchObject({ ok: true, changed: false, conflicts: [] });
  });

  it('reports package installation failure without claiming readiness', async () => {
    const runtime = createRuntime({
      runCommand: async () => ({ ok: false, exitCode: 1, stdout: '', stderr: 'network unavailable' }),
    });

    const result = await runtime.provision();

    expect(result.ok).toBe(false);
    expect(result.install).toMatchObject({ ok: false, exitCode: 1 });
    expect(result.error).toContain('network unavailable');
  });

  it('fails explicit validation when installation succeeds without materializing managed entrypoints', async () => {
    const runtime = createRuntime({
      runCommand: async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '' }),
    });

    const result = await runtime.provision();

    expect(result.ok).toBe(false);
    expect(result.install).toMatchObject({ ok: true, exitCode: 0 });
    expect(result.managedPluginIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'opencode-antigravity-auth',
        kind: 'missing-package',
      }),
      expect.objectContaining({
        pluginId: '@rama_nigg/open-cursor',
        kind: 'missing-package',
      }),
    ]));
    expect(result.error).toContain('Managed OpenCode plugin validation failed after provisioning');
  });
});
