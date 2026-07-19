import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'fs/promises';

const vscodeFsMocks = vi.hoisted(() => ({
  createDirectory: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
  delete: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
}));
const osMocks = vi.hoisted(() => ({
  homedir: vi.fn(),
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    homedir: osMocks.homedir,
  };
});

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: undefined,
    fs: vscodeFsMocks,
    findFiles: vi.fn(async () => []),
    getConfiguration: vi.fn(() => ({ get: vi.fn() })),
  },
  window: {
    showOpenDialog: vi.fn(async () => undefined),
    showSaveDialog: vi.fn(async () => undefined),
  },
  Uri: {
    file: (value) => ({ fsPath: value, path: value }),
    joinPath: (base, name) => ({ fsPath: path.join(base.fsPath, name), path: path.join(base.fsPath, name) }),
    parse: (value) => ({ fsPath: value, path: value, scheme: 'file' }),
  },
  FileType: { Directory: 2, File: 1 },
  commands: { executeCommand: vi.fn(async () => {}) },
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    exec: vi.fn(),
  };
});

const { handleFsBridgeMessage } = await import('./bridge-fs-runtime');
const {
  resolveFileMutationPath,
  resolveExecCwdPath,
  resolveUserPath,
  listDirectoryEntries,
  normalizeFsPath,
  searchDirectory,
  resolveFileReadPath,
  parseDroppedFileReference,
  readUriAsAttachment,
} = await import('./bridge-fs-helpers-runtime');
const vscode = await import('vscode');

const createDeps = () => ({
  resolveUserPath,
  listDirectoryEntries,
  normalizeFsPath,
  execGit: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
  searchDirectory: vi.fn(async () => []),
  resolveFileReadPath,
  resolveFileMutationPath,
  resolveExecCwdPath,
  parseDroppedFileReference,
  readUriAsAttachment: vi.fn(),
});

describe('handleFsBridgeMessage mutation safety', () => {
  let workspace = '';
  let outsideDir = '';
  let fakeHome = '';
  let cleanup = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    workspace = await mkdtemp(path.join(os.tmpdir(), 'devryan-vscode-workspace-'));
    outsideDir = await mkdtemp(path.join(os.tmpdir(), 'devryan-vscode-outside-'));
    fakeHome = await mkdtemp(path.join(os.tmpdir(), 'devryan-vscode-home-'));
    cleanup = [workspace, outsideDir, fakeHome];
    osMocks.homedir.mockReturnValue(fakeHome);
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: workspace } }];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('allows plan reads and writes only under the canonical OpenChamber config root', async () => {
    const configRoot = path.join(fakeHome, '.config', 'openchamber');
    const planPath = path.join(configRoot, 'projects', 'project-a', 'plans', 'plan.md');
    const otherHomePath = path.join(fakeHome, 'Documents', 'private.md');
    const deps = createDeps();

    const writeResponse = await handleFsBridgeMessage(
      { id: 'config-write', type: 'api:fs:write', payload: { path: planPath, content: '# Plan' } },
      deps,
    );
    expect(writeResponse?.error).toBeUndefined();
    expect(writeResponse?.success).toBe(true);
    expect(vscodeFsMocks.writeFile).toHaveBeenCalledOnce();

    const deniedResponse = await handleFsBridgeMessage(
      { id: 'home-write', type: 'api:fs:write', payload: { path: otherHomePath, content: 'nope' } },
      deps,
    );
    expect(deniedResponse?.success).toBe(false);

    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, '# Existing plan', 'utf8');
    const readResolution = await resolveFileReadPath(planPath);
    expect(readResolution).toMatchObject({ ok: true, resolvedPath: await fs.promises.realpath(planPath) });
  });

  it('rejects symlink escapes from the canonical OpenChamber config root', async () => {
    const configRoot = path.join(fakeHome, '.config', 'openchamber');
    await mkdir(configRoot, { recursive: true });
    const linkPath = path.join(configRoot, 'escape-link');
    await symlink(outsideDir, linkPath);

    const resolution = await resolveFileMutationPath(path.join(linkPath, 'plan.md'));
    expect(resolution).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects write/delete/rename/exec with direct outside-root paths', async () => {
    const outsideFile = path.join(outsideDir, 'outside.txt');
    await writeFile(outsideFile, 'outside', 'utf8');
    const deps = createDeps();

    const writeResponse = await handleFsBridgeMessage(
      { id: '1', type: 'api:fs:write', payload: { path: outsideFile, content: 'nope' } },
      deps,
    );
    expect(writeResponse?.success).toBe(false);
    expect(writeResponse?.error).toMatch(/outside of active workspace/i);

    const deleteResponse = await handleFsBridgeMessage(
      { id: '2', type: 'api:fs:delete', payload: { path: outsideFile } },
      deps,
    );
    expect(deleteResponse?.success).toBe(false);

    const renameResponse = await handleFsBridgeMessage(
      {
        id: '3',
        type: 'api:fs:rename',
        payload: { oldPath: outsideFile, newPath: path.join(outsideDir, 'renamed.txt') },
      },
      deps,
    );
    expect(renameResponse?.success).toBe(false);

    const execResponse = await handleFsBridgeMessage(
      { id: '4', type: 'api:fs:exec', payload: { cwd: outsideDir, commands: ['echo hi'] } },
      deps,
    );
    expect(execResponse?.success).toBe(false);

    expect(vscodeFsMocks.writeFile).not.toHaveBeenCalled();
    expect(vscodeFsMocks.delete).not.toHaveBeenCalled();
    expect(vscodeFsMocks.rename).not.toHaveBeenCalled();

    const { exec } = await import('child_process');
    expect(exec).not.toHaveBeenCalled();
  });

  it('rejects write/mkdir through a workspace symlink parent', async () => {
    const linkPath = path.join(workspace, 'escape-link');
    await symlink(outsideDir, linkPath);
    const deps = createDeps();

    const writeResponse = await handleFsBridgeMessage(
      {
        id: '5',
        type: 'api:fs:write',
        payload: { path: path.join(linkPath, 'escaped.txt'), content: 'escaped' },
      },
      deps,
    );
    expect(writeResponse?.success).toBe(false);
    expect(writeResponse?.error).toBe('Access denied');

    const mkdirResponse = await handleFsBridgeMessage(
      {
        id: '6',
        type: 'api:fs:mkdir',
        payload: { path: path.join(linkPath, 'nested') },
      },
      deps,
    );
    expect(mkdirResponse?.success).toBe(false);
    expect(vscodeFsMocks.writeFile).not.toHaveBeenCalled();
    expect(vscodeFsMocks.createDirectory).not.toHaveBeenCalled();
  });

  it('rejects delete/rename when symlink target realpaths outside the workspace', async () => {
    const outsideFile = path.join(outsideDir, 'victim.txt');
    await writeFile(outsideFile, 'untouched', 'utf8');
    const linkFile = path.join(workspace, 'victim-link');
    await symlink(outsideFile, linkFile);
    const deps = createDeps();

    const deleteResponse = await handleFsBridgeMessage(
      { id: '7', type: 'api:fs:delete', payload: { path: linkFile } },
      deps,
    );
    expect(deleteResponse?.success).toBe(false);
    expect(deleteResponse?.error).toBe('Access denied');

    const renameResponse = await handleFsBridgeMessage(
      {
        id: '8',
        type: 'api:fs:rename',
        payload: {
          oldPath: linkFile,
          newPath: path.join(workspace, 'renamed.txt'),
        },
      },
      deps,
    );
    expect(renameResponse?.success).toBe(false);

    expect(vscodeFsMocks.delete).not.toHaveBeenCalled();
    expect(vscodeFsMocks.rename).not.toHaveBeenCalled();
    expect(await readFile(outsideFile, 'utf8')).toBe('untouched');
  });

  it('reports markdown export cancellation without writing a file', async () => {
    vscode.window.showSaveDialog.mockResolvedValueOnce(undefined);

    const response = await handleFsBridgeMessage(
      {
        id: 'export-canceled',
        type: 'api:files/save-markdown',
        payload: { fileName: 'chat.md', content: '# Chat' },
      },
      createDeps(),
    );

    expect(response).toEqual({
      id: 'export-canceled',
      type: 'api:files/save-markdown',
      success: true,
      data: { saved: false, canceled: true },
    });
    expect(vscodeFsMocks.writeFile).not.toHaveBeenCalled();
  });

  it('writes exported markdown as UTF-8 and returns the selected path', async () => {
    const selectedPath = path.join(workspace, 'exports', 'chat.md');
    vscode.window.showSaveDialog.mockResolvedValueOnce({
      fsPath: selectedPath,
      path: selectedPath,
    });

    const response = await handleFsBridgeMessage(
      {
        id: 'export-saved',
        type: 'api:files/save-markdown',
        payload: { fileName: 'chat.md', content: '# Chat\n\nHello' },
      },
      createDeps(),
    );

    expect(response).toEqual({
      id: 'export-saved',
      type: 'api:files/save-markdown',
      success: true,
      data: { saved: true, path: selectedPath },
    });
    expect(vscodeFsMocks.writeFile).toHaveBeenCalledTimes(1);
    const [saveUri, bytes] = vscodeFsMocks.writeFile.mock.calls[0];
    expect(saveUri).toEqual({ fsPath: selectedPath, path: selectedPath });
    expect(Buffer.from(bytes).toString('utf8')).toBe('# Chat\n\nHello');
  });
});
