import { describe, expect, test } from 'bun:test';

import {
  BotImportPlanError,
  CONFIGURATION_IMPORT_TABLES,
  IMPORT_CATALOG_SQL,
  IMPORT_DISABLED_TRIGGERS,
  REGENERATED_IDENTITIES,
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
} from './import-plan.js';

// Synthetic catalog in the shape IMPORT_CATALOG_SQL returns. It covers a
// deferrable self reference (bot_runs), a deferrable cycle (bots <->
// bot_revisions), the avatar pointer (bots -> bot_objects), both regenerated
// identities, validation-only dependencies (channels/ACL on memberships), and
// tables the planner must skip.
const table = (name, columns, extra = {}) => ({
  name,
  columns,
  identity: [],
  primaryKey: ['id'],
  references: [],
  userColumns: [],
  ...extra,
});
const ref = (target, deferrable = false) => ({ table: target, deferrable });

const syntheticTables = () => [
  table('bots', ['id', 'name', 'owner_user_id', 'avatar_object_id', 'active_revision_id'], {
    references: [ref('bot_objects'), ref('bot_revisions', true), ref('user_profiles')],
    userColumns: ['owner_user_id'],
  }),
  table('bot_audit_events', ['id', 'event_id', 'bot_id', 'actor_user_id'], {
    identity: ['id'],
    references: [ref('bots'), ref('user_profiles')],
    userColumns: ['actor_user_id'],
  }),
  table('bot_channel_acl', ['channel_id', 'user_id', 'bot_id'], {
    primaryKey: ['channel_id', 'user_id'],
    references: [ref('bots'), ref('user_profiles')],
    userColumns: ['user_id'],
  }),
  table('bot_channels', ['id', 'bot_id', 'owner_user_id'], {
    references: [ref('bots'), ref('user_profiles')],
    userColumns: ['owner_user_id'],
  }),
  table('bot_local_owner_mappings', ['bot_id', 'source_owner_user_id'], {
    primaryKey: ['bot_id'],
    references: [ref('bots'), ref('user_profiles')],
  }),
  table('bot_memberships', ['id', 'bot_id', 'user_id', 'revoked_at'], {
    references: [ref('bots'), ref('user_profiles')],
    userColumns: ['user_id'],
  }),
  table('bot_objects', ['id', 'bot_id', 'storage_object_name'], { references: [ref('bots')] }),
  table('bot_revisions', ['id', 'bot_id', 'revision'], { references: [ref('bots')] }),
  table('bot_runs', ['id', 'bot_id', 'queue_sequence', 'parent_run_id'], {
    identity: ['queue_sequence'],
    references: [ref('bot_runs', true), ref('bots')],
  }),
  table('user_profiles', ['id', 'email']),
  table('botany', ['id']),
];

const EXPECTED_ORDER = [
  'bots',
  'bot_audit_events',
  'bot_memberships',
  'bot_channels',
  'bot_channel_acl',
  'bot_objects',
  'bot_revisions',
  'bot_runs',
];

const plan = (tables = syntheticTables()) => planImportTables({ tables });
const planned = (name) => plan().find((entry) => entry.name === name);

const expectPlanError = (callback, { code = 'bot_import_plan_invalid', message } = {}) => {
  let caught = null;
  try {
    callback();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BotImportPlanError);
  expect(caught.name).toBe('BotImportPlanError');
  expect(caught.code).toBe(code);
  if (message) expect(caught.message).toMatch(message);
  return caught;
};

// Statement-level views that ignore incidental whitespace and psql
// meta-commands (lines starting with a backslash).
const normalize = (sql) => sql.replace(/\s+/g, ' ').trim();
const statements = (sql) => sql.split('\n')
  .filter((line) => !line.trimStart().startsWith('\\'))
  .join('\n')
  .split(';')
  .map(normalize)
  .filter(Boolean);
const indexOfStatement = (sql, pattern) => statements(sql).findIndex((statement) => pattern.test(statement));

describe('planImportTables', () => {
  test('configuration scope uses a fixed allowlist and retains Telegram settings without its queues', () => {
    const tables = [...syntheticTables(), ...[
      'bot_routines', 'bot_credentials', 'bot_environment_secrets', 'bot_agent_connections',
      'bot_mcp_bindings', 'bot_revision_binding_resolutions', 'bot_revision_signatures',
      'bot_signer_trust', 'bot_telegram_connections', 'bot_telegram_pairings',
      'bot_telegram_inbox', 'bot_telegram_outbox', 'bot_skill_packages', 'bot_library_versions',
      'bot_new_future_history',
    ].map((name) => table(name, ['id']))];
    expect(planImportTables({ tables }, { scope: 'configuration' }).map((entry) => entry.name).sort())
      .toEqual([...CONFIGURATION_IMPORT_TABLES].sort());
    expectPlanError(() => planImportTables({ tables }, { scope: 'unknown' }));
  });
  test('orders parents before children with a deterministic tie-break', () => {
    const order = plan().map((entry) => entry.name);
    expect(order).toEqual(EXPECTED_ORDER);

    const position = new Map(order.map((name, index) => [name, index]));
    for (const source of syntheticTables()) {
      if (!position.has(source.name)) continue;
      for (const reference of source.references) {
        if (reference.deferrable || !position.has(reference.table)) continue;
        if (source.name === 'bots' && reference.table === 'bot_objects') continue;
        expect(position.get(reference.table)).toBeLessThan(position.get(source.name));
      }
    }
  });

  test('is independent of catalog input order', () => {
    const reversed = plan(syntheticTables().reverse()).map((entry) => entry.name);
    const rotated = plan([...syntheticTables().slice(4), ...syntheticTables().slice(0, 4)]).map((entry) => entry.name);
    expect(reversed).toEqual(EXPECTED_ORDER);
    expect(rotated).toEqual(EXPECTED_ORDER);
  });

  test('honors validation dependencies that are not foreign keys', () => {
    const order = plan().map((entry) => entry.name);
    // Alphabetically, the ACL and channels would load before memberships.
    expect(order.indexOf('bot_memberships')).toBeLessThan(order.indexOf('bot_channels'));
    expect(order.indexOf('bot_memberships')).toBeLessThan(order.indexOf('bot_channel_acl'));
    expect(order.indexOf('bot_channels')).toBeLessThan(order.indexOf('bot_channel_acl'));
  });

  test('ignores validation dependencies on tables absent from the catalog', () => {
    const tables = syntheticTables().filter((entry) => entry.name !== 'bot_memberships');
    const order = plan(tables).map((entry) => entry.name);
    expect(order).not.toContain('bot_memberships');
    expect(order.indexOf('bot_channels')).toBeLessThan(order.indexOf('bot_channel_acl'));
  });

  test('skips non-Bot tables and the local owner mapping table', () => {
    const order = plan().map((entry) => entry.name);
    expect(order).not.toContain('user_profiles');
    expect(order).not.toContain('botany');
    expect(order).not.toContain('bot_local_owner_mappings');
  });

  test('loads bots before bot_objects despite the avatar pointer', () => {
    const order = plan().map((entry) => entry.name);
    expect(order.indexOf('bots')).toBeLessThan(order.indexOf('bot_objects'));
  });

  test('defers deferrable self references and cycles instead of failing', () => {
    const order = plan().map((entry) => entry.name);
    expect(order).toContain('bot_runs');
    expect(order.indexOf('bots')).toBeLessThan(order.indexOf('bot_revisions'));
  });

  test('rejects a non-deferrable cycle with a deterministic path', () => {
    const minimal = [
      table('bots', ['id', 'active_revision_id'], { references: [ref('bot_revisions')] }),
      table('bot_revisions', ['id', 'bot_id'], { references: [ref('bots')] }),
    ];
    const first = expectPlanError(() => plan(minimal), { code: 'bot_import_plan_cycle' });
    expect(first.message).toBe('Import tables form a cycle: bot_revisions -> bots -> bot_revisions');
    const second = expectPlanError(() => plan([...minimal].reverse()), { code: 'bot_import_plan_cycle' });
    expect(second.message).toBe(first.message);

    const full = syntheticTables().map((entry) => (entry.name === 'bots'
      ? { ...entry, references: [ref('bot_objects'), ref('bot_revisions', false)] }
      : entry));
    expectPlanError(() => plan(full), { code: 'bot_import_plan_cycle', message: /bots -> bot_revisions -> bots/ });
  });

  test('rejects a cycle created by a validation dependency', () => {
    const tables = syntheticTables().map((entry) => (entry.name === 'bot_memberships'
      ? { ...entry, references: [...entry.references, ref('bot_channels')] }
      : entry));
    expectPlanError(() => plan(tables), {
      code: 'bot_import_plan_cycle',
      message: /bot_channels -> bot_memberships -> bot_channels/,
    });
  });

  test('rejects a non-deferrable self reference', () => {
    const tables = syntheticTables().map((entry) => (entry.name === 'bot_runs'
      ? { ...entry, references: [ref('bot_runs', false), ref('bots')] }
      : entry));
    expectPlanError(() => plan(tables), {
      code: 'bot_import_plan_cycle',
      message: 'bot_runs has a non-deferrable self reference',
    });
  });

  test('marks exactly the regenerated identities and their page order', () => {
    expect(REGENERATED_IDENTITIES).toEqual({ bot_audit_events: 'id', bot_runs: 'queue_sequence' });
    expect(Object.isFrozen(REGENERATED_IDENTITIES)).toBe(true);
    const byName = new Map(plan().map((entry) => [entry.name, entry]));

    expect(byName.get('bot_audit_events').regeneratedIdentity).toBe('id');
    expect(byName.get('bot_audit_events').orderColumns).toEqual(['id']);
    expect(byName.get('bot_runs').regeneratedIdentity).toBe('queue_sequence');
    expect(byName.get('bot_runs').orderColumns).toEqual(['queue_sequence']);
    expect(byName.get('bot_runs').primaryKey).toEqual(['id']);

    for (const [name, entry] of byName) {
      if (Object.hasOwn(REGENERATED_IDENTITIES, name)) continue;
      expect(entry.regeneratedIdentity).toBeNull();
      expect(entry.orderColumns).toEqual(entry.primaryKey);
    }
    expect(byName.get('bot_channel_acl').orderColumns).toEqual(['channel_id', 'user_id']);
  });

  test('rejects a regenerated identity table that lost its identity column', () => {
    const tables = syntheticTables().map((entry) => (entry.name === 'bot_runs'
      ? { ...entry, columns: ['id', 'bot_id', 'parent_run_id'], identity: [] }
      : entry));
    expectPlanError(() => plan(tables), { message: 'bot_runs lost its identity column' });
  });

  test('returns frozen copies with defaults for optional metadata', () => {
    const tables = syntheticTables();
    const bare = { name: 'bot_memberships', columns: ['id', 'bot_id'], primaryKey: ['id'] };
    const result = plan(tables.map((entry) => (entry.name === 'bot_memberships' ? bare : entry)));
    const memberships = result.find((entry) => entry.name === 'bot_memberships');
    expect(memberships.identity).toEqual([]);
    expect(memberships.userColumns).toEqual([]);

    expect(Object.isFrozen(result)).toBe(true);
    for (const entry of result) {
      expect(Object.isFrozen(entry)).toBe(true);
      for (const key of ['columns', 'primaryKey', 'identity', 'userColumns', 'orderColumns']) {
        expect(Object.isFrozen(entry[key])).toBe(true);
      }
    }

    const bots = tables.find((entry) => entry.name === 'bots');
    const before = result.find((entry) => entry.name === 'bots').columns;
    bots.columns.push('mutated_later');
    expect(before).not.toContain('mutated_later');
    expect(result.find((entry) => entry.name === 'bots').userColumns).toEqual(['owner_user_id']);
  });

  test('rejects a missing or malformed catalog', () => {
    for (const catalog of [undefined, null, {}, { tables: 'bots' }, { tables: { bots: {} } }]) {
      expectPlanError(() => planImportTables(catalog), { message: 'The import catalog is invalid' });
    }
    expectPlanError(() => planImportTables({ tables: [] }), { message: 'The import catalog has no Bot tables' });
    expectPlanError(() => plan(syntheticTables().filter((entry) => entry.name !== 'bots')), {
      message: 'The import catalog has no Bot tables',
    });
  });

  test('rejects invalid table metadata, including tables it would skip', () => {
    const base = table('bot_memberships', ['id', 'bot_id']);
    const invalid = [
      null,
      { ...base, name: undefined },
      { ...base, name: 'Bot_memberships' },
      { ...base, name: 'bot-memberships' },
      { ...base, name: `bot_${'x'.repeat(60)}` },
      { ...base, columns: [] },
      { ...base, columns: 'id' },
      { ...base, columns: ['id', 'Bot_id'] },
      { ...base, columns: ['id', 'bot_id"; drop table bots; --'] },
      { ...base, columns: ['id', '1st'] },
      { ...base, primaryKey: [] },
      { ...base, primaryKey: undefined },
      { ...base, primaryKey: ['missing'] },
      table('user_profiles', ['id', 'Email']),
    ];
    for (const entry of invalid) {
      expectPlanError(() => plan([...syntheticTables(), entry]), { message: /^Table metadata for .+ is invalid$/ });
    }
    expectPlanError(() => plan([...syntheticTables(), null]), { message: 'Table metadata for unknown is invalid' });
  });
});

describe('renderPageInsert', () => {
  test('source loads keep every column and override generated identities', () => {
    const sql = normalize(renderPageInsert(planned('bot_runs')));
    expect(sql).toContain(
      'insert into public."bot_runs" ("id", "bot_id", "queue_sequence", "parent_run_id") overriding system value',
    );
    expect(sql).toContain('select r."id", r."bot_id", r."queue_sequence", r."parent_run_id"');
    expect(sql).toContain('from jsonb_populate_recordset(null::public."bot_runs", (select document from devryan_import_page)) r;');
    expect(sql).not.toContain('order by');

    const audit = normalize(renderPageInsert(planned('bot_audit_events'), { regenerate: false }));
    expect(audit).toContain('("id", "event_id", "bot_id", "actor_user_id") overriding system value');
  });

  test('merges omit the regenerated identity and allocate it in source order', () => {
    const runs = normalize(renderPageInsert(planned('bot_runs'), { regenerate: true }));
    expect(runs).toContain('insert into public."bot_runs" ("id", "bot_id", "parent_run_id") select');
    expect(runs).toContain('select r."id", r."bot_id", r."parent_run_id" from');
    expect(runs).not.toContain('overriding system value');
    expect(runs).toMatch(/\) r order by r\."queue_sequence";$/);
    expect(runs.match(/"queue_sequence"/g)).toHaveLength(1);

    const audit = normalize(renderPageInsert(planned('bot_audit_events'), { regenerate: true }));
    expect(audit).toContain('insert into public."bot_audit_events" ("event_id", "bot_id", "actor_user_id") select');
    expect(audit).toContain('select r."event_id", r."bot_id", r."actor_user_id" from');
    expect(audit).not.toContain('overriding system value');
    expect(audit).toMatch(/\) r order by r\."id";$/);
  });

  test('tables without identities render the same in both modes', () => {
    const memberships = planned('bot_memberships');
    const source = renderPageInsert(memberships, { regenerate: false });
    expect(renderPageInsert(memberships, { regenerate: true })).toBe(source);
    expect(renderPageInsert(memberships)).toBe(source);
    const sql = normalize(source);
    expect(sql).toBe(
      'insert into public."bot_memberships" ("id", "bot_id", "user_id", "revoked_at") '
      + 'select r."id", r."bot_id", r."user_id", r."revoked_at" '
      + 'from jsonb_populate_recordset(null::public."bot_memberships", (select document from devryan_import_page)) r;',
    );
    expect(source.endsWith('\n')).toBe(true);
  });

  test('always inserts bots.avatar_object_id as null and stages it for restore', () => {
    for (const regenerate of [false, true]) {
      const sql = renderPageInsert(planned('bots'), { regenerate });
      const parts = statements(sql);
      expect(parts).toHaveLength(2);
      expect(parts[0]).toBe(
        'insert into devryan_import_avatars (bot_id, avatar_object_id) select r.id, r.avatar_object_id '
        + 'from jsonb_populate_recordset(null::public.bots, (select document from devryan_import_page)) r '
        + 'where r.avatar_object_id is not null',
      );
      expect(parts[1]).toContain(
        'insert into public."bots" ("id", "name", "owner_user_id", "avatar_object_id", "active_revision_id") select',
      );
      expect(parts[1]).toContain('select r."id", r."name", r."owner_user_id", null::uuid, r."active_revision_id" from');
      expect(parts[1]).not.toContain('r."avatar_object_id"');
    }
  });

  test('only the bots table nulls an avatar pointer', () => {
    const profiles = {
      name: 'bot_profiles', columns: ['id', 'avatar_object_id'], identity: [], regeneratedIdentity: null,
    };
    const sql = normalize(renderPageInsert(profiles));
    expect(sql).toContain('select r."id", r."avatar_object_id" from');
    expect(sql).not.toContain('null::uuid');
    expect(sql).not.toContain('devryan_import_avatars');
  });

  test('quotes every identifier and refuses unsafe ones', () => {
    const sql = renderPageInsert(planned('bot_channel_acl'));
    expect(normalize(sql)).toContain('insert into public."bot_channel_acl" ("channel_id", "user_id", "bot_id")');
    expect(normalize(sql)).toContain('select r."channel_id", r."user_id", r."bot_id"');

    const safe = { name: 'bot_things', columns: ['id'], identity: [], regeneratedIdentity: null };
    expectPlanError(() => renderPageInsert({ ...safe, name: 'bot_things"; drop table bots; --' }), {
      message: /^Identifier .* is invalid$/,
    });
    expectPlanError(() => renderPageInsert({ ...safe, columns: ['id', 'x"y'] }), { message: 'Identifier x"y is invalid' });
    expectPlanError(() => renderPageInsert({ ...safe, columns: ['Id'] }), { message: 'Identifier Id is invalid' });
  });
});

describe('page framing', () => {
  test('opens a CSV copy with control-byte quote and delimiter, and closes it', () => {
    const open = renderPageOpen();
    expect(open.startsWith('truncate devryan_import_page;\n')).toBe(true);
    expect(open).toContain("copy devryan_import_page (document) from stdin with (format csv, quote e'\\x01', delimiter e'\\x02');");
    expect(open.endsWith('\n')).toBe(true);
    expect(renderPageClose()).toBe('\n\\.\n');
  });

  test('identity inserts never overwrite existing identities', () => {
    const local = normalize(renderIdentityInsert());
    expect(local).toContain('select public.devryan_local_upsert_identity( r.id, r.email, r.display_name, r.account_kind, r.role, r.status)');
    expect(local).toContain('where not exists (select 1 from public.user_profiles existing where existing.id = r.id);');

    const source = statements(renderSourceIdentityInsert());
    expect(source).toHaveLength(2);
    expect(source[0]).toMatch(/^insert into auth\.users \(id, email\) .* on conflict \(id\) do nothing$/);
    expect(source[1]).toMatch(/^insert into public\.user_profiles .* on conflict \(id\) do nothing$/);
  });
});

describe('assertPageBytes', () => {
  test('accepts a JSON array and returns the same bytes', () => {
    const buffer = Buffer.from('[{"id":"a","text":"line\\nbreak\\r"}]');
    expect(assertPageBytes(buffer)).toBe(buffer);
    expect(assertPageBytes(Buffer.from('[]')).toString()).toBe('[]');
    expect(assertPageBytes('[1,2]').toString()).toBe('[1,2]');
    const view = new Uint8Array([0x5b, 0x5d]);
    const fromView = assertPageBytes(view);
    expect(Buffer.isBuffer(fromView)).toBe(true);
    expect(fromView.toString()).toBe('[]');
  });

  test('rejects anything that is not a JSON array', () => {
    for (const bytes of [undefined, null, '', '[', '{}', '{"a":[]}', '"[]"', ' []', 'null', Buffer.alloc(0)]) {
      expectPlanError(() => assertPageBytes(bytes), {
        code: 'bot_import_page_invalid',
        message: 'An import page is not a JSON array',
      });
    }
  });

  test('rejects raw line and CSV framing bytes', () => {
    for (const byte of [0x0a, 0x0d, 0x01, 0x02]) {
      const bytes = Buffer.concat([Buffer.from('["a'), Buffer.from([byte]), Buffer.from('b"]')]);
      expectPlanError(() => assertPageBytes(bytes), {
        code: 'bot_import_page_invalid',
        message: 'An import page contains raw control characters',
      });
    }
    // A raw line break is the only way to forge the \. end-of-copy marker.
    expectPlanError(() => assertPageBytes(Buffer.from('[]\n\\.\ndrop table bots;')), {
      code: 'bot_import_page_invalid',
    });
    expectPlanError(() => assertPageBytes(Buffer.from('[1]\r\n')), { code: 'bot_import_page_invalid' });
  });
});

describe('load prelude and epilogue', () => {
  test('exposes the reviewed trigger set', () => {
    expect(IMPORT_DISABLED_TRIGGERS).toEqual({
      load: [{ table: 'bot_runs', trigger: 'bot_runs_enqueue_memory_extraction' }],
      avatarRestore: [{ table: 'bots', trigger: 'bots_updated_at' }],
    });
    expect(Object.isFrozen(IMPORT_DISABLED_TRIGGERS)).toBe(true);
    expect(Object.isFrozen(IMPORT_DISABLED_TRIGGERS.load)).toBe(true);
    expect(Object.isFrozen(IMPORT_DISABLED_TRIGGERS.avatarRestore)).toBe(true);
  });

  test('prelude opens a deferred transaction and disables only the load triggers', () => {
    const prelude = renderLoadPrelude();
    const lines = prelude.split('\n').map((line) => line.trim()).filter(Boolean);
    expect(lines[0]).toBe('\\set ON_ERROR_STOP 1');
    expect(lines[1]).toBe('begin;');

    const begin = indexOfStatement(prelude, /^begin$/);
    const deferred = indexOfStatement(prelude, /^set constraints all deferred$/);
    const disable = indexOfStatement(prelude, /disable trigger/);
    const staging = indexOfStatement(prelude, /^create temporary table devryan_import_page /);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(deferred).toBeGreaterThan(begin);
    expect(disable).toBeGreaterThan(deferred);
    expect(staging).toBeGreaterThan(disable);

    const disabled = statements(prelude).filter((statement) => statement.includes('disable trigger'));
    expect(disabled).toEqual(['alter table public."bot_runs" disable trigger "bot_runs_enqueue_memory_extraction"']);
    expect(prelude).not.toContain('bots_updated_at');
    expect(prelude).not.toContain('enable trigger');
    expect(statements(prelude)).not.toContain('commit');
    expect(statements(prelude)).toContain('create temporary table devryan_import_page (document jsonb not null) on commit drop');
    expect(statements(prelude)).toContain(
      'create temporary table devryan_import_avatars (bot_id uuid primary key, avatar_object_id uuid not null) on commit drop',
    );
  });

  test('prelude disables exactly the configured triggers', () => {
    const custom = [
      { table: 'bot_runs', trigger: 'bot_runs_enqueue_memory_extraction' },
      { table: 'user_profiles', trigger: 'user_profiles_require_active_assignment' },
    ];
    const disabled = statements(renderLoadPrelude({ disableTriggers: custom }))
      .filter((statement) => statement.includes('disable trigger'));
    expect(disabled).toEqual([
      'alter table public."bot_runs" disable trigger "bot_runs_enqueue_memory_extraction"',
      'alter table public."user_profiles" disable trigger "user_profiles_require_active_assignment"',
    ]);
    expect(renderLoadPrelude({ disableTriggers: [] })).not.toContain('alter table');
    expectPlanError(() => renderLoadPrelude({ disableTriggers: [{ table: 'bots', trigger: 'x"; drop' }] }), {
      message: /^Identifier .* is invalid$/,
    });
  });

  test('epilogue checks deferred constraints before any alter table', () => {
    const epilogue = renderLoadEpilogue();
    const parts = statements(epilogue);
    expect(parts[0]).toBe('set constraints all immediate');
    const immediate = indexOfStatement(epilogue, /^set constraints all immediate$/);
    const firstAlter = indexOfStatement(epilogue, /^alter table /);
    expect(firstAlter).toBeGreaterThan(immediate);
    expect(epilogue.indexOf('set constraints all immediate;')).toBeLessThan(epilogue.indexOf('alter table'));
    expect(epilogue).not.toContain('set constraints all deferred');
  });

  test('epilogue restores avatars with the updated_at trigger disabled, then re-enables triggers and commits', () => {
    const epilogue = renderLoadEpilogue();
    expect(statements(epilogue)).toEqual([
      'set constraints all immediate',
      'alter table public."bots" disable trigger "bots_updated_at"',
      'update public.bots b set avatar_object_id = a.avatar_object_id from devryan_import_avatars a where b.id = a.bot_id',
      'alter table public."bots" enable trigger "bots_updated_at"',
      'alter table public."bot_runs" enable trigger "bot_runs_enqueue_memory_extraction"',
      'commit',
    ]);
    expect(epilogue.endsWith('\n')).toBe(true);
  });

  test('epilogue re-enables exactly what the matching prelude disabled', () => {
    const custom = [
      { table: 'bot_runs', trigger: 'bot_runs_enqueue_memory_extraction' },
      { table: 'user_profiles', trigger: 'user_profiles_require_active_assignment' },
    ];
    for (const options of [undefined, { disableTriggers: custom }, { disableTriggers: [] }]) {
      const disabled = statements(renderLoadPrelude(options))
        .filter((statement) => statement.includes(' disable trigger '))
        .map((statement) => statement.replace(' disable trigger ', ' enable trigger '));
      const epilogue = statements(renderLoadEpilogue(options));
      const avatarEnable = epilogue.indexOf('alter table public."bots" enable trigger "bots_updated_at"');
      expect(avatarEnable).toBeGreaterThan(0);
      const reenabled = epilogue.slice(avatarEnable + 1).filter((statement) => statement.includes(' enable trigger '));
      expect(reenabled).toEqual(disabled);
      expect(epilogue.at(-1)).toBe('commit');
      // The avatar restore always happens, whatever the load trigger set.
      expect(epilogue).toContain('alter table public."bots" disable trigger "bots_updated_at"');
    }
  });
});

describe('renderMergeFinalization', () => {
  test('configuration scope pauses imported activity and clears transport checkpoints without changing signed revisions', () => {
    const sql = renderMergeFinalization({ importedBotIds: ['b0000000-0000-4000-8000-000000000001'], scope: 'configuration' });
    expect(sql).toContain("set lifecycle = 'paused'");
    expect(sql).toContain("then 'paused' else status end, next_occurrence_at = null, last_occurrence_at = null");
    expect(sql).toContain("enabled = false, state = 'disabled'");
    expect(sql).toContain('update_offset = 0, lease_owner = null, lease_until = null');
    expect(sql).toContain('generation = gen_random_uuid()');
    expect(sql).toContain('set health = null');
    expect(sql).not.toContain('update public.bot_revisions');
  });
  const BOT_A = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const BOT_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const OWNER = 'a3bb189e-8bf9-3888-9912-ace4e6543002';
  const CREDENTIAL = '16fd2706-8baf-433b-82eb-8c7fada847da';
  const SECRET = '886313e1-3b8a-5372-9b90-0c9aee199e5d';
  const literal = (id) => `'${id}'::uuid`;

  test('renders nothing when no Bot was imported', () => {
    expect(renderMergeFinalization()).toBe('');
    expect(renderMergeFinalization({})).toBe('');
    expect(renderMergeFinalization({ importedBotIds: [] })).toBe('');
  });

  test('keeps possibly delivered Telegram work uncertain and releases leases', () => {
    const sql = renderMergeFinalization({ importedBotIds: [BOT_A, BOT_B] });
    const list = `(${literal(BOT_A)}, ${literal(BOT_B)})`;
    expect(statements(sql)).toEqual([
      `update public.bot_telegram_outbox set state = 'uncertain' where bot_id in ${list} and state in ('sending', 'synthesizing')`,
      `update public.bot_telegram_inbox set state = 'admission_uncertain' where bot_id in ${list} and state = 'admitting'`,
      `update public.bot_telegram_connections set lease_owner = null, lease_until = null where bot_id in ${list}`,
    ]);
    expect(sql.endsWith('\n')).toBe(true);
    expect(sql).not.toContain('bot_local_owner_mappings');
    expect(sql).not.toContain("status = 'error'");
    expect(sql).not.toContain('telegram_credential_missing');
  });

  test('lower-cases identifiers and drops exact duplicates', () => {
    const sql = renderMergeFinalization({ importedBotIds: [BOT_A.toUpperCase(), BOT_B, BOT_B] });
    expect(sql).not.toContain(BOT_A.toUpperCase());
    const outbox = statements(sql)[0];
    expect(outbox).toContain(`(${literal(BOT_A)}, ${literal(BOT_B)})`);
    expect(outbox.split(BOT_B)).toHaveLength(2);
  });

  test('maps owners only through an active source membership', () => {
    const sql = renderMergeFinalization({
      importedBotIds: [BOT_A, BOT_B],
      ownerMappings: [{ botId: BOT_A, sourceOwnerUserId: OWNER }, { botId: BOT_B, sourceOwnerUserId: OWNER }],
    });
    const inserts = statements(sql).filter((statement) => statement.startsWith('insert into public.bot_local_owner_mappings'));
    expect(inserts).toEqual([BOT_A, BOT_B].map((botId) => (
      'insert into public.bot_local_owner_mappings (bot_id, source_owner_user_id) '
      + `select ${literal(botId)}, ${literal(OWNER)} `
      + 'where exists (select 1 from public.bot_memberships m '
      + `where m.bot_id = ${literal(botId)} and m.user_id = ${literal(OWNER)} and m.revoked_at is null)`
    )));
    const parts = statements(sql);
    expect(parts.findIndex((statement) => statement.startsWith('insert into'))).toBe(3);
  });

  test('disconnects integrations whose vault records are missing', () => {
    const sql = renderMergeFinalization({
      importedBotIds: [BOT_A],
      ownerMappings: [{ botId: BOT_A, sourceOwnerUserId: OWNER }],
      disconnected: {
        credentials: [CREDENTIAL.toUpperCase()],
        environmentSecrets: [SECRET, SECRET],
        telegramConnections: [BOT_A],
      },
    });
    const parts = statements(sql);
    expect(parts.slice(-3)).toEqual([
      `update public.bot_credentials set status = 'error' where id in (${literal(CREDENTIAL)})`,
      `update public.bot_environment_secrets set status = 'error' where id in (${literal(SECRET)})`,
      `update public.bot_telegram_connections set enabled = false, state = 'error', error_code = 'telegram_credential_missing' where bot_id in (${literal(BOT_A)})`,
    ]);
    expect(parts.findIndex((statement) => statement.startsWith('insert into public.bot_local_owner_mappings')))
      .toBeLessThan(parts.findIndex((statement) => statement.startsWith('update public.bot_credentials')));
  });

  test('omits disconnect statements for empty or absent lists', () => {
    const partial = renderMergeFinalization({ importedBotIds: [BOT_A], disconnected: { credentials: [CREDENTIAL] } });
    expect(partial).toContain('update public.bot_credentials');
    expect(partial).not.toContain('bot_environment_secrets');
    expect(partial).not.toContain('telegram_credential_missing');

    const empty = renderMergeFinalization({
      importedBotIds: [BOT_A],
      disconnected: { credentials: [], environmentSecrets: [], telegramConnections: [] },
    });
    expect(statements(empty)).toHaveLength(3);
  });

  test('rejects anything that is not a UUID before rendering SQL', () => {
    const hostile = [
      "x'); drop table public.bots; --",
      `${BOT_A}'::uuid); drop table public.bots; --`,
      `${BOT_A}\n`,
      ` ${BOT_A}`,
      BOT_A.replaceAll('-', ''),
      '0f8fad5b-d9cb-069f-a165-70867728950e',
      '0f8fad5b-d9cb-469f-c165-70867728950e',
      '',
      1,
      null,
    ];
    for (const value of hostile) {
      expectPlanError(() => renderMergeFinalization({ importedBotIds: [BOT_A, value] }), {
        message: 'A merge identifier is invalid',
      });
      for (const bucket of ['credentials', 'environmentSecrets', 'telegramConnections']) {
        expectPlanError(() => renderMergeFinalization({
          importedBotIds: [BOT_A],
          disconnected: { credentials: [], environmentSecrets: [], telegramConnections: [], [bucket]: [value] },
        }), { message: 'A merge identifier is invalid' });
      }
      expectPlanError(() => renderMergeFinalization({
        importedBotIds: [BOT_A],
        ownerMappings: [{ botId: value, sourceOwnerUserId: OWNER }],
      }), { message: 'An owner mapping is invalid' });
      expectPlanError(() => renderMergeFinalization({
        importedBotIds: [BOT_A],
        ownerMappings: [{ botId: BOT_A, sourceOwnerUserId: value }],
      }), { message: 'An owner mapping is invalid' });
    }
    expectPlanError(() => renderMergeFinalization({ importedBotIds: BOT_A }), { message: 'A merge identifier is invalid' });
    expectPlanError(() => renderMergeFinalization({ importedBotIds: [BOT_A], ownerMappings: [{}] }), {
      message: 'An owner mapping is invalid',
    });
  });

  test('renders only UUID literals and fixed state values', () => {
    const sql = renderMergeFinalization({
      importedBotIds: [BOT_A, BOT_B],
      ownerMappings: [{ botId: BOT_A, sourceOwnerUserId: OWNER }],
      disconnected: { credentials: [CREDENTIAL], environmentSecrets: [SECRET], telegramConnections: [BOT_B] },
    });
    const literals = [...sql.matchAll(/'([^']*)'/g)].map((match) => match[1]);
    const fixed = new Set(['uncertain', 'sending', 'synthesizing', 'admission_uncertain', 'admitting', 'error', 'telegram_credential_missing']);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const value of literals) expect(fixed.has(value) || uuid.test(value)).toBe(true);
  });
});

describe('IMPORT_CATALOG_SQL', () => {
  test('projects every key the planner reads, for public Bot tables only', () => {
    for (const key of ["'tables'", "'name'", "'columns'", "'identity'", "'primaryKey'", "'references'", "'table'", "'deferrable'", "'userColumns'"]) {
      expect(IMPORT_CATALOG_SQL).toContain(key);
    }
    expect(IMPORT_CATALOG_SQL).toContain("n.nspname = 'public'");
    expect(IMPORT_CATALOG_SQL).toContain("c.relkind = 'r'");
    // The underscore is escaped so LIKE does not treat it as a wildcard.
    expect(IMPORT_CATALOG_SQL).toContain("c.relname like 'bot\\_%'");
  });
});

describe('import rendering edge cases', () => {
  const BOT = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const OWNER_ID = 'a3bb189e-8bf9-3888-9912-ace4e6543002';
  const OTHER_OWNER = '16fd2706-8baf-433b-82eb-8c7fada847da';
  const CREDENTIAL_ID = '886313e1-3b8a-5372-9b90-0c9aee199e5d';

  test('de-duplicates identifiers regardless of case', () => {
    const sql = renderMergeFinalization({ importedBotIds: [BOT, BOT.toUpperCase()] });
    expect(sql.match(new RegExp(`'${BOT}'::uuid`, 'g'))).toHaveLength(3);
    expect(sql).not.toContain(BOT.toUpperCase());
  });

  test('disconnects integrations even when the merge imported no Bot', () => {
    const sql = renderMergeFinalization({
      importedBotIds: [],
      disconnected: { credentials: [CREDENTIAL_ID], environmentSecrets: [], telegramConnections: [] },
    });
    expect(sql).toBe(`update public.bot_credentials set status = 'error' where id in ('${CREDENTIAL_ID}'::uuid);\n`);
    expect(renderMergeFinalization({ importedBotIds: [] })).toBe('');
  });

  test('renders one owner mapping per Bot and refuses an ambiguous one', () => {
    const sql = renderMergeFinalization({
      importedBotIds: [BOT],
      ownerMappings: [
        { botId: BOT, sourceOwnerUserId: OWNER_ID },
        { botId: BOT.toUpperCase(), sourceOwnerUserId: OWNER_ID.toUpperCase() },
      ],
    });
    expect(sql.match(/insert into public\.bot_local_owner_mappings/g)).toHaveLength(1);
    expect(() => renderMergeFinalization({
      importedBotIds: [BOT],
      ownerMappings: [
        { botId: BOT, sourceOwnerUserId: OWNER_ID },
        { botId: BOT, sourceOwnerUserId: OTHER_OWNER },
      ],
    })).toThrow(BotImportPlanError);
  });

  test('refuses a merge of a table with an identity the plan does not regenerate', () => {
    const [entry] = planImportTables({
      tables: [table('bots', ['id', 'counter'], { identity: ['counter'] })],
    });
    expect(renderPageInsert(entry, { regenerate: false })).toContain('overriding system value');
    let caught = null;
    try {
      renderPageInsert(entry, { regenerate: true });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BotImportPlanError);
    expect(caught.code).toBe('bot_import_plan_identity_unsupported');
  });
});
