import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
  '../../../../../supabase/migrations/20260903100000_bot_run_failure_stage_audit.sql',
  import.meta.url,
), 'utf8');

describe('Bot run failure stage audit migration', () => {
  it('replaces the terminal audit trigger function idempotently without touching the trigger', () => {
    expect(migration).toContain(
      'create or replace function public.devryan_capture_bot_run_terminal_audit()',
    );
    expect(migration).toContain('returns trigger');
    expect(migration).not.toMatch(/create\s+trigger/i);
    expect(migration).not.toMatch(/drop\s+(table|column|function|trigger)/i);
  });

  it('adds a bounded content-free failureStage next to failurePhase', () => {
    expect(migration).toContain("new.context_snapshot ->> 'failureStage'");
    expect(migration).toContain("~ '^[A-Za-z0-9_.:-]{1,80}$'");
    expect(migration).toContain("'failurePhase', failure_phase,");
    expect(migration).toContain("'failureStage', failure_stage,");
    expect(migration).toContain('pg_catalog.jsonb_strip_nulls(');
    for (const key of [
      'botId', 'runId', 'channelId', 'revisionId', 'agentAdapter', 'agentThreadId',
      'terminalState', 'code', 'retryable', 'retryCount',
    ]) {
      expect(migration).toContain(`'${key}',`);
    }
  });

  it('preserves restricted grants and advances the schema marker', () => {
    expect(migration).toContain(
      'revoke all on function public.devryan_capture_bot_run_terminal_audit()',
    );
    expect(migration).toContain(
      'grant execute on function public.devryan_capture_bot_run_terminal_audit()',
    );
    expect(migration).toContain("select '20260903100000'::text");
  });
});
