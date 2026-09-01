import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
  '../../../../../supabase/migrations/20260901160000_bot_runtime_scope_and_audit_repair.sql',
  import.meta.url,
), 'utf8');

describe('Bot runtime scope and audit repair migration', () => {
  it('does not claim extraction work for a channel with a non-terminal run', () => {
    expect(migration).toContain('from public.bot_runs active_run');
    expect(migration).toContain('active_run.channel_id = candidate.channel_id');
    for (const state of [
      'queued', 'starting', 'running', 'waiting_approval',
      'waiting_control', 'needs_reconciliation',
    ]) {
      expect(migration).toContain(`'${state}'`);
    }
  });

  it('requeues admission races without consuming the extraction attempt', () => {
    expect(migration).toContain("p_disposition not in ('defer', 'retry', 'succeeded', 'terminal')");
    expect(migration).toContain("when p_disposition = 'defer' then greatest(attempt_count - 1, 0)");
    expect(migration).toContain("when p_disposition in ('defer', 'retry') then 'queued'");
  });

  it('terminalizes runs under a row lock and relies on the audit trigger transaction', () => {
    expect(migration).toContain('function public.devryan_settle_bot_run_terminal');
    expect(migration).toContain('for update');
    expect(migration).toContain("current_run.state in ('completed', 'failed', 'cancelled', 'interrupted')");
    expect(migration).toContain('lease_owner = null');
    expect(migration).toContain('lease_until = null');
    expect(migration).toContain('to service_role');
  });

  it('backfills only missing immutable terminal evidence and preserves cleared ledger rows', () => {
    expect(migration).toContain('insert into public.bot_audit_events');
    expect(migration).toContain("where run.state in ('failed', 'interrupted')");
    expect(migration).toContain('and not exists');
    expect(migration).not.toMatch(/delete\s+from\s+public\.bot_audit_events/i);
    expect(migration).toContain("select '20260901160000'::text");
  });
});
