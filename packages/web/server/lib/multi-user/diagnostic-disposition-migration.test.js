import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../../../../supabase/migrations/20260815141850_add_diagnostic_disposition.sql', import.meta.url),
  'utf8',
).toLowerCase();

describe('diagnostic disposition migration', () => {
  it('adds a nullable constrained disposition and the filtered keyset index', () => {
    expect(migration).toContain('add column diagnostic_disposition text');
    expect(migration).toContain("diagnostic_disposition in ('actionable', 'expected')");
    expect(migration).not.toContain('diagnostic_disposition text not null');
    expect(migration).toContain('activity_logs_diagnostic_disposition_error_idx');
    expect(migration).toContain('(diagnostic_disposition, action, created_at desc, event_id desc)');
    expect(migration).toContain("where action in ('session.error', 'tool.failed', 'managed_task.failed', 'client.error')");
  });

  it('backfills narrowly, preserves evidence, and keeps classification immutable', () => {
    expect(migration).toContain("diagnostic_disposition = 'actionable'");
    expect(migration).toContain("diagnostic_disposition = 'expected'");
    expect(migration).toContain("diagnostic_impact = 'low'");
    expect(migration).not.toContain('disk i/o error');
    expect(migration).not.toContain('database is locked');
    expect(migration).not.toMatch(/delete\s+from\s+public\.activity_logs/);
    expect(migration).not.toMatch(/set\s+metadata\s*=/);
    expect(migration).toContain('new.diagnostic_disposition is distinct from old.diagnostic_disposition');
  });
});
