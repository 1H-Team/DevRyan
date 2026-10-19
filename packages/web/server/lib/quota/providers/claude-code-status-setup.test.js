import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildClaudeCodeStatusLineScript,
  CLAUDE_CODE_STATUS_LINE_CUSTOM_CODE,
  ensureClaudeCodeStatusLineBridge,
  getManagedStatusLineCommand,
} from './claude-code-status-setup.js';

let tempDir = null;

const createPaths = () => {
  tempDir = mkdtempSync(join(tmpdir(), 'devryan-claude-status-setup-'));
  return {
    settingsPath: join(tempDir, '.claude', 'settings.json'),
    scriptPath: join(tempDir, '.cache', 'openchamber', 'claude-code-status-line.sh'),
    statusPath: join(tempDir, '.cache', 'openchamber', 'claude-code-status.json'),
  };
};

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('ensureClaudeCodeStatusLineBridge', () => {
  it('creates the managed script and Claude Code settings when no statusLine exists', () => {
    const paths = createPaths();

    const result = ensureClaudeCodeStatusLineBridge(paths);

    expect(result.ok).toBe(true);
    expect(result.status).toBe('installed');
    expect(existsSync(paths.scriptPath)).toBe(true);
    expect(statSync(paths.scriptPath).mode & 0o111).toBeGreaterThan(0);
    expect(readFileSync(paths.scriptPath, 'utf8')).toContain(paths.statusPath);
    expect(JSON.parse(readFileSync(paths.settingsPath, 'utf8'))).toEqual({
      statusLine: { type: 'command', command: getManagedStatusLineCommand({ scriptPath: paths.scriptPath }) },
    });
  });

  it('preserves unrelated Claude Code settings while adding the bridge', () => {
    const paths = createPaths();
    mkdirSync(join(tempDir, '.claude'), { recursive: true });
    writeFileSync(paths.settingsPath, JSON.stringify({ theme: 'dark' }, null, 2), 'utf8');

    const result = ensureClaudeCodeStatusLineBridge(paths);

    expect(result.ok).toBe(true);
    expect(JSON.parse(readFileSync(paths.settingsPath, 'utf8'))).toEqual({
      theme: 'dark',
      statusLine: { type: 'command', command: getManagedStatusLineCommand({ scriptPath: paths.scriptPath }) },
    });
  });

  it('does not overwrite an existing custom statusLine', () => {
    const paths = createPaths();
    const existingSettings = { statusLine: { type: 'command', command: 'custom-status-line' } };
    mkdirSync(join(tempDir, '.claude'), { recursive: true });
    writeFileSync(paths.settingsPath, JSON.stringify(existingSettings, null, 2), 'utf8');

    const result = ensureClaudeCodeStatusLineBridge(paths);

    expect(result.ok).toBe(false);
    expect(result.code).toBe(CLAUDE_CODE_STATUS_LINE_CUSTOM_CODE);
    expect(JSON.parse(readFileSync(paths.settingsPath, 'utf8'))).toEqual(existingSettings);
  });

  it('quotes managed command and status path safely for shell usage', () => {
    const scriptPath = "/tmp/Claude's Dir/status line.sh";
    const statusPath = "/tmp/Claude's Dir/status file.json";

    expect(getManagedStatusLineCommand({ scriptPath })).toBe("'/tmp/Claude'\\''s Dir/status line.sh'");
    expect(buildClaudeCodeStatusLineScript({ statusPath })).toContain("STATUS_PATH='/tmp/Claude'\\''s Dir/status file.json'");
  });
});
