// Deterministic planning and SQL rendering for loading hosted Bot rows into a
// temporary source database and merging them into a local candidate.
//
// Normal FK, CHECK, UNIQUE and validation triggers stay enabled. Existing
// deferrable cyclic foreign keys are deferred for the whole load. Only two
// reviewed historical-load side effects are disabled, inside the load
// transaction: memory-extraction enqueue on run insertion, and the updated_at
// mutation while Bot avatar pointers are restored after their objects exist.

export const IMPORT_DISABLED_TRIGGERS = Object.freeze({
  load: Object.freeze([{ table: 'bot_runs', trigger: 'bot_runs_enqueue_memory_extraction' }]),
  avatarRestore: Object.freeze([{ table: 'bots', trigger: 'bots_updated_at' }]),
});

// Validation triggers read other tables, not only foreign keys: an active
// channel needs its owner's active membership; an ACL needs the channel and an
// active membership.
const EXTRA_DEPENDENCIES = Object.freeze({
  bot_channels: Object.freeze(['bot_memberships']),
  bot_channel_acl: Object.freeze(['bot_memberships', 'bot_channels']),
});

// Imported numeric identities are allocated above local maxima in source
// order; they are never copied into a populated catalog.
export const REGENERATED_IDENTITIES = Object.freeze({
  bot_audit_events: 'id',
  bot_runs: 'queue_sequence',
});

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const PAGE_OPEN = "copy devryan_import_page (document) from stdin with (format csv, quote e'\\x01', delimiter e'\\x02');";

export class BotImportPlanError extends Error {
  constructor(message, code = 'bot_import_plan_invalid') {
    super(message);
    this.name = 'BotImportPlanError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new BotImportPlanError(message, code);
};

const ident = (value) => {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail(`Identifier ${String(value)} is invalid`);
  return `"${value}"`;
};

const validateTable = (table) => {
  if (!table || !IDENTIFIER.test(table.name || '') || !Array.isArray(table.columns) || table.columns.length < 1
    || table.columns.some((column) => !IDENTIFIER.test(column))
    || !Array.isArray(table.primaryKey) || table.primaryKey.length < 1
    || table.primaryKey.some((column) => !table.columns.includes(column))) {
    fail(`Table metadata for ${table?.name || 'unknown'} is invalid`);
  }
  return table;
};

// Orders Bot tables so every non-deferrable reference and every reviewed
// validation dependency loads first. Deferrable foreign keys are ignored: the
// load defers them to commit.
export function planImportTables(catalog) {
  if (!catalog || !Array.isArray(catalog.tables)) fail('The import catalog is invalid');
  const tables = new Map();
  for (const table of catalog.tables) {
    validateTable(table);
    if (table.name !== 'bots' && !table.name.startsWith('bot_')) continue;
    if (table.name === 'bot_local_owner_mappings') continue;
    tables.set(table.name, table);
  }
  if (!tables.has('bots')) fail('The import catalog has no Bot tables');
  const dependencies = new Map([...tables.keys()].map((name) => [name, new Set()]));
  for (const table of tables.values()) {
    for (const reference of table.references || []) {
      if (reference.deferrable === true) continue;
      if (reference.table === table.name) {
        fail(`${table.name} has a non-deferrable self reference`, 'bot_import_plan_cycle');
      }
      // The avatar pointer is nulled during load and restored afterwards.
      if (table.name === 'bots' && reference.table === 'bot_objects') continue;
      if (tables.has(reference.table)) dependencies.get(table.name).add(reference.table);
    }
    for (const extra of EXTRA_DEPENDENCIES[table.name] || []) {
      if (tables.has(extra)) dependencies.get(table.name).add(extra);
    }
  }
  const ordered = [];
  const state = new Map();
  const visit = (name, path) => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') {
      fail(`Import tables form a cycle: ${[...path, name].join(' -> ')}`, 'bot_import_plan_cycle');
    }
    state.set(name, 'visiting');
    for (const dependency of [...dependencies.get(name)].sort()) visit(dependency, [...path, name]);
    state.set(name, 'done');
    ordered.push(name);
  };
  for (const name of [...tables.keys()].sort()) visit(name, []);
  return Object.freeze(ordered.map((name) => {
    const table = tables.get(name);
    const regenerated = REGENERATED_IDENTITIES[name] || null;
    if (regenerated && !table.columns.includes(regenerated)) fail(`${name} lost its identity column`);
    return Object.freeze({
      name,
      columns: Object.freeze([...table.columns]),
      primaryKey: Object.freeze([...table.primaryKey]),
      identity: Object.freeze([...(table.identity || [])]),
      userColumns: Object.freeze([...(table.userColumns || [])]),
      regeneratedIdentity: regenerated,
      // Pages leave the source database in this order: source identity order
      // for regenerated identities, primary-key order otherwise.
      orderColumns: Object.freeze(regenerated ? [regenerated] : [...table.primaryKey]),
    });
  }));
}

export const renderLoadPrelude = ({ disableTriggers = IMPORT_DISABLED_TRIGGERS.load } = {}) => [
  '\\set ON_ERROR_STOP 1',
  'begin;',
  "set local lock_timeout = '30s';",
  'set local client_min_messages = warning;',
  'set constraints all deferred;',
  ...disableTriggers.map(({ table, trigger }) => `alter table public.${ident(table)} disable trigger ${ident(trigger)};`),
  'create temporary table devryan_import_page (document jsonb not null) on commit drop;',
  'create temporary table devryan_import_avatars (bot_id uuid primary key, avatar_object_id uuid not null) on commit drop;',
  '',
].join('\n');

// One raw JSON page. The bytes pass through untouched (no numeric
// conversion); CSV with control-character quote/delimiter keeps them intact.
export const renderPageOpen = () => `truncate devryan_import_page;\n${PAGE_OPEN}\n`;
export const renderPageClose = () => '\n\\.\n';

export const assertPageBytes = (bytes) => {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (buffer.byteLength < 2 || buffer[0] !== 0x5b) fail('An import page is not a JSON array', 'bot_import_page_invalid');
  if (buffer.includes(0x0a) || buffer.includes(0x0d) || buffer.includes(0x01) || buffer.includes(0x02)) {
    fail('An import page contains raw control characters', 'bot_import_page_invalid');
  }
  return buffer;
};

const insertColumns = (table, { regenerate }) => table.columns.filter((column) => (
  !(regenerate && column === table.regeneratedIdentity)
));

// Inserts the current page. Source loads preserve every value (overriding
// generated identities); merges let the candidate allocate regenerated
// identities in source order.
export function renderPageInsert(table, { regenerate = false } = {}) {
  // A merge never supplies identity values, so every identity column must be
  // one the candidate regenerates; anything else would need a reviewed plan.
  if (regenerate && table.identity.some((column) => column !== table.regeneratedIdentity)) {
    fail(`${table.name} has an identity column the merge cannot regenerate`, 'bot_import_plan_identity_unsupported');
  }
  const columns = insertColumns(table, { regenerate });
  const selectList = columns.map((column) => (
    table.name === 'bots' && column === 'avatar_object_id' ? 'null::uuid' : `r.${ident(column)}`
  ));
  const overriding = !regenerate && table.identity.length > 0 ? ' overriding system value' : '';
  const order = regenerate && table.regeneratedIdentity
    ? ` order by r.${ident(table.regeneratedIdentity)}`
    : '';
  const statements = [];
  if (table.name === 'bots') {
    statements.push(`insert into devryan_import_avatars (bot_id, avatar_object_id)
  select r.id, r.avatar_object_id
  from jsonb_populate_recordset(null::public.bots, (select document from devryan_import_page)) r
  where r.avatar_object_id is not null;`);
  }
  statements.push(`insert into public.${ident(table.name)} (${columns.map(ident).join(', ')})${overriding}
  select ${selectList.join(', ')}
  from jsonb_populate_recordset(null::public.${ident(table.name)}, (select document from devryan_import_page)) r${order};`);
  return `${statements.join('\n')}\n`;
}

// Identity projections: only missing users are inserted; an existing local
// projection (the owner or a mirrored account) is never overwritten.
export const renderIdentityInsert = () => `select public.devryan_local_upsert_identity(
    r.id, r.email, r.display_name, r.account_kind, r.role, r.status)
  from jsonb_populate_recordset(null::public.user_profiles, (select document from devryan_import_page)) r
  where not exists (select 1 from public.user_profiles existing where existing.id = r.id);
`;

// Source databases mirror the hosted schema, which has no local identity
// function yet: identities are inserted directly.
export const renderSourceIdentityInsert = () => `insert into auth.users (id, email)
  select r.id, r.email
  from jsonb_populate_recordset(null::public.user_profiles, (select document from devryan_import_page)) r
  on conflict (id) do nothing;
insert into public.user_profiles (id, email, display_name, role, status, account_kind)
  select r.id, r.email, r.display_name, r.role, r.status, r.account_kind
  from jsonb_populate_recordset(null::public.user_profiles, (select document from devryan_import_page)) r
  on conflict (id) do nothing;
`;

export const renderLoadEpilogue = ({ disableTriggers = IMPORT_DISABLED_TRIGGERS.load } = {}) => [
  // Every row is loaded: check the deferred (including cyclic) foreign keys
  // now. Trigger changes below are refused while checks are still pending.
  'set constraints all immediate;',
  ...IMPORT_DISABLED_TRIGGERS.avatarRestore.map(({ table, trigger }) => `alter table public.${ident(table)} disable trigger ${ident(trigger)};`),
  `update public.bots b set avatar_object_id = a.avatar_object_id
  from devryan_import_avatars a where b.id = a.bot_id;`,
  ...IMPORT_DISABLED_TRIGGERS.avatarRestore.map(({ table, trigger }) => `alter table public.${ident(table)} enable trigger ${ident(trigger)};`),
  ...disableTriggers.map(({ table, trigger }) => `alter table public.${ident(table)} enable trigger ${ident(trigger)};`),
  'commit;',
  '',
].join('\n');

// Merge-only statements applied inside the merge transaction, before commit:
// imported deliveries that may already have happened stay uncertain and are
// never replayed, Telegram leases held by the old owner are released, and
// integrations whose local vault record is missing are explicitly
// disconnected rather than re-keyed.
export function renderMergeFinalization({
  importedBotIds,
  ownerMappings = [],
  disconnected = { credentials: [], environmentSecrets: [], telegramConnections: [] },
} = {}) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const normalized = (value, message) => {
    if (typeof value !== 'string' || !uuid.test(value)) fail(message);
    return value.toLowerCase();
  };
  const list = (values) => {
    if (values !== undefined && values !== null && !Array.isArray(values)) fail('A merge identifier is invalid');
    const unique = [...new Set((values || []).map((value) => normalized(value, 'A merge identifier is invalid')))];
    return unique.length > 0 ? unique.map((value) => `'${value}'::uuid`).join(', ') : null;
  };
  const statements = [];
  const bots = list(importedBotIds);
  if (bots) {
    statements.push(
      `update public.bot_telegram_outbox set state = 'uncertain' where bot_id in (${bots}) and state in ('sending', 'synthesizing');`,
      `update public.bot_telegram_inbox set state = 'admission_uncertain' where bot_id in (${bots}) and state = 'admitting';`,
      `update public.bot_telegram_connections set lease_owner = null, lease_until = null where bot_id in (${bots});`,
    );
  }
  // One mapping per Bot; a Bot mapped to two different owners is refused.
  const mappings = new Map();
  if (ownerMappings !== undefined && ownerMappings !== null && !Array.isArray(ownerMappings)) {
    fail('Owner mappings are invalid');
  }
  for (const mapping of ownerMappings || []) {
    const botId = normalized(mapping?.botId, 'An owner mapping is invalid');
    const sourceOwnerUserId = normalized(mapping?.sourceOwnerUserId, 'An owner mapping is invalid');
    if (mappings.has(botId) && mappings.get(botId) !== sourceOwnerUserId) fail('An owner mapping is ambiguous');
    mappings.set(botId, sourceOwnerUserId);
  }
  for (const [botId, sourceOwnerUserId] of mappings) {
    statements.push(`insert into public.bot_local_owner_mappings (bot_id, source_owner_user_id)
  select '${botId}'::uuid, '${sourceOwnerUserId}'::uuid
  where exists (select 1 from public.bot_memberships m
    where m.bot_id = '${botId}'::uuid and m.user_id = '${sourceOwnerUserId}'::uuid and m.revoked_at is null);`);
  }
  // Integrations whose vault record is missing are disconnected whether or
  // not this merge imported any Bot (validation covers the whole candidate).
  const credentials = list(disconnected?.credentials);
  if (credentials) statements.push(`update public.bot_credentials set status = 'error' where id in (${credentials});`);
  const secrets = list(disconnected?.environmentSecrets);
  if (secrets) statements.push(`update public.bot_environment_secrets set status = 'error' where id in (${secrets});`);
  const telegram = list(disconnected?.telegramConnections);
  if (telegram) {
    statements.push(`update public.bot_telegram_connections set enabled = false, state = 'error', error_code = 'telegram_credential_missing' where bot_id in (${telegram});`);
  }
  return statements.length > 0 ? `${statements.join('\n')}\n` : '';
}

// Table metadata the planner consumes, read from a database at a known schema.
export const IMPORT_CATALOG_SQL = `
select json_build_object('tables', coalesce(json_agg(json_build_object(
  'name', c.relname,
  'columns', (select json_agg(a.attname order by a.attnum) from pg_catalog.pg_attribute a
    where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
  'identity', coalesce((select json_agg(a.attname order by a.attnum) from pg_catalog.pg_attribute a
    where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and a.attidentity in ('a', 'd')), '[]'::json),
  'primaryKey', coalesce((select json_agg(a.attname order by array_position(i.indkey::int2[], a.attnum))
    from pg_catalog.pg_index i join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
    where i.indrelid = c.oid and i.indisprimary), '[]'::json),
  'references', coalesce((select json_agg(json_build_object(
      'table', r.relname, 'deferrable', con.condeferrable) order by con.conname)
    from pg_catalog.pg_constraint con join pg_catalog.pg_class r on r.oid = con.confrelid
    join pg_catalog.pg_namespace rn on rn.oid = r.relnamespace
    where con.conrelid = c.oid and con.contype = 'f' and rn.nspname = 'public'), '[]'::json),
  'userColumns', coalesce((select json_agg(a.attname order by a.attname)
    from pg_catalog.pg_constraint con join pg_catalog.pg_attribute a
      on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
    where con.conrelid = c.oid and con.contype = 'f' and array_length(con.conkey, 1) = 1
      and con.confrelid = 'public.user_profiles'::regclass), '[]'::json)
) order by c.relname), '[]'::json))
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and (c.relname = 'bots' or c.relname like 'bot\\_%');
`;
