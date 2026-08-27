import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBotComputerResources } from './computer-resources.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const PRINCIPAL = { id: 'a0000000-0000-4000-8000-000000000001' };
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

const createHarness = async ({ active = true, indexerAvailable = true } = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-computer-resources-'));
  temporaryDirectories.push(root);
  const source = path.join(root, 'Operations Files');
  await fs.mkdir(path.join(source, 'Run Books'), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(source, 'handbook.md'), '# Handbook\nUse the reviewed checklist.\n'),
    fs.writeFile(path.join(source, 'Run Books', 'deploy.txt'), 'Deploy on Tuesday.\n'),
    fs.writeFile(path.join(source, 'fixture.bin'), Buffer.from([0, 1, 2, 3])),
    fs.writeFile(path.join(source, 'empty.txt'), ''),
    fs.writeFile(path.join(source, '.env'), 'SECRET=must-not-import\n'),
  ]);
  const authorization = {
    requireManager: vi.fn(async () => ({
      bot: { id: BOT_ID, active_revision_id: active ? 'revision-1' : null },
    })),
  };
  const imported = [];
  const dockerProvider = {
    importSharedFile: vi.fn(async (request) => {
      imported.push(request);
      return {
        written: true,
        path: `/workspace/Resources/${request.resourcePath}`,
        bytes: request.bytes.byteLength,
        sha256: crypto.createHash('sha256').update(request.bytes).digest('hex'),
      };
    }),
  };
  const computerRuntimeManager = { ensureBot: vi.fn(async () => ({})) };
  const indexer = { upsert: vi.fn(async () => ({ changed: true })) };
  const encryptionKey = Buffer.alloc(32, 7);
  const encryption = { getKey: vi.fn(async () => Buffer.from(encryptionKey)) };
  const audit = vi.fn(async () => ({}));
  let uuidCounter = 1;
  const service = createBotComputerResources({
    dataDirectory: path.join(root, 'data'),
    authorization,
    dockerProvider,
    computerRuntimeManager,
    encryption,
    getIndexer: () => indexerAvailable ? indexer : null,
    audit,
    uuid: () => `c0000000-0000-4000-8000-${String(uuidCounter++).padStart(12, '0')}`,
    now: () => new Date('2026-08-27T12:00:00.000Z'),
  });
  return {
    root,
    source,
    service,
    authorization,
    dockerProvider,
    computerRuntimeManager,
    indexer,
    audit,
    imported,
    dataDirectory: path.join(root, 'data'),
  };
};

describe('Bot computer resources', () => {
  it('copies a folder into Resources, indexes text, and stores Finder mappings', async () => {
    const harness = await createHarness();
    const result = await harness.service.importPath(PRINCIPAL, BOT_ID, { path: harness.source });

    expect(result).toMatchObject({
      rootComputerPath: 'Resources/Operations-Files',
      indexSynchronized: true,
    });
    expect(result.imported.map((entry) => entry.computerPath)).toEqual([
      'Resources/Operations-Files/fixture.bin',
      'Resources/Operations-Files/handbook.md',
      'Resources/Operations-Files/Run-Books/deploy.txt',
    ]);
    expect(result.skipped.map((entry) => entry.reason).sort()).toEqual([
      'empty_file',
      'secret_like_name',
    ]);
    expect(harness.computerRuntimeManager.ensureBot).toHaveBeenCalledTimes(1);
    expect(harness.imported.map((entry) => entry.resourcePath)).toEqual([
      'Operations-Files/fixture.bin',
      'Operations-Files/handbook.md',
      'Operations-Files/Run-Books/deploy.txt',
    ]);
    expect(harness.indexer.upsert).toHaveBeenCalledTimes(2);
    expect(harness.indexer.upsert).toHaveBeenCalledWith(expect.objectContaining({
      documentId: expect.stringMatching(/^computer-resource:[a-f0-9]{64}$/u),
      metadata: expect.objectContaining({
        kind: 'computer_resource',
        computerPath: 'Resources/Operations-Files/handbook.md',
      }),
    }));

    const listed = await harness.service.list(PRINCIPAL, BOT_ID);
    expect(listed.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        computerPath: 'Resources/Operations-Files',
        sourcePath: harness.source,
        kind: 'directory',
      }),
      expect.objectContaining({
        computerPath: 'Resources/Operations-Files/handbook.md',
        sourcePath: path.join(harness.source, 'handbook.md'),
        kind: 'file',
      }),
    ]));
    expect(harness.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'bot.computer.resource.import',
      result: 'success',
      metadata: expect.objectContaining({ fileCount: 3, skippedCount: 2 }),
    }));
    expect(JSON.stringify(harness.audit.mock.calls)).not.toContain(harness.source);

    const rebuilt = await harness.service.listIndexDocuments();
    expect(rebuilt).toHaveLength(2);
    expect(rebuilt).toEqual(expect.arrayContaining([
      expect.objectContaining({
        namespace: `bot:${BOT_ID}`,
        text: '# Handbook\nUse the reviewed checklist.\n',
        metadata: expect.objectContaining({
          kind: 'computer_resource',
          computerPath: 'Resources/Operations-Files/handbook.md',
        }),
      }),
    ]));
    const manifest = await fs.readFile(path.join(
      harness.dataDirectory,
      'bots',
      'computer-resources',
      `${BOT_ID}.json`,
    ), 'utf8');
    expect(manifest).not.toContain('Use the reviewed checklist.');
  });

  it('keeps the copy usable when reference indexing is temporarily unavailable', async () => {
    const harness = await createHarness({ indexerAvailable: false });
    const file = path.join(harness.source, 'handbook.md');
    const result = await harness.service.importPath(PRINCIPAL, BOT_ID, { path: file });

    expect(result.imported).toHaveLength(1);
    expect(result.indexSynchronized).toBe(false);
    expect(harness.dockerProvider.importSharedFile).toHaveBeenCalledTimes(1);
    expect(harness.audit).toHaveBeenCalledWith(expect.objectContaining({ result: 'partial' }));
  });

  it('requires an active Bot and refuses resources with no supported non-empty files', async () => {
    const inactive = await createHarness({ active: false });
    await expect(inactive.service.importPath(PRINCIPAL, BOT_ID, { path: inactive.source }))
      .rejects.toMatchObject({ code: 'bot_not_active', statusCode: 409 });
    expect(inactive.computerRuntimeManager.ensureBot).not.toHaveBeenCalled();

    const empty = await createHarness();
    const emptyDirectory = path.join(empty.root, 'Empty Folder');
    await fs.mkdir(emptyDirectory);
    await fs.writeFile(path.join(emptyDirectory, 'empty.txt'), '');
    await expect(empty.service.importPath(PRINCIPAL, BOT_ID, { path: emptyDirectory }))
      .rejects.toMatchObject({ code: 'bot_computer_resource_invalid', statusCode: 400 });
    expect(empty.dockerProvider.importSharedFile).not.toHaveBeenCalled();
  });
});
