import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createGlobalAgentsMdRuntime,
  MAX_GLOBAL_AGENTS_MD_BYTES,
} from './global-agents-md-runtime.js';

const tempRoots = new Set();

const makeRuntime = async (overrides = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-global-agents-md-'));
  tempRoots.add(root);
  const agentsMdPath = path.join(root, '.config', 'opencode', 'AGENTS.md');
  const refreshRuntime = vi.fn(async () => undefined);
  const runtime = createGlobalAgentsMdRuntime({
    agentsMdPath,
    refreshRuntime,
    isEditable: () => true,
    ...overrides,
  });
  return { root, agentsMdPath, refreshRuntime, runtime };
};

afterEach(async () => {
  await Promise.all(Array.from(tempRoots, (root) => fs.rm(root, { recursive: true, force: true })));
  tempRoots.clear();
});

describe('global AGENTS.md runtime', () => {
  it('returns an empty editable state when the file does not exist', async () => {
    const { runtime } = await makeRuntime();

    await expect(runtime.read()).resolves.toEqual({
      content: '',
      exists: false,
      editable: true,
    });
  });

  it('reads existing instructions without changing their content', async () => {
    const { agentsMdPath, runtime } = await makeRuntime();
    await fs.mkdir(path.dirname(agentsMdPath), { recursive: true });
    await fs.writeFile(agentsMdPath, '# Existing\n\nKeep this exact.\n', 'utf8');

    await expect(runtime.read()).resolves.toEqual({
      content: '# Existing\n\nKeep this exact.\n',
      exists: true,
      editable: true,
    });
  });

  it('writes non-empty markdown with a final newline before refreshing OpenCode', async () => {
    const callOrder = [];
    const { agentsMdPath, runtime } = await makeRuntime({
      refreshRuntime: vi.fn(async () => {
        callOrder.push(await fs.readFile(agentsMdPath, 'utf8'));
      }),
    });

    await expect(runtime.save('# Global rule')).resolves.toEqual({
      success: true,
      content: '# Global rule\n',
      exists: true,
      editable: true,
      runtimeApplied: false,
    });
    expect(callOrder).toEqual(['# Global rule\n']);
    await expect(fs.readFile(agentsMdPath, 'utf8')).resolves.toBe('# Global rule\n');
  });

  it('removes the file for whitespace-only content and still refreshes OpenCode', async () => {
    const { agentsMdPath, refreshRuntime, runtime } = await makeRuntime();
    await fs.mkdir(path.dirname(agentsMdPath), { recursive: true });
    await fs.writeFile(agentsMdPath, '# Remove me\n', 'utf8');

    await expect(runtime.save(' \n\t ')).resolves.toEqual({
      success: true,
      content: '',
      exists: false,
      editable: true,
      runtimeApplied: false,
    });
    await expect(fs.stat(agentsMdPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(refreshRuntime).toHaveBeenCalledTimes(1);
  });

  it('rejects normalized UTF-8 content over one MiB without changing the file', async () => {
    const { agentsMdPath, refreshRuntime, runtime } = await makeRuntime();
    await fs.mkdir(path.dirname(agentsMdPath), { recursive: true });
    await fs.writeFile(agentsMdPath, '# Existing\n', 'utf8');
    const overLimit = 'é'.repeat(MAX_GLOBAL_AGENTS_MD_BYTES / 2);

    await expect(runtime.save(overLimit)).rejects.toMatchObject({
      statusCode: 413,
    });
    await expect(fs.readFile(agentsMdPath, 'utf8')).resolves.toBe('# Existing\n');
    expect(refreshRuntime).not.toHaveBeenCalled();
  });

  it('does not report success when the filesystem write fails', async () => {
    const { root } = await makeRuntime();
    const blockingFile = path.join(root, 'not-a-directory');
    await fs.writeFile(blockingFile, 'blocking', 'utf8');
    const runtime = createGlobalAgentsMdRuntime({
      agentsMdPath: path.join(blockingFile, 'AGENTS.md'),
      refreshRuntime: vi.fn(async () => undefined),
      isEditable: () => true,
    });

    await expect(runtime.save('# Cannot write')).rejects.toBeTruthy();
  });

  it('returns persisted success with a warning when runtime refresh fails', async () => {
    const { agentsMdPath, runtime } = await makeRuntime({
      refreshRuntime: vi.fn(async () => {
        throw new Error('restart failed');
      }),
    });

    await expect(runtime.save('# Saved anyway')).resolves.toEqual({
      success: true,
      content: '# Saved anyway\n',
      exists: true,
      editable: true,
      runtimeApplied: false,
      warning: 'Global AGENTS.md was saved, but the apply request could not be recorded: restart failed',
    });
    await expect(fs.readFile(agentsMdPath, 'utf8')).resolves.toBe('# Saved anyway\n');
  });

  it('does not read or mutate the local file for an external runtime', async () => {
    const { agentsMdPath } = await makeRuntime();
    await fs.mkdir(path.dirname(agentsMdPath), { recursive: true });
    await fs.writeFile(agentsMdPath, '# Local only\n', 'utf8');
    const runtime = createGlobalAgentsMdRuntime({
      agentsMdPath,
      refreshRuntime: vi.fn(async () => undefined),
      isEditable: () => false,
    });

    await expect(runtime.read()).resolves.toEqual({
      content: '',
      exists: false,
      editable: false,
      unavailableReason: 'Global AGENTS.md can only be edited for a locally managed OpenCode runtime.',
    });
    await expect(runtime.save('# Remote rule')).rejects.toMatchObject({ statusCode: 409 });
    await expect(fs.readFile(agentsMdPath, 'utf8')).resolves.toBe('# Local only\n');
  });
});
