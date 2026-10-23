import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempHome;
let originalHome;

const writeJson = (filePath, data) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
};

const loadMcpSourcesModule = async () => {
  vi.resetModules();
  return import('./mcp-sources.js');
};

describe('MCP source helpers', () => {
  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-mcp-sources-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
    vi.resetModules();
  });

  it('defaults clean project MCP writes to the project .opencode config', async () => {
    const projectDir = path.join(tempHome, 'project');
    const { getProjectMcpWritePath } = await loadMcpSourcesModule();

    expect(getProjectMcpWritePath(projectDir)).toBe(path.join(projectDir, '.opencode', 'opencode.json'));
  });

  it('prefers existing project .opencode MCP config over root project config for writes', async () => {
    const projectDir = path.join(tempHome, 'project');
    const legacyPath = path.join(projectDir, '.opencode', 'opencode.json');
    const rootPath = path.join(projectDir, 'opencode.json');
    writeJson(rootPath, { mcp: { root: { type: 'local', command: ['root'] } } });
    writeJson(legacyPath, { mcp: { legacy: { type: 'local', command: ['legacy'] } } });

    const { getProjectMcpWritePath } = await loadMcpSourcesModule();

    expect(getProjectMcpWritePath(projectDir)).toBe(legacyPath);
  });

  it('uses an existing root project MCP config when no .opencode config exists', async () => {
    const projectDir = path.join(tempHome, 'project');
    const rootPath = path.join(projectDir, 'opencode.json');
    writeJson(rootPath, { mcp: { root: { type: 'local', command: ['root'] } } });

    const { getProjectMcpWritePath } = await loadMcpSourcesModule();

    expect(getProjectMcpWritePath(projectDir)).toBe(rootPath);
  });

  it('lists parent folder configs as active sources in OpenCode order', async () => {
    const workspace = path.join(tempHome, 'workspace');
    const projectDir = path.join(workspace, 'project');
    writeJson(path.join(workspace, 'opencode.json'), { mcp: {} });
    writeJson(path.join(workspace, '.opencode', 'opencode.json'), { mcp: {} });
    // The global config folder's own files are never a parent folder source.
    writeJson(path.join(tempHome, '.config', 'opencode', 'opencode.json'), { mcp: {} });

    const { describeMcpSource, getActiveMcpSources } = await loadMcpSourcesModule();
    const projectSources = getActiveMcpSources(projectDir)
      .map(describeMcpSource)
      .filter((source) => source.kind !== 'user' && source.kind !== 'user-legacy' && source.kind !== 'custom')
      .map((source) => [path.relative(tempHome, source.path), source.kind, source.scope, path.relative(tempHome, source.targetPath)]);

    expect(projectSources).toEqual([
      ['workspace/opencode.json', 'folder', 'user', 'workspace/opencode.json'],
      ['workspace/project/opencode.json', 'project', 'project', 'workspace/project/.opencode/opencode.json'],
      ['workspace/project/opencode.jsonc', 'project', 'project', 'workspace/project/.opencode/opencode.json'],
      ['workspace/.opencode/opencode.json', 'folder', 'user', 'workspace/.opencode/opencode.json'],
      ['workspace/project/.opencode/opencode.json', 'project-legacy', 'project', 'workspace/project/.opencode/opencode.json'],
      ['workspace/project/.opencode/opencode.jsonc', 'project-legacy', 'project', 'workspace/project/.opencode/opencode.json'],
    ]);
  });

  it('does not list home .opencode MCP config as an active user-scoped source', async () => {
    const homePath = path.join(tempHome, '.opencode', 'opencode.json');
    writeJson(homePath, {
      mcp: {
        home: { type: 'remote', url: 'https://home.example.test/mcp' },
      },
    });

    const { describeMcpSource, getActiveMcpSources } = await loadMcpSourcesModule();
    const sources = getActiveMcpSources().map(describeMcpSource);

    expect(sources).not.toContainEqual({
      path: homePath,
      scope: 'user',
      kind: 'user-home',
      active: true,
      recoverable: false,
      targetPath: path.join(tempHome, '.config', 'opencode', 'opencode.json'),
      origin: 'opencode',
    });
  });
});
