import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fsPromises from 'node:fs/promises';
import nodeOs from 'node:os';
import path from 'node:path';
import request from 'supertest';

import { assistantImageSyntaxFixtures } from '../../../../shared-runtime/testing/assistant-image-fixtures.js';
import {
  MAX_IMAGE_BYTES,
  createImageAssetGrantStore,
  createImageAssetsRuntime,
  extractAuthorizedAssistantImageSources,
} from './runtime.js';

const PNG_HEADER = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const JPEG_HEADER = Buffer.from('ffd8ffe000104a464946', 'hex');

const temporaryDirectories = [];

const assistantMessage = ({ workspace, id = 'message-1', parts = [] }) => ({
  info: {
    id,
    sessionID: 'session-1',
    role: 'assistant',
    time: { created: 1, completed: 2 },
    path: { cwd: workspace, root: workspace },
  },
  parts,
});

const textPart = (text) => ({ id: 'text-1', type: 'text', text });
const imageToolPart = (source) => ({
  id: 'tool-image',
  type: 'tool',
  tool: 'gpt_imagegen',
  state: {
    status: 'completed',
    metadata: { out: source },
    time: { start: 1, end: 2 },
  },
});

const createHarness = ({ message, ownsSession = async () => true, now } = {}) => {
  const fetchImpl = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => message,
  }));
  let tokenCounter = 0;
  const runtime = createImageAssetsRuntime({
    fsPromises,
    path,
    os: { tmpdir: () => message.generatedRoot },
    crypto: { randomUUID: () => `grant-${++tokenCounter}` },
    buildOpenCodeUrl: (pathname) => `http://opencode.invalid${pathname}`,
    getOpenCodeAuthHeaders: () => ({ authorization: 'Bearer private' }),
    ownsSession,
    fetchImpl,
    ...(now ? { now } : {}),
  });
  const app = express();
  app.use((req, _res, next) => {
    const principalId = req.headers['x-test-principal'];
    if (typeof principalId === 'string') {
      req.principal = { id: principalId, scope: 'managed', role: 'developer' };
    }
    next();
  });
  runtime.registerRoutes(app);
  return { app, runtime, fetchImpl };
};

const postPrepare = (app, body, principal = 'user-1') => {
  const operation = request(app)
    .post('/api/devryan/sessions/session-1/image-assets/prepare')
    .send(body);
  return principal ? operation.set('x-test-principal', principal) : operation;
};

beforeEach(async () => {
  const root = await fsPromises.mkdtemp(path.join(nodeOs.tmpdir(), 'devryan-image-assets-'));
  temporaryDirectories.push(root);
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fsPromises.rm(directory, { recursive: true, force: true })
  )));
});

const createFixtureDirectories = async () => {
  const root = temporaryDirectories[temporaryDirectories.length - 1];
  const workspace = path.join(root, 'workspace');
  const generatedRoot = path.join(root, 'runtime-generated');
  const outside = path.join(root, 'outside');
  await Promise.all([
    fsPromises.mkdir(workspace, { recursive: true }),
    fsPromises.mkdir(generatedRoot, { recursive: true }),
    fsPromises.mkdir(outside, { recursive: true }),
  ]);
  return { root, workspace, generatedRoot, outside };
};

describe('assistant image source authorization parser', () => {
  for (const fixture of assistantImageSyntaxFixtures) {
    it(`matches shared golden syntax: ${fixture.name}`, () => {
      const message = assistantMessage({ workspace: '/workspace', parts: [textPart(fixture.markdown)] });
      expect(Array.from(extractAuthorizedAssistantImageSources(message).keys()))
        .toEqual(fixture.expected.map((entry) => entry.source));
    });
  }

  it('generalizes finalized metadata only for declared images or image-generation tools', () => {
    const message = assistantMessage({
      workspace: '/workspace',
      parts: [
        imageToolPart('/tmp/generated.png'),
        { ...imageToolPart('/tmp/chart.webp'), id: 'mime-tool', tool: 'write', state: {
          ...imageToolPart('/tmp/chart.webp').state,
          metadata: { out: '/tmp/chart.webp', mimeType: 'image/webp' },
        } },
        { ...imageToolPart('/tmp/arbitrary.png'), id: 'arbitrary', tool: 'write' },
        { ...imageToolPart('/tmp/running.png'), id: 'running', state: {
          status: 'running', metadata: { out: '/tmp/running.png' }, time: { start: 1 },
        } },
      ],
    });
    expect(Array.from(extractAuthorizedAssistantImageSources(message).keys()))
      .toEqual(['/tmp/generated.png', '/tmp/chart.webp']);
  });
});

describe('message-scoped assistant image preparation', () => {
  it('requires a principal and session ownership before fetching the message', async () => {
    const directories = await createFixtureDirectories();
    const message = Object.assign(assistantMessage({ workspace: directories.workspace }), {
      generatedRoot: directories.generatedRoot,
    });
    const ownsSession = vi.fn(async () => false);
    const { app, fetchImpl } = createHarness({ message, ownsSession });

    expect((await postPrepare(app, { messageId: 'message-1', sources: ['image.png'] }, null)).status).toBe(401);
    expect((await postPrepare(app, { messageId: 'message-1', sources: ['image.png'] })).status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an authoritative message mismatch', async () => {
    const directories = await createFixtureDirectories();
    const message = Object.assign(assistantMessage({ workspace: directories.workspace, id: 'other-message' }), {
      generatedRoot: directories.generatedRoot,
    });
    const { app } = createHarness({ message });
    const response = await postPrepare(app, { messageId: 'message-1', sources: ['image.png'] });
    expect(response.status).toBe(404);
  });

  it('prepares workspace and generated temporary images without server-fetching remote sources', async () => {
    const directories = await createFixtureDirectories();
    const workspaceImage = path.join(directories.workspace, 'workspace.png');
    const generatedImage = path.join(directories.generatedRoot, 'generated.webp');
    await fsPromises.writeFile(workspaceImage, PNG_HEADER);
    await fsPromises.writeFile(generatedImage, Buffer.concat([
      Buffer.from('RIFF0000WEBP', 'ascii'),
      Buffer.from([0, 0, 0, 0]),
    ]));
    const remote = 'https://cdn.example/image.gif';
    const message = Object.assign(assistantMessage({
      workspace: directories.workspace,
      parts: [
        textPart(`![Workspace](<${workspaceImage}>) ![Remote](${remote})`),
        imageToolPart(generatedImage),
      ],
    }), { generatedRoot: directories.generatedRoot });
    const { app, runtime, fetchImpl } = createHarness({ message });

    const response = await postPrepare(app, {
      messageId: 'message-1',
      sources: [workspaceImage, generatedImage, remote],
    });

    expect(response.status).toBe(200);
    expect(response.body.results[0]).toMatchObject({
      source: workspaceImage,
      status: 'ready',
      mimeType: 'image/png',
      size: PNG_HEADER.length,
    });
    expect(response.body.results[0].url).not.toContain('assetGrant=');
    expect(response.body.results[1]).toMatchObject({
      source: generatedImage,
      status: 'ready',
      mimeType: 'image/webp',
    });
    expect(response.body.results[1].url).toContain('assetGrant=grant1');
    expect(response.body.results[2]).toEqual({
      source: remote,
      status: 'error',
      errorCode: 'REMOTE_SOURCE_UNSUPPORTED',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const grantUrl = new URL(response.body.results[1].url, 'https://devryan.invalid');
    expect(runtime.authorizeAssetGrant({
      token: grantUrl.searchParams.get('assetGrant'),
      principal: { id: 'user-1', scope: 'managed' },
      canonicalPath: await fsPromises.realpath(generatedImage),
    })).toBe(true);
  });

  it('rejects unreferenced, traversal, symlink escape, and directory sources', async () => {
    const directories = await createFixtureDirectories();
    const outsideImage = path.join(directories.outside, 'outside.png');
    const symlinkImage = path.join(directories.workspace, 'linked.png');
    const imageDirectory = path.join(directories.workspace, 'folder.png');
    await fsPromises.writeFile(outsideImage, PNG_HEADER);
    await fsPromises.symlink(outsideImage, symlinkImage);
    await fsPromises.mkdir(imageDirectory);
    const traversal = '../outside/outside.png';
    const message = Object.assign(assistantMessage({
      workspace: directories.workspace,
      parts: [textPart([
        `![Traversal](${traversal})`,
        `![Symlink](<${symlinkImage}>)`,
        `![Directory](<${imageDirectory}>)`,
      ].join('\n'))],
    }), { generatedRoot: directories.generatedRoot });
    const { app } = createHarness({ message });

    const response = await postPrepare(app, {
      messageId: 'message-1',
      sources: ['unreferenced.png', traversal, symlinkImage, imageDirectory],
    });
    expect(response.body.results.map((result) => result.errorCode)).toEqual([
      'UNREFERENCED_SOURCE',
      'PATH_TRAVERSAL',
      'SYMLINK_ESCAPE',
      'NOT_A_FILE',
    ]);
  });

  it('rejects oversize, MIME-mismatched, invalid-signature, and SVG files', async () => {
    const directories = await createFixtureDirectories();
    const oversize = path.join(directories.workspace, 'oversize.png');
    const mismatch = path.join(directories.workspace, 'mismatch.png');
    const invalid = path.join(directories.workspace, 'invalid.png');
    const svg = path.join(directories.workspace, 'vector.svg');
    await fsPromises.writeFile(oversize, PNG_HEADER);
    await fsPromises.truncate(oversize, MAX_IMAGE_BYTES + 1);
    await fsPromises.writeFile(mismatch, JPEG_HEADER);
    await fsPromises.writeFile(invalid, 'not an image');
    await fsPromises.writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const message = Object.assign(assistantMessage({
      workspace: directories.workspace,
      parts: [textPart([
        `![Oversize](<${oversize}>)`,
        `![Mismatch](<${mismatch}>)`,
        `![Invalid](<${invalid}>)`,
        `![SVG](<${svg}>)`,
      ].join('\n'))],
    }), { generatedRoot: directories.generatedRoot });
    const { app } = createHarness({ message });

    const response = await postPrepare(app, {
      messageId: 'message-1',
      sources: [oversize, mismatch, invalid, svg],
    });
    expect(response.body.results.map((result) => result.errorCode)).toEqual([
      'FILE_TOO_LARGE',
      'MIME_MISMATCH',
      'INVALID_SIGNATURE',
      'UNSUPPORTED_FORMAT',
    ]);
  });
});

describe('path-bound assistant image grants', () => {
  it('rejects expired grants, wrong principals, and wrong paths', () => {
    let currentTime = 100;
    const store = createImageAssetGrantStore({
      crypto: { randomUUID: () => 'token-1' },
      now: () => currentTime,
      ttlMs: 10,
    });
    const principal = { id: 'user-1', scope: 'managed' };
    const token = store.grant({
      principal,
      canonicalPath: '/tmp/image.png',
      sessionId: 'session-1',
      messageId: 'message-1',
    });

    expect(store.authorize({ token, principal: { id: 'user-2', scope: 'managed' }, canonicalPath: '/tmp/image.png' })).toBe(false);
    expect(store.authorize({ token, principal, canonicalPath: '/tmp/other.png' })).toBe(false);
    expect(store.authorize({ token, principal, canonicalPath: '/tmp/image.png' })).toBe(true);
    currentTime = 111;
    expect(store.authorize({ token, principal, canonicalPath: '/tmp/image.png' })).toBe(false);
  });
});
