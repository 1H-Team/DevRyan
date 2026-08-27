import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../../../../../supabase/migrations/20260827200000_refine_error_log_remediation.sql',
    import.meta.url,
  ),
  'utf8',
).toLowerCase();

describe('error log remediation migration', () => {
  it('matches only confirmed routine signatures and excludes real browser host failures', () => {
    expect(migration).toContain('skill\\s+"[^\"]+"\\s+not found');
    expect(migration).toContain('managed task barrier');
    expect(migration).toContain('result is already acknowledged');
    expect(migration).toContain('filepath|oldstring');
    expect(migration).toContain('resizeobserver loop completed with undelivered notifications');
    expect(migration).toContain('diagnostic.recovered');
    expect(migration).toContain('cannot resolve session lineage');
    expect(migration).toContain('browser_owner_context_unavailable');
  });

  it('preserves every forensic identifier and row', () => {
    expect(migration).not.toMatch(/delete\s+from\s+public\.activity_logs/);
    expect(migration).not.toMatch(/\b(event_id|created_at|session_id|request_id|success)\s*=/);
    expect(migration).not.toMatch(/metadata\s*=\s*jsonb_build_object/);
    expect(migration).toContain("diagnostic_source = 'inferred'");
    expect(migration).toContain("diagnostic_disposition = 'expected'");
  });

  it('restores the immutable-classification trigger in the same transaction', () => {
    expect(migration.trimStart()).toMatch(/^--[\s\S]*?\nbegin;/);
    expect(migration.trimEnd()).toMatch(/commit;$/);
    expect(migration).toContain('drop trigger if exists activity_logs_preserve_diagnostic_classification');
    expect(migration).toContain('create trigger activity_logs_preserve_diagnostic_classification');
    expect(migration).toContain(
      'execute function public.devryan_preserve_activity_diagnostic_classification()',
    );
  });
});
