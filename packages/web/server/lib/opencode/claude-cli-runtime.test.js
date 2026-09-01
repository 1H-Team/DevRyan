import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveClaudeCodeLaunch } from './claude-cli-runtime.js';

const temporaryDirectories = [];
const makeDirectory = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-claude-cli-'));
  temporaryDirectories.push(directory);
  return directory;
};
const makeExecutable = (filePath) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '#!/usr/bin/env node\n', { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('resolveClaudeCodeLaunch', () => {
  it('prefers an explicit executable over managed and PATH candidates', () => {
    const root = makeDirectory();
    const explicit = path.join(root, 'explicit', 'claude');
    const managed = path.join(root, 'config', 'node_modules', '.bin', 'claude');
    const global = path.join(root, 'global', 'claude');
    [explicit, managed, global].forEach(makeExecutable);

    expect(resolveClaudeCodeLaunch({
      env: { CLAUDE_CODE_CLI: explicit, PATH: path.dirname(global) },
      pathValue: path.dirname(global),
      configDirectory: path.join(root, 'config'),
    })).toMatchObject({ executable: explicit, source: 'explicit' });
  });

  it('resolves the managed package bin before the augmented PATH', () => {
    const root = makeDirectory();
    const packageDirectory = path.join(root, 'config', 'node_modules', '@anthropic-ai', 'claude-code');
    const managed = path.join(packageDirectory, 'cli.js');
    const global = path.join(root, 'global', 'claude');
    makeExecutable(managed);
    makeExecutable(global);
    fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({ bin: { claude: 'cli.js' } }));

    expect(resolveClaudeCodeLaunch({
      env: { PATH: path.dirname(global) },
      pathValue: path.dirname(global),
      configDirectory: path.join(root, 'config'),
    })).toMatchObject({ executable: managed, source: 'managed' });
  });

  it('falls back to an absolute PATH entry and ignores relative entries', () => {
    const root = makeDirectory();
    const global = path.join(root, 'global', 'claude');
    makeExecutable(global);
    const pathValue = ['relative-bin', path.dirname(global)].join(path.delimiter);

    expect(resolveClaudeCodeLaunch({
      env: { PATH: pathValue },
      pathValue,
      configDirectory: path.join(root, 'missing'),
    })).toMatchObject({ executable: global, source: 'path' });
  });

  it('returns null for an invalid explicit override without silently changing sources', () => {
    const root = makeDirectory();
    const global = path.join(root, 'global', 'claude');
    makeExecutable(global);
    expect(resolveClaudeCodeLaunch({
      env: { CLAUDE_CODE_CLI: path.join(root, 'missing'), PATH: path.dirname(global) },
      pathValue: path.dirname(global),
      configDirectory: path.join(root, 'missing-config'),
    })).toBeNull();
  });

  it('resolves Windows command shims through PATHEXT', () => {
    const root = makeDirectory();
    const shim = path.join(root, 'config', 'node_modules', '.bin', 'claude.CMD');
    makeExecutable(shim);
    expect(resolveClaudeCodeLaunch({
      env: { PATH: '', PATHEXT: '.EXE;.CMD' },
      configDirectory: path.join(root, 'config'),
      platform: 'win32',
    })).toMatchObject({ executable: shim, source: 'managed' });
  });

  it('returns null when no valid executable exists', () => {
    expect(resolveClaudeCodeLaunch({
      env: { PATH: '' },
      pathValue: '',
      configDirectory: makeDirectory(),
    })).toBeNull();
  });
});
