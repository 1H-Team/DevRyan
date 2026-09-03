import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { createWorkspaceGateway } from './workspace.js';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true,
  })));
});

const fixture = async (fetchImpl) => {
  const scratchDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-computer-files-'));
  directories.push(scratchDirectory);
  return {
    scratchDirectory,
    workspace: createWorkspaceGateway({
      scratchDirectory,
      gatewayUrl: 'http://egress:43121',
      runtimeToken: 'runtime-token-0123456789abcdef0123456789',
      fetchImpl,
    }),
  };
};

describe('gateway-only computer file transfer', () => {
  test('stages a private artifact in scratch without accepting a caller path', async () => {
    const calls = [];
    const { workspace, scratchDirectory } = await fixture(async (url, options) => {
      calls.push({
        url: url.toString(),
        options: { ...options, body: options.body ? Buffer.from(options.body) : options.body },
      });
      return new Response('private upload', { status: 200 });
    });
    const result = await workspace.stageUpload({ artifactId: 'artifact-01', filename: 'input.txt' });
    expect(result.path).toBe(path.join(scratchDirectory, 'input.txt'));
    expect(await fs.readFile(result.path, 'utf8')).toBe('private upload');
    expect(calls[0].url).toContain('/api/bots/private/artifacts/artifact-01/content');
    expect(calls[0].options.redirect).toBe('error');
    expect(calls[0].options.signal).toBeInstanceOf(AbortSignal);
    await expect(workspace.stageUpload({ artifactId: 'artifact-01', filename: '../escape' }))
      .rejects.toMatchObject({ code: 'DEVRYAN_BOT_FILE_INVALID' });
  });

  test('publishes a scratch download through the authenticated object gateway', async () => {
    const calls = [];
    const { workspace, scratchDirectory } = await fixture(async (url, options) => {
      calls.push({
        url: url.toString(),
        options: { ...options, body: Buffer.from(options.body) },
      });
      return new Response(JSON.stringify({ ok: true, artifact: { id: 'artifact-02' } }), {
        status: 201,
      });
    });
    await fs.writeFile(path.join(scratchDirectory, 'download.txt'), 'download bytes');
    const result = await workspace.publishDownload({ filename: 'download.txt' });
    expect(result).toEqual({ artifactId: 'artifact-02', filename: 'download.txt', size: 14 });
    expect(calls[0].options.headers.authorization).toStartWith('Bearer ');
    expect(calls[0].options.redirect).toBe('error');
    expect(calls[0].options.signal).toBeInstanceOf(AbortSignal);
    expect(Buffer.from(calls[0].options.body).toString('utf8')).toBe('download bytes');
  });

  test('bounds object-gateway metadata responses', async () => {
    const { workspace, scratchDirectory } = await fixture(async () => new Response(
      JSON.stringify({ padding: 'x'.repeat(70 * 1024) }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    ));
    await fs.writeFile(path.join(scratchDirectory, 'download.txt'), 'download bytes');
    await expect(workspace.publishDownload({ filename: 'download.txt' })).rejects.toMatchObject({
      code: 'DEVRYAN_BOT_FILE_GATEWAY_INVALID',
    });
  });
});
