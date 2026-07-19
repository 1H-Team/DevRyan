import { EventEmitter } from 'events';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach } from 'vitest';
import { describe, expect, it } from 'vitest';

import {
  CLAUDE_CODE_REFRESH_FAILED_CODE,
  CLAUDE_CODE_SESSION_LIMIT_CODE,
  refreshClaudeCodeStatusUsage,
} from './claude-code-status-refresh.js';

const createChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
};

let tempDir = null;

const createStatusPath = () => {
  tempDir = mkdtempSync(join(tmpdir(), 'openchamber-claude-refresh-'));
  return join(tempDir, 'status.json');
};

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('refreshClaudeCodeStatusUsage', () => {
  it('runs Claude CLI print mode to force a status-line usage refresh', async () => {
    const child = createChild();
    const statusPath = createStatusPath();
    const calls = [];
    const spawnImpl = (command, args, options) => {
      calls.push({ command, args, options });
      queueMicrotask(() => {
        writeFileSync(statusPath, '{}', 'utf8');
        child.emit('close', 0);
      });
      return child;
    };

    const result = await refreshClaudeCodeStatusUsage({ spawnImpl, statusPath });

    expect(result).toEqual({ ok: true });
    expect(calls[0].command).toBe('claude');
    expect(calls[0].args).toEqual(['-p', 'Reply with exactly: OK', '--output-format', 'text']);
    expect(calls[0].options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('returns a deterministic error when Claude CLI exits without fresh status data', async () => {
    const child = createChild();
    const statusPath = createStatusPath();
    const spawnImpl = () => {
      queueMicrotask(() => child.emit('close', 0));
      return child;
    };

    const result = await refreshClaudeCodeStatusUsage({ spawnImpl, statusPath, statusWaitMs: 1 });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(CLAUDE_CODE_REFRESH_FAILED_CODE);
    expect(result.error).toContain('did not emit fresh usage data');
  });

  it('returns a deterministic error when Claude CLI is missing', async () => {
    const child = createChild();
    const spawnImpl = () => {
      queueMicrotask(() => child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })));
      return child;
    };

    const result = await refreshClaudeCodeStatusUsage({ spawnImpl });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(CLAUDE_CODE_REFRESH_FAILED_CODE);
    expect(result.error).toContain('Claude Code was not found');
  });

  it('includes stderr when Claude CLI exits unsuccessfully', async () => {
    const child = createChild();
    const spawnImpl = () => {
      queueMicrotask(() => {
        child.stderr.emit('data', 'not authenticated');
        child.emit('close', 1);
      });
      return child;
    };

    const result = await refreshClaudeCodeStatusUsage({ spawnImpl });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(CLAUDE_CODE_REFRESH_FAILED_CODE);
    expect(result.error).toBe('not authenticated');
  });

  it('classifies a Claude Code session limit reported on stdout', async () => {
    const child = createChild();
    const spawnImpl = () => {
      queueMicrotask(() => {
        child.stdout.emit('data', "You've hit your session limit · resets 2:10am");
        child.emit('close', 1);
      });
      return child;
    };

    const result = await refreshClaudeCodeStatusUsage({ spawnImpl });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(CLAUDE_CODE_SESSION_LIMIT_CODE);
    expect(result.error).toContain('session limit');
  });
});
