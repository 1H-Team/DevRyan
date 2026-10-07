import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { REVIEWED_SOURCE_SCHEMAS } from '@openchamber/bot-db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBotActivationHold } from './activation-hold.js';
import { encryptBotJson } from './encryption.js';
import { BotCatalogImportError, createBotCatalogImport, createCloudBotReader } from './catalog-import.js';

const MiB = 1024 * 1024;
const MARKER = Object.keys(REVIEWED_SOURCE_SCHEMAS)[0];
const CLOUD_URL = 'https://project-ref.supabase.co';
const SECRET = 'sb_secret_import_fixture';
const JWT_SECRET = 'aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl';
const KEY_BYTE = 7;
const PROFILE_SELECT = 'id,email,display_name,account_kind,role,status';

const OWNER = 'c0000000-0000-4000-8000-000000000001';
const BOT_A = 'b0000000-0000-4000-8000-00000000000a';
const BOT_B = 'b0000000-0000-4000-8000-00000000000b';
const LIVE_OBJECT_ROW = 'd0000000-0000-4000-8000-000000000001';
const DELETED_OBJECT_ROW = 'd0000000-0000-4000-8000-000000000002';
const LIVE_OBJECT_NAME = 'e0000000-0000-4000-8000-000000000001';
const DELETED_OBJECT_NAME = 'e0000000-0000-4000-8000-000000000002';
const LIVE_OBJECT_FILE = `${LIVE_OBJECT_NAME}.bin`;
const OBJECT_BYTES = Buffer.from('opaque-ciphertext-object-bytes');
// Beyond Number.MAX_SAFE_INTEGER: a JSON number round trip would round these.
const BIG_A = 9007199254740993n;
const BIG_B = 9007199254740995n;

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// ---------------------------------------------------------------------------
// In-memory hosted Supabase stand-in: the GET subset the cloud reader uses
// (select with ::text aliases, order, limit, keyset `or`, `in` filters, the
// schema RPC and private object downloads). BigInt cells serialize as raw
// JSON numbers so precision loss would be observable.
// ---------------------------------------------------------------------------

const serialize = (value) => JSON.stringify(value, (_key, item) => (
  typeof item === 'bigint' ? JSON.rawJSON(item.toString()) : item
));

const compareValues = (left, right) => {
  const a = String(left);
  const b = String(right);
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
};

const parseCondition = (text) => {
  const match = /^([a-z_0-9]+)\.(eq|gt)\.(.+)$/.exec(text);
  if (!match) throw new Error(`Unsupported filter ${text}`);
  return { column: match[1], op: match[2], value: match[3] };
};

const parseOr = (value) => {
  const inner = value.replace(/^\(/, '').replace(/\)$/, '');
  const groups = [];
  let depth = 0;
  let current = '';
  for (const char of inner) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      groups.push(current);
      current = '';
    } else current += char;
  }
  if (current) groups.push(current);
  return groups.map((group) => (group.startsWith('and(')
    ? group.slice(4, -1).split(',').map(parseCondition)
    : [parseCondition(group)]));
};

const jsonResponse = (value, status = 200) => new Response(serialize(value), {
  status, headers: { 'content-type': 'application/json' },
});
const rawResponse = (text, status = 200) => new Response(text, { status, headers: { 'content-type': 'application/json' } });
const statusResponse = (status) => new Response('{}', { status });
const oversizedResponse = (declared = 33 * MiB) => new Response('[]', {
  status: 200, headers: { 'content-length': String(declared) },
});

const cloudTables = () => ({
  bots: [
    { id: BOT_B, name: 'Cloud two', created_by: OWNER },
    { id: BOT_A, name: 'Cloud one', created_by: OWNER },
  ],
  bot_audit_events: [
    { id: BIG_B, bot_id: BOT_B, action: 'bot.created' },
    { id: BIG_A, bot_id: BOT_A, action: 'bot.created' },
  ],
  bot_objects: [
    {
      id: LIVE_OBJECT_ROW,
      bot_id: BOT_A,
      storage_object_name: `objects/${LIVE_OBJECT_NAME}.bin`,
      ciphertext_size: OBJECT_BYTES.byteLength,
      ciphertext_hash: sha256(OBJECT_BYTES),
      deleted_at: null,
    },
    {
      id: DELETED_OBJECT_ROW,
      bot_id: BOT_B,
      storage_object_name: `objects/${DELETED_OBJECT_NAME}.bin`,
      ciphertext_size: 3,
      ciphertext_hash: 'gone',
      deleted_at: '2026-09-01T00:00:00.000Z',
    },
  ],
  user_profiles: [{
    id: OWNER,
    email: 'owner@example.test',
    display_name: 'Cloud owner',
    account_kind: 'person',
    role: 'admin',
    status: 'active',
    password_hash: 'never-exported',
  }],
});

const createFakeCloud = ({ tables = cloudTables(), objects, marker = MARKER, tracker = { phase: null } } = {}) => {
  const objectStore = objects || new Map([[LIVE_OBJECT_FILE, OBJECT_BYTES]]);
  const requests = [];
  const hooks = { respond: null };
  const fetchImpl = vi.fn(async (input, init = {}) => {
    const url = new URL(String(input));
    const entry = {
      method: init.method,
      origin: url.origin,
      path: url.pathname,
      params: Object.fromEntries(url.searchParams),
      headers: init.headers,
      signal: init.signal,
      phase: tracker.phase,
    };
    requests.push(entry);
    if (init.method !== 'GET') return statusResponse(405);
    const override = hooks.respond ? await hooks.respond(url, entry) : null;
    if (override) return override;
    if (url.pathname === '/rest/v1/rpc/devryan_bot_schema_version') return jsonResponse(marker);
    const object = /^\/storage\/v1\/object\/devryan-bot-objects\/objects\/(.+)$/.exec(url.pathname);
    if (object) {
      const bytes = objectStore.get(object[1]);
      return bytes ? new Response(bytes, { status: 200 }) : statusResponse(404);
    }
    const table = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname)?.[1];
    if (!table || !Object.hasOwn(tables, table)) return jsonResponse({ code: 'PGRST205' }, 404);
    let rows = [...tables[table]];
    for (const [key, value] of url.searchParams) {
      if (['select', 'order', 'limit', 'or'].includes(key)) continue;
      const inList = /^in\.\((.*)\)$/.exec(value);
      if (inList) {
        const values = new Set(inList[1].split(','));
        rows = rows.filter((row) => values.has(String(row[key])));
      } else if (value.startsWith('eq.')) {
        rows = rows.filter((row) => String(row[key]) === value.slice(3));
      } else if (value === 'is.null') {
        rows = rows.filter((row) => row[key] === null);
      }
    }
    const or = url.searchParams.get('or');
    if (or) {
      const groups = parseOr(or);
      rows = rows.filter((row) => groups.some((group) => group.every((condition) => {
        const order = compareValues(row[condition.column], condition.value);
        return condition.op === 'eq' ? order === 0 : order > 0;
      })));
    }
    const order = (url.searchParams.get('order') || '').split(',').filter(Boolean).map((part) => part.replace(/\.asc$/, ''));
    rows.sort((left, right) => {
      for (const column of order) {
        const result = compareValues(left[column], right[column]);
        if (result !== 0) return result;
      }
      return 0;
    });
    rows = rows.slice(0, Number(url.searchParams.get('limit') || rows.length));
    const select = (url.searchParams.get('select') || '*').split(',');
    return jsonResponse(rows.map((row) => {
      const output = {};
      for (const field of select) {
        const alias = /^([a-z0-9_]+):([a-z0-9_]+)::text$/.exec(field);
        if (alias) output[alias[1]] = row[alias[2]] === null || row[alias[2]] === undefined ? null : String(row[alias[2]]);
        else if (field === '*') Object.assign(output, row);
        else output[field] = row[field] ?? null;
      }
      return output;
    }));
  });
  return { fetchImpl, requests, hooks, tables, objects: objectStore };
};

// Catalog metadata as the host reports it for the reviewed source schema.
const CATALOG = Object.freeze({
  tables: [
    { name: 'bots', columns: ['id', 'name', 'created_by'], primaryKey: ['id'], userColumns: ['created_by'], references: [] },
    {
      name: 'bot_audit_events',
      columns: ['id', 'bot_id', 'action'],
      primaryKey: ['id'],
      identity: ['id'],
      references: [{ table: 'bots', deferrable: false }],
    },
    {
      name: 'bot_objects',
      columns: ['id', 'bot_id', 'storage_object_name', 'ciphertext_size', 'ciphertext_hash', 'deleted_at'],
      primaryKey: ['id'],
      references: [{ table: 'bots', deferrable: false }],
    },
    { name: 'user_profiles', columns: ['id', 'email'], primaryKey: ['id'] },
  ],
});

const collectScript = async (chunks) => {
  let text = '';
  for await (const chunk of chunks) text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  return text;
};

const SOURCE_LOAD_FAILURE = Object.freeze({ code: 'fake_source_load_failed', message: 'fake source database refused the load' });

// Export/verify-only host: the source load fails fast so nothing merges.
const createExportHost = () => {
  const scripts = [];
  const host = {
    createImportSource: vi.fn(async () => ({ handle: 'source-handle', catalog: CATALOG })),
    runImportSql: vi.fn(async (target, chunks) => {
      scripts.push({ target, text: await collectScript(chunks) });
      throw Object.assign(new Error(SOURCE_LOAD_FAILURE.message), { code: SOURCE_LOAD_FAILURE.code });
    }),
    dropImportSource: vi.fn(async () => {}),
  };
  return { host, scripts };
};

let dataDirectory;
let importRoot;
let statePath;
let clock;

beforeEach(async () => {
  dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-bot-import-'));
  importRoot = path.join(dataDirectory, 'bots', 'import');
  statePath = path.join(importRoot, 'state.v1.json');
  clock = Date.parse('2026-09-26T12:00:00.000Z');
});

afterEach(async () => {
  await fs.rm(dataDirectory, { recursive: true, force: true });
});

const exists = async (target) => fs.stat(target).then(() => true, () => false);
const readState = async () => JSON.parse(await fs.readFile(statePath, 'utf8'));
const pagePath = (stateId, group, index) => path.join(importRoot, stateId, 'pages', group, `${String(index).padStart(6, '0')}.enc`);

const pageKey = (stateId) => Buffer.from(crypto.hkdfSync(
  'sha256', Buffer.alloc(32, KEY_BYTE), Buffer.from(stateId, 'utf8'), Buffer.from('devryan-bot-import/v1/page', 'utf8'), 32,
));

const decryptPage = async (stateId, group, entry, { aadIndex = entry.index } = {}) => {
  const decipher = crypto.createDecipheriv('aes-256-gcm', pageKey(stateId), Buffer.from(entry.iv, 'base64'));
  decipher.setAAD(Buffer.from(`devryan-bot-import:${stateId}:${group}:${aadIndex}`, 'utf8'));
  decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
  const ciphertext = await fs.readFile(pagePath(stateId, group, entry.index));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
};

const createHarness = ({ cloud: cloudOptions = {}, host: hostOverride, ...overrides } = {}) => {
  const tracker = { phase: null };
  const cloud = createFakeCloud({ ...cloudOptions, tracker });
  const exportHost = createExportHost();
  const host = hostOverride || exportHost.host;
  const phases = [];
  // The real private hold file in the temp data directory, spied for ordering.
  const realHold = createBotActivationHold({ dataDirectory });
  const activationHold = {
    get: vi.fn(() => realHold.get()),
    isHeld: vi.fn(() => realHold.isHeld()),
    hold: vi.fn((request) => realHold.hold(request)),
    release: vi.fn(() => realHold.release()),
    reinstate: vi.fn((previous) => realHold.reinstate(previous)),
  };
  const options = {
    dataDirectory,
    encryption: { getKey: async () => Buffer.alloc(32, KEY_BYTE) },
    host,
    runMaintenance: vi.fn(async () => { throw new Error('the merge must not run in this test'); }),
    activationHold,
    readCloudSource: () => ({ url: CLOUD_URL, secretKey: SECRET }),
    validateCandidate: vi.fn(async () => { throw new Error('validation must not run in this test'); }),
    fetchImpl: cloud.fetchImpl,
    now: () => clock,
    wait: async () => {},
    recordDiagnostic: (event) => {
      expect(event).toMatchObject({ type: 'lifecycle', event: 'bot.catalog.import' });
      tracker.phase = event.payload.phase;
      phases.push(event.payload.phase);
    },
    ...overrides,
  };
  const importer = createBotCatalogImport(options);
  return { importer, cloud, host, scripts: exportHost.scripts, phases, tracker, options, activationHold };
};

const settle = async (importer) => {
  await vi.waitFor(() => {
    if (importer.running) throw new Error('import still running');
  }, { timeout: 10_000, interval: 1 });
  return importer.status();
};

const runImport = async (importer, mode = 'merge') => {
  await importer.start({ mode, writersStopped: true });
  return settle(importer);
};

const configurationHarness = ({ keyByte = KEY_BYTE, secondAvatar = false } = {}) => {
  const tables = cloudTables();
  const avatar = (row, botId) => ({
    ...row, bot_id: botId, visibility: 'profile', channel_id: null, deleted_at: null, content_type: 'image/png',
    ciphertext_size: OBJECT_BYTES.byteLength, ciphertext_hash: sha256(OBJECT_BYTES),
    wrapped_key: encryptBotJson({ key: Buffer.alloc(32, keyByte), keyId: 'deployment-v1',
      value: { key: Buffer.alloc(32, 9).toString('base64') }, associatedData: `devryan-bot-object-key:${row.id}:v1` }),
  });
  tables.bots = tables.bots.map((row) => ({ ...row,
    avatar_object_id: row.id === BOT_A ? LIVE_OBJECT_ROW : secondAvatar ? DELETED_OBJECT_ROW : null,
  }));
  tables.bot_objects[0] = avatar(tables.bot_objects[0], BOT_A);
  if (secondAvatar) tables.bot_objects[1] = avatar(tables.bot_objects[1], BOT_B);
  const catalog = { tables: CATALOG.tables.map((table) => ({ ...table, columns: table.name === 'bots'
    ? [...table.columns, 'avatar_object_id'] : table.name === 'bot_objects'
      ? [...table.columns, 'visibility', 'channel_id', 'content_type', 'wrapped_key'] : table.columns })) };
  const exported = createExportHost();
  exported.host.createImportSource = vi.fn(async () => ({ handle: 'source-handle', catalog }));
  const result = createHarness({ host: exported.host, cloud: { tables,
    objects: new Map([[LIVE_OBJECT_FILE, OBJECT_BYTES], [`${DELETED_OBJECT_NAME}.bin`, OBJECT_BYTES]]) } });
  return { ...result, scripts: exported.scripts };
};

describe('configuration-only import', () => {
  it('transfers only configuration and current avatars, retaining strict filters during re-verification', async () => {
    const { importer, cloud, scripts } = configurationHarness();
    await importer.start({ mode: 'merge', scope: 'configuration', writersStopped: true });
    const status = await settle(importer);
    expect(status.import.scope).toBe('configuration');
    expect(status.import.downloadedBytes).toBeGreaterThan(OBJECT_BYTES.byteLength);
    expect(cloud.requests.some((request) => request.path === '/rest/v1/bot_audit_events')).toBe(false);
    const requests = cloud.requests.filter((request) => request.path === '/rest/v1/bot_objects');
    expect(requests.length).toBeGreaterThan(1);
    for (const request of requests) expect(request.params).toMatchObject({
      id: `in.(${LIVE_OBJECT_ROW})`, visibility: 'eq.profile', channel_id: 'is.null', deleted_at: 'is.null',
    });
    expect(cloud.requests.filter((request) => request.path.startsWith('/storage/')).map((request) => request.path))
      .toEqual([`/storage/v1/object/devryan-bot-objects/objects/${LIVE_OBJECT_FILE}`]);
    expect(scripts[0].text).not.toContain('insert into public."bot_audit_events"');
    expect(scripts[0].text).toContain(LIVE_OBJECT_ROW);
    expect(scripts[0].text).not.toContain(DELETED_OBJECT_ROW);
  });

  it('checks the source encryption identity before fetching an avatar', async () => {
    const { importer, cloud } = configurationHarness({ keyByte: 42 });
    await importer.start({ mode: 'merge', scope: 'configuration', writersStopped: true });
    expect((await settle(importer)).import.error.code).toBe('bot_import_encryption_identity_mismatch');
    expect(cloud.requests.some((request) => request.path.startsWith('/storage/'))).toBe(false);
  });

  it('does not query object metadata when no Bot has an avatar', async () => {
    const { importer, cloud } = configurationHarness();
    cloud.tables.bots.forEach((bot) => { bot.avatar_object_id = null; });
    await importer.start({ mode: 'merge', scope: 'configuration', writersStopped: true });
    await settle(importer);
    expect(cloud.requests.some((request) => request.path === '/rest/v1/bot_objects' || request.path.startsWith('/storage/'))).toBe(false);
  });

  it('checkpoints each avatar across quota interruptions and refuses a change of scope', async () => {
    const { importer, cloud } = configurationHarness({ secondAvatar: true });
    let blocked = true;
    cloud.hooks.respond = (_url, request) => (blocked && request.path.endsWith(`${DELETED_OBJECT_NAME}.bin`)
      ? statusResponse(402) : null);
    await importer.start({ mode: 'merge', scope: 'configuration', writersStopped: true });
    expect((await settle(importer)).import.phase).toBe('blocked');
    expect((await readState()).objects.entries).toHaveLength(1);
    const downloaded = importer.status().import.downloadedBytes;
    await expect(importer.start({ mode: 'merge', scope: 'full', writersStopped: true }))
      .rejects.toMatchObject({ code: 'bot_import_scope_mismatch' });
    blocked = false;
    await importer.start({ mode: 'merge', scope: 'configuration', writersStopped: true });
    await settle(importer);
    expect(cloud.requests.filter((request) => request.path.endsWith(LIVE_OBJECT_FILE))).toHaveLength(1);
    expect(importer.status().import.downloadedBytes).toBeGreaterThan(downloaded);
    expect((await readState()).objects.entries).toHaveLength(2);
  });
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

// ---------------------------------------------------------------------------

describe('cloud Bot reader', () => {
  const reader = (options = {}) => {
    const cloud = createFakeCloud(options.cloud);
    const waits = [];
    const instance = createCloudBotReader({
      url: CLOUD_URL,
      secretKey: SECRET,
      fetchImpl: options.fetchImpl || cloud.fetchImpl,
      allowedTables: ['bots', 'bot_audit_events', 'bot_objects', 'user_profiles'],
      wait: async (ms) => { waits.push(ms); },
      ...options.reader,
    });
    return { reader: instance, cloud, waits };
  };

  it('requires an http(s) project URL and a secret key', () => {
    for (const bad of [
      { url: 'not a url', secretKey: SECRET },
      { url: undefined, secretKey: SECRET },
      { url: 'ftp://project-ref.supabase.co', secretKey: SECRET },
      { url: 'file:///etc/passwd', secretKey: SECRET },
      { url: CLOUD_URL, secretKey: '' },
      { url: CLOUD_URL, secretKey: undefined },
      { url: CLOUD_URL, secretKey: 42 },
    ]) {
      let thrown = null;
      try {
        createCloudBotReader({ ...bad, fetchImpl: vi.fn() });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(BotCatalogImportError);
      expect(thrown).toMatchObject({ code: 'bot_import_source_unconfigured', statusCode: 400, retryable: false });
    }
  });

  it('exposes a read-only, frozen surface bound to the project identity', () => {
    const { reader: instance } = reader();
    expect(Object.isFrozen(instance)).toBe(true);
    expect(Object.keys(instance).sort()).toEqual(['hasBots', 'object', 'page', 'profiles', 'project', 'schemaMarker']);
    expect(instance.project).toBe(sha256(CLOUD_URL));
    const slash = createCloudBotReader({ url: `${CLOUD_URL}/`, secretKey: SECRET, fetchImpl: vi.fn() });
    expect(slash.project).toBe(instance.project);
    const other = createCloudBotReader({ url: 'https://other-ref.supabase.co', secretKey: SECRET, fetchImpl: vi.fn() });
    expect(other.project).not.toBe(instance.project);
  });

  it('sends only GETs with the secret key as apikey, adding a bearer only for JWT-shaped keys', async () => {
    const { reader: instance, cloud } = reader();
    await instance.schemaMarker();
    await instance.hasBots();
    await instance.page('bots', { columns: ['id'], orderColumns: ['id'], limit: 5 });
    await instance.profiles([OWNER]);
    await instance.object(LIVE_OBJECT_FILE);
    expect(cloud.requests).toHaveLength(5);
    for (const request of cloud.requests) {
      expect(request.method).toBe('GET');
      expect(request.origin).toBe(CLOUD_URL);
      expect(request.headers).toEqual({ Accept: 'application/json', apikey: SECRET });
      expect(request.signal).toBeInstanceOf(AbortSignal);
    }

    const jwt = reader({ reader: { secretKey: JWT_SECRET } });
    await jwt.reader.schemaMarker();
    expect(jwt.cloud.requests[0].headers).toEqual({
      Accept: 'application/json', apikey: JWT_SECRET, Authorization: `Bearer ${JWT_SECRET}`,
    });
  });

  it('refuses anything outside the allowlist before any request is sent', async () => {
    const { reader: instance, cloud } = reader({ reader: { allowedTables: ['bots'] } });
    const forbidden = { code: 'bot_import_request_forbidden', statusCode: 500 };
    const page = (table, request) => instance.page(table, { columns: ['id'], orderColumns: ['id'], limit: 1, ...request });

    await expect(page('bot_secrets')).rejects.toMatchObject(forbidden);
    await expect(page('user_profiles')).rejects.toMatchObject(forbidden);
    await expect(page('bots', { columns: ['id', 'name; drop table bots'] })).rejects.toMatchObject(forbidden);
    await expect(page('bots', { columns: ['*'] , orderColumns: ['*'] })).rejects.toMatchObject(forbidden);
    await expect(page('bots', { columns: ['Id'], orderColumns: ['Id'] })).rejects.toMatchObject(forbidden);
    await expect(page('bots', { orderColumns: ['created_at'] })).rejects.toMatchObject(forbidden);
    for (const after of [['abc'], ['1,id.gt.0'], ['1)'], ['123456789012345678901'], [' 1'], [BOT_A.replace('4000', '6000')]]) {
      await expect(page('bots', { after })).rejects.toMatchObject(forbidden);
    }
    // Identities need their own allowlist entry.
    await expect(instance.profiles([OWNER])).rejects.toMatchObject(forbidden);
    for (const file of ['../../rest/v1/bots', 'abc.bin', `${LIVE_OBJECT_NAME}.txt`, `${LIVE_OBJECT_NAME.toUpperCase()}.bin`, `x/${LIVE_OBJECT_FILE}`]) {
      await expect(instance.object(file)).rejects.toMatchObject(forbidden);
    }
    expect(cloud.fetchImpl).not.toHaveBeenCalled();
  });

  it('validates identity requests before sending them', async () => {
    const { reader: instance, cloud } = reader();
    const forbidden = { code: 'bot_import_request_forbidden', statusCode: 500 };
    await expect(instance.profiles([])).rejects.toMatchObject(forbidden);
    await expect(instance.profiles(['not-a-uuid'])).rejects.toMatchObject(forbidden);
    await expect(instance.profiles([OWNER, `${OWNER})`])).rejects.toMatchObject(forbidden);
    const tooMany = Array.from({ length: 101 }, (_, index) => `c0000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    await expect(instance.profiles(tooMany)).rejects.toMatchObject(forbidden);
    expect(cloud.fetchImpl).not.toHaveBeenCalled();

    // Duplicates collapse and ids are sorted; only the reviewed columns are selected.
    const bytes = await instance.profiles([OWNER, BOT_B, OWNER, BOT_A]);
    expect(cloud.requests[0]).toMatchObject({
      path: '/rest/v1/user_profiles',
      params: { select: PROFILE_SELECT, id: `in.(${BOT_A},${BOT_B},${OWNER})`, order: 'id.asc' },
    });
    const rows = JSON.parse(bytes.toString('utf8'));
    expect(rows).toEqual([{
      id: OWNER, email: 'owner@example.test', display_name: 'Cloud owner', account_kind: 'person', role: 'admin', status: 'active',
    }]);
  });

  it('pages with text-cast keyset aliases and returns the raw bytes untouched', async () => {
    const { reader: instance, cloud } = reader();
    const first = await instance.page('bot_audit_events', { columns: ['id', 'action'], orderColumns: ['id'], limit: 1 });
    expect(cloud.requests[0].params).toEqual({ select: 'id,action,__k0:id::text', order: 'id.asc', limit: '1' });
    const text = first.toString('utf8');
    // The big integer is preserved byte-for-byte; the alias carries it as text.
    expect(text).toBe('[{"id":9007199254740993,"action":"bot.created","__k0":"9007199254740993"}]');
    expect(JSON.parse(text)[0].__k0).toBe(BIG_A.toString());

    const second = await instance.page('bot_audit_events', {
      columns: ['id', 'action'], orderColumns: ['id'], after: [BIG_A.toString()], limit: 1,
    });
    expect(cloud.requests[1].params.or).toBe('(id.gt.9007199254740993)');
    expect(second.toString('utf8')).toContain('"__k0":"9007199254740995"');

    const third = await instance.page('bot_audit_events', {
      columns: ['id'], orderColumns: ['id'], after: [BIG_B.toString()], limit: 1,
    });
    expect(third.toString('utf8')).toBe('[]');
  });

  it('builds a composite keyset filter from every order column', async () => {
    const { reader: instance, cloud } = reader();
    await instance.page('bot_objects', {
      columns: ['bot_id', 'ciphertext_size', 'id'],
      orderColumns: ['bot_id', 'ciphertext_size'],
      after: [BOT_A, '12345678901234567890'],
      limit: 10,
    });
    expect(cloud.requests[0].params).toEqual({
      select: 'bot_id,ciphertext_size,id,__k0:bot_id::text,__k1:ciphertext_size::text',
      order: 'bot_id.asc,ciphertext_size.asc',
      limit: '10',
      or: `(bot_id.gt.${BOT_A},and(bot_id.eq.${BOT_A},ciphertext_size.gt.12345678901234567890))`,
    });
  });

  it('maps a missing table to an unsupported schema', async () => {
    const { reader: missing } = reader({ cloud: { tables: { user_profiles: [] } } });
    await expect(missing.page('bots', { columns: ['id'], orderColumns: ['id'], limit: 1 })).rejects.toMatchObject({
      code: 'bot_import_source_schema_unsupported',
    });
  });

  it('reads and validates the schema marker within a small bound', async () => {
    const { reader: instance } = reader();
    await expect(instance.schemaMarker()).resolves.toBe(MARKER);

    const exact = `"${'a'.repeat(4094)}"`;
    const fits = reader();
    fits.cloud.hooks.respond = () => rawResponse(exact);
    await expect(fits.reader.schemaMarker()).resolves.toBe('a'.repeat(4094));

    for (const respond of [
      () => statusResponse(404),
      () => rawResponse('not json'),
      () => rawResponse(`"${'a'.repeat(4095)}"`), // one byte over, streamed without a length
      () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(3000).fill(0x61));
          controller.enqueue(new Uint8Array(3000).fill(0x61));
          controller.close();
        },
      })),
    ]) {
      const { reader: bad, cloud } = reader();
      cloud.hooks.respond = respond;
      await expect(bad.schemaMarker()).rejects.toMatchObject({ code: 'bot_import_source_schema_unsupported' });
    }
  });

  it('stops on a quota response as a retryable condition without retrying', async () => {
    const { reader: instance, cloud, waits } = reader();
    let cancelled = false;
    cloud.hooks.respond = () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(8)); },
      cancel() { cancelled = true; },
    }), { status: 402 });
    const error = await instance.page('bots', { columns: ['id'], orderColumns: ['id'], limit: 1 }).catch((caught) => caught);
    expect(error).toBeInstanceOf(BotCatalogImportError);
    expect(error).toMatchObject({ code: 'bot_import_source_quota_exceeded', statusCode: 409, retryable: true });
    expect(cloud.fetchImpl).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
    expect(cancelled).toBe(true);
  });

  it('retries throttling, server errors and network failures with bounded backoff', async () => {
    const { reader: instance, cloud, waits } = reader();
    const responses = [statusResponse(503), statusResponse(429)];
    cloud.hooks.respond = () => responses.shift() || null;
    await expect(instance.schemaMarker()).resolves.toBe(MARKER);
    expect(waits).toEqual([1_000, 4_000]);

    const failing = reader({ fetchImpl: vi.fn(async () => { throw new TypeError('fetch failed'); }) });
    const error = await failing.reader.hasBots().catch((caught) => caught);
    expect(error).toMatchObject({
      code: 'bot_import_source_unavailable', retryable: true, report: { reason: 'fetch failed' },
    });
    expect(failing.waits).toEqual([1_000, 4_000, 10_000]);

    const down = reader();
    down.cloud.hooks.respond = () => statusResponse(500);
    await expect(down.reader.schemaMarker()).rejects.toMatchObject({
      code: 'bot_import_source_unavailable', retryable: true, report: { reason: 'status 500' },
    });
    expect(down.cloud.fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('fails without retrying on rejected credentials and unexpected client errors', async () => {
    for (const [status, code, retryable] of [
      [401, 'bot_import_source_forbidden', false],
      [403, 'bot_import_source_forbidden', false],
      [400, 'bot_import_source_unavailable', true],
      [409, 'bot_import_source_unavailable', true],
    ]) {
      const { reader: instance, cloud, waits } = reader();
      cloud.hooks.respond = () => statusResponse(status);
      await expect(instance.schemaMarker()).rejects.toMatchObject({ code, retryable });
      expect(cloud.fetchImpl).toHaveBeenCalledTimes(1);
      expect(waits).toEqual([]);
    }
  });

  it('rejects a page whose declared length exceeds the 32 MiB bound without reading it', async () => {
    const { reader: instance, cloud } = reader();
    let cancelled = false;
    cloud.hooks.respond = () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(16)); },
      cancel() { cancelled = true; },
    }), { status: 200, headers: { 'content-length': String(32 * MiB + 1) } });
    await expect(instance.page('bots', { columns: ['id'], orderColumns: ['id'], limit: 500 })).resolves.toBeNull();
    expect(cancelled).toBe(true);
  });

  it('stops reading a streamed page as soon as it exceeds the 32 MiB bound', async () => {
    const { reader: instance, cloud } = reader();
    const chunk = new Uint8Array(MiB).fill(0x20);
    let pulls = 0;
    let cancelled = false;
    cloud.hooks.respond = () => new Response(new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() { cancelled = true; },
    }), { status: 200 });
    await expect(instance.page('bots', { columns: ['id'], orderColumns: ['id'], limit: 500 })).resolves.toBeNull();
    expect(cancelled).toBe(true);
    expect(pulls).toBeGreaterThanOrEqual(33);
    expect(pulls).toBeLessThanOrEqual(35);
  });

  it('bounds identity pages and objects', async () => {
    const oversizedProfiles = reader();
    oversizedProfiles.cloud.hooks.respond = () => oversizedResponse();
    await expect(oversizedProfiles.reader.profiles([OWNER])).rejects.toMatchObject({ code: 'bot_import_row_too_large' });

    const { reader: instance, cloud } = reader();
    await expect(instance.object(LIVE_OBJECT_FILE)).resolves.toEqual(OBJECT_BYTES);
    await expect(instance.object(`${DELETED_OBJECT_NAME}.bin`)).resolves.toBeNull();
    cloud.hooks.respond = () => oversizedResponse(25 * MiB + 1);
    await expect(instance.object(LIVE_OBJECT_FILE)).rejects.toMatchObject({ code: 'bot_import_row_too_large' });
    expect(cloud.requests.map((request) => request.path)).toEqual([
      `/storage/v1/object/devryan-bot-objects/objects/${LIVE_OBJECT_FILE}`,
      `/storage/v1/object/devryan-bot-objects/objects/${DELETED_OBJECT_NAME}.bin`,
      `/storage/v1/object/devryan-bot-objects/objects/${LIVE_OBJECT_FILE}`,
    ]);
  });

  it('detects hosted Bots with a one-row probe and treats unusable answers as none', async () => {
    const { reader: instance, cloud } = reader();
    await expect(instance.hasBots()).resolves.toBe(true);
    expect(cloud.requests[0]).toMatchObject({ path: '/rest/v1/bots', params: { select: 'id', limit: '1' } });

    for (const respond of [
      () => rawResponse('[]'),
      () => rawResponse('<html>'),
      () => statusResponse(404),
      () => rawResponse(`[${'{"id":"x"},'.repeat(500)}{"id":"y"}]`), // over the 4 KiB probe bound
    ]) {
      const probe = reader();
      probe.cloud.hooks.respond = respond;
      await expect(probe.reader.hasBots()).resolves.toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------

describe('Bot catalog import', () => {
  it('rejects an incomplete configuration', () => {
    const base = {
      dataDirectory: '/tmp/devryan-import-config-check',
      encryption: { getKey: async () => Buffer.alloc(32) },
      runMaintenance: async () => {},
      activationHold: { hold: async () => {}, get: () => null, reinstate: async () => null },
      readCloudSource: () => null,
      validateCandidate: async () => {},
    };
    expect(() => createBotCatalogImport(base)).not.toThrow();
    for (const override of [
      { dataDirectory: 'relative/data' },
      { dataDirectory: undefined },
      { encryption: {} },
      { runMaintenance: null },
      { activationHold: {} },
      // The merge saves and reinstates an earlier hold; both are required up front.
      { activationHold: { hold: async () => {} } },
      { readCloudSource: 'nope' },
      { validateCandidate: undefined },
    ]) {
      expect(() => createBotCatalogImport({ ...base, ...override })).toThrow(TypeError);
    }
    expect(() => createBotCatalogImport()).toThrow(TypeError);
  });

  it('reports an empty status until something happens', async () => {
    const { importer } = createHarness();
    const status = importer.status();
    expect(status).toEqual({ sourceConfigured: true, cloud: null, checking: false, import: null, pending: false });
    expect(Object.isFrozen(status)).toBe(true);
    expect(importer.running).toBe(false);
    await importer.initialize();
    expect(importer.status()).toEqual({ sourceConfigured: true, cloud: null, checking: false, import: null, pending: false });
    expect(await exists(importRoot)).toBe(false);
  });

  it('requires a valid mode and the owner writers-stopped confirmation before touching anything', async () => {
    const readCloudSource = vi.fn(() => ({ url: CLOUD_URL, secretKey: SECRET }));
    const { importer, cloud } = createHarness({ readCloudSource });
    for (const mode of [undefined, '', 'replace', 'EMPTY', 'Merge', 1]) {
      const error = await importer.start({ mode, writersStopped: true }).catch((caught) => caught);
      expect(error).toBeInstanceOf(BotCatalogImportError);
      expect(error).toMatchObject({ code: 'bot_import_mode_invalid', statusCode: 400 });
    }
    // The mode is checked first.
    await expect(importer.start({ mode: 'bad', writersStopped: false })).rejects.toMatchObject({ code: 'bot_import_mode_invalid' });
    for (const writersStopped of [undefined, false, 'true', 1, {}]) {
      for (const mode of ['empty', 'merge']) {
        await expect(importer.start({ mode, writersStopped })).rejects.toMatchObject({
          code: 'bot_import_writers_unconfirmed', statusCode: 400,
        });
      }
    }
    await expect(importer.start()).rejects.toMatchObject({ code: 'bot_import_mode_invalid' });
    expect(importer.running).toBe(false);
    expect(readCloudSource).not.toHaveBeenCalled();
    expect(cloud.fetchImpl).not.toHaveBeenCalled();
    expect(await exists(importRoot)).toBe(false);
  });

  describe('cloud probe and dismissal', () => {
    it('publishes pending discovery synchronously and settles both successful and failed probes', async () => {
      let resolve;
      let calls = 0;
      const fetchImpl = () => { calls += 1; return new Promise((done) => { resolve = done; }); };
      const { importer } = createHarness({ fetchImpl });
      const probe = importer.probeCloud();
      expect(importer.status()).toMatchObject({ checking: true, cloud: null });
      await importer.probeCloud();
      expect(calls).toBe(1);
      resolve(new Response(JSON.stringify([{ id: 'fixture-bot' }]), { status: 200 }));
      await probe;
      expect(importer.status()).toMatchObject({ checking: false, pending: true });
      const failing = createHarness({ fetchImpl: async () => new Response('{}', { status: 401 }) }).importer;
      await failing.probeCloud();
      expect(failing.status()).toMatchObject({ checking: false, cloud: { hasBots: null } });
      expect(failing.status().cloud.code).toBeTruthy();
    });

    it('reports no cloud when no hosted project is configured', async () => {
      const { importer, cloud } = createHarness({ readCloudSource: () => null });
      await expect(importer.probeCloud()).resolves.toEqual({
        sourceConfigured: false, cloud: null, checking: false, import: null, pending: false,
      });
      expect(cloud.fetchImpl).not.toHaveBeenCalled();
      // A source that cannot be read is reported as absent, never as an error.
      const broken = createHarness({ readCloudSource: () => { throw new Error('unreadable'); } }).importer;
      expect(broken.status()).toMatchObject({ sourceConfigured: false, cloud: null });
    });

    it('marks hosted Bots as pending import with a single allowlisted GET', async () => {
      const { importer, cloud } = createHarness();
      const status = await importer.probeCloud();
      expect(status).toEqual({
        sourceConfigured: true,
        cloud: { hasBots: true, checkedAt: '2026-09-26T12:00:00.000Z', code: null },
        checking: false,
        import: null,
        pending: true,
      });
      expect(cloud.requests).toHaveLength(1);
      expect(cloud.requests[0]).toMatchObject({ method: 'GET', path: '/rest/v1/bots', params: { select: 'id', limit: '1' } });
      expect(importer.status()).toEqual(status);
    });

    it('does not mark an empty hosted catalog as pending', async () => {
      const { importer } = createHarness({ cloud: { tables: { ...cloudTables(), bots: [] } } });
      await expect(importer.probeCloud()).resolves.toMatchObject({ cloud: { hasBots: false, code: null }, pending: false });
    });

    it('keeps the last known answer and records the code when the probe fails', async () => {
      const { importer, cloud } = createHarness();
      await importer.probeCloud();
      clock += 60_000;
      cloud.hooks.respond = () => statusResponse(402);
      await expect(importer.probeCloud()).resolves.toEqual({
        sourceConfigured: true,
        cloud: { hasBots: true, checkedAt: '2026-09-26T12:01:00.000Z', code: 'bot_import_source_quota_exceeded' },
        checking: false,
        import: null,
        pending: true,
      });

      const fresh = createHarness({ readCloudSource: () => ({ url: 'not a url', secretKey: SECRET }) });
      await expect(fresh.importer.probeCloud()).resolves.toMatchObject({
        cloud: { hasBots: null, code: 'bot_import_source_unconfigured' }, pending: false,
      });
    });

    it('dismisses the pending notice persistently and privately', async () => {
      const { importer } = createHarness();
      await importer.probeCloud();
      const status = await importer.dismiss();
      expect(status.pending).toBe(false);
      expect(status.import).toMatchObject({ mode: null, phase: 'dismissed', running: false, tables: 0, pages: 0, objects: 0 });
      expect(status.import.id).toMatch(/^[0-9a-f-]{36}$/);

      const saved = await readState();
      expect(saved).toMatchObject({ version: 1, id: status.import.id, mode: null, phase: 'dismissed', updatedAt: '2026-09-26T12:00:00.000Z' });
      expect((await fs.stat(statePath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(importRoot)).mode & 0o777).toBe(0o700);
      expect((await fs.readdir(importRoot)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

      // Survives a restart: the hosted Bots stay in the cloud without a notice.
      const restarted = createHarness();
      await restarted.importer.initialize();
      await restarted.importer.probeCloud();
      expect(restarted.importer.status()).toMatchObject({ import: { phase: 'dismissed' }, pending: false });

      // The owner going to look for them outranks the earlier dismissal,
      // until they dismiss the notice again.
      await expect(restarted.importer.probeCloud({ requested: true })).resolves.toMatchObject({
        import: { phase: 'dismissed' }, pending: true,
      });
      await expect(restarted.importer.probeCloud()).resolves.toMatchObject({ pending: true });
      await expect(restarted.importer.dismiss()).resolves.toMatchObject({ pending: false });
    });
  });

  describe('export and verification', () => {
    it('exports, seals and verifies a hosted snapshot before loading it', async () => {
      const { importer, cloud, host, scripts, phases, activationHold, options } = createHarness();
      const started = await importer.start({ mode: 'merge', writersStopped: true });
      expect(started.import).toMatchObject({ mode: 'merge', running: true });
      expect(importer.running).toBe(true);
      const status = await settle(importer);

      expect(phases).toEqual([
        'connecting', 'preparing_source', 'exporting', 'exporting_objects', 'verifying', 'loading_source', 'failed',
      ]);
      expect(status.import).toMatchObject({
        mode: 'merge',
        phase: 'failed',
        running: false,
        tables: 3,
        pages: 4,
        objects: 1,
        error: {
          code: SOURCE_LOAD_FAILURE.code,
          message: SOURCE_LOAD_FAILURE.message,
          retryable: false,
          report: null,
          at: '2026-09-26T12:00:00.000Z',
        },
        result: null,
      });

      // The host prepared and then dropped the source database; nothing merged.
      expect(host.createImportSource).toHaveBeenCalledWith(MARKER);
      expect(host.dropImportSource).toHaveBeenCalledTimes(1);
      expect(host.dropImportSource).toHaveBeenCalledWith('source-handle');
      expect(options.runMaintenance).not.toHaveBeenCalled();
      expect(options.validateCandidate).not.toHaveBeenCalled();
      expect(activationHold.hold).not.toHaveBeenCalled();

      // The cloud saw only allowlisted GETs, with the secret as apikey.
      const allowed = new Set([
        '/rest/v1/rpc/devryan_bot_schema_version', '/rest/v1/bots', '/rest/v1/bot_audit_events',
        '/rest/v1/bot_objects', '/rest/v1/user_profiles', `/storage/v1/object/devryan-bot-objects/objects/${LIVE_OBJECT_FILE}`,
      ]);
      for (const request of cloud.requests) {
        expect(request.method).toBe('GET');
        expect(allowed.has(request.path)).toBe(true);
        expect(request.headers.apikey).toBe(SECRET);
      }
      const exporting = cloud.requests.filter((request) => request.phase === 'exporting');
      expect(exporting.map((request) => [request.path, request.params.or ?? null])).toEqual([
        ['/rest/v1/bots', null],
        ['/rest/v1/bots', `(id.gt.${BOT_B})`],
        ['/rest/v1/bot_audit_events', null],
        ['/rest/v1/bot_audit_events', '(id.gt.9007199254740995)'],
        ['/rest/v1/bot_objects', null],
        ['/rest/v1/bot_objects', `(id.gt.${DELETED_OBJECT_ROW})`],
        ['/rest/v1/user_profiles', null],
      ]);
      expect(exporting[0].params).toEqual({ select: 'id,name,created_by,__k0:id::text', order: 'id.asc', limit: '500' });
      expect(exporting[6].params).toEqual({ select: PROFILE_SELECT, id: `in.(${OWNER})`, order: 'id.asc' });
      // Only the live object is downloaded.
      expect(cloud.requests.filter((request) => request.phase === 'exporting_objects').map((request) => request.path)).toEqual([
        `/storage/v1/object/devryan-bot-objects/objects/${LIVE_OBJECT_FILE}`,
      ]);
      // Verification re-reads every stored page, every table tail, identities and the marker.
      const verifying = cloud.requests.filter((request) => request.phase === 'verifying');
      expect(verifying.map((request) => [request.path, request.params.limit ?? null, request.params.or ?? null])).toEqual([
        ['/rest/v1/bots', '500', null],
        ['/rest/v1/bots', '1', `(id.gt.${BOT_B})`],
        ['/rest/v1/bot_audit_events', '500', null],
        ['/rest/v1/bot_audit_events', '1', '(id.gt.9007199254740995)'],
        ['/rest/v1/bot_objects', '500', null],
        ['/rest/v1/bot_objects', '1', `(id.gt.${DELETED_OBJECT_ROW})`],
        ['/rest/v1/user_profiles', null, null],
        ['/rest/v1/rpc/devryan_bot_schema_version', null, null],
      ]);

      // Checkpointed state: hashes and keys only, never row contents.
      const saved = await readState();
      const stateText = await fs.readFile(statePath, 'utf8');
      expect(stateText).not.toContain('Cloud one');
      expect(stateText).not.toContain('owner@example.test');
      expect(saved).toMatchObject({
        version: 1,
        id: status.import.id,
        mode: 'merge',
        phase: 'failed',
        source: { project: sha256(CLOUD_URL), marker: MARKER },
        objects: {
          complete: true,
          entries: [{ id: LIVE_OBJECT_ROW, file: LIVE_OBJECT_FILE, bytes: OBJECT_BYTES.byteLength, sha256: sha256(OBJECT_BYTES) }],
        },
      });
      expect(saved.tables.bots).toMatchObject({
        complete: true,
        columns: ['id', 'name', 'created_by'],
        orderColumns: ['id'],
        limit: 500,
        terminalAfter: [BOT_B],
        pages: [{ index: 0, rows: 2, after: null, last: [BOT_B], limit: 500 }],
      });
      expect(saved.tables.bot_audit_events).toMatchObject({
        complete: true,
        terminalAfter: ['9007199254740995'],
        pages: [{ index: 0, rows: 2, after: null, last: ['9007199254740995'] }],
      });
      expect(saved.tables.__identities).toMatchObject({ complete: true, pages: [{ index: 0, ids: [OWNER] }] });

      // Pages are sealed per import, group and index, privately on disk.
      const id = saved.id;
      for (const [group, entry] of [
        ['bots', saved.tables.bots.pages[0]],
        ['bot_audit_events', saved.tables.bot_audit_events.pages[0]],
        ['bot_objects', saved.tables.bot_objects.pages[0]],
        ['__identities', saved.tables.__identities.pages[0]],
      ]) {
        const file = pagePath(id, group, entry.index);
        const ciphertext = await fs.readFile(file);
        expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
        const plaintext = await decryptPage(id, group, entry);
        expect(sha256(plaintext)).toBe(entry.sha256);
        expect(plaintext.byteLength).toBe(entry.bytes);
        expect(ciphertext.includes(plaintext.subarray(0, 16))).toBe(false);
        await expect(decryptPage(id, group, entry, { aadIndex: entry.index + 1 })).rejects.toThrow();
      }
      const auditPage = (await decryptPage(id, 'bot_audit_events', saved.tables.bot_audit_events.pages[0])).toString('utf8');
      expect(auditPage).toContain('"id":9007199254740993,');
      expect(auditPage).toContain('"__k0":"9007199254740995"');
      const botsPage = (await decryptPage(id, 'bots', saved.tables.bots.pages[0])).toString('utf8');
      expect(JSON.parse(botsPage).map((row) => row.name)).toEqual(['Cloud one', 'Cloud two']);
      expect((await fs.readFile(pagePath(id, 'bots', 0))).includes(Buffer.from('Cloud one'))).toBe(false);
      const identities = (await decryptPage(id, '__identities', saved.tables.__identities.pages[0])).toString('utf8');
      expect(identities).not.toContain('never-exported');

      // Downloaded object ciphertext is kept privately beside the pages.
      const objectFile = path.join(importRoot, id, 'objects', LIVE_OBJECT_FILE);
      expect(await fs.readFile(objectFile)).toEqual(OBJECT_BYTES);
      expect((await fs.stat(objectFile)).mode & 0o777).toBe(0o600);
      expect(await fs.readdir(path.join(importRoot, id, 'objects'))).toEqual([LIVE_OBJECT_FILE]);

      // The source load streams the decrypted pages into the source database.
      expect(scripts).toHaveLength(1);
      expect(scripts[0].target).toEqual({ kind: 'source', handle: 'source-handle' });
      expect(scripts[0].text.startsWith('\\set ON_ERROR_STOP 1\nbegin;')).toBe(true);
      expect(scripts[0].text).toContain('disable trigger "user_profiles_require_active_assignment"');
      expect(scripts[0].text).toContain(botsPage);
      expect(scripts[0].text).toContain(auditPage);
      expect(scripts[0].text).toContain(identities);
      expect(scripts[0].text.trimEnd().endsWith('commit;')).toBe(true);
    });

    it('halves the page size for oversized pages and keeps large keys exact across pages', async () => {
      const { importer, cloud } = createHarness();
      cloud.hooks.respond = (url) => (
        url.pathname === '/rest/v1/bot_audit_events' && Number(url.searchParams.get('limit')) > 1 ? oversizedResponse() : null
      );
      const status = await runImport(importer);
      expect(status.import.error.code).toBe(SOURCE_LOAD_FAILURE.code);

      const audit = cloud.requests.filter((request) => request.phase === 'exporting' && request.path === '/rest/v1/bot_audit_events');
      expect(audit.map((request) => request.params.limit)).toEqual([
        '500', '250', '125', '62', '31', '15', '7', '3', '1', '1', '1',
      ]);
      expect(audit.slice(-2).map((request) => request.params.or)).toEqual([
        '(id.gt.9007199254740993)',
        '(id.gt.9007199254740995)',
      ]);
      const saved = await readState();
      expect(saved.tables.bot_audit_events).toMatchObject({
        complete: true,
        limit: 1,
        terminalAfter: ['9007199254740995'],
        pages: [
          { index: 0, rows: 1, after: null, last: ['9007199254740993'], limit: 1 },
          { index: 1, rows: 1, after: ['9007199254740993'], last: ['9007199254740995'], limit: 1 },
        ],
      });
      // Other tables keep the initial page size.
      expect(saved.tables.bots.limit).toBe(500);
    });

    it('fails explicitly when a single row exceeds the page bound', async () => {
      const { importer, cloud, host } = createHarness();
      cloud.hooks.respond = (url) => (url.pathname === '/rest/v1/bots' ? oversizedResponse() : null);
      const status = await runImport(importer);
      expect(status.import).toMatchObject({ phase: 'failed', error: { code: 'bot_import_row_too_large', retryable: false } });
      expect(cloud.requests.filter((request) => request.path === '/rest/v1/bots').map((request) => request.params.limit))
        .toEqual(['500', '250', '125', '62', '31', '15', '7', '3', '1']);
      expect(host.runImportSql).not.toHaveBeenCalled();
      expect(host.dropImportSource).toHaveBeenCalledWith('source-handle');
    });

    it('rejects malformed cloud pages without storing them', async () => {
      for (const body of [
        '{"rows":[]}',
        '[not json',
        `[{"id":"${BOT_A}"}]`,
        '[{"id":"x","__k0":"1,id.gt.0"}]',
        '[{"id":"x","__k0":null}]',
        '[{"id":"x",\n"__k0":"1"}]',
        '[',
      ]) {
        await fs.rm(importRoot, { recursive: true, force: true });
        const { importer, cloud, host } = createHarness();
        cloud.hooks.respond = (url) => (url.pathname === '/rest/v1/bots' ? rawResponse(body) : null);
        const status = await runImport(importer);
        expect({ body, phase: status.import.phase, code: status.import.error.code }).toEqual({
          body, phase: 'failed', code: 'bot_import_page_invalid',
        });
        expect(status.import.pages).toBe(0);
        expect(await exists(path.join(importRoot, status.import.id, 'pages'))).toBe(false);
        expect(host.runImportSql).not.toHaveBeenCalled();
      }
    });

    it('refuses an unreviewed or missing cloud schema before preparing a source database', async () => {
      for (const cloudOptions of [{ marker: '19990101000000' }, { marker: 'supabase:20260908182901' }]) {
        const { importer, host } = createHarness({ cloud: cloudOptions });
        const status = await runImport(importer);
        expect(status.import).toMatchObject({ phase: 'failed', error: { code: 'bot_import_source_schema_unsupported' } });
        expect(host.createImportSource).not.toHaveBeenCalled();
      }
      const { importer, cloud, host } = createHarness();
      cloud.hooks.respond = (url) => (url.pathname.includes('/rpc/') ? statusResponse(404) : null);
      const status = await runImport(importer);
      expect(status.import.error.code).toBe('bot_import_source_schema_unsupported');
      expect(host.createImportSource).not.toHaveBeenCalled();
    });

    it('fails when no hosted project is configured or the credentials are rejected', async () => {
      const unconfigured = createHarness({ readCloudSource: () => null });
      const first = await runImport(unconfigured.importer);
      expect(first.import).toMatchObject({ phase: 'failed', error: { code: 'bot_import_source_unconfigured' } });
      expect(unconfigured.cloud.fetchImpl).not.toHaveBeenCalled();

      await fs.rm(importRoot, { recursive: true, force: true });
      const rejected = createHarness();
      rejected.cloud.hooks.respond = () => statusResponse(401);
      const second = await runImport(rejected.importer);
      expect(second.import).toMatchObject({ phase: 'failed', error: { code: 'bot_import_source_forbidden', retryable: false } });
    });

    it('rejects equal-count drift between export and verification', async () => {
      const { importer, cloud, host } = createHarness({
        recordDiagnostic: (event) => {
          if (event.payload.phase === 'verifying') cloud.tables.bots[0] = { ...cloud.tables.bots[0], name: 'Renamed' };
        },
      });
      const status = await runImport(importer);
      expect(status.import).toMatchObject({
        phase: 'failed', error: { code: 'bot_import_source_changed', retryable: false, report: { table: 'bots' } },
      });
      expect(host.runImportSql).not.toHaveBeenCalled();
    });

    it('rejects rows added after a table finished exporting', async () => {
      const { importer, cloud, host } = createHarness({
        recordDiagnostic: (event) => {
          if (event.payload.phase === 'verifying') {
            cloud.tables.bot_audit_events.push({ id: 9007199254740999n, bot_id: BOT_A, action: 'bot.renamed' });
          }
        },
      });
      const status = await runImport(importer);
      expect(status.import).toMatchObject({
        phase: 'failed', error: { code: 'bot_import_source_changed', report: { table: 'bot_audit_events' } },
      });
      expect(host.runImportSql).not.toHaveBeenCalled();
    });

    it('rejects identity changes during verification', async () => {
      const { importer, cloud } = createHarness({
        recordDiagnostic: (event) => {
          if (event.payload.phase === 'verifying') cloud.tables.user_profiles[0].display_name = 'Changed';
        },
      });
      const status = await runImport(importer);
      expect(status.import.error).toMatchObject({ code: 'bot_import_source_changed', report: { table: 'user_profiles' } });
    });

    it('requires a profile for every referenced account', async () => {
      const { importer, host } = createHarness({ cloud: { tables: { ...cloudTables(), user_profiles: [] } } });
      const status = await runImport(importer);
      expect(status.import).toMatchObject({
        phase: 'failed', error: { code: 'bot_import_identity_missing', report: { missingCount: 1 } },
      });
      expect(host.runImportSql).not.toHaveBeenCalled();
    });

    it('requires every live object to exist and match its record', async () => {
      const missing = createHarness({ cloud: { objects: new Map() } });
      const first = await runImport(missing.importer);
      expect(first.import.error).toMatchObject({ code: 'bot_import_object_missing', report: { objectCount: 1 } });

      await fs.rm(importRoot, { recursive: true, force: true });
      const tampered = createHarness({ cloud: { objects: new Map([[LIVE_OBJECT_FILE, Buffer.from('tampered-ciphertext-bytes-xxxxx')]]) } });
      const second = await runImport(tampered.importer);
      expect(second.import.error.code).toBe('bot_import_object_invalid');

      await fs.rm(importRoot, { recursive: true, force: true });
      const truncated = createHarness({ cloud: { objects: new Map([[LIVE_OBJECT_FILE, OBJECT_BYTES.subarray(1)]]) } });
      const third = await runImport(truncated.importer);
      expect(third.import.error.code).toBe('bot_import_object_invalid');
      expect(await exists(path.join(importRoot, third.import.id, 'objects', LIVE_OBJECT_FILE))).toBe(false);
    });

    it('fails closed without a usable encryption key and wipes key material after use', async () => {
      const provided = [];
      const shortKey = createHarness({
        encryption: { getKey: async () => { const key = Buffer.alloc(16, KEY_BYTE); provided.push(key); return key; } },
      });
      const first = await runImport(shortKey.importer);
      expect(first.import.error).toMatchObject({ code: 'bot_os_encryption_unavailable' });
      expect(first.import.pages).toBe(0);

      await fs.rm(importRoot, { recursive: true, force: true });
      const { importer } = createHarness({
        encryption: { getKey: async () => { const key = Buffer.alloc(32, KEY_BYTE); provided.push(key); return key; } },
      });
      const second = await runImport(importer);
      expect(second.import.error.code).toBe(SOURCE_LOAD_FAILURE.code);
      expect(provided.length).toBeGreaterThan(4);
      for (const key of provided) expect(key.every((byte) => byte === 0)).toBe(true);
    });
  });

  describe('blocking, resume and cancellation', () => {
    it('blocks resumably on a hosted quota response and resumes from its checkpoint after a restart', async () => {
      const first = createHarness();
      first.cloud.hooks.respond = (url) => (url.pathname === '/rest/v1/bot_objects' ? statusResponse(402) : null);
      const blocked = await runImport(first.importer);
      expect(blocked.import).toMatchObject({
        phase: 'blocked',
        running: false,
        error: {
          code: 'bot_import_source_quota_exceeded',
          retryable: true,
          message: 'The Supabase project is over its quota; local Bots stay usable and the import can resume later',
        },
      });
      expect(first.phases.at(-1)).toBe('blocked');
      expect(first.host.dropImportSource).toHaveBeenCalledWith('source-handle');
      const checkpoint = await readState();
      expect(checkpoint).toMatchObject({ phase: 'blocked', tables: { bots: { complete: true }, bot_audit_events: { complete: true } } });
      expect(checkpoint.tables.bot_objects).toMatchObject({ complete: false, pages: [] });
      const botsPageFile = pagePath(checkpoint.id, 'bots', 0);
      const botsPageBefore = await fs.readFile(botsPageFile);

      // A restart loads the checkpoint lazily and resumes the same import.
      const second = createHarness();
      expect(second.importer.status().import).toBeNull();
      await second.importer.initialize();
      expect(second.importer.status().import).toMatchObject({ id: checkpoint.id, phase: 'blocked', running: false });
      const resumed = await runImport(second.importer);
      expect(resumed.import).toMatchObject({ id: checkpoint.id, error: { code: SOURCE_LOAD_FAILURE.code } });
      const exported = second.cloud.requests.filter((request) => request.phase === 'exporting').map((request) => request.path);
      expect(exported).not.toContain('/rest/v1/bots');
      expect(exported).not.toContain('/rest/v1/bot_audit_events');
      expect(exported.filter((pathname) => pathname === '/rest/v1/bot_objects')).toHaveLength(2);
      const saved = await readState();
      expect(saved.tables.bots.pages).toEqual(checkpoint.tables.bots.pages);
      expect(await fs.readFile(botsPageFile)).toEqual(botsPageBefore);
    });

    it('authenticates stored pages when resuming', async () => {
      const first = createHarness();
      first.cloud.hooks.respond = (url) => (url.pathname === '/rest/v1/bot_objects' ? statusResponse(402) : null);
      await runImport(first.importer);
      const checkpoint = await readState();
      const file = pagePath(checkpoint.id, 'bots', 0);
      const bytes = await fs.readFile(file);
      bytes[0] ^= 0xff;
      await fs.writeFile(file, bytes);

      const second = createHarness();
      const status = await runImport(second.importer);
      expect(status.import).toMatchObject({ phase: 'failed', error: { code: 'bot_import_page_invalid' } });
      expect(second.host.runImportSql).not.toHaveBeenCalled();
    });

    it('refuses to resume against a different hosted project', async () => {
      const first = createHarness();
      first.cloud.hooks.respond = (url) => (url.pathname === '/rest/v1/bot_objects' ? statusResponse(402) : null);
      await runImport(first.importer);

      const second = createHarness({ readCloudSource: () => ({ url: 'https://other-ref.supabase.co', secretKey: SECRET }) });
      const status = await runImport(second.importer);
      expect(status.import).toMatchObject({ phase: 'failed', error: { code: 'bot_import_source_changed' } });
      expect(second.cloud.fetchImpl).not.toHaveBeenCalled();
      expect(second.host.createImportSource).not.toHaveBeenCalled();
    });

    it('starts a fresh import and discards old pages when the mode changes', async () => {
      const first = createHarness();
      first.cloud.hooks.respond = (url) => (url.pathname === '/rest/v1/bot_objects' ? statusResponse(402) : null);
      await runImport(first.importer, 'merge');
      const old = await readState();
      expect(await exists(path.join(importRoot, old.id))).toBe(true);

      const second = createHarness();
      second.cloud.hooks.respond = first.cloud.hooks.respond;
      const status = await runImport(second.importer, 'empty');
      expect(status.import.id).not.toBe(old.id);
      expect(status.import).toMatchObject({ mode: 'empty', phase: 'blocked' });
      expect(await exists(path.join(importRoot, old.id))).toBe(false);
      const exported = second.cloud.requests.filter((request) => request.phase === 'exporting').map((request) => request.path);
      expect(exported).toContain('/rest/v1/bots');
    });

    it('refuses dismiss and a second start while running; cancel stops at the next checkpoint', async () => {
      const { importer, cloud } = createHarness();
      await importer.probeCloud();
      const reached = deferred();
      const gate = deferred();
      cloud.hooks.respond = async (url) => {
        if (url.pathname === '/rest/v1/bot_audit_events') {
          reached.resolve();
          await gate.promise;
        }
        return null;
      };
      await importer.start({ mode: 'merge', writersStopped: true });
      await reached.promise;
      expect(importer.running).toBe(true);
      expect(importer.status().import.running).toBe(true);

      await expect(importer.dismiss()).rejects.toMatchObject({ code: 'bot_import_running', statusCode: 409 });
      await expect(importer.start({ mode: 'merge', writersStopped: true })).rejects.toMatchObject({ code: 'bot_import_running' });
      const id = importer.status().import.id;
      expect(await exists(path.join(importRoot, id, 'pages', 'bots'))).toBe(true);

      const cancelling = importer.cancel();
      gate.resolve();
      const status = await cancelling;
      expect(status.import).toMatchObject({ id, phase: 'cancelled', running: false, error: { code: 'bot_import_cancelled' } });
      expect(importer.running).toBe(false);
      expect(await exists(path.join(importRoot, id))).toBe(false);
      expect((await readState()).phase).toBe('cancelled');
      // The export stopped: bot_objects was never read.
      expect(cloud.requests.some((request) => request.path === '/rest/v1/bot_objects')).toBe(false);
      // A cancelled import still leaves the hosted Bots pending.
      expect(status.pending).toBe(true);

      // Dismissal is possible again once nothing runs.
      await expect(importer.dismiss()).resolves.toMatchObject({ import: { phase: 'dismissed' }, pending: false });
    });

    it('cancels a stopped import by removing its sealed pages', async () => {
      const first = createHarness();
      first.cloud.hooks.respond = (url) => (url.pathname === '/rest/v1/bot_objects' ? statusResponse(402) : null);
      await runImport(first.importer);
      const blocked = await readState();
      expect(await exists(path.join(importRoot, blocked.id, 'pages'))).toBe(true);

      const second = createHarness();
      const status = await second.importer.cancel();
      expect(status.import).toMatchObject({ id: blocked.id, phase: 'cancelled', running: false });
      expect(await exists(path.join(importRoot, blocked.id))).toBe(false);
      expect(await readState()).toMatchObject({ id: blocked.id, phase: 'cancelled' });

      // The next start is a new import.
      second.cloud.hooks.respond = first.cloud.hooks.respond;
      const restarted = await runImport(second.importer);
      expect(restarted.import.id).not.toBe(blocked.id);
    });

    it('treats cancel without any import as a no-op', async () => {
      const { importer } = createHarness();
      await expect(importer.cancel()).resolves.toEqual({
        sourceConfigured: true, cloud: null, checking: false, import: null, pending: false,
      });
      expect(await exists(importRoot)).toBe(false);
    });

    it('lets exactly one of two concurrent starts run', async () => {
      const { importer, host } = createHarness();
      const results = await Promise.allSettled([
        importer.start({ mode: 'merge', writersStopped: true }),
        importer.start({ mode: 'merge', writersStopped: true }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((result) => result.status === 'rejected').reason).toMatchObject({ code: 'bot_import_running' });
      await importer.cancel();
      expect(host.createImportSource.mock.calls.length).toBeLessThanOrEqual(1);
    });

    it('starts over from a fresh export after the hosted catalog changed', async () => {
      let drift = true;
      const { importer, cloud } = createHarness({
        recordDiagnostic: (event) => {
          if (drift && event.payload.phase === 'verifying') {
            cloud.tables.bots[0] = { ...cloud.tables.bots[0], name: 'Renamed' };
            drift = false;
          }
        },
      });
      cloud.hooks.respond = (url) => (url.pathname === '/rest/v1/bot_objects' ? statusResponse(402) : null);
      const failedStatus = await runImport(importer);
      // The 402 blocks first; clear it so the drift reaches verification.
      expect(failedStatus.import.phase).toBe('blocked');
      cloud.hooks.respond = null;
      const changed = await runImport(importer);
      expect(changed.import).toMatchObject({ phase: 'failed', error: { code: 'bot_import_source_changed' } });
      const retried = await runImport(importer);
      expect(retried.import.id).not.toBe(changed.import.id);
      expect(retried.import.error?.code).not.toBe('bot_import_source_changed');
      expect(await exists(path.join(importRoot, changed.import.id))).toBe(false);
    });

    it('ignores a state file whose id is not a UUID and never deletes outside its pages', async () => {
      await fs.mkdir(importRoot, { recursive: true });
      const sentinel = path.join(importRoot, '..', 'keep-me');
      await fs.writeFile(sentinel, 'x');
      await fs.writeFile(path.join(importRoot, 'state.v1.json'), JSON.stringify({ version: 1, id: '..', phase: 'blocked', mode: 'merge', tables: {} }));
      const { importer } = createHarness();
      await expect(importer.cancel()).resolves.toMatchObject({ import: null });
      expect(await exists(sentinel)).toBe(true);
    });

    it('keeps a dismissal when cancel is pressed afterwards', async () => {
      const { importer } = createHarness();
      await importer.dismiss();
      const status = await importer.cancel();
      expect(status.import.phase).toBe('dismissed');
      expect(status.pending).toBe(false);
    });

    it('starts a new import after a dismissal', async () => {
      const { importer, cloud } = createHarness();
      const dismissed = await importer.dismiss();
      cloud.hooks.respond = (url) => (url.pathname === '/rest/v1/bot_objects' ? statusResponse(402) : null);
      const status = await runImport(importer);
      expect(status.import.id).not.toBe(dismissed.import.id);
      expect(status.import).toMatchObject({ mode: 'merge', phase: 'blocked' });
    });
  });

  describe('merge guards (fake host)', () => {
    const sourceTables = () => {
      const { user_profiles: _profiles, ...rest } = cloudTables();
      return rest;
    };

    const exportPage = (rows, { columns, orderColumns, after, limit }) => {
      const [column] = orderColumns;
      const ordered = [...rows].sort((left, right) => compareValues(left[column], right[column]));
      const remaining = after ? ordered.filter((row) => compareValues(row[column], after[0]) > 0) : ordered;
      const page = remaining.slice(0, limit).map((row) => Object.fromEntries(columns.map((name) => [name, row[name] ?? null])));
      return { page: serialize(page), last: page.length ? orderColumns.map((name) => String(page.at(-1)[name])) : null };
    };

    const createMergeHarness = async ({
      localBots = [],
      commitError = null,
      mergedCounts = null,
      candidateSqlError = null,
      ...overrides
    } = {}) => {
      const candidateDirectory = path.join(dataDirectory, 'candidate');
      await fs.mkdir(path.join(candidateDirectory, 'objects'), { recursive: true });
      const source = sourceTables();
      const sourceCounts = Object.fromEntries(Object.entries(source).map(([name, rows]) => [name, rows.length]));
      const localCounts = { bots: localBots.length, bot_audit_events: 0, bot_objects: 0 };
      let candidateCountCalls = 0;
      const scripts = [];
      const candidate = {
        operationId: 'candidate-operation',
        objectsDirectory: path.join(candidateDirectory, 'objects'),
        hostStateDirectory: candidateDirectory,
      };
      const host = {
        createImportSource: vi.fn(async () => ({ handle: 'source-handle', catalog: CATALOG })),
        migrateImportSource: vi.fn(async () => ({ catalog: CATALOG })),
        runImportSql: vi.fn(async (target, chunks) => {
          scripts.push({ target, text: await collectScript(chunks) });
          if (target.kind === 'candidate' && candidateSqlError) throw candidateSqlError;
        }),
        exportImportPage: vi.fn(async (_target, request) => exportPage(source[request.table], request)),
        countRows: vi.fn(async (target) => {
          if (target.kind === 'source') return sourceCounts;
          candidateCountCalls += 1;
          if (candidateCountCalls === 1) return localCounts;
          return mergedCounts || Object.fromEntries(Object.keys(sourceCounts).map((name) => [
            name, (localCounts[name] || 0) + sourceCounts[name],
          ]));
        }),
        backup: vi.fn(async (options) => ({ id: 'backup-1', ...options })),
        prepareRestore: vi.fn(async () => candidate),
        readCandidate: vi.fn(async (_operationId, { afterId, limit }) => localBots
          .filter((id) => !afterId || id > afterId).sort().slice(0, limit).map((id) => ({ id }))),
        commitRestore: vi.fn(async () => {
          if (commitError) throw commitError;
          return { committed: true };
        }),
        discardCandidate: vi.fn(async () => {}),
        dropImportSource: vi.fn(async () => {}),
      };
      const markReplaced = vi.fn();
      const runMaintenance = vi.fn(async (_kind, operation) => operation({ markReplaced }));
      const validateCandidate = vi.fn(async () => ({
        envelopes: 3,
        objects: 1,
        disconnected: { credentials: [], environmentSecrets: [], telegramConnections: [] },
      }));
      const onImported = vi.fn(async () => {});
      const harness = createHarness({
        host,
        runMaintenance,
        validateCandidate,
        onImported,
        resolveVerifiedSourceOwner: async () => OWNER,
        ...overrides,
      });
      return { ...harness, host, scripts, candidate, markReplaced, runMaintenance, validateCandidate, onImported };
    };

    it('merges disjoint hosted Bots under a hold and cleans up the sealed pages', async () => {
      const merge = await createMergeHarness({ localBots: ['a0000000-0000-4000-8000-000000000001'] });
      await merge.importer.probeCloud();
      const status = await runImport(merge.importer);
      expect(status.import).toMatchObject({
        phase: 'completed',
        error: null,
        result: {
          importedBotCount: 2,
          envelopes: 3,
          objects: 1,
          disconnected: { credentials: 0, environmentSecrets: 0, telegramConnections: 0 },
        },
      });
      expect(status.pending).toBe(false);
      expect(merge.phases.slice(-3)).toEqual(['loading_source', 'merging', 'completed']);

      expect(merge.runMaintenance).toHaveBeenCalledWith('import', expect.any(Function), {
        drainTimeoutMs: 120_000, replacesDatabase: true,
      });
      expect(merge.host.backup).toHaveBeenCalledWith({ kind: 'pre_import' });
      expect(merge.host.prepareRestore).toHaveBeenCalledWith('backup-1');
      expect(merge.validateCandidate).toHaveBeenCalledWith(merge.candidate, { missingVaultRecord: 'disconnect' });

      // Nothing autonomous runs until the owner resumes: the hold precedes the commit.
      const stateId = status.import.id;
      expect(merge.activationHold.hold).toHaveBeenCalledWith({ reason: 'import', operationId: stateId });
      expect(merge.activationHold.hold.mock.invocationCallOrder[0])
        .toBeLessThan(merge.host.commitRestore.mock.invocationCallOrder[0]);
      expect(merge.host.commitRestore).toHaveBeenCalledWith('candidate-operation');
      expect(merge.markReplaced).toHaveBeenCalledTimes(1);
      expect(merge.host.discardCandidate).not.toHaveBeenCalled();
      expect(merge.activationHold.release).not.toHaveBeenCalled();
      expect(merge.activationHold.reinstate).not.toHaveBeenCalled();
      expect(merge.onImported).toHaveBeenCalledTimes(1);
      expect(merge.host.dropImportSource).toHaveBeenCalledTimes(1);
      // The hold is the private host file, so it survives a restart.
      expect(createBotActivationHold({ dataDirectory }).get()).toMatchObject({ reason: 'import', operationId: stateId });

      // The merge regenerates audit identities and maps the verified owner.
      const mergeScript = merge.scripts.find((script) => script.target.kind === 'candidate');
      expect(mergeScript.target).toEqual({ kind: 'candidate', operationId: 'candidate-operation' });
      expect(mergeScript.text).toContain('insert into public."bot_audit_events" ("bot_id", "action")');
      expect(mergeScript.text).toContain('9007199254740993');
      for (const botId of [BOT_A, BOT_B]) {
        expect(mergeScript.text).toContain(`select '${botId}'::uuid, '${OWNER}'::uuid`);
      }

      // The object was copied privately into the candidate; the import directory is gone.
      const copied = path.join(merge.candidate.objectsDirectory, LIVE_OBJECT_FILE);
      expect(await fs.readFile(copied)).toEqual(OBJECT_BYTES);
      expect((await fs.stat(copied)).mode & 0o777).toBe(0o600);
      expect(await exists(path.join(importRoot, stateId))).toBe(false);
      expect(await readState()).toMatchObject({ phase: 'completed' });

      // A completed import is never cancelled; the next start is a new import.
      await expect(merge.importer.cancel()).resolves.toMatchObject({ import: { phase: 'completed' } });
    });

    it('refuses an empty-mode import into a catalog that already has Bots', async () => {
      const merge = await createMergeHarness({ localBots: ['a0000000-0000-4000-8000-000000000001'] });
      const status = await runImport(merge.importer, 'empty');
      expect(status.import).toMatchObject({ phase: 'failed', error: { code: 'bot_import_local_not_empty' } });
      expect(merge.host.discardCandidate).toHaveBeenCalledWith('candidate-operation');
      expect(merge.host.commitRestore).not.toHaveBeenCalled();
      expect(merge.activationHold.hold).not.toHaveBeenCalled();
      expect(merge.scripts.map((script) => script.target.kind)).toEqual(['source']);
      expect(merge.onImported).not.toHaveBeenCalled();
    });

    it('aborts when a hosted Bot already exists locally', async () => {
      const merge = await createMergeHarness({ localBots: [BOT_A, 'a0000000-0000-4000-8000-000000000001'] });
      const status = await runImport(merge.importer);
      expect(status.import).toMatchObject({
        phase: 'failed',
        error: { code: 'bot_import_bot_conflict', report: { conflictCount: 1, botIds: [BOT_A] } },
      });
      expect(merge.host.discardCandidate).toHaveBeenCalledTimes(1);
      expect(merge.host.commitRestore).not.toHaveBeenCalled();
      expect(merge.activationHold.hold).not.toHaveBeenCalled();
    });

    it('reports a merge SQL failure as a row conflict with a bounded detail', async () => {
      const merge = await createMergeHarness({
        candidateSqlError: Object.assign(new Error('psql failed'), { diagnostics: { detail: `Key (id)=(x) exists${'!'.repeat(400)}` } }),
      });
      const status = await runImport(merge.importer);
      expect(status.import.error).toMatchObject({ code: 'bot_import_conflict' });
      expect(status.import.error.report.detail).toHaveLength(300);
      expect(status.import.error.report.detail.startsWith('Key (id)=(x) exists')).toBe(true);
      expect(merge.host.discardCandidate).toHaveBeenCalledTimes(1);
      expect(merge.activationHold.hold).not.toHaveBeenCalled();
    });

    it('refuses a merged inventory that does not add up', async () => {
      const merge = await createMergeHarness({ mergedCounts: { bots: 2, bot_audit_events: 2, bot_objects: 2 }, localBots: ['a0000000-0000-4000-8000-000000000001'] });
      const status = await runImport(merge.importer);
      expect(status.import.error).toMatchObject({ code: 'bot_import_inventory_mismatch', report: { table: 'bots' } });
      expect(merge.activationHold.hold).not.toHaveBeenCalled();
      expect(merge.host.commitRestore).not.toHaveBeenCalled();
      expect(merge.host.discardCandidate).toHaveBeenCalledTimes(1);
    });

    it('lifts its own hold and discards the candidate when the commit fails', async () => {
      const commitError = Object.assign(new Error('commit failed'), { code: 'bot_restore_commit_failed' });
      const merge = await createMergeHarness({ commitError, resolveVerifiedSourceOwner: async () => 'not-a-uuid' });
      const status = await runImport(merge.importer);
      expect(status.import).toMatchObject({ phase: 'failed', error: { code: 'bot_restore_commit_failed' } });
      expect(merge.activationHold.hold).toHaveBeenCalledTimes(1);
      // No hold existed before the import, so reinstating "none" releases it.
      expect(merge.activationHold.reinstate).toHaveBeenCalledWith(null);
      expect(merge.activationHold.hold.mock.invocationCallOrder[0])
        .toBeLessThan(merge.activationHold.reinstate.mock.invocationCallOrder[0]);
      expect(createBotActivationHold({ dataDirectory }).isHeld()).toBe(false);
      expect(merge.host.discardCandidate).toHaveBeenCalledWith('candidate-operation');
      expect(merge.markReplaced).not.toHaveBeenCalled();
      expect(merge.onImported).not.toHaveBeenCalled();
      // An unverified source owner never becomes an owner mapping.
      const mergeScript = merge.scripts.find((script) => script.target.kind === 'candidate');
      expect(mergeScript.text).not.toContain('bot_local_owner_mappings');
      // The sealed pages stay for a retry.
      expect(await exists(path.join(importRoot, status.import.id, 'pages'))).toBe(true);
    });

    it('never lifts an earlier hold when the commit fails', async () => {
      const earlier = await createBotActivationHold({ dataDirectory }).hold({
        reason: 'restore', operationId: 'f0000000-0000-4000-8000-000000000001',
      });
      const commitError = Object.assign(new Error('commit failed'), { code: 'bot_restore_commit_failed' });
      const merge = await createMergeHarness({ commitError });
      const status = await runImport(merge.importer);
      expect(status.import.error.code).toBe('bot_restore_commit_failed');
      expect(merge.activationHold.hold).toHaveBeenCalledWith({ reason: 'import', operationId: status.import.id });
      expect(merge.activationHold.reinstate).toHaveBeenCalledWith(earlier);
      expect(merge.activationHold.release).not.toHaveBeenCalled();
      expect(createBotActivationHold({ dataDirectory }).get()).toEqual(earlier);
    });

    it('keeps an earlier hold untouched when the merge fails before holding', async () => {
      const earlier = await createBotActivationHold({ dataDirectory }).hold({
        reason: 'start_empty', operationId: 'f0000000-0000-4000-8000-000000000002',
      });
      const merge = await createMergeHarness({ localBots: [BOT_B] });
      const status = await runImport(merge.importer);
      expect(status.import.error.code).toBe('bot_import_bot_conflict');
      expect(merge.activationHold.hold).not.toHaveBeenCalled();
      expect(merge.activationHold.reinstate).not.toHaveBeenCalled();
      expect(createBotActivationHold({ dataDirectory }).get()).toEqual(earlier);
    });
  });
});
