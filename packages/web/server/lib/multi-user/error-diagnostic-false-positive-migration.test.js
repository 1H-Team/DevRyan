import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../../../../../supabase/migrations/20260818120000_refine_error_diagnostic_false_positives.sql',
    import.meta.url,
  ),
  'utf8',
).toLowerCase();

describe('error diagnostic false-positive migration', () => {
  it('matches only the three confirmed historical signature families', () => {
    expect(migration).toContain("= 'devryan_browser'");
    expect(migration).toContain('could not locate element');
    expect(migration).toContain("in ('webfetch', 'web_fetch')");
    expect(migration).toContain('status code: 404');
    expect(migration).toContain("in ('glob', 'grep', 'rg', 'search')");
    expect(migration).toContain('stdout maxbuffer length exceeded');
    expect(migration).not.toContain('managed_task.failed');
    expect(migration).not.toContain('parent message');
  });

  it('marks rows inferred and expected without deleting forensic evidence', () => {
    expect(migration.match(/diagnostic_source = 'inferred'/g)).toHaveLength(3);
    expect(migration.match(/diagnostic_disposition = 'expected'/g)).toHaveLength(3);
    expect(migration).toContain("'failureclass', 'integration_runtime'");
    expect(migration).toContain("'diagnosticdisposition', 'expected'");
    expect(migration).not.toMatch(/delete\s+from\s+public\.activity_logs/);
    expect(migration).not.toMatch(/\b(event_id|created_at|session_id|request_id|success)\s*=/);
    expect(migration).not.toMatch(/metadata\s*=\s*jsonb_build_object/);
  });

  it('suspends and restores immutable classification in one transaction', () => {
    expect(migration.trimStart()).toMatch(/^--[\s\S]*?\nbegin;/);
    expect(migration.trimEnd()).toMatch(/commit;$/);
    expect(migration).toContain('drop trigger if exists activity_logs_preserve_diagnostic_classification');
    expect(migration).toContain('create trigger activity_logs_preserve_diagnostic_classification');
    expect(migration).toContain(
      'execute function public.devryan_preserve_activity_diagnostic_classification()',
    );
  });
});
