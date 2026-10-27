// Native session archive state (OpenCode 2.1): writes, filtered native lists,
// native pagination, the legacy-override backfill and the kill switch.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOpenCodeClient } from '../opencode-client/index.js';
import { createOpenCodeAdmission } from './admission.js';
import { listFacadeSessionPage } from './facade-routes.js';
import { createNativeArchiveMigration, NATIVE_ARCHIVE_ENV, NATIVE_ARCHIVE_RECEIPT_FILE } from './native-archive.js';
import { pageV1Sessions } from './projection/sessions.js';

const DIRECTORY = '/repo';
const STORE = 'native:/data/opencode.db';
const encodeCursor = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const decodeCursor = (text) => JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
const sessionID = (index) => `ses_${String(index).padStart(6, '0')}`;

/**
 * An in-memory native host with the 2.1 session semantics the client relies on:
 * `GET /api/session` filters (archived included) before it paginates, orders by
 * `time.updated` then id (descending), and its cursor carries the first page's
 * filters plus an anchor; metadata and archive changes move `time.updated`;
 * repeating the current archive state is a no-op.
 */
const createNativeHost = () => {
  let clock = 10_000;
  const rows = new Map();
  const requests = [];
  const failures = [];
  const stats = { rowsReturned: 0 };
  const add = (id, { updated = clock += 1, archived, metadata, directory = DIRECTORY } = {}) => {
    rows.set(id, { id, projectID: 'prj', location: { directory }, title: id, cost: 0, tokens: {},
      time: { created: updated, updated, ...(archived === undefined ? {} : { archived }) }, ...(metadata ? { metadata } : {}) });
  };
  const compare = (left, right) => right.time.updated - left.time.updated || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0);
  const list = (params) => {
    const cursor = params.has('cursor') ? decodeCursor(params.get('cursor')) : null;
    const filters = cursor?.filters ?? {
      directory: params.get('directory') ?? undefined, parentID: params.get('parentID') ?? undefined,
      search: params.get('search') ?? undefined, archived: params.get('archived') ?? undefined, order: params.get('order') ?? 'desc',
    };
    const limit = Number(params.get('limit') ?? 50);
    let listed = [...rows.values()].filter((row) => (filters.directory === undefined || row.location.directory === filters.directory)
      && (filters.search === undefined || row.title.includes(filters.search))
      && (filters.parentID === undefined || (filters.parentID === 'null' ? !row.parentID : row.parentID === filters.parentID))
      && (filters.archived === undefined || (filters.archived === 'true') === (row.time.archived !== undefined)));
    listed.sort(compare);
    if (filters.order === 'asc') listed.reverse();
    if (cursor) {
      const { id, time } = cursor.anchor;
      listed = listed.filter((row) => (filters.order === 'asc'
        ? row.time.updated > time || (row.time.updated === time && row.id > id)
        : row.time.updated < time || (row.time.updated === time && row.id < id)));
    }
    const data = listed.slice(0, limit).map((row) => structuredClone(row));
    stats.rowsReturned += data.length;
    const last = data.at(-1);
    return { data, cursor: { previous: null, next: last ? encodeCursor({ filters, anchor: { id: last.id, time: last.time.updated } }) : null } };
  };
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url);
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const request = { method, path: target.pathname, query: Object.fromEntries(target.searchParams), body };
    requests.push(request);
    for (const failure of failures) {
      const response = failure(request);
      if (response) return response;
    }
    if (method === 'GET' && target.pathname === '/api/session') return Response.json(list(target.searchParams));
    const match = /^\/api\/session\/([^/]+)$/.exec(target.pathname);
    const row = match ? rows.get(decodeURIComponent(match[1])) : undefined;
    if (!row) return Response.json({ _tag: 'SessionNotFoundError', message: 'missing' }, { status: 404 });
    if (method === 'GET') return Response.json({ data: structuredClone(row) });
    if (method === 'PATCH') {
      if (body.metadata !== undefined) { row.metadata = structuredClone(body.metadata); row.time.updated = clock += 1; }
      if (typeof body.archived === 'boolean' && body.archived !== (row.time.archived !== undefined)) {
        clock += 1;
        if (body.archived) row.time.archived = clock; else delete row.time.archived;
        row.time.updated = clock;
      }
      return new Response(null, { status: 204 });
    }
    return Response.json({ message: 'unsupported' }, { status: 405 });
  };
  return { rows, requests, failures, stats, add, fetchImpl, tick: () => (clock += 1) };
};

const override = (id, at) => ({ devryan: { archive: { sessionID: id, at } } });

const migrations = [];
const setup = async ({ host = createNativeHost(), receiptPath, migration: migrationOptions = {} } = {}) => {
  let admission, migration;
  let runtime = { generation: 2, baseUrl: 'http://native.invalid', epoch: 1 };
  const deps = {
    getRuntime: () => runtime,
    fetchImpl: host.fetchImpl,
    getAdmission: () => admission,
    nativeArchive: () => migration,
  };
  const client = createOpenCodeClient(deps);
  admission = createOpenCodeAdmission(deps, { client });
  migration = createNativeArchiveMigration({
    receiptPath,
    storeIdentity: () => STORE,
    listDisagreements: () => client.sessions.archiveDisagreements(),
    align: ({ sessionID: id, directory, archived }) => client.sessions.alignArchive(id, archived, { directory }),
    retryMs: 0,
    repairCooldownMs: 0,
    ...migrationOptions,
  });
  migrations.push(migration);
  return { host, client, migration, setRuntime: (next) => { runtime = next; } };
};

const readReceipt = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const patches = (host) => host.requests.filter((request) => request.method === 'PATCH');
const sessionLists = (host) => host.requests.filter((request) => request.method === 'GET' && request.path === '/api/session');
const ids = (sessions) => sessions.map((session) => session.id);

let root, receiptPath;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-native-archive-'));
  receiptPath = path.join(root, 'runtime', NATIVE_ARCHIVE_RECEIPT_FILE);
  vi.stubEnv(NATIVE_ARCHIVE_ENV, '1');
});
afterEach(async () => {
  // Background passes and receipt writes finish before the scratch is removed.
  for (const migration of migrations.splice(0)) await migration.settle();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe('archive and unarchive write native state', () => {
  it('round-trips: the override commits first on archive, native state first on unarchive', async () => {
    const { host, client } = await setup({ receiptPath });
    host.add('ses_a', { metadata: { kept: true, devryan: { todo: { sessionID: 'ses_a', items: [], rev: 1 } } } });

    const archived = await client.sessions.archive('ses_a', 123, { directory: DIRECTORY });
    expect(archived.time.archived).toBe(123);
    expect(patches(host).map((request) => request.body)).toEqual([{
      metadata: { kept: true, devryan: { todo: { sessionID: 'ses_a', items: [], rev: 1 }, archive: { sessionID: 'ses_a', at: 123 } } },
      archived: true,
    }]);
    expect(host.rows.get('ses_a').time.archived).toEqual(expect.any(Number));

    // Idempotent: a retried archive repeats the same state and stays archived.
    await client.sessions.archive('ses_a', 123, { directory: DIRECTORY });
    expect(host.rows.get('ses_a').time.archived).toEqual(expect.any(Number));

    host.requests.length = 0;
    const restored = await client.sessions.archive('ses_a', null, { directory: DIRECTORY });
    expect(restored.time.archived).toBeUndefined();
    expect(patches(host).map((request) => Object.keys(request.body))).toEqual([['archived'], ['metadata']]);
    expect(patches(host)[0].body).toEqual({ archived: false });
    expect(host.rows.get('ses_a').time.archived).toBeUndefined();
    expect(host.rows.get('ses_a').metadata.devryan.archive).toEqual({ sessionID: 'ses_a', at: null });
    expect(host.rows.get('ses_a').metadata.kept).toBe(true);
  });

  it('keeps the legacy "touch" (at 0) an unarchived metadata write that moves updated', async () => {
    const { host, client } = await setup({ receiptPath });
    host.add('ses_a', { updated: 5 });
    const touched = await client.sessions.archive('ses_a', 0, { directory: DIRECTORY });
    expect(patches(host).map((request) => request.body)).toEqual([{ metadata: override('ses_a', 0) }]);
    expect(touched.time.updated).toBeGreaterThan(5);
    expect(host.rows.get('ses_a').time.archived).toBeUndefined();
  });
});

describe('filtered native lists', () => {
  it('push the archive filter to native both ways once the backfill receipt is complete', async () => {
    const { host, client, migration } = await setup({ receiptPath });
    for (let index = 0; index < 6; index += 1) host.add(sessionID(index));
    for (const index of [1, 3]) await client.sessions.archive(sessionID(index), 500 + index, { directory: DIRECTORY });
    expect((await migration.backfill()).state).toBe('complete');

    host.requests.length = 0;
    expect(ids(await client.sessions.list({ directory: DIRECTORY, archived: true })).sort()).toEqual([sessionID(1), sessionID(3)]);
    expect(ids(await client.sessions.list({ directory: DIRECTORY, archived: false })).sort())
      .toEqual([0, 2, 4, 5].map(sessionID));
    const firstPages = sessionLists(host).filter((request) => request.query.cursor === undefined);
    expect(firstPages.map((request) => request.query.archived)).toEqual(['true', 'false']);

    const archivedPage = await listFacadeSessionPage(client, { query: { archived: 'true', limit: '10' } }, { directory: DIRECTORY });
    expect(ids(archivedPage.sessions)).toEqual([sessionID(3), sessionID(1)]);
    expect(archivedPage.sessions.map((session) => session.time.archived)).toEqual([503, 501]);
    expect(sessionLists(host).at(-1).query).toMatchObject({ archived: 'true', order: 'desc' });
  });

  it('verifies projected state before trusting the receipt and filters in memory until then', async () => {
    const { host, client } = await setup({ receiptPath });
    host.add('ses_legacy', { metadata: override('ses_legacy', 77) });
    host.add('ses_open');
    const listed = await client.sessions.list({ directory: DIRECTORY, archived: false });
    expect(ids(listed)).toEqual(['ses_open']);
    expect(sessionLists(host)[0].query.archived).toBeUndefined();
  });
});

describe('native pagination', () => {
  const seed = (host, count, { archivedEvery = 0, tieEvery = 0 } = {}) => {
    let updated = 1_000;
    for (let index = 0; index < count; index += 1) {
      if (!tieEvery || index % tieEvery !== 0) updated += 1;
      const archived = archivedEvery && index % archivedEvery === 0;
      host.add(sessionID(index), { updated, ...(archived ? { archived: updated, metadata: override(sessionID(index), updated) } : {}) });
    }
  };

  it('reads one page plus a small cohort tail, and resumes the native cursor for the next page', async () => {
    const { host, client, migration } = await setup({ receiptPath });
    seed(host, 1_000, { archivedEvery: 3 });
    expect((await migration.backfill()).state).toBe('complete');
    host.requests.length = 0;
    host.stats.rowsReturned = 0;

    const first = await listFacadeSessionPage(client, { query: { archived: 'false', limit: '100' } }, { directory: DIRECTORY });
    expect(first.sessions).toHaveLength(100);
    expect(sessionLists(host).map((request) => request.query.limit)).toEqual(['100', '16']);
    expect(sessionLists(host)[0].query).toMatchObject({ archived: 'false', order: 'desc' });
    expect(host.stats.rowsReturned).toBe(116);

    host.requests.length = 0;
    const second = await listFacadeSessionPage(client, { query: { archived: 'false', limit: '100', cursor: String(first.nextCursor) } },
      { directory: DIRECTORY });
    expect(sessionLists(host)).toHaveLength(2);
    expect(sessionLists(host)[0].query.cursor).toEqual(expect.any(String));
    expect(second.sessions).toHaveLength(100);
    expect(second.sessions.every((session) => session.time.updated < first.nextCursor)).toBe(true);
  });

  it('keeps the legacy page contract: whole cohorts, stable order, identical pages to the complete read', async () => {
    const { host, client, migration } = await setup({ receiptPath });
    seed(host, 450, { archivedEvery: 4, tieEvery: 3 });
    expect((await migration.backfill()).state).toBe('complete');
    for (const archived of ['false', 'true']) {
      vi.stubEnv(NATIVE_ARCHIVE_ENV, '0');
      const all = await client.sessions.list({ directory: DIRECTORY, archived: archived === 'true' });
      vi.stubEnv(NATIVE_ARCHIVE_ENV, '1');
      expect((await migration.backfill()).state).toBe('complete');
      let cursor, expected = { nextCursor: undefined };
      const native = [], legacy = [];
      do {
        const page = await listFacadeSessionPage(client, { query: { archived, limit: '7', ...(cursor === undefined ? {} : { cursor: String(cursor) }) } },
          { directory: DIRECTORY });
        expected = pageV1Sessions(all, { limit: 7, before: cursor });
        expect(ids(page.sessions)).toEqual(ids(expected.sessions));
        expect(page.nextCursor).toBe(expected.nextCursor);
        native.push(...ids(page.sessions));
        legacy.push(...ids(expected.sessions));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      expect(native).toEqual(legacy);
      expect(new Set(native).size).toBe(all.length);
    }
  });

  it('honours start and a cache miss (another process or a restart) by skipping forward', async () => {
    const { host, client, migration, setRuntime } = await setup({ receiptPath });
    seed(host, 60);
    expect((await migration.backfill()).state).toBe('complete');
    const first = await client.sessions.page({ directory: DIRECTORY, archived: false }, { limit: 10 });
    setRuntime({ generation: 2, baseUrl: 'http://native.invalid', epoch: 2 });
    host.requests.length = 0;
    const second = await client.sessions.page({ directory: DIRECTORY, archived: false }, { limit: 10, before: first.nextCursor });
    expect(sessionLists(host)[0].query.cursor).toBeUndefined();
    expect(second.sessions.every((session) => session.time.updated < first.nextCursor)).toBe(true);
    const bounded = await client.sessions.page({ directory: DIRECTORY }, { limit: 100, start: first.sessions.at(-1).time.updated });
    expect(ids(bounded.sessions)).toEqual(ids(first.sessions));
    expect(bounded.nextCursor).toBeNull();
  });
});

describe('legacy override backfill', () => {
  const legacyState = (host) => {
    host.add('ses_archived', { metadata: override('ses_archived', 111) });
    host.add('ses_archived_two', { metadata: override('ses_archived_two', 222) });
    host.add('ses_restored', { archived: 5, metadata: override('ses_restored', null) });
    host.add('ses_inherited', { metadata: override('ses_parent', 333) });
    host.add('ses_plain');
  };

  it('copies every owned override into native state, oldest first, and records completion', async () => {
    const { host, client, migration } = await setup({ receiptPath });
    legacyState(host);
    const before = await client.sessions.list({ directory: DIRECTORY });
    expect(migration.filterReady()).toBe(false);
    await migration.settle();
    const receipt = await readReceipt(receiptPath);
    expect(receipt).toMatchObject({ version: 1, identity: STORE, state: 'complete', migrated: 3 });
    expect(patches(host).map((request) => [request.path, request.body])).toEqual([
      ['/api/session/ses_archived', { archived: true }],
      ['/api/session/ses_archived_two', { archived: true }],
      ['/api/session/ses_restored', { archived: false }],
    ]);
    expect(host.rows.get('ses_inherited').time.archived).toBeUndefined();
    expect(host.rows.get('ses_plain').time.archived).toBeUndefined();
    // Archive state is never lost or changed: the projection reads the same.
    const after = await client.sessions.list({ directory: DIRECTORY });
    expect(after.map((session) => [session.id, session.time.archived])).toEqual(expect.arrayContaining(
      before.map((session) => [session.id, session.time.archived])));
    expect(migration.filterReady()).toBe(true);
  });

  it('records a partial failure, then resumes after a restart and writes only what is left', async () => {
    const host = createNativeHost();
    legacyState(host);
    let failing = true;
    host.failures.push((request) => (failing && request.method === 'PATCH' && request.path === '/api/session/ses_archived_two'
      ? Response.json({ _tag: 'ServiceUnavailableError', message: 'restarting' }, { status: 503 }) : undefined));
    const first = await setup({ host, receiptPath, migration: { retryMs: 60_000 } });
    const partial = await first.migration.backfill();
    expect(partial).toMatchObject({ state: 'incomplete', migrated: 2, failed: 1 });
    expect(await readReceipt(receiptPath)).toMatchObject({ state: 'incomplete', failed: 1 });
    expect(first.migration.filterReady()).toBe(false);
    expect(host.rows.get('ses_archived').time.archived).toEqual(expect.any(Number));
    expect(host.rows.get('ses_archived_two').time.archived).toBeUndefined();

    failing = false;
    host.requests.length = 0;
    const restarted = await setup({ host, receiptPath });
    await restarted.migration.start();
    expect(restarted.migration.filterReady()).toBe(false);
    await restarted.migration.settle();
    expect(await readReceipt(receiptPath)).toMatchObject({ state: 'complete', migrated: 1 });
    expect(patches(host).map((request) => request.path)).toEqual(['/api/session/ses_archived_two']);
    expect(restarted.migration.filterReady()).toBe(true);
  });

  it('trusts a complete receipt after a restart without scanning, but not for another store', async () => {
    const host = createNativeHost();
    legacyState(host);
    expect((await (await setup({ host, receiptPath })).migration.backfill()).state).toBe('complete');
    host.requests.length = 0;
    const restarted = await setup({ host, receiptPath });
    await restarted.migration.start();
    expect(restarted.migration.filterReady()).toBe(true);
    await restarted.migration.settle();
    expect(host.requests).toEqual([]);

    const other = await setup({ host, receiptPath, migration: { storeIdentity: () => 'native:/other/opencode.db' } });
    await other.migration.start();
    expect(other.migration.filterReady()).toBe(false);
    await other.migration.settle();
    expect(await readReceipt(receiptPath)).toMatchObject({ identity: 'native:/other/opencode.db', state: 'complete', migrated: 0 });
  });

  it('never trusts an unreadable receipt', async () => {
    await fs.mkdir(path.dirname(receiptPath), { recursive: true });
    await fs.writeFile(receiptPath, '{"version":1,"state":"complete"');
    const { host, migration } = await setup({ receiptPath });
    legacyState(host);
    await migration.start();
    expect(migration.filterReady()).toBe(false);
    await migration.settle();
    expect(await readReceipt(receiptPath)).toMatchObject({ state: 'complete', migrated: 3 });
  });
});

describe('DEVRYAN_NATIVE_ARCHIVE=0', () => {
  it('restores metadata-only writes and complete unfiltered reads, and invalidates the receipt', async () => {
    const host = createNativeHost();
    for (let index = 0; index < 5; index += 1) host.add(sessionID(index));
    const { client, migration } = await setup({ host, receiptPath });
    expect((await migration.backfill()).state).toBe('complete');
    await client.sessions.archive(sessionID(2), 999, { directory: DIRECTORY });
    expect(host.rows.get(sessionID(2)).time.archived).toEqual(expect.any(Number));

    vi.stubEnv(NATIVE_ARCHIVE_ENV, '0');
    host.requests.length = 0;
    await client.sessions.archive(sessionID(1), 456, { directory: DIRECTORY });
    await client.sessions.archive(sessionID(2), null, { directory: DIRECTORY });
    expect(patches(host).map((request) => request.body)).toEqual([
      { metadata: override(sessionID(1), 456) }, { metadata: override(sessionID(2), null) }]);
    expect(host.rows.get(sessionID(1)).time.archived).toBeUndefined();
    expect(host.rows.get(sessionID(2)).time.archived).toEqual(expect.any(Number));
    host.requests.length = 0;
    const page = await listFacadeSessionPage(client, { query: { archived: 'false', limit: '2' } }, { directory: DIRECTORY });
    expect(page.sessions).toHaveLength(2);
    expect(sessionLists(host).every((request) => request.query.archived === undefined)).toBe(true);
    expect(sessionLists(host)[0].query.limit).toBe('200');
    expect(ids((await client.sessions.list({ directory: DIRECTORY, archived: true })))).toEqual([sessionID(1)]);
    expect(migration.filterReady()).toBe(false);
    await migration.settle();
    expect(await readReceipt(receiptPath)).toMatchObject({ state: 'invalidated' });

    // Back in native mode the backfill repairs what the legacy writes left behind.
    vi.stubEnv(NATIVE_ARCHIVE_ENV, '1');
    expect(migration.filterReady()).toBe(false);
    await migration.settle();
    expect(await readReceipt(receiptPath)).toMatchObject({ state: 'complete', migrated: 2 });
    expect(host.rows.get(sessionID(1)).time.archived).toEqual(expect.any(Number));
    expect(host.rows.get(sessionID(2)).time.archived).toBeUndefined();
    expect(ids(await client.sessions.list({ directory: DIRECTORY, archived: true }))).toEqual([sessionID(1)]);
  });
});

describe('restart and retention retries', () => {
  it('surfaces a retryable 409/503 and converges when the caller retries', async () => {
    const { host, client } = await setup({ receiptPath });
    host.add('ses_a');
    let failures = 2;
    host.failures.push((request) => {
      if (request.method !== 'PATCH' || failures <= 0) return undefined;
      failures -= 1;
      return failures === 1
        ? Response.json({ _tag: 'ServiceUnavailableError', message: 'restarting' }, { status: 503 })
        : Response.json({ code: 'session_retention_in_progress', message: 'retention' }, { status: 409 });
    });
    await expect(client.sessions.archive('ses_a', 42, { directory: DIRECTORY })).rejects.toMatchObject({ statusCode: 503, retryable: true });
    await expect(client.sessions.archive('ses_a', 42, { directory: DIRECTORY })).rejects.toMatchObject({ statusCode: 409 });
    const archived = await client.sessions.archive('ses_a', 42, { directory: DIRECTORY });
    expect(archived.time.archived).toBe(42);
    expect(host.rows.get('ses_a').time.archived).toEqual(expect.any(Number));
    expect(host.rows.get('ses_a').metadata).toEqual(override('ses_a', 42));
  });

  it('repairs a partially applied write from the override when a filtered list sees it', async () => {
    const { host, client, migration } = await setup({ receiptPath });
    host.add('ses_open');
    host.add('ses_half');
    expect((await migration.backfill()).state).toBe('complete');
    // The host applied the override, then failed before the native flag (a restart).
    host.failures.push((request) => {
      if (request.method !== 'PATCH' || request.body?.archived !== true) return undefined;
      const row = host.rows.get('ses_half');
      row.metadata = structuredClone(request.body.metadata);
      row.time.updated = host.tick();
      return Response.json({ code: 'session_retention_in_progress', message: 'retention' }, { status: 409 });
    });
    await expect(client.sessions.archive('ses_half', 9, { directory: DIRECTORY })).rejects.toMatchObject({ statusCode: 409 });
    host.failures.length = 0;
    expect(host.rows.get('ses_half').time.archived).toBeUndefined();

    // The active view drops it (the override wins) and repairs native state.
    expect(ids(await client.sessions.list({ directory: DIRECTORY, archived: false }))).toEqual(['ses_open']);
    await migration.settle();
    expect(host.rows.get('ses_half').time.archived).toEqual(expect.any(Number));
    expect(ids(await client.sessions.list({ directory: DIRECTORY, archived: true }))).toEqual(['ses_half']);
  });

  it('rolls a half-applied unarchive back to the override, and the retry completes it', async () => {
    const { host, client, migration } = await setup({ receiptPath });
    host.add('ses_a');
    await client.sessions.archive('ses_a', 7, { directory: DIRECTORY });
    expect((await migration.backfill()).state).toBe('complete');
    let fail = true;
    host.failures.push((request) => (fail && request.method === 'PATCH' && request.body?.metadata
      ? Response.json({ _tag: 'ServiceUnavailableError', message: 'restarting' }, { status: 503 }) : undefined));
    await expect(client.sessions.archive('ses_a', null, { directory: DIRECTORY })).rejects.toMatchObject({ statusCode: 503 });
    fail = false;
    expect(host.rows.get('ses_a').time.archived).toBeUndefined();
    expect(ids(await client.sessions.list({ directory: DIRECTORY, archived: false }))).toEqual([]);
    await migration.settle();
    expect(host.rows.get('ses_a').time.archived).toEqual(expect.any(Number));
    expect((await client.sessions.archive('ses_a', null, { directory: DIRECTORY })).time.archived).toBeUndefined();
    expect(ids(await client.sessions.list({ directory: DIRECTORY, archived: false }))).toEqual(['ses_a']);
  });
});

describe('alignArchive', () => {
  it('writes native state only when the owned override still wants it', async () => {
    const { host, client } = await setup({ receiptPath });
    host.add('ses_a', { metadata: override('ses_a', 5) });
    host.add('ses_b');
    expect(await client.sessions.alignArchive('ses_a', false, { directory: DIRECTORY })).toBe('changed');
    expect(await client.sessions.alignArchive('ses_b', true, { directory: DIRECTORY })).toBe('none');
    expect(await client.sessions.alignArchive('ses_missing', true, { directory: DIRECTORY })).toBe('none');
    expect(patches(host)).toEqual([]);
    expect(await client.sessions.alignArchive('ses_a', true, { directory: DIRECTORY })).toBe('migrated');
    expect(await client.sessions.alignArchive('ses_a', true, { directory: DIRECTORY })).toBe('aligned');
    expect(patches(host).map((request) => request.body)).toEqual([{ archived: true }]);
    expect(host.rows.get('ses_a').metadata).toEqual(override('ses_a', 5));
  });
});
