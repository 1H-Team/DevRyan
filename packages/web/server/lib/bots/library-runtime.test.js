import { describe, expect, it, vi } from 'vitest';

import { createBotLibraryRuntime } from './library-runtime.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const SCAN_1 = 'c0000000-0000-4000-8000-000000000001';
const SOURCE_ID = 'd0000000-0000-4000-8000-000000000001';
const VERSION_1 = 'e0000000-0000-4000-8000-000000000001';
const SCAN_2 = 'c0000000-0000-4000-8000-000000000002';
const VERSION_2 = 'e0000000-0000-4000-8000-000000000002';
const principal = { id: USER_ID, role: 'developer', scope: 'managed' };

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const waitFor = async (assertion, timeoutMs = 1_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  } while (Date.now() < deadline);
  throw lastError;
};

const candidate = (text, sha256 = 'a'.repeat(64)) => Object.freeze({
  rootPath: '/manager-selected/handbook',
  rootKind: 'directory',
  exclusions: Object.freeze({ names: [], extensions: [], paths: [] }),
  files: Object.freeze([Object.freeze({
    relativePath: 'handbook.md',
    absolutePath: '/manager-selected/handbook/handbook.md',
    contentType: 'text/markdown',
    size: Buffer.byteLength(text),
    textBytes: Buffer.byteLength(text),
    sha256,
    text,
    bytes: Buffer.from(text),
  })]),
  findings: Object.freeze([]),
  totalBytes: Buffer.byteLength(text),
});

const createHarness = ({
  dockerProvider = null,
  computerRuntimeManager = null,
  authorizationDecision = { reason: 'manager' },
} = {}) => {
  const rows = new Map([
    ['bot_library_sources', []],
    ['bot_library_versions', []],
    ['bot_objects', []],
  ]);
  const objectBytes = new Map();
  let timestamp = 0;
  let objectOrdinal = 0;
  const nextTimestamp = () => `2026-08-23T10:${String(timestamp++).padStart(2, '0')}:00.000Z`;
  const matches = (row, filters) => Object.entries(filters || {})
    .every(([key, value]) => row[key] === value);
  const repository = (table) => ({
    get: vi.fn(async (filters) => rows.get(table).find((row) => matches(row, filters)) || null),
    list: vi.fn(async ({ filters = {}, limit = 100 }) => ({
      items: rows.get(table).filter((row) => matches(row, filters))
        .sort((left, right) => Number(right.version_number || 0) - Number(left.version_number || 0))
        .slice(0, limit),
      nextCursor: null,
    })),
    insert: vi.fn(async (input) => {
      const row = {
        ...structuredClone(input),
        created_at: input.created_at || nextTimestamp(),
        updated_at: input.updated_at || nextTimestamp(),
      };
      rows.get(table).push(row);
      return structuredClone(row);
    }),
    updateIfRevision: vi.fn(async (filters, changes, expectedUpdatedAt) => {
      const row = rows.get(table).find((candidateRow) => (
        matches(candidateRow, filters) && candidateRow.updated_at === expectedUpdatedAt
      ));
      if (!row) throw Object.assign(new Error('conflict'), { code: 'bot_revision_conflict' });
      Object.assign(row, structuredClone(changes), { updated_at: nextTimestamp() });
      return structuredClone(row);
    }),
  });
  const repositories = Object.fromEntries([...rows.keys()].map((table) => [table, repository(table)]));
  const store = {
    repositories,
    storage: {
      delete: vi.fn(async (_bucket, names) => names.forEach((name) => objectBytes.delete(name))),
    },
    deleteCreated: vi.fn(async (table, filters) => {
      const index = rows.get(table).findIndex((row) => matches(row, filters));
      if (index >= 0) rows.get(table).splice(index, 1);
    }),
  };
  const blobStore = {
    createLibraryObject: vi.fn(async ({ botId, contentType, bytes, provenance }) => {
      objectOrdinal += 1;
      const id = `f0000000-0000-4000-8000-${String(objectOrdinal).padStart(12, '0')}`;
      const row = {
        id,
        bot_id: botId,
        channel_id: null,
        visibility: 'library',
        storage_bucket: 'devryan-bot-objects',
        storage_object_name: `objects/${id}.bin`,
        content_type: contentType,
        provenance,
        ciphertext_hash: 'f'.repeat(64),
        ciphertext_size: bytes.byteLength,
        created_by: USER_ID,
        created_at: nextTimestamp(),
        updated_at: nextTimestamp(),
        deleted_at: null,
      };
      rows.get('bot_objects').push(row);
      objectBytes.set(row.storage_object_name, Buffer.from(bytes));
      return structuredClone(row);
    }),
    download: vi.fn(),
    downloadAuthorized: vi.fn(async ({ objectId }) => {
      const object = rows.get('bot_objects').find((row) => row.id === objectId);
      return { object, bytes: Buffer.from(objectBytes.get(object.storage_object_name)) };
    }),
  };
  const scanner = {
    scan: vi.fn()
      .mockResolvedValueOnce(candidate('# Handbook v1\n'))
      .mockResolvedValueOnce(candidate('# Handbook v2\n', 'b'.repeat(64))),
  };
  const authorization = {
    requireManager: vi.fn(async () => ({
      bot: { id: BOT_ID, tenancy: 'team' },
      decision: authorizationDecision,
    })),
  };
  const indexer = {
    upsert: vi.fn(async () => ({ changed: true })),
    search: vi.fn(async () => ({ results: [] })),
    rebuild: vi.fn(async (documents) => ({ documentCount: documents.length })),
  };
  const ids = [SCAN_1, SOURCE_ID, VERSION_1, SCAN_2, VERSION_2];
  const runtime = createBotLibraryRuntime({
    store,
    authorization,
    blobStore,
    scanner,
    encryption: { getKey: () => Buffer.alloc(32, 0x71) },
    indexer,
    dockerProvider,
    computerRuntimeManager,
    audit: vi.fn(async () => {}),
    loadMemoryIndexDocuments: vi.fn(async () => [{
      namespace: `bot:${BOT_ID}`,
      documentId: 'memory:one',
      version: 'memory-v1',
      text: 'memory',
      metadata: { kind: 'memory' },
    }]),
    uuid: () => ids.shift(),
    now: () => new Date('2026-08-23T12:00:00.000Z'),
  });
  return { authorization, blobStore, indexer, objectBytes, rows, runtime, scanner, store };
};

describe('Production Bot curated Library runtime', () => {
  it('returns an actionable computer state when Docker is temporarily unavailable', async () => {
    const harness = createHarness({
      dockerProvider: {
        workspaceListAvailable: true,
        listWorkspace: vi.fn(async () => {
          throw Object.assign(new Error('Docker is installed but unavailable'), {
            code: 'bot_runtime_docker_unavailable',
          });
        }),
      },
    });

    await expect(harness.runtime.listComputerFiles(principal, BOT_ID)).resolves.toEqual({
      available: false,
      state: 'docker_stopped',
      code: 'bot_runtime_docker_unavailable',
      scope: 'workspace',
      rootLabel: 'Workspace',
      path: '',
      entries: [],
      truncated: false,
    });
  });

  it('exposes an isolated Active Bot computer startup failure', async () => {
    const harness = createHarness({
      dockerProvider: {
        workspaceListAvailable: true,
        listWorkspace: vi.fn(async () => {
          throw Object.assign(new Error('Computer missing'), {
            code: 'bot_supervisor_workspace_unavailable',
          });
        }),
      },
      computerRuntimeManager: {
        getFailure: vi.fn(() => ({ code: 'bot_computer_start_failed' })),
      },
    });

    await expect(harness.runtime.listComputerFiles(principal, BOT_ID)).resolves.toEqual({
      available: false,
      state: 'runtime_degraded',
      code: 'bot_computer_start_failed',
      scope: 'workspace',
      rootLabel: 'Workspace',
      path: '',
      entries: [],
      truncated: false,
    });
  });

  it('uses the container root only for a global administrator', async () => {
    const listContainerFilesystem = vi.fn(async () => ({
      state: 'running',
      path: '',
      entries: [{
        path: 'workspace',
        name: 'workspace',
        kind: 'directory',
        size: 0,
        modifiedAt: null,
        restricted: false,
      }],
      truncated: false,
    }));
    const harness = createHarness({
      authorizationDecision: { reason: 'global_admin' },
      dockerProvider: { containerListAvailable: true, listContainerFilesystem },
    });

    await expect(harness.runtime.listComputerFiles(
      { ...principal, role: 'admin' },
      BOT_ID,
    )).resolves.toMatchObject({
      available: true,
      scope: 'container',
      rootLabel: 'Computer',
      path: '',
    });
    expect(listContainerFilesystem).toHaveBeenCalledWith(expect.objectContaining({ path: null }));
  });

  it('encrypts host provenance, requires review, and publishes immutable diffed versions', async () => {
    const harness = createHarness();
    const firstScan = await harness.runtime.scanImport(principal, BOT_ID, {
      path: '/manager-selected/handbook',
      name: 'Team Handbook',
      exclusions: { names: [], extensions: [], paths: [] },
    });
    expect(firstScan).toMatchObject({
      scanId: SCAN_1,
      sourceId: SOURCE_ID,
      sourceExpectedUpdatedAt: null,
      scan: { fileCount: 1 },
      diff: { added: ['handbook.md'], changed: [], removed: [] },
    });

    const first = await harness.runtime.publishScan(principal, BOT_ID, SCAN_1, {
      confirmed: true,
      expectedSourceUpdatedAt: null,
    });
    expect(first.version).toMatchObject({ id: VERSION_1, versionNumber: 1 });
    const persistedSource = harness.rows.get('bot_library_sources')[0];
    expect(JSON.stringify(persistedSource.host_path_envelope))
      .not.toContain('/manager-selected/handbook');
    expect(JSON.stringify(persistedSource.provenance))
      .not.toContain('/manager-selected/handbook');
    expect(JSON.stringify(persistedSource.provenance))
      .not.toContain('manager_selected_filesystem');
    const detail = await harness.runtime.getVersionForManager(principal, BOT_ID, VERSION_1);
    expect(detail.source.hostPath).toBe('/manager-selected/handbook');
    expect(detail.source.provenance).toMatchObject({ source: 'manager_selected_filesystem' });
    expect(detail.manifest.files[0]).toMatchObject({ relativePath: 'handbook.md' });

    const refresh = await harness.runtime.scanRefresh(principal, BOT_ID, SOURCE_ID, {});
    expect(refresh.diff).toMatchObject({ added: [], changed: ['handbook.md'], removed: [] });
    const second = await harness.runtime.publishScan(principal, BOT_ID, SCAN_2, {
      confirmed: true,
      expectedSourceUpdatedAt: refresh.sourceExpectedUpdatedAt,
    });
    expect(second.version).toMatchObject({ id: VERSION_2, versionNumber: 2 });
    expect(harness.rows.get('bot_library_versions').map((row) => row.id))
      .toEqual([VERSION_1, VERSION_2]);
    expect(harness.rows.get('bot_library_sources')[0].current_published_version_id)
      .toBe(VERSION_2);
    expect(harness.rows.get('bot_objects')).toHaveLength(2);
  });

  it('pins new runs to the newest publication while an admitted snapshot stays exact', async () => {
    const harness = createHarness();
    const firstScan = await harness.runtime.scanImport(principal, BOT_ID, {
      path: '/manager-selected/handbook',
      name: 'Team Handbook',
      exclusions: {},
    });
    await harness.runtime.publishScan(principal, BOT_ID, firstScan.scanId, {
      confirmed: true,
      expectedSourceUpdatedAt: null,
    });
    const admittedBeforeRefresh = await harness.runtime.snapshotForRun({
      botId: BOT_ID,
      configuredVersionIds: [VERSION_1],
    });
    const refresh = await harness.runtime.scanRefresh(principal, BOT_ID, SOURCE_ID, {});
    await harness.runtime.publishScan(principal, BOT_ID, refresh.scanId, {
      confirmed: true,
      expectedSourceUpdatedAt: refresh.sourceExpectedUpdatedAt,
    });

    expect(admittedBeforeRefresh).toEqual([VERSION_1]);
    await expect(harness.runtime.snapshotExactVersions({
      botId: BOT_ID,
      versionIds: admittedBeforeRefresh,
    })).resolves.toEqual([VERSION_1]);
    await expect(harness.runtime.snapshotForRun({
      botId: BOT_ID,
      configuredVersionIds: [VERSION_1],
    })).resolves.toEqual([VERSION_2]);
  });

  it('resolves configured versions and distinct Library sources concurrently', async () => {
    const harness = createHarness();
    const sourceId2 = 'd0000000-0000-4000-8000-000000000002';
    const versionId2 = 'e0000000-0000-4000-8000-000000000003';
    harness.rows.get('bot_library_versions').push(
      { id: VERSION_1, source_id: SOURCE_ID },
      { id: versionId2, source_id: sourceId2 },
    );
    harness.rows.get('bot_library_sources').push(
      {
        id: SOURCE_ID,
        bot_id: BOT_ID,
        current_published_version_id: VERSION_1,
        retired_at: null,
      },
      {
        id: sourceId2,
        bot_id: BOT_ID,
        current_published_version_id: versionId2,
        retired_at: null,
      },
    );
    const versionGate = deferred();
    const sourceGate = deferred();
    const versionReads = [];
    const sourceReads = [];
    harness.store.repositories.bot_library_versions.get.mockImplementation(async ({ id }) => {
      versionReads.push(id);
      await versionGate.promise;
      return harness.rows.get('bot_library_versions').find((row) => row.id === id) || null;
    });
    harness.store.repositories.bot_library_sources.get.mockImplementation(async ({ id, bot_id: botId }) => {
      sourceReads.push(id);
      await sourceGate.promise;
      return harness.rows.get('bot_library_sources').find((row) => (
        row.id === id && row.bot_id === botId
      )) || null;
    });

    const snapshot = harness.runtime.snapshotForRun({
      botId: BOT_ID,
      configuredVersionIds: [VERSION_1, versionId2],
    });
    expect(versionReads).toEqual([VERSION_1, versionId2]);
    versionGate.resolve();
    await waitFor(() => expect(sourceReads).toEqual([SOURCE_ID, sourceId2]));
    sourceGate.resolve();

    await expect(snapshot).resolves.toEqual([VERSION_1, versionId2]);
  });

  it('rebuilds every immutable Library version alongside memory documents', async () => {
    const harness = createHarness();
    const firstScan = await harness.runtime.scanImport(principal, BOT_ID, {
      path: '/manager-selected/handbook',
      name: 'Team Handbook',
      exclusions: {},
    });
    await harness.runtime.publishScan(principal, BOT_ID, firstScan.scanId, {
      confirmed: true,
      expectedSourceUpdatedAt: null,
    });
    const refresh = await harness.runtime.scanRefresh(principal, BOT_ID, SOURCE_ID, {});
    await harness.runtime.publishScan(principal, BOT_ID, refresh.scanId, {
      confirmed: true,
      expectedSourceUpdatedAt: refresh.sourceExpectedUpdatedAt,
    });

    const result = await harness.runtime.rebuildIndex(principal, BOT_ID);
    expect(result).toMatchObject({
      documentCount: 3,
      memoryDocumentCount: 1,
      libraryDocumentCount: 2,
    });
    expect(harness.indexer.rebuild).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ documentId: `library:${VERSION_1}:f0000000-0000-4000-8000-000000000001` }),
      expect.objectContaining({ documentId: `library:${VERSION_2}:f0000000-0000-4000-8000-000000000002` }),
      expect.objectContaining({ documentId: 'memory:one' }),
    ]));
  });
});
