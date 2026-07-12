import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_PROFILE_ROOT, createUserProfileProvisioningRuntime } from './user-profile-provisioning.js';

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

    expect(result.ok).toBe(true);
    expect(config.plugin).toEqual([
      'opencode-antigravity-auth@latest',
      '@rama_nigg/open-cursor@latest',
      'cursor-acp',
      'opencode-with-claude',
      'superpowers@git+https://github.com/obra/superpowers.git',
      './plugins/devryan-oh-my-opencode-slim.mjs',
    ]);
    expect(config).not.toHaveProperty('mcp');
    expect(packageJson.dependencies).toMatchObject({
      '@ai-sdk/openai-compatible': '^2.0.47',
      '@opencode-ai/plugin': '1.17.11',
      'oh-my-opencode-slim': '2.0.5',
    });
    expect(JSON.stringify(slim)).not.toContain('"mcps"');
    expect(fs.existsSync(path.join(configDir, 'agents', 'orchestrator.md'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'plugins', 'devryan-oh-my-opencode-slim.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'skills', 'agent-browser', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'skills', 'superpowers', 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, '.openchamber', 'user-profile-manifest.json'))).toBe(true);
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
