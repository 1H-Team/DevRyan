import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const vscodeState = vi.hoisted(() => ({ workspaceRoot: '' }));

vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() {
      return vscodeState.workspaceRoot
        ? [{ uri: { fsPath: vscodeState.workspaceRoot } }]
        : undefined;
    },
  },
}));

import { tryHandleLocalFsProxy } from './bridge-localfs-proxy-runtime';

let testRoot = '';
let workspaceRoot = '';
let outsideImage = '';

beforeAll(async () => {
  testRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'devryan-vscode-images-'));
  workspaceRoot = path.join(testRoot, 'workspace');
  outsideImage = path.join(testRoot, 'outside.png');
  await fs.promises.mkdir(path.join(workspaceRoot, 'art'), { recursive: true });
  await fs.promises.writeFile(path.join(workspaceRoot, 'art', 'inside.png'), Buffer.from([1, 2, 3]));
  await fs.promises.writeFile(outsideImage, Buffer.from([4, 5, 6]));
  vscodeState.workspaceRoot = workspaceRoot;
});

afterAll(async () => {
  vscodeState.workspaceRoot = '';
  if (testRoot) await fs.promises.rm(testRoot, { recursive: true, force: true });
});

describe('VS Code assistant image bridge', () => {
  test('serves a workspace-contained image through the local raw bridge', async () => {
    const query = new URLSearchParams({
      path: 'art/inside.png',
      directory: workspaceRoot,
      assistantImage: '1',
    });
    const response = await tryHandleLocalFsProxy('GET', `/api/fs/raw?${query}`);

    expect(response?.status).toBe(200);
    expect(response?.headers['content-type']).toBe('image/png');
    expect(Buffer.from(response?.bodyBase64 || '', 'base64')).toEqual(Buffer.from([1, 2, 3]));
  });

  test('rejects out-of-workspace images and does not honor a server asset grant', async () => {
    const query = new URLSearchParams({
      path: outsideImage,
      directory: workspaceRoot,
      assistantImage: '1',
      assetGrant: 'server-grants-are-not-forwarded',
    });
    const response = await tryHandleLocalFsProxy('GET', `/api/fs/raw?${query}`);

    expect(response?.status).toBe(403);
    expect(Buffer.from(response?.bodyBase64 || '', 'base64').toString('utf8')).toContain('Workspace image is unavailable');
  });

  test('rejects a mismatched directory hint before reading the file', async () => {
    const query = new URLSearchParams({
      path: path.join(workspaceRoot, 'art', 'inside.png'),
      directory: path.join(testRoot, 'other-workspace'),
      assistantImage: '1',
    });
    const response = await tryHandleLocalFsProxy('GET', `/api/fs/raw?${query}`);

    expect(response?.status).toBe(403);
  });
});
