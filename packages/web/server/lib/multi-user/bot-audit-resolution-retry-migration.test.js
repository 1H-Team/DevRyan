import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
  '../../../../../supabase/migrations/20260902120000_bot_audit_resolution_and_read_only_retry.sql',
  import.meta.url,
), 'utf8');

describe('Bot audit resolution and read-only retry migration', () => {
  it('resolves matching target successes and completed Bot runs without mutating the ledger', () => {
    expect(migration).toContain('view public.bot_audit_events_with_resolution');
    expect(migration).toContain('with (security_invoker = true)');
    expect(migration).toContain("event.action || '.requeue'");
    expect(migration).toContain("event.action || '.retry'");
    expect(migration).toContain("event.target_type = 'bot_run'");
    expect(migration).toContain("run.state = 'completed'");
    expect(migration).not.toMatch(/update\s+public\.bot_audit_events/i);
  });

  it('ignores only settled read-only attempts with a known safe outcome', () => {
    expect(migration).toContain("action_attempt.target ->> 'operationKind'");
    expect(migration).toContain("action_attempt.state in ('succeeded', 'failed', 'denied')");
    expect(migration).toContain('action_attempt.unknown_outcome = false');
    expect(migration).toContain("action_attempt.execution_receipt ->> 'writeGuarantee' = 'safe_to_retry'");
    expect(migration).toContain("and not (");
    expect(migration).toContain("when action_attempt.tool = 'browser'");
  });

  it('preserves restricted grants and advances the schema marker', () => {
    expect(migration).toContain(
      'revoke all on public.bot_audit_events_with_resolution from public, anon, authenticated',
    );
    expect(migration).toContain(
      'grant execute on function public.devryan_retry_bot_run(uuid, uuid, timestamptz) to service_role',
    );
    expect(migration).toContain("select '20260902120000'::text");
    expect(migration).not.toMatch(/drop\s+(table|column|function)/i);
  });
});
