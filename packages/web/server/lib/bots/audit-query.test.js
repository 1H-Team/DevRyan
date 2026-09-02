import { describe, expect, it, vi } from 'vitest';

import { createBotAuditQuery } from './audit-query.js';

const ADMIN_ID = 'a0000000-0000-4000-8000-000000000001';
const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const EVENT_ID = 'c0000000-0000-4000-8000-000000000001';
const RUN_ID = 'd0000000-0000-4000-8000-000000000001';
const admin = { id: ADMIN_ID, role: 'admin', scope: 'managed' };

const auditRow = (overrides = {}) => ({
  id: '41',
  event_id: EVENT_ID,
  bot_id: BOT_ID,
  actor_user_id: ADMIN_ID,
  target_type: 'bot_run',
  target_id: RUN_ID,
  action: 'bot.run.failed',
  result: 'failure',
  metadata: { botId: BOT_ID, runId: RUN_ID, code: 'bot_run_timeout', retryCount: 0 },
  created_at: '2026-08-28T20:00:00.000Z',
  ...overrides,
});

const createHarness = ({ rows = [auditRow()], detailRow, bots, actors } = {}) => {
  const rest = vi.fn(async (table, options = {}) => {
    if (table === 'bot_audit_events' || table === 'bot_audit_review_events'
      || table === 'bot_audit_events_with_resolution') {
      if (options.maybeSingle) return detailRow === undefined ? rows[0] || null : detailRow;
      return rows;
    }
    if (table === 'bots') return bots === undefined
      ? [{ id: BOT_ID, name: 'Release Sentinel', title: 'Release Sentinel', lifecycle: 'active' }]
      : bots;
    if (table === 'user_profiles') return actors === undefined
      ? [{ id: ADMIN_ID, display_name: 'Administrator', email: 'admin@example.com', role: 'admin' }]
      : actors;
    throw new Error(`Unexpected table ${table}`);
  });
  const assertSchemaVersion = vi.fn(async () => '20260902120000');
  const rpc = vi.fn(async () => ({ clearedCount: 2 }));
  return {
    rest,
    rpc,
    assertSchemaVersion,
    query: createBotAuditQuery({
      supabase: { rest, rpc },
      now: () => Date.parse('2026-08-30T12:00:00.000Z'),
      assertSchemaVersion,
      logger: { warn: vi.fn() },
    }),
  };
};

describe('Bot audit query service', () => {
  it('requires the exact managed administrator role before reading storage', async () => {
    const harness = createHarness();
    await expect(harness.query.list({ ...admin, role: 'developer' })).rejects.toMatchObject({
      code: 'bot_audit_admin_required',
      statusCode: 403,
    });
    await expect(harness.query.list({ ...admin, scope: 'local-admin' })).rejects.toMatchObject({
      code: 'bot_audit_admin_required',
      statusCode: 403,
    });
    expect(harness.rest).not.toHaveBeenCalled();
  });

  it('defaults to issues and uses stable newest-first keyset pagination', async () => {
    const rows = [auditRow(), auditRow({ id: '40', event_id: 'c0000000-0000-4000-8000-000000000002' })];
    const harness = createHarness({ rows });
    const page = await harness.query.list(admin, { limit: '1' });

    expect(page.logs).toHaveLength(1);
    expect(page.logs[0]).toMatchObject({
      result: 'failure',
      diagnosticCode: 'bot_run_timeout',
      resolvedAt: null,
      resolvedByEventId: null,
      bot: { name: 'Release Sentinel', deleted: false },
      actor: { displayName: 'Administrator', former: false },
    });
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(harness.assertSchemaVersion).toHaveBeenCalledWith('20260902120000');
    const request = harness.rest.mock.calls.find(([table]) => table === 'bot_audit_review_events')[1];
    expect(request.query).toMatchObject({
      result: 'in.(failure,partial,unknown)',
      resolved_at: 'is.null',
      order: 'created_at.desc,id.desc',
      limit: 2,
    });

    await harness.query.list(admin, {
      result: 'all',
      bot: BOT_ID,
      actor: ADMIN_ID,
      q: ' timeout ',
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-31T00:00:00.000Z',
      limit: '1',
      cursor: page.nextCursor,
    });
    const filtered = harness.rest.mock.calls.filter(([table]) => table === 'bot_audit_review_events').at(-1)[1];
    expect(filtered.query.result).toBeUndefined();
    expect(filtered.query.bot_id).toBe(`eq.${BOT_ID}`);
    expect(filtered.query.actor_user_id).toBe(`eq.${ADMIN_ID}`);
    expect(filtered.query.and).toContain('id.lt.41');
    expect(filtered.query.and).toContain('metadata->>code.ilike.*timeout*');
    expect(filtered.query.and).toContain('created_at.gte.2026-08-01T00:00:00.000Z');
  });

  it('projects immutable issue resolution fields in All and detail views', async () => {
    const resolvedByEventId = 'c0000000-0000-4000-8000-000000000099';
    const row = auditRow({
      resolved_at: '2026-08-28T20:01:00.000Z',
      resolved_by_event_id: resolvedByEventId,
    });
    const harness = createHarness({ rows: [row], detailRow: row });

    const all = await harness.query.list(admin, { result: 'all' });
    expect(all.logs[0]).toMatchObject({
      eventId: EVENT_ID,
      resolvedAt: '2026-08-28T20:01:00.000Z',
      resolvedByEventId,
    });
    await expect(harness.query.detail(admin, EVENT_ID)).resolves.toMatchObject({
      log: { resolvedAt: '2026-08-28T20:01:00.000Z', resolvedByEventId },
    });
  });

  it('redacts invalid metadata per row without exposing content or failing the detail', async () => {
    const harness = createHarness({
      detailRow: auditRow({
        metadata: { botId: BOT_ID, code: 'legacy_error', prompt: 'do not expose this' },
      }),
    });
    const result = await harness.query.detail(admin, EVENT_ID);
    expect(result.log.metadataRedacted).toBe(true);
    expect(result.log.metadata).toEqual({ code: 'bot_audit_metadata_redacted', redacted: true });
    expect(JSON.stringify(result)).not.toContain('do not expose this');
  });

  it('hydrates deleted Bots and former users with safe fallbacks', async () => {
    const harness = createHarness({
      detailRow: auditRow({ bot_id: null, actor_user_id: null }),
      bots: [],
      actors: [],
    });
    const result = await harness.query.detail(admin, EVENT_ID);
    expect(result.log.bot).toMatchObject({ id: BOT_ID, name: 'Deleted Bot', deleted: true });
    expect(result.log.actor).toMatchObject({ id: null, former: true });
  });

  it('validates filters and returns an independent UUID-addressed detail', async () => {
    const harness = createHarness({ detailRow: null });
    await expect(harness.query.list(admin, { result: 'broken' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(harness.query.list(admin, { actor: 'not-a-uuid' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(harness.query.list(admin, { unsupported: 'value' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(harness.query.list(admin, {
      from: '2026-08-30T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
    })).rejects.toMatchObject({ statusCode: 400 });
    await expect(harness.query.detail(admin, 'not-a-uuid')).rejects.toMatchObject({ statusCode: 400 });
    await expect(harness.query.detail(admin, EVENT_ID)).rejects.toMatchObject({
      code: 'bot_audit_not_found',
      statusCode: 404,
    });
  });

  it('accepts every documented explicit result filter', async () => {
    const harness = createHarness();
    for (const result of ['failure', 'partial', 'unknown', 'denied', 'success']) {
      await harness.query.list(admin, { result });
      const request = harness.rest.mock.calls.filter(([table]) => table === 'bot_audit_review_events').at(-1)[1];
      expect(request.query.result).toBe(`eq.${result}`);
    }
  });

  it('lists current Bot identities without depending on execution health', async () => {
    const harness = createHarness();
    await expect(harness.query.options(admin)).resolves.toEqual({
      bots: [{ id: BOT_ID, name: 'Release Sentinel', title: 'Release Sentinel', lifecycle: 'active' }],
    });
  });

  it('clears only explicit ranges with one server cutoff and authenticated actor', async () => {
    const harness = createHarness();
    for (const [range, since] of [
      ['24h', '2026-08-29T12:00:00.000Z'],
      ['7d', '2026-08-23T12:00:00.000Z'],
      ['14d', '2026-08-16T12:00:00.000Z'],
      ['30d', '2026-07-31T12:00:00.000Z'],
      ['all', null],
    ]) {
      await expect(harness.query.clear(admin, { range })).resolves.toEqual({ clearedCount: 2 });
      expect(harness.rpc).toHaveBeenLastCalledWith('devryan_clear_bot_audit', {
        p_actor_id: ADMIN_ID, p_since: since, p_until: '2026-08-30T12:00:00.000Z',
      });
    }
    expect(harness.rest).not.toHaveBeenCalled();
  });

  it('rejects unauthorized clears and malformed ranges without a mutation', async () => {
    const harness = createHarness();
    for (const principal of [{ ...admin, role: 'developer' }, { ...admin, scope: 'local-admin' }, null]) {
      await expect(harness.query.clear(principal, { range: 'all' })).rejects.toMatchObject({ statusCode: 403 });
    }
    for (const query of [{}, { range: '31d' }, { range: ['all'] }, { range: 'all', actor: ADMIN_ID }]) {
      await expect(harness.query.clear(admin, query)).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(harness.rpc).not.toHaveBeenCalled();
  });

  it('reports missing migrations and invalid responses without claiming a successful clear', async () => {
    const harness = createHarness();
    harness.rpc.mockRejectedValueOnce({ payload: { code: 'PGRST202' } });
    await expect(harness.query.clear(admin, { range: 'all' })).rejects.toMatchObject({
      statusCode: 503, code: 'bot_audit_clear_migration_required',
    });
    harness.rpc.mockResolvedValueOnce({ clearedCount: '2' });
    await expect(harness.query.clear(admin, { range: 'all' })).rejects.toMatchObject({ statusCode: 502 });
    harness.rest.mockRejectedValueOnce({ payload: { code: 'PGRST205' } });
    await expect(harness.query.list(admin)).rejects.toMatchObject({
      code: 'bot_audit_clear_migration_required',
      message: expect.stringContaining('20260902120000'),
    });
  });
});
