import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_PROFILE_ROOT, createUserProfileProvisioningRuntime } from './user-profile-provisioning.js';
import { listDefaultConfigAssets } from './default-config-assets.js';
import { parseMdFile } from './shared.js';

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
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
      'opencode-antigravity-auth@latest',
      '@rama_nigg/open-cursor@latest',
      'cursor-acp',
      'opencode-with-claude@1.6.18',
      'context-mode@1.0.169',
      'superpowers@git+https://github.com/obra/superpowers.git',
      './plugins/devryan-oh-my-opencode-slim.mjs',
    ]);
    expect(config).not.toHaveProperty('mcp');
    expect(packageJson.dependencies).toMatchObject({
      '@ai-sdk/openai-compatible': '^2.0.47',
      '@opencode-ai/plugin': '1.17.11',
      '@rynfar/meridian': '1.57.0',
      'context-mode': '1.0.169',
      'oh-my-opencode-slim': '2.0.5',
      'opencode-with-claude': '1.6.18',
    });
    expect(JSON.stringify(slim)).not.toContain('"mcps"');
    expect(fs.existsSync(path.join(configDir, 'agents', 'orchestrator.md'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'plugins', 'devryan-oh-my-opencode-slim.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'node_modules', 'oh-my-opencode-slim'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'node_modules', 'opencode-with-claude'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'node_modules', 'context-mode'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'node_modules', '@rynfar', 'meridian'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'skills', 'agent-browser', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'skills', 'superpowers', 'README.md'))).toBe(true);
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
        if (relativePath === 'plugins/devryan-oh-my-opencode-slim.mjs') return [relativePath];
        if (relativePath.startsWith('user-profile/')) return [relativePath];
        return [];
      })
      .map((relativePath) => relativePath
        .replace(/^user-profile\//, '')
        .replace(/^plugins\//, 'plugins/'))
      .sort();
    const manifest = readJson(path.join(configDir, '.openchamber', 'user-profile-manifest.json'));

    expect(Object.keys(manifest.files).sort()).toEqual(expectedManagedFiles);
    for (const relativePath of expectedManagedFiles) {
      expect(fs.existsSync(path.join(configDir, relativePath))).toBe(true);
    }
  });

  it('ships canonical lowercase skill names that match their directories', async () => {
    const defaultConfigRoot = path.dirname(DEFAULT_PROFILE_ROOT);
    const skillAssets = (await listDefaultConfigAssets(defaultConfigRoot))
      .filter((relativePath) => (
        relativePath.startsWith('user-profile/skills/')
        && relativePath.endsWith('/SKILL.md')
      ));

    expect(skillAssets.length).toBeGreaterThan(0);
    for (const relativePath of skillAssets) {
      const skillPath = path.join(defaultConfigRoot, relativePath);
      const name = parseMdFile(skillPath).frontmatter.name;
      expect(name).toBe(path.basename(path.dirname(skillPath)));
      expect(name).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
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
    expect(preserved.warnings).toEqual([
      expect.stringContaining('both the Claude Code and client system prompts'),
    ]);
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
    expect(readJson(configPath).plugin).toContain('opencode-with-claude@1.6.18');
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

  it('updates untouched baseline files and removes untouched stale managed files', async () => {
    const profileRoot = path.join(root, 'profile');
    fs.cpSync(DEFAULT_PROFILE_ROOT, profileRoot, { recursive: true });
    const staleSource = path.join(profileRoot, 'skills', 'stale', 'SKILL.md');
    fs.mkdirSync(path.dirname(staleSource), { recursive: true });
    fs.writeFileSync(staleSource, 'managed stale skill\n', 'utf8');
    const runtime = createRuntime({ profileRoot });
    await runtime.provision();
    const configDir = path.join(home, '.config', 'opencode');
    const staleTarget = path.join(configDir, 'skills', 'stale', 'SKILL.md');
    const slimSource = path.join(profileRoot, 'oh-my-opencode-slim.json');
    const slim = readJson(slimSource);
    slim.preset = 'opencode-go';
    writeJson(slimSource, slim);
    fs.rmSync(path.join(profileRoot, 'skills', 'stale'), { recursive: true });

    const result = await runtime.provision();

    expect(readJson(path.join(configDir, 'oh-my-opencode-slim.json')).preset).toBe('opencode-go');
    expect(result.updated).toContain(path.join(configDir, 'oh-my-opencode-slim.json'));
    expect(result.removed).toContain(staleTarget);
    expect(fs.existsSync(staleTarget)).toBe(false);
  });

  it('upgrades an untouched managed skill name and preserves a user-modified conflict', async () => {
    const profileRoot = path.join(root, 'profile');
    fs.cpSync(DEFAULT_PROFILE_ROOT, profileRoot, { recursive: true });
    const sourceSkillPath = path.join(profileRoot, 'skills', 'frontend-design', 'SKILL.md');
    const titleCasedSource = fs.readFileSync(sourceSkillPath, 'utf8')
      .replace('name: frontend-design', 'name: Frontend Design');
    fs.writeFileSync(sourceSkillPath, titleCasedSource, 'utf8');
    const runtime = createRuntime({ profileRoot });
    await runtime.provision();

    const targetSkillPath = path.join(home, '.config', 'opencode', 'skills', 'frontend-design', 'SKILL.md');
    fs.writeFileSync(
      sourceSkillPath,
      titleCasedSource.replace('name: Frontend Design', 'name: frontend-design'),
      'utf8',
    );
    const upgraded = await runtime.provision();
    expect(parseMdFile(targetSkillPath).frontmatter.name).toBe('frontend-design');
    expect(upgraded.updated).toContain(targetSkillPath);

    fs.writeFileSync(targetSkillPath, 'user-owned skill change\n', 'utf8');
    fs.writeFileSync(
      sourceSkillPath,
      fs.readFileSync(sourceSkillPath, 'utf8').replace('description:', 'license: test\ndescription:'),
      'utf8',
    );
    const conflicted = await runtime.provision();
    expect(fs.readFileSync(targetSkillPath, 'utf8')).toBe('user-owned skill change\n');
    expect(conflicted.conflicts).toContain(targetSkillPath);
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
});
