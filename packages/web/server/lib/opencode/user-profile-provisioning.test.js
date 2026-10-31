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
    applyImagegenModelHotfix: () => ({ ok: true, changed: false }),
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

  it('preserves an unrecognized auto-discovered Cursor plugin without blocking provisioning', async () => {
    const config = path.join(home, '.config/opencode');
    const plugin = path.join(config, 'plugin/cursor-acp.js');
    fs.mkdirSync(path.dirname(plugin), { recursive: true });
    fs.writeFileSync(plugin, 'user modified plugin');
    const result = await createRuntime().provision();
    expect(result.ok).toBe(true);
    expect(result.error).toBeFalsy();
    expect(result.conflicts).toContain(plugin);
    expect(result.profileNotices).toEqual([expect.objectContaining({
      code: 'legacy_cursor_plugin_conflict',
      files: [plugin],
    })]);
    expect(result.warnings.some((warning) => warning.includes('DEVRYAN_CURSOR_PLUGIN_CONFLICT'))).toBe(true);
    expect(fs.readFileSync(plugin, 'utf8')).toBe('user modified plugin');
    expect(fs.existsSync(path.join(config, 'package.json'))).toBe(true);
  });

  it('retires the default open-cursor installer symlink during provisioning', async () => {
    const config = path.join(home, '.config/opencode');
    const target = path.join(root, 'global/lib/node_modules/@rama_nigg/open-cursor/dist/plugin-entry.js');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'open-cursor bundle');
    const plugin = path.join(config, 'plugin/cursor-acp.js');
    fs.mkdirSync(path.dirname(plugin), { recursive: true });
    fs.symlinkSync(target, plugin);
    const result = await createRuntime().provision();
    expect(result.ok).toBe(true);
    expect(result.profileNotices).toEqual([]);
    expect(result.removed).toContain(plugin);
    expect(fs.existsSync(plugin)).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('open-cursor bundle');
  });

  it('blocks startup when the image model patch cannot be applied safely', async () => {
    const result = await createRuntime({ applyImagegenModelHotfix: () => ({ ok: false, changed: false, code: 'DEVRYAN_IMAGEGEN_MODEL_INCOMPATIBLE', error: 'fixture source mismatch' }) }).provision();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('DEVRYAN_IMAGEGEN_MODEL_INCOMPATIBLE');
  });

  it('installs the complete sanitized baseline into a blank user profile', async () => {
    const result = await createRuntime().provision();
    const configDir = path.join(home, '.config', 'opencode');
    const config = readJson(path.join(configDir, 'opencode.json'));
    const packageJson = readJson(path.join(configDir, 'package.json'));
    const slim = readJson(path.join(configDir, 'devryan-agents.jsonc'));

    expect(result.ok).toBe(true);
    expect(config.plugin).toEqual([
      './plugins/devryan-open-cursor.mjs',
      './node_modules/opencode-gpt-imagegen/dist/index.js',
      './plugins/devryan-skill-context.mjs',
      './plugins/devryan-document-reader.mjs',
    ]);
    expect(config).not.toHaveProperty('mcp');
    expect(packageJson.dependencies).toMatchObject({
      '@ai-sdk/openai-compatible': '^2.0.47',
      '@opencode-ai/plugin': '1.18.33',
      '@rama_nigg/open-cursor': '2.5.17',
      'adm-zip': '0.6.0',
      'mammoth': '1.12.1',
      'opencode-gpt-imagegen': '0.1.12',
      'unpdf': '1.8.0',
    });
    expect(packageJson.dependencies).not.toHaveProperty('opencode-with-claude');
    expect(packageJson.dependencies).not.toHaveProperty('@rynfar/meridian');
    expect(packageJson).not.toHaveProperty('overrides');
    expect(JSON.stringify(slim)).not.toContain('"mcps"');
    expect(fs.existsSync(path.join(configDir, 'agents', 'orchestrator.md'))).toBe(true);
    expect(packageJson.dependencies).not.toHaveProperty('oh-my-opencode-slim');
    expect(fs.existsSync(path.join(configDir, 'plugins', 'devryan-oh-my-opencode-slim.mjs'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'plugins', 'devryan-superpowers.mjs'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'plugins', 'devryan-skill-context.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'plugins', 'devryan-document-reader.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'node_modules', 'oh-my-opencode-slim'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'node_modules', 'opencode-with-claude'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'node_modules', 'opencode-gpt-imagegen'))).toBe(true);
    expect(packageJson.dependencies).not.toHaveProperty('context-mode');
    expect(fs.existsSync(path.join(configDir, 'node_modules', 'context-mode'))).toBe(false);
    expect(packageJson.dependencies).not.toHaveProperty('opencode-antigravity-auth');
    expect(fs.existsSync(path.join(configDir, 'node_modules', '@rynfar', 'meridian'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'skills'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, '.devryan', 'user-profile-manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, '.devryan', 'meridian-sdk-features-policy.json'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, '.devryan', 'claude-runtime-compatibility.json'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.config', 'meridian'))).toBe(false);
    expect(result).not.toHaveProperty('meridianPolicy');
    expect(result).not.toHaveProperty('meridianHttpHotfix');
    expect(result).not.toHaveProperty('claudeRuntime');
    expect(result.warnings.join('\n')).not.toMatch(/superpowers/i);
    expect(result.warnings.join('\n')).not.toMatch(/claude|meridian/i);
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
    const manifest = readJson(path.join(configDir, '.devryan', 'user-profile-manifest.json'));

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

  it('upgrades managed routing prompts to the canonical visual ownership rules', async () => {
    const runtime = createRuntime();
    expect((await runtime.provision()).ok).toBe(true);
    const configDir = path.join(home, '.config', 'opencode');
    const manifestPath = path.join(configDir, '.devryan', 'user-profile-manifest.json');
    const manifest = readJson(manifestPath);
    const roles = ['orchestrator', 'designer', 'fixer'];
    for (const role of roles) {
      const relative = `agents/${role}.md`;
      const previous = `Previous managed ${role} routing rules\n`;
      fs.writeFileSync(path.join(configDir, relative), previous);
      manifest.files[relative].hash = hashContent(previous);
    }
    writeJson(manifestPath, manifest);
    const result = await runtime.provision();
    expect(result).toMatchObject({ ok: true, changed: true, conflicts: [] });
    for (const role of roles) {
      expect(fs.readFileSync(path.join(configDir, `agents/${role}.md`), 'utf8'))
        .toBe(fs.readFileSync(new URL(`../../default-config/agents/${role}.md`, import.meta.url), 'utf8'));
    }
    expect((await runtime.provision()).changed).toBe(false);
  });

  it('migrates personal legacy agent config ahead of the shipped default and preserves prompt overrides', async () => {
    const configDir = path.join(home, '.config', 'opencode');
    const legacyJsonPath = path.join(configDir, 'oh-my-opencode-slim.json');
    const legacyJsoncPath = path.join(configDir, 'oh-my-opencode-slim.jsonc');
    const agentsPath = path.join(configDir, 'devryan-agents.jsonc');
    const promptPath = path.join(configDir, 'agents', 'builder.md');
    const personal = { preset: 'openai', disabled_mcps: ['context7', 'websearch', 'gh_grep'],
      agents: { builder: { model: 'xai/grok-4.6', variant: 'high' }, designer: { model: 'anthropic/claude-opus-5', variant: 'medium' } } };
    writeJson(legacyJsonPath, personal);
    // JSONC outranks JSON, so it is the file that becomes the new configuration.
    fs.writeFileSync(legacyJsoncPath, '// personal precedence\n{"agents":{"oracle":{"model":"openai/gpt-6-astra"}}}\n');
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, 'My primary agent instructions\n');
    const before = [legacyJsonPath, legacyJsoncPath, promptPath].map(file => fs.readFileSync(file, 'utf8'));
    const runtime = createRuntime();
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await runtime.provision();
      expect(result.ok).toBe(true);
      expect(result.conflicts).toEqual(expect.arrayContaining([agentsPath, promptPath]));
      expect([legacyJsonPath, legacyJsoncPath, promptPath].map(file => fs.readFileSync(file, 'utf8'))).toEqual(before);
      expect(fs.readFileSync(agentsPath, 'utf8')).toBe(before[1]);
    }
  });

  it('keeps a user-owned Slim adapter but no longer registers or installs Slim', async () => {
    const configDir = path.join(home, '.config', 'opencode');
    const adapter = path.join(configDir, 'plugins', 'devryan-oh-my-opencode-slim.mjs');
    fs.mkdirSync(path.dirname(adapter), { recursive: true });
    fs.writeFileSync(adapter, 'export default async () => ({ custom: true });\n');
    writeJson(path.join(configDir, 'package.json'), { dependencies: { 'oh-my-opencode-slim': '2.2.15' } });
    const result = await createRuntime().provision();
    expect(result.ok).toBe(true);
    // An untracked file is user data: it stays, but nothing loads it.
    expect(fs.readFileSync(adapter, 'utf8')).toContain('custom: true');
    expect(readJson(path.join(configDir, 'opencode.json')).plugin).not.toContain('./plugins/devryan-oh-my-opencode-slim.mjs');
    // A pin other than DevRyan's own 2.2.25 is user-owned and left alone.
    expect(readJson(path.join(configDir, 'package.json')).dependencies['oh-my-opencode-slim']).toBe('2.2.15');
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
      'oh-my-opencode-slim@2.2.25',
    ];
    writeJson(configPath, staleConfig);

    const result = await runtime.provision();
    const reconciled = readJson(configPath);

    expect(result.ok).toBe(true);
    expect(result.conflicts).not.toContain(configPath);
    expect(reconciled.theme).toBe('user-theme');
    expect(reconciled.plugin).toEqual([
      'user-plugin@4.2.0',
      './plugins/devryan-open-cursor.mjs',
      './node_modules/opencode-gpt-imagegen/dist/index.js',
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

  it('removes the markers DevRyan wrote for the retired Meridian Claude runtime', async () => {
    const configDirectory = path.join(home, '.config', 'opencode');
    const policyMarker = path.join(configDirectory, '.devryan', 'meridian-sdk-features-policy.json');
    const runtimeMarker = path.join(configDirectory, '.devryan', 'claude-runtime-compatibility.json');
    writeJson(policyMarker, { managedFields: ['codeSystemPrompt', 'clientSystemPrompt'] });
    writeJson(runtimeMarker, { managedOverrides: { '@anthropic-ai/claude-code': '2.1.302' } });
    // Meridian's own settings belong to the user and are no longer read or rewritten.
    const featuresPath = path.join(home, '.config', 'meridian', 'sdk-features.json');
    writeJson(featuresPath, { opencode: { codeSystemPrompt: true } });
    const featuresContent = fs.readFileSync(featuresPath, 'utf8');

    const runtime = createRuntime();
    const result = await runtime.provision();

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.removed).toEqual(expect.arrayContaining([policyMarker, runtimeMarker]));
    expect(fs.existsSync(policyMarker)).toBe(false);
    expect(fs.existsSync(runtimeMarker)).toBe(false);
    expect(fs.readFileSync(featuresPath, 'utf8')).toBe(featuresContent);

    const second = await runtime.provision();
    expect(second).toMatchObject({ ok: true, changed: false });
    expect(second.removed).not.toContain(policyMarker);
    expect(second.removed).not.toContain(runtimeMarker);
  });

  it('removes the retired Claude plugin registrations while preserving explicit user pins', async () => {
    const configPath = path.join(home, '.config', 'opencode', 'opencode.json');
    writeJson(configPath, { plugin: [
      'opencode-with-claude',
      'opencode-with-claude@1.11.2',
      './node_modules/opencode-with-claude/dist/index.js',
      './plugins/devryan-claude-transport.mjs',
    ] });

    expect((await createRuntime().provision()).ok).toBe(true);
    expect(readJson(configPath).plugin.filter((entry) => /claude/.test(entry))).toEqual([]);

    const pinnedHome = path.join(root, 'pinned-home');
    const pinnedPath = path.join(pinnedHome, '.config', 'opencode', 'opencode.json');
    writeJson(pinnedPath, { plugin: ['opencode-with-claude@1.6.17'] });
    home = pinnedHome;

    await createRuntime().provision();
    const pinned = readJson(pinnedPath).plugin.filter((entry) => entry.startsWith('opencode-with-claude'));
    expect(pinned).toEqual(['opencode-with-claude@1.6.17']);
  });

  it('removes the DevRyan-pinned Claude dependencies and keeps user pins at other versions', async () => {
    const runtime = createRuntime();
    await runtime.provision();
    commands = [];
    const configDirectory = path.join(home, '.config', 'opencode');
    const packagePath = path.join(configDirectory, 'package.json');
    const packageJson = readJson(packagePath);
    packageJson.dependencies = {
      ...packageJson.dependencies,
      'opencode-with-claude': '1.11.2',
      '@rynfar/meridian': '1.79.0',
    };
    writeJson(packagePath, packageJson);

    const result = await runtime.provision();
    const retired = readJson(packagePath).dependencies;

    expect(result.ok).toBe(true);
    expect(retired).not.toHaveProperty('opencode-with-claude');
    expect(retired).not.toHaveProperty('@rynfar/meridian');
    expect(commands).toEqual([{ command: 'bun', args: ['install', '--ignore-scripts'], cwd: configDirectory }]);

    const userHome = path.join(root, 'user-home');
    home = userHome;
    const userPackagePath = path.join(userHome, '.config', 'opencode', 'package.json');
    writeJson(userPackagePath, {
      dependencies: {
        '@rynfar/meridian': '1.56.0',
        'opencode-with-claude': '1.6.17',
        'user-plugin': '3.2.1',
      },
    });

    expect((await createRuntime().provision()).ok).toBe(true);
    expect(readJson(userPackagePath).dependencies).toMatchObject({
      '@rynfar/meridian': '1.56.0',
      'opencode-with-claude': '1.6.17',
      'user-plugin': '3.2.1',
    });
  });

  it('removes only the Claude overrides DevRyan pinned and keeps user overrides', async () => {
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
      '@anthropic-ai/claude-code': '2.1.214',
      'user-package': '4.0.0',
    });
    expect(packageJson.dependencies['@rynfar/meridian']).toBe('1.62.6');
  });

  it.each([
    ['0.2.140', '2.1.215'],
    ['0.2.141', '2.1.251'],
    ['0.2.141', '2.1.280'],
    ['0.2.141', '2.1.302'],
  ])('drops the retired managed Claude overrides %s / %s from an upgraded profile', async (agentSdk, claudeCode) => {
    const runtime = createRuntime();
    await runtime.provision();
    commands = [];
    const configDirectory = path.join(home, '.config', 'opencode');
    const packagePath = path.join(configDirectory, 'package.json');
    const packageJson = readJson(packagePath);
    packageJson.overrides = {
      '@anthropic-ai/claude-agent-sdk': agentSdk,
      '@anthropic-ai/claude-code': claudeCode,
    };
    writeJson(packagePath, packageJson);

    const result = await runtime.provision();

    expect(result.ok).toBe(true);
    expect(readJson(packagePath)).not.toHaveProperty('overrides');
    expect(commands).toEqual([{ command: 'bun', args: ['install', '--ignore-scripts'], cwd: configDirectory }]);

    commands = [];
    expect((await runtime.provision()).changed).toBe(false);
    expect(commands).toEqual([]);
  });

  it('does not reinstall for Claude packages left in node_modules by an earlier release', async () => {
    const runtime = createRuntime();
    await runtime.provision();
    commands = [];
    const configDirectory = path.join(home, '.config', 'opencode');
    writeJson(
      path.join(configDirectory, 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'),
      { name: '@anthropic-ai/claude-code', version: '2.1.215' },
    );

    const result = await runtime.provision();

    expect(result).toMatchObject({ ok: true, changed: false });
    expect(commands).toEqual([]);
  });

  it('adds a newly managed dependency to a modified package without losing user fields', async () => {
    const profileRoot = path.join(root, 'profile');
    fs.cpSync(DEFAULT_PROFILE_ROOT, profileRoot, { recursive: true });
    const profilePackagePath = path.join(profileRoot, 'package.json');
    const profilePackage = readJson(profilePackagePath);
    expect(profilePackage.dependencies).not.toHaveProperty('fixture-managed-dependency');

    const runtime = createRuntime({ profileRoot });
    await runtime.provision();

    const packagePath = path.join(home, '.config', 'opencode', 'package.json');
    const userPackage = readJson(packagePath);
    userPackage.private = false;
    userPackage.dependencies['user-plugin'] = '3.2.1';
    writeJson(packagePath, userPackage);

    profilePackage.dependencies['fixture-managed-dependency'] = '1.0.0';
    writeJson(profilePackagePath, profilePackage);
    const result = await runtime.provision();
    const upgraded = readJson(packagePath);

    expect(result.ok).toBe(true);
    expect(result.conflicts).not.toContain(packagePath);
    expect(upgraded.private).toBe(false);
    expect(upgraded.dependencies['user-plugin']).toBe('3.2.1');
    expect(upgraded.dependencies['fixture-managed-dependency']).toBe('1.0.0');
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

  it('retires the Slim adapter and its pinned package from a profile provisioned by an earlier release', async () => {
    const runtime = createRuntime();
    await runtime.provision();
    const configDir = path.join(home, '.config', 'opencode');
    const configPath = path.join(configDir, 'opencode.json');
    const packagePath = path.join(configDir, 'package.json');
    const manifestPath = path.join(configDir, '.devryan', 'user-profile-manifest.json');
    const adapterPath = path.join(configDir, 'plugins', 'devryan-oh-my-opencode-slim.mjs');
    const slimConfigPath = path.join(configDir, 'devryan-agents.jsonc');
    // DevRyan <= 2.1.1 wrote and tracked the adapter, pinned the package and registered it.
    const adapterContent = 'export default async () => ({});\n';
    fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
    fs.writeFileSync(adapterPath, adapterContent, 'utf8');
    const manifest = readJson(manifestPath);
    manifest.files['plugins/devryan-oh-my-opencode-slim.mjs'] = { hash: hashContent(adapterContent) };
    writeJson(manifestPath, manifest);
    const config = readJson(configPath);
    config.plugin = [...config.plugin.slice(0, 3), './plugins/devryan-oh-my-opencode-slim.mjs', ...config.plugin.slice(3)];
    writeJson(configPath, config);
    const stalePackage = readJson(packagePath);
    stalePackage.dependencies['oh-my-opencode-slim'] = '2.2.25';
    writeJson(packagePath, stalePackage);
    // The agent model routing stays with the user.
    const userSlimConfig = readJson(slimConfigPath);
    userSlimConfig.agents.orchestrator = { model: 'openai/gpt-5.6-sol', variant: 'high' };
    writeJson(slimConfigPath, userSlimConfig);
    const expectedSlimConfig = fs.readFileSync(slimConfigPath, 'utf8');

    const result = await runtime.provision();

    expect(result.ok).toBe(true);
    expect(readJson(configPath).plugin).not.toContain('./plugins/devryan-oh-my-opencode-slim.mjs');
    expect(readJson(packagePath).dependencies).not.toHaveProperty('oh-my-opencode-slim');
    expect(fs.existsSync(adapterPath)).toBe(false);
    expect(result.removed).toContain(adapterPath);
    expect(readJson(manifestPath).files).not.toHaveProperty('plugins/devryan-oh-my-opencode-slim.mjs');
    expect(fs.readFileSync(slimConfigPath, 'utf8')).toBe(expectedSlimConfig);
  });

  it('retires the Superpowers adapter from a profile provisioned by an earlier release', async () => {
    const runtime = createRuntime();
    await runtime.provision();
    const configDir = path.join(home, '.config', 'opencode');
    const configPath = path.join(configDir, 'opencode.json');
    const manifestPath = path.join(configDir, '.devryan', 'user-profile-manifest.json');
    const adapterPath = path.join(configDir, 'plugins', 'devryan-superpowers.mjs');
    const ownedSkillPath = path.join(configDir, 'skills', 'Superpowers', 'SKILL.md');
    // DevRyan <= 2.0.1 wrote and tracked the adapter and registered it in the profile.
    const adapterContent = 'export default async () => ({});\n';
    fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
    fs.writeFileSync(adapterPath, adapterContent, 'utf8');
    const manifest = readJson(manifestPath);
    manifest.files['plugins/devryan-superpowers.mjs'] = { hash: hashContent(adapterContent) };
    writeJson(manifestPath, manifest);
    const config = readJson(configPath);
    config.plugin = [...config.plugin.slice(0, 4), './plugins/devryan-superpowers.mjs', ...config.plugin.slice(4)];
    writeJson(configPath, config);
    fs.mkdirSync(path.dirname(ownedSkillPath), { recursive: true });
    fs.writeFileSync(ownedSkillPath, '---\nname: Superpowers\n---\nUser-owned skill.\n', 'utf8');

    const result = await runtime.provision();

    expect(result.ok).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(readJson(configPath).plugin).not.toContain('./plugins/devryan-superpowers.mjs');
    expect(fs.existsSync(adapterPath)).toBe(false);
    expect(result.removed).toContain(adapterPath);
    expect(readJson(manifestPath).files).not.toHaveProperty('plugins/devryan-superpowers.mjs');
    // The owner's skill folder is user data; DevRyan never removes it.
    expect(fs.readFileSync(ownedSkillPath, 'utf8')).toContain('User-owned skill.');
    expect(result.warnings.join('\n')).not.toMatch(/superpowers/i);
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
    const manifest = readJson(path.join(configDir, '.devryan', 'user-profile-manifest.json'));

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
    // A stale dependency range makes provisioning refresh the install while
    // every managed package is already on disk.
    const packagePath = path.join(configDirectory, 'package.json');
    const stalePackage = readJson(packagePath);
    stalePackage.dependencies['@ai-sdk/openai-compatible'] = '^2.0.40';
    writeJson(packagePath, stalePackage);

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

  it('retires the DevRyan-pinned Context Mode dependency and registrations from an existing profile', async () => {
    const runtime = createRuntime();
    await runtime.provision();
    const configDirectory = path.join(home, '.config', 'opencode');
    const configPath = path.join(configDirectory, 'opencode.json');
    const packagePath = path.join(configDirectory, 'package.json');
    const config = readJson(configPath);
    config.plugin = [
      ...config.plugin,
      './node_modules/context-mode/build/adapters/opencode/plugin.js',
      'context-mode@1.0.169',
    ];
    writeJson(configPath, config);
    const packageJson = readJson(packagePath);
    packageJson.dependencies = { ...packageJson.dependencies, 'context-mode': '1.0.169' };
    writeJson(packagePath, packageJson);
    const dataDirectory = path.join(home, '.config', 'opencode', 'context-mode-data');
    fs.mkdirSync(dataDirectory, { recursive: true });
    commands = [];

    const result = await runtime.provision();

    expect(result.ok).toBe(true);
    expect(JSON.stringify(readJson(configPath).plugin)).not.toContain('context-mode');
    expect(readJson(packagePath).dependencies).not.toHaveProperty('context-mode');
    // The dependency change must trigger an install so bun prunes the retired package.
    expect(commands.map(({ args }) => args)).toEqual([['install', '--ignore-scripts']]);
    // Leftover Context Mode data is user data and is never deleted.
    expect(fs.existsSync(dataDirectory)).toBe(true);
  });

  it('retires the DevRyan-pinned Antigravity plugin and the Google models it wrote', async () => {
    const runtime = createRuntime();
    await runtime.provision();
    const configDirectory = path.join(home, '.config', 'opencode');
    const configPath = path.join(configDirectory, 'opencode.json');
    const packagePath = path.join(configDirectory, 'package.json');
    const legacyConfigPath = path.join(configDirectory, 'config.json');
    const config = readJson(configPath);
    config.plugin = [...config.plugin, './node_modules/opencode-antigravity-auth/dist/index.js'];
    config.provider = {
      google: {
        options: { timeout: 1000 },
        models: {
          'antigravity-gemini-3-pro': { name: 'Gemini 3 Pro (Antigravity)' },
          'gemini-2.5-pro': { name: 'Gemini 2.5 Pro (Gemini CLI)' },
          'my-gemini': { name: 'My Gemini' },
        },
      },
    };
    writeJson(configPath, config);
    const packageJson = readJson(packagePath);
    packageJson.dependencies = { ...packageJson.dependencies, 'opencode-antigravity-auth': '1.6.0' };
    writeJson(packagePath, packageJson);
    fs.writeFileSync(
      legacyConfigPath,
      '{\n  // keep this comment\n  "provider": {\n    "google": { "models": { "gemini-3-pro-preview": { "name": "Gemini 3 Pro Preview (Gemini CLI)" } } },\n    "anthropic": { "options": {} }\n  }\n}\n',
      'utf8',
    );
    commands = [];

    const result = await runtime.provision();

    expect(result.ok).toBe(true);
    const retired = readJson(configPath);
    expect(JSON.stringify(retired.plugin)).not.toContain('antigravity');
    // User-authored Google models and options survive; only plugin-written ones go.
    expect(retired.provider).toEqual({
      google: { options: { timeout: 1000 }, models: { 'my-gemini': { name: 'My Gemini' } } },
    });
    expect(readJson(packagePath).dependencies).not.toHaveProperty('opencode-antigravity-auth');
    expect(commands.map(({ args }) => args)).toEqual([['install', '--ignore-scripts']]);
    const legacySource = fs.readFileSync(legacyConfigPath, 'utf8');
    expect(legacySource).toContain('// keep this comment');
    expect(legacySource).not.toContain('google');
    expect(legacySource).toContain('anthropic');

    commands = [];
    const second = await runtime.provision();
    expect(second.ok).toBe(true);
    expect(JSON.stringify(readJson(configPath).plugin)).not.toContain('antigravity');
    expect(commands).toEqual([]);
  });

  it('keeps a user-owned Antigravity dependency at a version DevRyan never pinned', async () => {
    const runtime = createRuntime();
    await runtime.provision();
    const packagePath = path.join(home, '.config', 'opencode', 'package.json');
    const packageJson = readJson(packagePath);
    packageJson.dependencies = { ...packageJson.dependencies, 'opencode-antigravity-auth': '2.0.0' };
    writeJson(packagePath, packageJson);

    const result = await runtime.provision();

    expect(result.ok).toBe(true);
    expect(readJson(packagePath).dependencies['opencode-antigravity-auth']).toBe('2.0.0');
  });

  it('keeps a user-owned Context Mode dependency at a version DevRyan never pinned', async () => {
    const runtime = createRuntime();
    await runtime.provision();
    const packagePath = path.join(home, '.config', 'opencode', 'package.json');
    const packageJson = readJson(packagePath);
    packageJson.dependencies = { ...packageJson.dependencies, 'context-mode': '1.1.0' };
    writeJson(packagePath, packageJson);

    const result = await runtime.provision();

    expect(result.ok).toBe(true);
    expect(readJson(packagePath).dependencies['context-mode']).toBe('1.1.0');
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
        pluginId: 'opencode-gpt-imagegen',
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
