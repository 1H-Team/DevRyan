import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  IMPORT_DISABLED_TRIGGERS,
  REVIEWED_SOURCE_SCHEMAS,
  assertPageBytes,
  planImportTables,
  renderIdentityInsert,
  renderLoadEpilogue,
  renderLoadPrelude,
  renderMergeFinalization,
  renderPageClose,
  renderPageInsert,
  renderPageOpen,
  renderSourceIdentityInsert,
} from '@openchamber/bot-db';

import { botObjectFileName } from './local-object-storage.js';
import { BOT_CATALOG_ENVELOPES } from './catalog-validation.js';
import { decryptBotJson } from './encryption.js';
import { CONFIGURATION_RESOURCE_COLUMNS, configurationResourceBlockers } from './configuration-readiness.js';

// One-time import of hosted (Supabase) Bots into the local catalog.
//
// The cloud is read through an exact GET-only allowlist and never written;
// Supabase is never enabled by an import. Raw JSON pages are stored
// encrypted and checkpointed, bound to the source project, schema marker and
// per-page content hashes; a complete re-read must reproduce every hash before
// anything is loaded, so equal-count drift is rejected. Pages are loaded into a
// temporary source database at the reviewed hosted schema, migrated to the
// release head, then merged into a verified snapshot of the local catalog
// under the maintenance fence. Local Bots are preserved; cloud Bots must be
// disjoint. Nothing autonomous runs until the owner resumes activation.

const STATE_VERSION = 1;
const MAX_PAGE_BYTES = 32 * 1024 * 1024;
const INITIAL_PAGE_ROWS = 500;
const MERGE_PAGE_ROWS = 500;
const MAX_OBJECT_BYTES = 25 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const RETRY_DELAYS_MS = Object.freeze([1_000, 4_000, 10_000]);
const IMPORT_DRAIN_MS = 120_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const KEY_VALUE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|\d{1,20})$/i;
const PROFILE_COLUMNS = Object.freeze(['id', 'email', 'display_name', 'account_kind', 'role', 'status']);
const SOURCE_LOAD_TRIGGERS = Object.freeze([
  ...IMPORT_DISABLED_TRIGGERS.load,
  // The staging database mirrors the hosted schema, whose shared-host
  // assignment rule (removed by the local identity additions) cannot hold for
  // identity projections without project grants.
  { table: 'user_profiles', trigger: 'user_profiles_require_active_assignment' },
]);

export class BotCatalogImportError extends Error {
  constructor(message, code, { statusCode = 409, retryable = false, report = null } = {}) {
    super(message);
    this.name = 'BotCatalogImportError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.report = report;
  }
}

const fail = (message, code, options) => {
  throw new BotCatalogImportError(message, code, options);
};

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// GET-only cloud reader. Every request is checked against the exact allowlist
// before it is sent; responses are bounded before allocation.
export function createCloudBotReader({ url, secretKey, fetchImpl = globalThis.fetch, allowedTables, wait = sleep,
  onDownloadedBytes = () => {} }) {
  let base;
  try {
    base = new URL(url);
  } catch {
    fail('The Supabase project URL is invalid', 'bot_import_source_unconfigured', { statusCode: 400 });
  }
  if (!['https:', 'http:'].includes(base.protocol) || typeof secretKey !== 'string' || !secretKey) {
    fail('The Supabase project is not configured', 'bot_import_source_unconfigured', { statusCode: 400 });
  }
  const tables = new Set(allowedTables || []);
  const headers = {
    Accept: 'application/json',
    apikey: secretKey,
    ...(secretKey.split('.').length === 3 ? { Authorization: `Bearer ${secretKey}` } : {}),
  };
  const allowed = (pathname) => (
    pathname === '/rest/v1/rpc/devryan_bot_schema_version'
    || (/^\/rest\/v1\/[a-z_]+$/.test(pathname) && tables.has(pathname.slice('/rest/v1/'.length)))
    || /^\/storage\/v1\/object\/devryan-bot-objects\/objects\/[0-9a-f-]{36}\.bin$/.test(pathname)
  );

  const readBounded = async (response, maximumBytes) => {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maximumBytes) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        onDownloadedBytes(value.byteLength);
        if (total > maximumBytes) {
          await reader.cancel().catch(() => undefined);
          return null;
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, total);
  };

  const get = async (pathname, search = '', { maximumBytes = MAX_PAGE_BYTES } = {}) => {
    if (!allowed(pathname)) fail('The import request is outside the read-only allowlist', 'bot_import_request_forbidden', { statusCode: 500 });
    const target = new URL(`${pathname}${search ? `?${search}` : ''}`, base);
    let lastError = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      if (attempt > 0) await wait(RETRY_DELAYS_MS[attempt - 1]);
      let response;
      try {
        response = await fetchImpl(target, { method: 'GET', headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (error) {
        lastError = error;
        continue;
      }
      if (response.status === 402) {
        await response.body?.cancel().catch(() => undefined);
        fail('The Supabase project is over its quota; local Bots stay usable and the import can resume later',
          'bot_import_source_quota_exceeded', { statusCode: 409, retryable: true });
      }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel().catch(() => undefined);
        lastError = new Error(`status ${response.status}`);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined);
        fail('The Supabase project rejected the import credentials', 'bot_import_source_forbidden');
      }
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return { status: 404, body: null };
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        fail(`The Supabase project returned ${response.status}`, 'bot_import_source_unavailable', { retryable: true });
      }
      const body = await readBounded(response, maximumBytes);
      return { status: response.status, body };
    }
    fail('The Supabase project is unreachable; the import can resume later', 'bot_import_source_unavailable', {
      retryable: true, report: { reason: lastError?.message || 'unreachable' },
    });
  };

  const keysetFilter = (orderColumns, after) => {
    if (!after) return null;
    const clauses = orderColumns.map((column, index) => {
      const equal = orderColumns.slice(0, index).map((prior, priorIndex) => `${prior}.eq.${after[priorIndex]}`);
      const greater = `${column}.gt.${after[index]}`;
      return equal.length ? `and(${[...equal, greater].join(',')})` : greater;
    });
    return `(${clauses.join(',')})`;
  };

  return Object.freeze({
    project: sha256(`${base.origin}${base.pathname.replace(/\/+$/, '')}`),
    async schemaMarker() {
      const { status, body } = await get('/rest/v1/rpc/devryan_bot_schema_version', '', { maximumBytes: 4096 });
      if (status === 404 || !body) fail('The cloud project has no Bot schema', 'bot_import_source_schema_unsupported');
      let marker;
      try {
        marker = JSON.parse(body.toString('utf8'));
      } catch {
        fail('The cloud Bot schema marker is invalid', 'bot_import_source_schema_unsupported');
      }
      return marker;
    },
    // One keyset page as raw bytes; __k* aliases carry the order keys as text.
    async page(table, { columns, orderColumns, after = null, limit, avatarIds = null }) {
      if (!tables.has(table) || !columns.every((column) => IDENTIFIER.test(column))
        || !orderColumns.every((column) => columns.includes(column))
        || (after && after.some((value) => !KEY_VALUE.test(value)))) {
        fail('The import page request is invalid', 'bot_import_request_forbidden', { statusCode: 500 });
      }
      const search = new URLSearchParams();
      if (avatarIds !== null) {
        if (table !== 'bot_objects' || !Array.isArray(avatarIds) || avatarIds.length > 100
          || avatarIds.some((id) => !UUID.test(id))) {
          fail('The avatar request is invalid', 'bot_import_request_forbidden', { statusCode: 500 });
        }
        if (avatarIds.length === 0) return Buffer.from('[]');
        search.set('id', `in.(${avatarIds.join(',')})`);
        search.set('visibility', 'eq.profile');
        search.set('channel_id', 'is.null');
        search.set('deleted_at', 'is.null');
      }
      search.set('select', [...columns, ...orderColumns.map((column, index) => `__k${index}:${column}::text`)].join(','));
      search.set('order', orderColumns.map((column) => `${column}.asc`).join(','));
      search.set('limit', String(limit));
      const filter = keysetFilter(orderColumns, after);
      if (filter) search.set('or', filter);
      const { status, body } = await get(`/rest/v1/${table}`, search.toString());
      if (status === 404) fail(`The cloud project has no ${table} table`, 'bot_import_source_schema_unsupported');
      return body; // null when the page exceeded the bound
    },
    async profiles(ids) {
      const unique = [...new Set(ids)].sort();
      if (unique.length < 1 || unique.length > 100 || unique.some((id) => !UUID.test(id))) {
        fail('The identity request is invalid', 'bot_import_request_forbidden', { statusCode: 500 });
      }
      const search = new URLSearchParams();
      search.set('select', PROFILE_COLUMNS.join(','));
      search.set('id', `in.(${unique.join(',')})`);
      search.set('order', 'id.asc');
      const { body } = await get('/rest/v1/user_profiles', search.toString());
      if (!body) fail('A cloud identity page exceeded its bound', 'bot_import_row_too_large');
      return body;
    },
    async object(file) {
      const { status, body } = await get(`/storage/v1/object/devryan-bot-objects/objects/${file}`, '', {
        maximumBytes: MAX_OBJECT_BYTES,
      });
      if (status === 404) return null;
      if (!body) fail('A cloud object exceeded its bound', 'bot_import_row_too_large');
      return body;
    },
    async hasBots() {
      const { status, body } = await get('/rest/v1/bots', 'select=id&limit=1', { maximumBytes: 4096 });
      if (status === 404 || !body) return false;
      try {
        return JSON.parse(body.toString('utf8')).length > 0;
      } catch {
        return false;
      }
    },
  });
}

export function createBotCatalogImport({
  dataDirectory,
  encryption,
  host,
  runMaintenance,
  activationHold,
  readCloudSource,
  resolveVerifiedSourceOwner = async () => null,
  validateCandidate,
  onImported = async () => {},
  recordDiagnostic = () => {},
  fetchImpl = globalThis.fetch,
  now = Date.now,
  wait = sleep,
} = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)
    || typeof encryption?.getKey !== 'function' || typeof runMaintenance !== 'function'
    || typeof activationHold?.hold !== 'function' || typeof activationHold?.get !== 'function'
    || typeof activationHold?.reinstate !== 'function' || typeof readCloudSource !== 'function'
    || typeof validateCandidate !== 'function') {
    throw new TypeError('Bot catalog import is misconfigured');
  }
  const root = path.join(dataDirectory, 'bots', 'import');
  const statePath = path.join(root, 'state.v1.json');
  let state = null;
  let running = null;
  // Set synchronously by start() so two concurrent starts cannot both pass.
  let starting = false;
  let cancelRequested = false;
  let cloudProbe = null;
  let checking = false;
  // The owner asked for a check in this process, which outranks an earlier
  // "Not Now": the Bots they went looking for must be importable.
  let requested = false;

  const privateDirectory = async (directory) => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
  };

  const loadState = async () => {
    if (state) return state;
    try {
      const parsed = JSON.parse(await fs.readFile(statePath, 'utf8'));
      // The id names the page directory that cancel and restart delete.
      state = parsed?.version === STATE_VERSION && UUID.test(parsed.id || '') ? parsed : null;
    } catch {
      state = null;
    }
    return state;
  };

  const saveState = async () => {
    state.updatedAt = new Date(now()).toISOString();
    await privateDirectory(root);
    const temporary = `${statePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, statePath);
  };

  const withKey = async (operation) => {
    const provided = await encryption.getKey();
    const key = Buffer.from(provided || []);
    try {
      if (key.byteLength !== 32) fail('The Bot encryption key is unavailable', 'bot_os_encryption_unavailable', { statusCode: 503 });
      return await operation(key);
    } finally {
      key.fill(0);
      if (Buffer.isBuffer(provided) || provided instanceof Uint8Array) provided.fill(0);
    }
  };

  const pageKey = (key) => Buffer.from(crypto.hkdfSync('sha256', key, Buffer.from(state.id, 'utf8'),
    Buffer.from('devryan-bot-import/v1/page', 'utf8'), 32));
  const pageAad = (group, index) => Buffer.from(`devryan-bot-import:${state.id}:${group}:${index}`, 'utf8');
  const pageFile = (group, index) => path.join(root, state.id, 'pages', group, `${String(index).padStart(6, '0')}.enc`);

  const storePage = (group, index, bytes) => withKey(async (key) => {
    const derived = pageKey(key);
    try {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', derived, iv);
      cipher.setAAD(pageAad(group, index));
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
      const file = pageFile(group, index);
      await privateDirectory(path.dirname(file));
      await fs.writeFile(file, ciphertext, { mode: 0o600 });
      return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
    } finally {
      derived.fill(0);
    }
  });

  const readPage = (group, entry) => withKey(async (key) => {
    const derived = pageKey(key);
    try {
      const ciphertext = await fs.readFile(pageFile(group, entry.index));
      const decipher = crypto.createDecipheriv('aes-256-gcm', derived, Buffer.from(entry.iv, 'base64'));
      decipher.setAAD(pageAad(group, entry.index));
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      const bytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (sha256(bytes) !== entry.sha256) fail('A stored import page is corrupt', 'bot_import_page_invalid');
      return bytes;
    } catch (error) {
      if (error instanceof BotCatalogImportError) throw error;
      fail('A stored import page failed authentication', 'bot_import_page_invalid');
    } finally {
      derived.fill(0);
    }
  });

  const parseRows = (bytes) => {
    try {
      const rows = JSON.parse(bytes.toString('utf8'));
      if (!Array.isArray(rows)) throw new Error('not an array');
      return rows;
    } catch {
      fail('A cloud page is not a JSON array', 'bot_import_page_invalid');
    }
  };

  const checkCancelled = () => {
    if (cancelRequested) fail('The import was cancelled', 'bot_import_cancelled');
  };

  const setPhase = async (phase, extra = {}) => {
    state.phase = phase;
    Object.assign(state, extra);
    await saveState();
    recordDiagnostic({ type: 'lifecycle', event: 'bot.catalog.import', payload: { phase } });
  };

  // Pages one table from the cloud, resuming from its checkpoint. A row that
  // cannot fit the bound even alone fails explicitly.
  const exportTable = async (reader, group, table, { columns, orderColumns, avatarIds = null }) => {
    const entry = state.tables[group] ||= { pages: [], complete: false, table, columns, orderColumns,
      ...(avatarIds === null ? {} : { avatarIds }) };
    while (!entry.complete) {
      checkCancelled();
      const after = entry.pages.at(-1)?.last || null;
      let limit = entry.limit || INITIAL_PAGE_ROWS;
      let bytes = null;
      for (;;) {
        bytes = await reader.page(table, { columns, orderColumns, after, limit, avatarIds: entry.avatarIds ?? null });
        if (bytes) break;
        if (limit === 1) fail(`A ${table} row exceeds the ${MAX_PAGE_BYTES}-byte import bound`, 'bot_import_row_too_large');
        limit = Math.max(1, Math.floor(limit / 2));
      }
      assertPageBytes(bytes);
      const rows = parseRows(bytes);
      if (rows.length === 0) {
        entry.complete = true;
        entry.terminalAfter = after;
        await saveState();
        break;
      }
      const last = orderColumns.map((_, index) => rows.at(-1)[`__k${index}`]);
      if (last.some((value) => typeof value !== 'string' || !KEY_VALUE.test(value))) {
        fail(`A ${table} page has invalid order keys`, 'bot_import_page_invalid');
      }
      const index = entry.pages.length;
      const sealed = await storePage(group, index, bytes);
      entry.pages.push({ index, sha256: sha256(bytes), bytes: bytes.byteLength, rows: rows.length, after, last, limit, ...sealed });
      entry.limit = limit;
      await saveState();
    }
  };

  const tableEntries = (table) => Object.entries(state.tables).filter(([group, entry]) => (
    (entry.table || group) === table
  ));

  async function* exportedRows(table) {
    for (const [group, entry] of tableEntries(table)) {
      for (const page of entry.pages) {
        for (const row of parseRows(await readPage(group, page))) yield row;
      }
    }
  }

  const exportAvatars = async (reader, table) => {
    const avatars = new Map();
    for await (const bot of exportedRows('bots')) {
      if (bot.avatar_object_id === null || bot.avatar_object_id === undefined) continue;
      if (!UUID.test(bot.avatar_object_id) || avatars.has(bot.avatar_object_id)) {
        fail('A cloud Bot avatar pointer is invalid', 'bot_import_object_invalid');
      }
      avatars.set(bot.avatar_object_id, bot.id);
    }
    const ids = [...avatars.keys()].sort();
    // Empty avatar sets issue no object-table request. Batches keep PostgREST
    // URLs bounded; their exact filters persist with each checkpoint.
    for (let offset = 0; offset < Math.max(1, ids.length); offset += 100) {
      await exportTable(reader, `bot_objects__avatars_${offset}`, 'bot_objects', {
        columns: table.columns, orderColumns: table.primaryKey, avatarIds: ids.slice(offset, offset + 100),
      });
    }
    const found = new Set();
    for await (const row of exportedRows('bot_objects')) {
      if (!avatars.has(row.id) || avatars.get(row.id) !== row.bot_id || row.visibility !== 'profile'
        || row.channel_id !== null || row.deleted_at !== null
        || !['image/png', 'image/jpeg', 'image/webp'].includes(row.content_type)) {
        fail('A cloud Bot avatar record is invalid', 'bot_import_object_invalid');
      }
      found.add(row.id);
    }
    if (found.size !== avatars.size) fail('A cloud Bot avatar is missing', 'bot_import_object_missing');
  };

  const verifyConfigurationKey = () => withKey(async (key) => {
    for (const spec of BOT_CATALOG_ENVELOPES.filter((entry) => (
      ['bot_objects', 'bot_mcp_bindings'].includes(entry.table)
    ))) {
      for await (const row of exportedRows(spec.table)) {
        for (const envelope of spec.envelopes) {
          try {
            decryptBotJson({ key, envelope: envelope.read(row), expectedKeyId: 'deployment-v1', associatedData: envelope.aad(row) });
          } catch {
            fail('The cloud Bot configuration requires its original encryption identity', 'bot_import_encryption_identity_mismatch', {
              report: { table: spec.table },
            });
          }
        }
      }
    }
  });

  // Every stored page must be reproduced byte-for-byte, and each table must
  // still end where it ended: counts alone never prove a snapshot.
  const verifyTables = async (reader) => {
    for (const [group, entry] of Object.entries(state.tables)) {
      if (group === '__identities') continue;
      for (const page of entry.pages) {
        checkCancelled();
        const bytes = await reader.page(entry.table || group, {
          columns: entry.columns, orderColumns: entry.orderColumns, after: page.after, limit: page.limit,
          avatarIds: entry.avatarIds ?? null,
        });
        if (!bytes || sha256(bytes) !== page.sha256) {
          fail(`Cloud ${group} rows changed during the import; stop every cloud Bot writer and start again`,
            'bot_import_source_changed', { report: { table: group } });
        }
      }
      const tail = await reader.page(entry.table || group, {
        columns: entry.columns, orderColumns: entry.orderColumns, after: entry.terminalAfter ?? null, limit: 1,
        avatarIds: entry.avatarIds ?? null,
      });
      if (!tail || parseRows(tail).length !== 0) {
        fail(`Cloud ${group} rows were added during the import; stop every cloud Bot writer and start again`,
          'bot_import_source_changed', { report: { table: group } });
      }
    }
    const identities = state.tables.__identities;
    for (const page of identities?.pages || []) {
      const bytes = await reader.profiles(page.ids);
      if (sha256(bytes) !== page.sha256) {
        fail('Cloud identities changed during the import', 'bot_import_source_changed', { report: { table: 'user_profiles' } });
      }
    }
  };

  const referencedUserIds = async (plan) => {
    const ids = new Set();
    for (const table of plan) {
      if (table.userColumns.length === 0) continue;
      for await (const row of exportedRows(table.name)) {
        for (const column of table.userColumns) {
          if (typeof row[column] === 'string' && UUID.test(row[column])) ids.add(row[column].toLowerCase());
        }
      }
    }
    return [...ids].sort();
  };

  const candidateConfigurationBlockers = async (candidate, botIds, ownerUserId) => {
    const selected = new Set(botIds);
    const cached = new Map();
    const readRows = async (table, columns) => {
      const rows = [];
      let afterId = null;
      for (;;) {
        const page = await host.readCandidate(candidate.operationId, {
          table, columns, keyColumn: 'id', afterId, limit: 200,
        });
        rows.push(...page);
        if (page.length < 200) return rows;
        afterId = page.at(-1).id;
      }
    };
    const get = async (table, id) => {
      if (!cached.has(table)) cached.set(table, new Map((await readRows(table, CONFIGURATION_RESOURCE_COLUMNS[table]))
        .map((row) => [row.id, row])));
      return cached.get(table).get(id) || null;
    };
    const bots = new Map((await readRows('bots', ['id', 'active_revision_id'])).map((row) => [row.id, row]));
    const environmentSecrets = await readRows('bot_environment_secrets', CONFIGURATION_RESOURCE_COLUMNS.bot_environment_secrets);
    const credentials = await readRows('bot_credentials', CONFIGURATION_RESOURCE_COLUMNS.bot_credentials);
    cached.set('bot_credentials', new Map(credentials.map((row) => [row.id, row])));
    const blockers = [];
    for (const revision of await readRows('bot_revisions', ['id', 'bot_id', 'contract'])) {
      if (!selected.has(revision.bot_id) || bots.get(revision.bot_id)?.active_revision_id !== revision.id) continue;
      blockers.push(...await configurationResourceBlockers({ botId: revision.bot_id, contract: revision.contract, get,
        environmentSecrets, credentials, ownerUserId }));
    }
    return blockers;
  };

  const exportIdentities = async (reader, plan) => {
    const entry = state.tables.__identities ||= { pages: [], complete: false };
    if (entry.complete) return;
    entry.pages = [];
    const ids = await referencedUserIds(plan);
    const found = new Set();
    for (let offset = 0; offset < ids.length; offset += 100) {
      checkCancelled();
      const batch = ids.slice(offset, offset + 100);
      const bytes = await reader.profiles(batch);
      assertPageBytes(bytes);
      for (const row of parseRows(bytes)) found.add(String(row.id).toLowerCase());
      const index = entry.pages.length;
      const sealed = await storePage('__identities', index, bytes);
      entry.pages.push({ index, sha256: sha256(bytes), bytes: bytes.byteLength, ids: batch, ...sealed });
    }
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      fail(`${missing.length} referenced cloud accounts have no profile`, 'bot_import_identity_missing', {
        report: { missingCount: missing.length },
      });
    }
    entry.complete = true;
    await saveState();
  };

  const exportObjects = async (reader) => {
    const objects = state.objects ||= { entries: [], complete: false };
    if (objects.complete) return;
    const directory = path.join(root, state.id, 'objects');
    await privateDirectory(directory);
    const done = new Set(objects.entries.map((entry) => entry.id));
    for await (const row of exportedRows('bot_objects')) {
      checkCancelled();
      if (row.deleted_at || done.has(row.id)) continue;
      const file = botObjectFileName(row.storage_object_name);
      const bytes = await reader.object(file);
      if (!bytes) {
        fail('A live cloud Bot object is missing', 'bot_import_object_missing', { report: { objectCount: 1 } });
      }
      if (bytes.byteLength !== Number(row.ciphertext_size) || sha256(bytes) !== row.ciphertext_hash) {
        fail('A cloud Bot object does not match its record', 'bot_import_object_invalid');
      }
      const target = path.join(directory, file);
      await fs.writeFile(target, bytes, { mode: 0o600 });
      objects.entries.push({ id: row.id, file, bytes: bytes.byteLength, sha256: row.ciphertext_hash });
      done.add(row.id);
      if (state.scope === 'configuration' || objects.entries.length % 50 === 0) await saveState();
    }
    objects.complete = true;
    await saveState();
  };

  async function* sourceLoadScript(plan) {
    yield renderLoadPrelude({ disableTriggers: SOURCE_LOAD_TRIGGERS });
    for (const page of state.tables.__identities?.pages || []) {
      yield renderPageOpen();
      yield await readPage('__identities', page);
      yield renderPageClose();
      yield renderSourceIdentityInsert();
    }
    for (const table of plan) {
      for (const [group, entry] of tableEntries(table.name)) {
        for (const page of entry.pages) {
          yield renderPageOpen();
          yield await readPage(group, page);
          yield renderPageClose();
          yield renderPageInsert(table, { regenerate: false });
        }
      }
    }
    yield renderLoadEpilogue({ disableTriggers: SOURCE_LOAD_TRIGGERS });
  }

  // Merge: identities, then every Bot table exported from the source database
  // in plan order; regenerated identities are allocated in source order.
  async function* mergeScript(plan, source, finalization) {
    yield renderLoadPrelude();
    for (const page of state.tables.__identities?.pages || []) {
      yield renderPageOpen();
      yield await readPage('__identities', page);
      yield renderPageClose();
      yield renderIdentityInsert();
    }
    for (const table of plan) {
      let after = null;
      for (;;) {
        const exported = await host.exportImportPage({ kind: 'source', handle: source }, {
          table: table.name, columns: table.columns, orderColumns: table.orderColumns, after, limit: MERGE_PAGE_ROWS,
        });
        if (exported.page === '[]') break;
        yield renderPageOpen();
        yield assertPageBytes(Buffer.from(exported.page, 'utf8'));
        yield renderPageClose();
        yield renderPageInsert(table, { regenerate: true });
        after = exported.last;
        if (!Array.isArray(after)) break;
      }
    }
    yield finalization;
    yield renderLoadEpilogue();
  }

  const collectIds = async (reader, table, column = 'id') => {
    const ids = [];
    let after = null;
    for (;;) {
      const page = await reader(table, after);
      if (page.length === 0) break;
      for (const row of page) ids.push(String(row[column]).toLowerCase());
      after = page.at(-1)[column];
      if (page.length < 200) break;
    }
    return ids;
  };

  const execute = async ({ mode, scope, sourceOwnerUserId }) => {
    const cloud = readCloudSource();
    if (!cloud) fail('No Supabase project is configured on this host', 'bot_import_source_unconfigured', { statusCode: 400 });
    let source = null;
    try {
      const onDownloadedBytes = (bytes) => { state.downloadedBytes = (state.downloadedBytes || 0) + bytes; };
      const probe = createCloudBotReader({ ...cloud, fetchImpl, allowedTables: [], wait, onDownloadedBytes });
      if (state.source?.project && state.source.project !== probe.project) {
        fail('The configured Supabase project changed since this import started', 'bot_import_source_changed');
      }
      await setPhase('connecting');
      const marker = await probe.schemaMarker();
      if (typeof marker !== 'string' || !Object.hasOwn(REVIEWED_SOURCE_SCHEMAS, marker)) {
        fail('The cloud Bot schema is not a reviewed import source', 'bot_import_source_schema_unsupported');
      }
      if (state.source?.marker && state.source.marker !== marker) {
        fail('The cloud Bot schema changed since this import started', 'bot_import_source_changed');
      }
      state.source = { project: probe.project, marker };
      await setPhase('preparing_source');
      const created = await host.createImportSource(marker);
      source = created.handle;
      const exportPlan = planImportTables(created.catalog, { scope });
      const reader = createCloudBotReader({
        ...cloud, fetchImpl, wait, onDownloadedBytes,
        allowedTables: [...exportPlan.map((table) => table.name), 'user_profiles'],
      });

      await setPhase('exporting');
      for (const table of exportPlan) {
        if (scope === 'configuration' && table.name === 'bot_objects') {
          await exportAvatars(reader, table);
          continue;
        }
        await exportTable(reader, table.name, table.name, { columns: table.columns, orderColumns: table.primaryKey });
      }
      await exportIdentities(reader, exportPlan);
      if (scope === 'configuration') await verifyConfigurationKey();
      await setPhase('exporting_objects');
      await exportObjects(reader);

      await setPhase('verifying');
      await verifyTables(reader);
      if (await probe.schemaMarker() !== marker) fail('The cloud Bot schema changed during the import', 'bot_import_source_changed');

      await setPhase('loading_source');
      await host.runImportSql({ kind: 'source', handle: source }, sourceLoadScript(exportPlan));
      const migrated = await host.migrateImportSource(source);
      const mergePlan = planImportTables(migrated.catalog, { scope });
      const sourceCounts = await host.countRows({ kind: 'source', handle: source });
      const importedBotIds = await collectIds(async (table, after) => JSON.parse((await host.exportImportPage(
        { kind: 'source', handle: source },
        { table, columns: ['id'], orderColumns: ['id'], after: after ? [after] : null, limit: 200 },
      )).page), 'bots');

      await setPhase('merging');
      const merged = await runMaintenance('import', async ({ markReplaced }) => {
        const backup = await host.backup({ kind: 'pre_import' });
        const candidate = await host.prepareRestore(backup.id);
        const target = { kind: 'candidate', operationId: candidate.operationId };
        const previousHold = activationHold.get();
        let held = false;
        try {
          const localCounts = await host.countRows(target);
          const localBotIds = await collectIds((table, after) => host.readCandidate(candidate.operationId, {
            table, columns: ['id'], keyColumn: 'id', afterId: after, limit: 200,
          }), 'bots');
          if (mode === 'empty' && localBotIds.length > 0) {
            fail('The local catalog already has Bots; choose Merge to keep them', 'bot_import_local_not_empty');
          }
          const local = new Set(localBotIds);
          const conflicts = importedBotIds.filter((id) => local.has(id));
          if (conflicts.length > 0) {
            fail(`${conflicts.length} cloud Bots already exist locally`, 'bot_import_bot_conflict', {
              report: { conflictCount: conflicts.length, botIds: conflicts.slice(0, 20) },
            });
          }
          const finalization = renderMergeFinalization({
            importedBotIds,
            scope,
            ownerMappings: sourceOwnerUserId
              ? importedBotIds.map((botId) => ({ botId, sourceOwnerUserId }))
              : [],
          });
          try {
            await host.runImportSql(target, mergeScript(mergePlan, source, finalization));
          } catch (error) {
            fail('A cloud row conflicts with the local catalog', 'bot_import_conflict', {
              report: { detail: typeof error?.diagnostics?.detail === 'string' ? error.diagnostics.detail.slice(0, 300) : null },
            });
          }
          for (const entry of state.objects?.entries || []) {
            const destination = path.join(candidate.objectsDirectory, entry.file);
            await fs.copyFile(path.join(root, state.id, 'objects', entry.file), destination, fsConstants.COPYFILE_EXCL);
            await fs.chmod(destination, 0o600);
          }
          const report = await validateCandidate(candidate, { missingVaultRecord: 'disconnect' });
          const disconnected = report.disconnected;
          if (disconnected.credentials.length || disconnected.environmentSecrets.length
            || disconnected.telegramConnections.length) {
            await host.runImportSql(target, (async function* disconnect() {
              yield '\\set ON_ERROR_STOP 1\nbegin;\n';
              yield renderMergeFinalization({ importedBotIds, disconnected });
              yield 'commit;\n';
            })());
          }
          const blockers = scope === 'configuration'
            ? await candidateConfigurationBlockers(candidate, importedBotIds, sourceOwnerUserId)
            : [];
          const candidateCounts = await host.countRows(target);
          for (const table of mergePlan) {
            const expected = (localCounts[table.name] || 0) + (sourceCounts[table.name] || 0);
            if (candidateCounts[table.name] !== expected) {
              fail(`The merged ${table.name} inventory does not match`, 'bot_import_inventory_mismatch', {
                report: { table: table.name },
              });
            }
          }
          await activationHold.hold({ reason: 'import', operationId: state.id });
          held = true;
          const committed = await host.commitRestore(candidate.operationId);
          markReplaced();
          return { committed, report, blockers, importedBotCount: importedBotIds.length };
        } catch (error) {
          await host.discardCandidate(candidate.operationId).catch(() => undefined);
          if (held) await activationHold.reinstate(previousHold).catch(() => undefined);
          throw error;
        }
      }, { drainTimeoutMs: IMPORT_DRAIN_MS, replacesDatabase: true });

      await host.dropImportSource(source).catch(() => undefined);
      source = null;
      await fs.rm(path.join(root, state.id), { recursive: true, force: true }).catch(() => undefined);
      await setPhase('completed', {
        result: {
          importedBotCount: merged.importedBotCount,
          blockers: merged.blockers,
          envelopes: merged.report.envelopes,
          objects: merged.report.objects,
          disconnected: {
            credentials: merged.report.disconnected.credentials.length,
            environmentSecrets: merged.report.disconnected.environmentSecrets.length,
            telegramConnections: merged.report.disconnected.telegramConnections.length,
          },
        },
        error: null,
      });
      await onImported();
    } finally {
      if (source) await host.dropImportSource(source).catch(() => undefined);
    }
  };

  // Whether a hosted project is saved on this host; never the source itself.
  const sourceConfigured = () => {
    try {
      return Boolean(readCloudSource());
    } catch {
      return false;
    }
  };

  const publicStatus = () => {
    const current = state;
    return Object.freeze({
      sourceConfigured: sourceConfigured(),
      cloud: cloudProbe,
      checking,
      import: current ? {
        id: current.id,
        mode: current.mode,
        scope: current.scope || 'full',
        downloadedBytes: current.downloadedBytes || 0,
        phase: current.phase,
        running: running !== null,
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
        tables: new Set(Object.entries(current.tables || {}).filter(([name]) => name !== '__identities')
          .map(([name, entry]) => entry.table || name)).size,
        pages: Object.values(current.tables || {}).reduce((sum, entry) => sum + (entry.pages?.length || 0), 0),
        objects: current.objects?.entries?.length || 0,
        error: current.error || null,
        result: current.result || null,
      } : null,
      pending: Boolean(cloudProbe?.hasBots) && current?.phase !== 'completed'
        && (current?.phase !== 'dismissed' || requested),
    });
  };

  return Object.freeze({
    status: publicStatus,
    async initialize() {
      await loadState();
    },
    // Detects hosted Bots that have not been imported, so an empty local
    // catalog never reads as "the cloud Bots were deleted".
    async probeCloud({ requested: byOwner = false } = {}) {
      if (byOwner === true) requested = true;
      if (checking) return publicStatus();
      const cloud = readCloudSource();
      if (!cloud) {
        cloudProbe = null;
        return publicStatus();
      }
      checking = true;
      try {
        const reader = createCloudBotReader({ ...cloud, fetchImpl, wait, allowedTables: ['bots'] });
        cloudProbe = { hasBots: await reader.hasBots(), checkedAt: new Date(now()).toISOString(), code: null };
      } catch (error) {
        cloudProbe = { hasBots: cloudProbe?.hasBots ?? null, checkedAt: new Date(now()).toISOString(), code: error?.code || 'bot_import_source_unavailable' };
      } finally {
        checking = false;
      }
      return publicStatus();
    },
    async start({ mode, scope = 'full', writersStopped } = {}) {
      if (!['empty', 'merge'].includes(mode)) fail('Choose an import mode: empty or merge', 'bot_import_mode_invalid', { statusCode: 400 });
      if (!['full', 'configuration'].includes(scope)) fail('Choose a valid import scope', 'bot_import_scope_invalid', { statusCode: 400 });
      if (writersStopped !== true) {
        fail('Confirm that no other DevRyan host is writing cloud Bots before importing', 'bot_import_writers_unconfirmed', { statusCode: 400 });
      }
      if (running || starting) fail('An import is already running', 'bot_import_running');
      starting = true;
      try {
        await loadState();
        if (state && !['completed', 'cancelled', 'dismissed', 'failed'].includes(state.phase)
          && (state.scope || 'full') !== scope) {
          fail('This import checkpoint has a different scope; cancel it before starting another import', 'bot_import_scope_mismatch');
        }
        // Only an interrupted or quota-blocked import resumes; a failed one
        // (for example after the cloud changed) starts over from a fresh export.
        if (!state || ['completed', 'cancelled', 'dismissed', 'failed'].includes(state.phase) || state.mode !== mode) {
          if (state?.id) await fs.rm(path.join(root, state.id), { recursive: true, force: true }).catch(() => undefined);
          state = {
            version: STATE_VERSION,
            id: crypto.randomUUID(),
            mode,
            scope,
            downloadedBytes: 0,
            phase: 'created',
            createdAt: new Date(now()).toISOString(),
            updatedAt: new Date(now()).toISOString(),
            source: null,
            tables: {},
            objects: null,
            error: null,
            result: null,
          };
        }
        state.error = null;
        await saveState();
        cancelRequested = false;
        const sourceOwnerUserId = await resolveVerifiedSourceOwner().catch(() => null);
        running = execute({ mode, scope, sourceOwnerUserId: UUID.test(sourceOwnerUserId || '') ? sourceOwnerUserId : null })
          .catch(async (error) => {
            const code = typeof error?.code === 'string' ? error.code : 'bot_import_failed';
            state.error = {
              code,
              message: typeof error?.message === 'string' ? error.message.slice(0, 300) : 'The import failed',
              retryable: error?.retryable === true,
              report: error?.report || null,
              at: new Date(now()).toISOString(),
            };
            await setPhase(code === 'bot_import_source_quota_exceeded' ? 'blocked'
              : code === 'bot_import_cancelled' ? 'cancelled' : 'failed').catch(() => undefined);
          })
          .finally(() => {
            running = null;
          });
        return publicStatus();
      } finally {
        starting = false;
      }
    },
    async cancel() {
      cancelRequested = true;
      await running?.catch(() => undefined);
      await loadState();
      // A completed import stays completed, and a dismissal stays dismissed.
      if (state && !['completed', 'dismissed'].includes(state.phase)) {
        await fs.rm(path.join(root, state.id), { recursive: true, force: true }).catch(() => undefined);
        state.phase = 'cancelled';
        await saveState();
      }
      return publicStatus();
    },
    // The owner chose to keep the hosted Bots in the cloud; the pending notice
    // stays hidden until they start an import themselves.
    async dismiss() {
      if (running) fail('A Bot import is running; cancel it first', 'bot_import_running', { statusCode: 409 });
      await loadState();
      state ||= { version: STATE_VERSION, id: crypto.randomUUID(), mode: null, createdAt: new Date(now()).toISOString(), tables: {}, objects: null };
      requested = false;
      state.phase = 'dismissed';
      await saveState();
      return publicStatus();
    },
    get running() { return running !== null; },
  });
}
