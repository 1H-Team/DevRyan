import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createBotArtifactService,
  MAX_INLINE_ATTACHMENT_BYTES,
  MAX_INLINE_ATTACHMENT_TURN_BYTES,
} from './artifact-service.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';
const PRIVATE_ID = 'd0000000-0000-4000-8000-000000000001';
const LIBRARY_ID = 'd0000000-0000-4000-8000-000000000002';
const CSV_ID = 'd0000000-0000-4000-8000-000000000003';
const PDF_ID = 'd0000000-0000-4000-8000-000000000004';
const BINARY_ID = 'd0000000-0000-4000-8000-000000000005';
const INVALID_UTF8_ID = 'd0000000-0000-4000-8000-000000000009';
const LARGE_TEXT_IDS = [
  'd0000000-0000-4000-8000-000000000006',
  'd0000000-0000-4000-8000-000000000007',
  'd0000000-0000-4000-8000-000000000008',
];
const VERSION_ID = 'e0000000-0000-4000-8000-000000000001';
const SOURCE_ID = 'f0000000-0000-4000-8000-000000000001';
const RUN_ID = '90000000-0000-4000-8000-000000000001';
const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const principal = { id: USER_ID, role: 'developer', scope: 'managed' };
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

const createHarness = async () => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-artifacts-'));
  temporaryDirectories.push(dataDirectory);
  const rows = new Map([
    [PRIVATE_ID, {
      id: PRIVATE_ID,
      bot_id: BOT_ID,
      channel_id: CHANNEL_ID,
      visibility: 'private',
      content_type: 'text/plain',
      deleted_at: null,
    }],
    [LIBRARY_ID, {
      id: LIBRARY_ID,
      bot_id: BOT_ID,
      channel_id: null,
      visibility: 'library',
      content_type: 'text/markdown',
      deleted_at: null,
    }],
    [CSV_ID, {
      id: CSV_ID, bot_id: BOT_ID, channel_id: CHANNEL_ID, visibility: 'private',
      content_type: 'text/csv', provenance: { name: 'report.csv' }, deleted_at: null,
    }],
    [PDF_ID, {
      id: PDF_ID, bot_id: BOT_ID, channel_id: CHANNEL_ID, visibility: 'private',
      content_type: 'application/pdf', provenance: { name: 'report.pdf' }, deleted_at: null,
    }],
    [BINARY_ID, {
      id: BINARY_ID, bot_id: BOT_ID, channel_id: CHANNEL_ID, visibility: 'private',
      content_type: 'application/zip', provenance: { name: 'archive.zip' }, deleted_at: null,
    }],
    [INVALID_UTF8_ID, {
      id: INVALID_UTF8_ID, bot_id: BOT_ID, channel_id: CHANNEL_ID, visibility: 'private',
      content_type: 'text/plain', provenance: { name: 'invalid.txt' }, deleted_at: null,
    }],
    ...LARGE_TEXT_IDS.map((id, index) => [id, {
      id, bot_id: BOT_ID, channel_id: CHANNEL_ID, visibility: 'private',
      content_type: 'text/plain', provenance: { name: `large-${index + 1}.txt` }, deleted_at: null,
    }]),
  ]);
  const objectBytes = new Map([
    [PRIVATE_ID, Buffer.from('private upload')],
    [LIBRARY_ID, Buffer.from('# Library copy')],
    [CSV_ID, Buffer.from('name,value\nTyrone,1\n')],
    [PDF_ID, Buffer.from('%PDF-1.7\nfixture')],
    [BINARY_ID, Buffer.from([0, 1, 2, 3, 255])],
    [INVALID_UTF8_ID, Buffer.from([0x66, 0x6f, 0x80])],
    [LARGE_TEXT_IDS[0], Buffer.alloc(MAX_INLINE_ATTACHMENT_BYTES + 1, 0x61)],
    [LARGE_TEXT_IDS[1], Buffer.alloc(MAX_INLINE_ATTACHMENT_BYTES + 1, 0x62)],
    [LARGE_TEXT_IDS[2], Buffer.from('tail')],
  ]);
  const blobStore = {
    download: vi.fn(async ({ principal: actor, objectId }) => {
      if (actor !== principal || objectId !== PRIVATE_ID) throw new Error('unauthorized');
      return { object: rows.get(PRIVATE_ID), bytes: Buffer.from('private upload') };
    }),
    downloadAuthorized: vi.fn(async ({ objectId }) => ({
      object: rows.get(objectId),
      bytes: Buffer.from(objectBytes.get(objectId)),
    })),
  };
  let publishedBytes = null;
  const libraryRuntime = {
    publishArtifactBytes: vi.fn(async (input) => {
      publishedBytes = Buffer.from(input.bytes);
      return {
        source: { id: SOURCE_ID },
        version: { id: VERSION_ID },
        object: { id: LIBRARY_ID, visibility: 'library' },
      };
    }),
    resolveVersionObjects: vi.fn(async () => [{
      source: { id: SOURCE_ID },
      version: { id: VERSION_ID, object_ids: [LIBRARY_ID] },
      entries: [{ relativePath: 'docs/guide.md', objectId: LIBRARY_ID }],
    }]),
  };
  const authorization = { requireManager: vi.fn(async () => ({ allowed: true })) };
  const store = {
    repositories: {
      bot_objects: {
        get: vi.fn(async (filters) => {
          const row = rows.get(filters.id);
          return row && Object.entries(filters).every(([key, value]) => row[key] === value)
            ? row
            : null;
        }),
      },
    },
  };
  const service = createBotArtifactService({
    store,
    authorization,
    blobStore,
    libraryRuntime,
    dataDirectory,
  });
  return {
    authorization,
    blobStore,
    dataDirectory,
    libraryRuntime,
    publishedBytes: () => publishedBytes,
    rows,
    service,
  };
};

describe('Production Bot private artifact service', () => {
  it('publishes an explicit immutable copy without widening the private source ACL', async () => {
    const harness = await createHarness();
    const result = await harness.service.publishPrivate(principal, BOT_ID, PRIVATE_ID, {
      name: 'Reviewed Upload.txt',
      provenance: { requestedFrom: 'operations' },
    });

    expect(result.version.id).toBe(VERSION_ID);
    expect(harness.authorization.requireManager).toHaveBeenCalledWith(principal, BOT_ID);
    expect(harness.blobStore.download).toHaveBeenCalledWith({
      principal,
      botId: BOT_ID,
      objectId: PRIVATE_ID,
    });
    expect(harness.libraryRuntime.publishArtifactBytes).toHaveBeenCalledWith(expect.objectContaining({
      objectId: PRIVATE_ID,
      channelId: CHANNEL_ID,
      name: 'Reviewed Upload.txt',
    }));
    expect(harness.publishedBytes()).toEqual(Buffer.from('private upload'));
    expect(harness.rows.get(PRIVATE_ID).visibility).toBe('private');
    expect(harness.rows.get(PRIVATE_ID).id).not.toBe(LIBRARY_ID);
  });

  it('materializes only exact channel artifacts and pinned Library objects, then removes plaintext', async () => {
    const harness = await createHarness();
    const result = await harness.service.materializeRun({
      run: { id: RUN_ID, botId: BOT_ID, channelId: CHANNEL_ID },
      channel: { id: CHANNEL_ID },
      attachmentIds: [PRIVATE_ID],
      libraryVersionIds: [VERSION_ID],
    });
    const root = path.join(harness.service.artifactsRoot, RUN_ID);
    expect(result).toMatchObject({ objectCount: 2, relativeRoot: '.devryan' });
    expect(result.attachments).toEqual([expect.objectContaining({
      objectId: PRIVATE_ID,
      mime: 'text/plain',
      relativePath: `artifacts/artifact-${PRIVATE_ID}.txt`,
      url: `file:///workspace/.devryan/artifacts/artifact-${PRIVATE_ID}.txt`,
      delivery: 'inline_text',
      inlineText: 'private upload',
      truncated: false,
    })]);
    await expect(fs.readFile(path.join(root, `artifacts/artifact-${PRIVATE_ID}.txt`), 'utf8'))
      .resolves.toBe('private upload');
    await expect(fs.readFile(path.join(root, `library/${VERSION_ID}/docs/guide.md`), 'utf8'))
      .resolves.toBe('# Library copy');
    await harness.service.cleanupRun(RUN_ID);
    await expect(fs.stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('inlines CSV, keeps PDFs native, and exposes unsupported binary only through the manifest', async () => {
    const harness = await createHarness();
    const result = await harness.service.materializeRun({
      run: { id: RUN_ID, botId: BOT_ID, channelId: CHANNEL_ID },
      channel: { id: CHANNEL_ID },
      attachmentIds: [CSV_ID, PDF_ID, BINARY_ID, INVALID_UTF8_ID],
      libraryVersionIds: [],
    });

    expect(result.attachments).toEqual([
      expect.objectContaining({
        objectId: CSV_ID,
        filename: 'report.csv',
        delivery: 'inline_text',
        inlineText: 'name,value\nTyrone,1\n',
        truncated: false,
      }),
      expect.objectContaining({ objectId: PDF_ID, filename: 'report.pdf', delivery: 'native' }),
      expect.objectContaining({
        objectId: BINARY_ID,
        filename: 'archive.zip',
        delivery: 'mounted',
        inlineText: null,
      }),
      expect.objectContaining({
        objectId: INVALID_UTF8_ID,
        filename: 'invalid.txt',
        delivery: 'mounted',
        inlineText: null,
      }),
    ]);
    const manifest = JSON.parse(await fs.readFile(
      path.join(harness.service.artifactsRoot, RUN_ID, 'manifest.json'),
      'utf8',
    ));
    expect(manifest.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ objectId: CSV_ID, delivery: 'inline_text' }),
      expect.objectContaining({ objectId: PDF_ID, delivery: 'native' }),
      expect.objectContaining({ objectId: BINARY_ID, delivery: 'mounted' }),
      expect.objectContaining({ objectId: INVALID_UTF8_ID, delivery: 'mounted' }),
    ]));
  });

  it('enforces 128 KiB per file and 256 KiB per turn while marking truncation', async () => {
    const harness = await createHarness();
    const result = await harness.service.materializeRun({
      run: { id: RUN_ID, botId: BOT_ID, channelId: CHANNEL_ID },
      channel: { id: CHANNEL_ID },
      attachmentIds: LARGE_TEXT_IDS,
      libraryVersionIds: [],
    });

    expect(result.attachments.map((attachment) => attachment.inlineBytes)).toEqual([
      MAX_INLINE_ATTACHMENT_BYTES,
      MAX_INLINE_ATTACHMENT_BYTES,
      0,
    ]);
    expect(result.attachments.every((attachment) => attachment.truncated)).toBe(true);
    expect(result.attachments.reduce((sum, attachment) => sum + attachment.inlineBytes, 0))
      .toBe(MAX_INLINE_ATTACHMENT_TURN_BYTES);
  });

  it('rejects a private object from another channel before any plaintext is written', async () => {
    const harness = await createHarness();
    await expect(harness.service.materializeRun({
      run: { id: RUN_ID, botId: BOT_ID, channelId: 'c0000000-0000-4000-8000-000000000099' },
      channel: { id: 'c0000000-0000-4000-8000-000000000099' },
      attachmentIds: [PRIVATE_ID],
      libraryVersionIds: [],
    })).rejects.toMatchObject({ code: 'bot_object_not_found', statusCode: 404 });
    await expect(fs.stat(path.join(harness.service.artifactsRoot, RUN_ID)))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});
