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
      for (const [name, version] of Object.entries(packageJson.dependencies || {})) {
        const packageRoot = path.join(options.cwd, 'node_modules', ...name.split('/'));
        writeJson(path.join(packageRoot, 'package.json'), { name, version });
      }
      for (const [name, version] of Object.entries(packageJson.overrides || {})) {
        const packageRoot = path.join(options.cwd, 'node_modules', ...name.split('/'));
        writeJson(path.join(packageRoot, 'package.json'), { name, version });
      }
      for (const plugin of DEVRYAN_MANAGED_PLUGINS) {
        const dependencies = [
          ...(plugin.packageName && plugin.version && plugin.entrypoint
            ? [{ packageName: plugin.packageName, version: plugin.version, entrypoint: plugin.entrypoint }]
            : []),
          ...plugin.runtimeDependencies,
        ];
        for (const dependency of dependencies) {
          const packageRoot = path.join(options.cwd, 'node_modules', ...dependency.packageName.split('/'));
          writeJson(path.join(packageRoot, 'package.json'), {
            name: dependency.packageName,
            version: dependency.version,
          });
          const entrypointPath = path.join(packageRoot, ...dependency.entrypoint.split('/'));
          fs.mkdirSync(path.dirname(entrypointPath), { recursive: true });
          fs.writeFileSync(entrypointPath, 'export default async () => ({});\n', 'utf8');
        }
      }
      return { ok: true, exitCode: 0, stdout: '', stderr: '' };
    },
    applyContextModeHotfix: () => ({ ok: true, changed: false }),
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
      './node_modules/opencode-gpt-imagegen/dist/index.js',
      './node_modules/context-mode/build/adapters/opencode/plugin.js',
      './plugins/devryan-oh-my-opencode-slim.mjs',
      './plugins/devryan-superpowers.mjs',
      './plugins/devryan-skill-context.mjs',
      './plugins/devryan-document-reader.mjs',
    ]);
    expect(config).not.toHaveProperty('mcp');
    expect(packageJson.dependencies).toMatchObject({
      '@ai-sdk/openai-compatible': '^2.0.47',
      '@opencode-ai/plugin': '1.17.11',
      '@rama_nigg/open-cursor': '2.5.4',
      '@rynfar/meridian': '1.62.6',
      'context-mode': '1.0.169',
      'adm-zip': '0.6.0',
      'mammoth': '1.12.1',
      'oh-my-opencode-slim': '2.2.15',
      'opencode-antigravity-auth': '1.6.0',
      'opencode-gpt-imagegen': '0.1.10',
      'opencode-with-claude': '1.8.0',
      'unpdf': '1.8.0',
    });
    expect(packageJson.overrides).toEqual({
      '@anthropic-ai/claude-agent-sdk': '0.2.141',
      '@anthropic-ai/claude-code': '2.1.215',
    });
    expect(JSON.stringify(slim)).not.toContain('"mcps"');
    expect(fs.existsSync(path.join(configDir, 'agents', 'orchestrator.md'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'plugins', 'devryan-oh-my-opencode-slim.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'plugins', 'devryan-superpowers.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'plugins', 'devryan-skill-context.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'plugins', 'devryan-document-reader.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'node_modules', 'oh-my-opencode-slim'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'node_modules', 'opencode-with-claude'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'node_modules', 'opencode-gpt-imagegen'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'node_modules', 'context-mode'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'node_modules', '@rynfar', 'meridian'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'skills'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, '.openchamber', 'user-profile-manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, '.openchamber', 'meridian-sdk-features-policy.json'))).toBe(true);
    expect(meridianFeatures.opencode).toEqual({
      codeSystemPrompt: true,
      clientSystemPrompt: true,
    });
    expect(result.meridianPolicy).toMatchObject({
      ok: true,
      promptMode: 'combined',
      managedFields: ['codeSystemPrompt', 'clientSystemPrompt'],
    });
    expect(result.claudeRuntime).toMatchObject({
      source: 'managed',
      channel: 'candidate',
      compatibilityStatus: 'upstream_blocked',
      runtimeStatus: 'ready',
      installed: {
        opencodeWithClaude: '1.8.0',
        meridian: '1.62.6',
        agentSdk: '0.2.141',
        claudeCode: '2.1.215',
      },
      managementSources: {
        opencodeWithClaude: 'managed',
        meridian: 'managed',
        agentSdk: 'managed',
        claudeCode: 'managed',
      },
    });
    expect(result.warnings).toContain(
      'Superpowers skills are not installed; the optional adapter will remain disabled.',
    );
    expect(result.warnings).toContain(
      'Claude Code 2.1.215 is selected for Meridian compatibility; the broader cross-provider context target remains upstream-blocked.',
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
      'opencode-gpt-imagegen@latest',
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
      './node_modules/opencode-gpt-imagegen/dist/index.js',
      './node_modules/context-mode/build/adapters/opencode/plugin.js',
      './plugins/devryan-superpowers.mjs',
      './plugins/devryan-oh-my-opencode-slim.mjs',
      './plugins/devryan-skill-context.mjs',
      './plugins/devryan-document-reader.mjs',
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
      promptMode: 'combined',
    });
    expect(migratedFeatures.opencode.codeSystemPrompt).toBe(true);
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
    expect(preserved.warnings).toContain(
      'Superpowers skills are not installed; the optional adapter will remain disabled.',
    );
    expect(preserved.warnings.join('\n')).not.toContain('both the Claude Code and client system prompts');
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
    expect(dependencies['opencode-with-claude']).toBe('1.8.0');
    expect(result.claudeRuntime).toMatchObject({
      source: 'user-managed',
      compatibilityStatus: 'user_managed',
      managementSources: { meridian: 'user-managed' },
    });
  });

  it('preserves explicit user Claude runtime overrides and reports user management', async () => {
    const packagePath = path.join(home, '.config', 'opencode', 'package.json');
    writeJson(packagePath, {
      dependencies: {
        '@rynfar/meridian': '1.62.6',
      },
      overrides: {
        '@anthropic-ai/claude-agent-sdk': '0.2.140',
        '@anthropic-ai/claude-code': '2.1.214',
        'user-package': '4.0.0',
      },
    });

    const result = await createRuntime().provision();
    const packageJson = readJson(packagePath);

    expect(result.ok).toBe(true);
    expect(packageJson.overrides).toEqual({
      '@anthropic-ai/claude-agent-sdk': '0.2.140',
      '@anthropic-ai/claude-code': '2.1.214',
      'user-package': '4.0.0',
    });
    expect(result.claudeRuntime).toMatchObject({
      source: 'user-managed',
      compatibilityStatus: 'user_managed',
      runtimeStatus: 'ready',
      managementSources: {
        meridian: 'user-managed',
        agentSdk: 'user-managed',
        claudeCode: 'user-managed',
      },
    });
  });

  it('reinstalls when managed Claude runtime overrides change', async () => {
    const runtime = createRuntime();
    await runtime.provision();
    commands = [];

    const packagePath = path.join(home, '.config', 'opencode', 'package.json');
    const markerPath = path.join(
      home,
      '.config',
      'opencode',
      '.openchamber',
      'claude-runtime-compatibility.json',
    );
    const packageJson = readJson(packagePath);
    packageJson.overrides['@anthropic-ai/claude-code'] = '2.1.200';
    writeJson(packagePath, packageJson);
    const marker = readJson(markerPath);
    marker.managedOverrides['@anthropic-ai/claude-code'] = '2.1.200';
    writeJson(markerPath, marker);

    const result = await runtime.provision();

    expect(readJson(packagePath).overrides['@anthropic-ai/claude-code']).toBe('2.1.215');
    expect(result.claudeRuntime).toMatchObject({
      source: 'managed',
      runtimeStatus: 'ready',
    });
    expect(commands).toEqual([{
      command: 'bun',
      args: ['install', '--ignore-scripts'],
      cwd: path.join(home, '.config', 'opencode'),
    }]);
  });

  it('repairs stale installed Claude packages when the managed manifest is already current', async () => {
    const runtime = createRuntime();
    await runtime.provision();
    commands = [];

    const configDirectory = path.join(home, '.config', 'opencode');
    const installedMeridianPath = path.join(
      configDirectory,
      'node_modules',
      '@rynfar',
      'meridian',
      'package.json',
    );
    writeJson(installedMeridianPath, {
      name: '@rynfar/meridian',
      version: '1.62.5',
    });

    const result = await runtime.provision();

    expect(result.ok).toBe(true);
    expect(result.claudeRuntime).toMatchObject({
      source: 'managed',
      runtimeStatus: 'ready',
      installed: { meridian: '1.62.6' },
    });
    expect(commands).toEqual([{
      command: 'bun',
      args: ['install', '--ignore-scripts'],
      cwd: configDirectory,
    }]);
  });

  it('fails managed provisioning when a successful install command leaves Claude runtime drift', async () => {
    const runtime = createRuntime();
    await runtime.provision();
    commands = [];

    const configDirectory = path.join(home, '.config', 'opencode');
    writeJson(
      path.join(configDirectory, 'node_modules', '@rynfar', 'meridian', 'package.json'),
      { name: '@rynfar/meridian', version: '1.62.5' },
    );
    const driftedRuntime = createRuntime({
      runCommand: async (command, args, options) => {
        commands.push({ command, args, cwd: options.cwd });
        return { ok: true, exitCode: 0, stdout: '', stderr: '' };
      },
    });

    const result = await driftedRuntime.provision();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Managed Claude runtime installation remained drifted after provisioning');
    expect(result.claudeRuntime).toMatchObject({
      source: 'managed',
      runtimeStatus: 'drifted',
      installed: { meridian: '1.62.5' },
      versionMismatches: ['meridian'],
    });
    expect(commands).toEqual([{
      command: 'bun',
      args: ['install', '--ignore-scripts'],
      cwd: configDirectory,
    }]);
  });

  it('upgrades a manifest-owned pre-marker Claude tuple to the selected runtime', async () => {
    const runtime = createRuntime();
    await runtime.provision();
    commands = [];

    const configDirectory = path.join(home, '.config', 'opencode');
    const packagePath = path.join(configDirectory, 'package.json');
    const manifestPath = path.join(
      configDirectory,
      '.openchamber',
      'user-profile-manifest.json',
    );
    const markerPath = path.join(
      configDirectory,
      '.openchamber',
      'claude-runtime-compatibility.json',
    );
    const packageJson = readJson(packagePath);
    packageJson.dependencies['opencode-with-claude'] = '1.6.18';
    packageJson.dependencies['@rynfar/meridian'] = '1.57.0';
    packageJson.overrides['@anthropic-ai/claude-code'] = '2.1.215';
    writeJson(packagePath, packageJson);
    const packageContent = fs.readFileSync(packagePath, 'utf8');
    const manifest = readJson(manifestPath);
    manifest.files['package.json'].hash = hashContent(packageContent);
    writeJson(manifestPath, manifest);
    fs.unlinkSync(markerPath);

    const result = await runtime.provision();
    const upgraded = readJson(packagePath);

    expect(result.ok).toBe(true);
    expect(upgraded.dependencies).toMatchObject({
      'opencode-with-claude': '1.8.0',
      '@rynfar/meridian': '1.62.6',
    });
    expect(upgraded.overrides).toMatchObject({
      '@anthropic-ai/claude-agent-sdk': '0.2.141',
      '@anthropic-ai/claude-code': '2.1.215',
    });
    expect(result.claudeRuntime).toMatchObject({
      source: 'managed',
      channel: 'candidate',
      runtimeStatus: 'ready',
    });
    expect(commands).toEqual([{
      command: 'bun',
      args: ['install', '--ignore-scripts'],
      cwd: configDirectory,
    }]);
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

    profilePackage.dependencies['@rynfar/meridian'] = '1.62.6';
    writeJson(profilePackagePath, profilePackage);
    const result = await runtime.provision();
    const upgraded = readJson(packagePath);

    expect(result.ok).toBe(true);
    expect(result.conflicts).not.toContain(packagePath);
    expect(upgraded.private).toBe(false);
    expect(upgraded.dependencies['user-plugin']).toBe('3.2.1');
    expect(upgraded.dependencies['@rynfar/meridian']).toBe('1.62.6');
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

  it('upgrades Slim from 2.0.5 without changing user-owned config or primary prompt', async () => {
    const runtime = createRuntime();
    await runtime.provision();
    const configDir = path.join(home, '.config', 'opencode');
    const packagePath = path.join(configDir, 'package.json');
    const installedPackagePath = path.join(
      configDir,
      'node_modules',
      'oh-my-opencode-slim',
      'package.json',
    );
    const slimConfigPath = path.join(configDir, 'oh-my-opencode-slim.json');
    const orchestratorPath = path.join(configDir, 'agents', 'orchestrator.md');

    const stalePackage = readJson(packagePath);
    stalePackage.dependencies['oh-my-opencode-slim'] = '2.0.5';
    writeJson(packagePath, stalePackage);
    writeJson(installedPackagePath, {
      name: 'oh-my-opencode-slim',
      version: '2.0.5',
    });

    const userSlimConfig = readJson(slimConfigPath);
    userSlimConfig.agents.orchestrator = {
      model: 'openai/gpt-5.6-sol',
      variant: 'high',
    };
    writeJson(slimConfigPath, userSlimConfig);
    fs.writeFileSync(orchestratorPath, 'user-owned primary prompt\n', 'utf8');
    const expectedSlimConfig = fs.readFileSync(slimConfigPath, 'utf8');
    const expectedOrchestrator = fs.readFileSync(orchestratorPath, 'utf8');

    const result = await runtime.provision();

    expect(result.ok).toBe(true);
    expect(readJson(packagePath).dependencies['oh-my-opencode-slim']).toBe('2.2.15');
    expect(readJson(installedPackagePath).version).toBe('2.2.15');
    expect(fs.readFileSync(slimConfigPath, 'utf8')).toBe(expectedSlimConfig);
    expect(fs.readFileSync(orchestratorPath, 'utf8')).toBe(expectedOrchestrator);
    expect(result.conflicts).toEqual(expect.arrayContaining([
      slimConfigPath,
      orchestratorPath,
    ]));
    expect(commands).toHaveLength(2);
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

  it('continues with the previously installed plugins when a refresh install fails', async () => {
    await createRuntime().provision();
    commands = [];

    const configDirectory = path.join(home, '.config', 'opencode');
    writeJson(path.join(configDirectory, 'node_modules', '@rynfar', 'meridian', 'package.json'), {
      name: '@rynfar/meridian',
      version: '1.62.5',
    });

    const result = await createRuntime({
      runCommand: async (command, args, options) => {
        commands.push({ command, args, cwd: options.cwd });
        return { ok: false, exitCode: 1, stdout: '', stderr: 'Resolving dependencies' };
      },
    }).provision();

    expect(result.ok).toBe(true);
    expect(result.installDegraded).toBe(true);
    expect(result.install).toMatchObject({ ok: false, exitCode: 1 });
    expect(result.warnings.some((warning) => (
      warning.includes('Failed to install OpenCode user plugins')
      && warning.includes('Continuing with the previously installed plugins')
    ))).toBe(true);
    expect(commands).toEqual([{
      command: 'bun',
      args: ['install', '--ignore-scripts'],
      cwd: configDirectory,
    }]);
  });

  it('forces one pinned reinstall when the context-mode hotfix hash is incompatible', async () => {
    let hotfixAttempts = 0;
    const result = await createRuntime({
      applyContextModeHotfix: () => {
        hotfixAttempts += 1;
        return hotfixAttempts === 1
          ? { ok: false, changed: false, error: 'unexpected source hash' }
          : { ok: true, changed: true };
      },
    }).provision();

    expect(result).toMatchObject({
      ok: true,
      contextModeHotfix: { ok: true, changed: true },
      contextModeHotfixReinstall: { ok: true, exitCode: 0 },
    });
    expect(commands.map(({ args }) => args)).toEqual([
      ['install', '--ignore-scripts'],
      ['install', '--force', '--ignore-scripts'],
    ]);
  });

  it('fails with a stable code after one incompatible context-mode reinstall', async () => {
    const result = await createRuntime({
      applyContextModeHotfix: () => ({
        ok: false,
        changed: false,
        error: 'unexpected source hash',
      }),
    }).provision();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('CONTEXT_MODE_HOTFIX_INCOMPATIBLE: unexpected source hash');
    expect(commands.map(({ args }) => args)).toEqual([
      ['install', '--ignore-scripts'],
      ['install', '--force', '--ignore-scripts'],
    ]);
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
