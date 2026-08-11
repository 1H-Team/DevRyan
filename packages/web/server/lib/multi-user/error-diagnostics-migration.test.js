import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../../../../supabase/migrations/20260810130000_managed_error_diagnostics.sql', import.meta.url),
  'utf8',
).toLowerCase();

describe('managed error diagnostics migration', () => {
  it('adds nullable constrained diagnostic columns and the filtered keyset index', () => {
    expect(migration).toContain('add column diagnostic_impact text');
    expect(migration).toContain('add column diagnostic_source text');
    expect(migration).toContain("diagnostic_impact in ('low', 'medium', 'high', 'critical')");
    expect(migration).toContain("diagnostic_source in ('observed', 'inferred')");
    expect(migration).toContain('activity_logs_diagnostic_impact_created_idx');
    expect(migration).toContain('(diagnostic_impact, action, created_at desc, event_id desc)');
    expect(migration).toContain("where action in ('session.error', 'tool.failed', 'managed_task.failed')");
    expect(migration).not.toMatch(/diagnostic_(?:impact|source) text not null/);
    expect(migration).toContain('activity_logs_preserve_diagnostic_classification');
    expect(migration).toContain('activity diagnostic classification is immutable');
  });

  it('backfills legacy rows additively without rewriting metadata or audit content', () => {
    expect(migration).toContain("diagnostic_source = 'inferred'");
    expect(migration).toContain("when action = 'managed_task.failed' then 'high'");
    expect(migration).toContain("metadata -> 'retryable' = 'true'::jsonb then 'medium'");
    expect(migration).toContain("when action = 'tool.failed' then 'medium'");
    expect(migration).not.toMatch(/set\s+metadata\s*=/);
    expect(migration).not.toContain('delete from public.activity_logs');
  });

  it('maps the captured Zoubair tool snapshot to 75 low and 82 medium rows', () => {
    const counts = {
      apply_patch: 26,
      ctx_execute: 25,
      devryan_browser: 25,
      read: 17,
      grep: 15,
      ctx_execute_file: 10,
      skill: 10,
      ctx_batch_execute: 9,
      devryan_task: 5,
      oc_read: 5,
      gh_grep_searchgithub: 3,
      stat: 1,
      stripe: 1,
      bash: 1,
      linear: 1,
      list_mcp_resource_templates: 1,
      list_mcp_resources: 1,
      ctx_index: 1,
    };
    const lowClause = migration.match(/lower\(coalesce\(metadata ->> 'tool', ''\)\) in \(([\s\S]*?)\) then 'low'/);
    expect(lowClause).not.toBeNull();
    const lowTools = new Set([...lowClause[1].matchAll(/'([^']+)'/g)].map((match) => match[1]));
    let low = 0;
    let medium = 0;
    for (const [tool, count] of Object.entries(counts)) {
      if (lowTools.has(tool)) low += count;
      else medium += count;
    }
    expect({ low, medium }).toEqual({ low: 75, medium: 82 });
  });
});
