import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../../../../../supabase/migrations/20260816120000_refine_error_diagnostic_classification.sql',
    import.meta.url,
  ),
  'utf8',
).toLowerCase();

describe('error diagnostic refinement migration', () => {
  it('reclassifies only the narrow benign and transport-timeout patterns', () => {
    expect(migration).toContain("'tool execution aborted'");
    expect(migration).toContain("in ('grep', 'rg', 'search')");
    expect(migration).toContain('regex parse error');
    expect(migration).toContain("= 'devryan_browser'");
    expect(migration).toContain('err_connection_refused');
    expect(migration).toContain("in ('unknownerror', 'unknown error')");
    expect(migration).toContain("'failurekind', 'request_timeout'");
    expect(migration).toContain("jsonb_typeof(metadata -> 'retryable')");
    expect(migration).not.toContain('managed_task.failed');
  });

  it('preserves evidence while updating columns and mirrored metadata as inferred', () => {
    expect(migration).toContain("diagnostic_source = 'inferred'");
    expect(migration).toContain("'failureclass', 'input'");
    expect(migration).toContain("'failureclass', 'integration_runtime'");
    expect(migration).toContain("'failureclass', 'session_runtime'");
    expect(migration).toContain("'diagnosticdisposition', 'expected'");
    expect(migration).not.toMatch(/delete\s+from\s+public\.activity_logs/);
    expect(migration).not.toMatch(/\b(event_id|created_at|session_id|request_id|success)\s*=/);
    expect(migration).not.toMatch(/metadata\s*=\s*jsonb_build_object/);
  });

  it('suspends and restores classification immutability in one transaction', () => {
    expect(migration.trimStart()).toMatch(/^--[\s\S]*?\nbegin;/);
    expect(migration.trimEnd()).toMatch(/commit;$/);
    expect(migration).toContain('drop trigger if exists activity_logs_preserve_diagnostic_classification');
    expect(migration).toContain('create trigger activity_logs_preserve_diagnostic_classification');
    expect(migration).toContain(
      'execute function public.devryan_preserve_activity_diagnostic_classification()',
    );
  });
});
