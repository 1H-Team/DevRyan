import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createGlobalAgentsMdRuntime,
  MAX_GLOBAL_AGENTS_MD_BYTES,
} from './globalAgentsMdRuntime';

const tempRoots = new Set<string>();

const makeRuntime = async (
  overrides: Partial<Parameters<typeof createGlobalAgentsMdRuntime>[0]> = {},
) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-vscode-global-agents-md-'));
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

describe('VS Code global AGENTS.md runtime', () => {
  it('returns an empty editable state when the file does not exist', async () => {
    const { runtime } = await makeRuntime();

    await expect(runtime.read()).resolves.toEqual({ content: '', exists: false, editable: true });
  });

  it('reads existing instructions unchanged', async () => {
    const { agentsMdPath, runtime } = await makeRuntime();
    await fs.mkdir(path.dirname(agentsMdPath), { recursive: true });
    await fs.writeFile(agentsMdPath, '# Existing\n', 'utf8');

    await expect(runtime.read()).resolves.toEqual({
      content: '# Existing\n',
      exists: true,
      editable: true,
    });
  });

  it('writes normalized markdown before refreshing OpenCode', async () => {
    const readsDuringRefresh: string[] = [];
    const { agentsMdPath, runtime } = await makeRuntime({
      refreshRuntime: async () => {
        readsDuringRefresh.push(await fs.readFile(agentsMdPath, 'utf8'));
      },
    });

    await expect(runtime.save('# Rule')).resolves.toEqual({
      success: true,
      content: '# Rule\n',
      exists: true,
      editable: true,
      runtimeApplied: true,
    });
    expect(readsDuringRefresh).toEqual(['# Rule\n']);
  });

  it('removes the file for whitespace-only content and refreshes OpenCode', async () => {
    const { agentsMdPath, refreshRuntime, runtime } = await makeRuntime();
    await fs.mkdir(path.dirname(agentsMdPath), { recursive: true });
    await fs.writeFile(agentsMdPath, '# Remove\n', 'utf8');

    await expect(runtime.save('\n  \t')).resolves.toMatchObject({
      content: '',
      exists: false,
      runtimeApplied: true,
    });
    await expect(fs.stat(agentsMdPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(refreshRuntime).toHaveBeenCalledTimes(1);
  });

  it('enforces the normalized UTF-8 byte limit without changing the file', async () => {
    const { agentsMdPath, refreshRuntime, runtime } = await makeRuntime();
    await fs.mkdir(path.dirname(agentsMdPath), { recursive: true });
    await fs.writeFile(agentsMdPath, '# Existing\n', 'utf8');

    await expect(runtime.save('é'.repeat(MAX_GLOBAL_AGENTS_MD_BYTES / 2))).rejects.toMatchObject({
      statusCode: 413,
    });
    await expect(fs.readFile(agentsMdPath, 'utf8')).resolves.toBe('# Existing\n');
    expect(refreshRuntime).not.toHaveBeenCalled();
  });

  it('does not report success when persistence fails', async () => {
    const { root } = await makeRuntime();
    const blockingFile = path.join(root, 'not-a-directory');
    await fs.writeFile(blockingFile, 'blocking', 'utf8');
    const runtime = createGlobalAgentsMdRuntime({
      agentsMdPath: path.join(blockingFile, 'AGENTS.md'),
      refreshRuntime: async () => undefined,
      isEditable: () => true,
    });

    await expect(runtime.save('# Cannot write')).rejects.toBeTruthy();
  });

  it('preserves saved content and returns a warning when restart fails', async () => {
    const { agentsMdPath, runtime } = await makeRuntime({
      refreshRuntime: async () => {
        throw new Error('restart failed');
      },
    });

    await expect(runtime.save('# Saved')).resolves.toEqual({
      success: true,
      content: '# Saved\n',
      exists: true,
      editable: true,
      runtimeApplied: false,
      warning: 'Global AGENTS.md was saved, but OpenCode could not reload it automatically: restart failed',
    });
    await expect(fs.readFile(agentsMdPath, 'utf8')).resolves.toBe('# Saved\n');
  });

  it('is read-only and leaves local files untouched for external runtimes', async () => {
    const { agentsMdPath } = await makeRuntime();
    await fs.mkdir(path.dirname(agentsMdPath), { recursive: true });
    await fs.writeFile(agentsMdPath, '# Local\n', 'utf8');
    const runtime = createGlobalAgentsMdRuntime({
      agentsMdPath,
      refreshRuntime: async () => undefined,
      isEditable: () => false,
    });

    await expect(runtime.read()).resolves.toMatchObject({ editable: false, exists: false, content: '' });
    await expect(runtime.save('# Remote')).rejects.toMatchObject({ statusCode: 409 });
    await expect(fs.readFile(agentsMdPath, 'utf8')).resolves.toBe('# Local\n');
  });
});
