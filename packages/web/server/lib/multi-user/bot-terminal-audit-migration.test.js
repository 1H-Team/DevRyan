import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
  '../../../../../supabase/migrations/20260828210316_bot_terminal_error_audit.sql',
  import.meta.url,
), 'utf8');

describe('Production Bot terminal audit migration', () => {
  it('captures only distinct failed and interrupted state transitions', () => {
    expect(migration).toContain('after update of state on public.bot_runs');
    expect(migration).toContain('old.state is distinct from new.state');
    expect(migration).toContain("new.state in ('failed', 'interrupted')");
    expect(migration).not.toContain("new.state in ('completed', 'cancelled')");
    expect(migration).toContain("then 'bot.run.interrupted' else 'bot.run.failed'");
    expect(migration).not.toMatch(/unique[^;]+target_id/i);
  });

  it('classifies failures, interruptions, approval denials, and expiry explicitly', () => {
    expect(migration).toContain("diagnostic_code in ('bot_action_denied', 'bot_approval_expired')");
    expect(migration).toContain("when new.state = 'interrupted' then 'unknown'");
    expect(migration).toContain("else 'failure'");
    expect(migration).toContain("when diagnostic.code in ('bot_action_denied', 'bot_approval_expired') then 'denied'");
  });

  it('stores only bounded correlation and outcome metadata', () => {
    for (const key of [
      'botId', 'runId', 'channelId', 'revisionId', 'agentAdapter', 'agentThreadId',
      'terminalState', 'code', 'failurePhase', 'retryable', 'retryCount',
    ]) {
      expect(migration).toContain(`'${key}'`);
    }
    for (const forbidden of [
      "'prompt'", "'transcript'", "'output'", "'credentials'", "'secret'",
      "'cookie'", "'screenshot'", "'hostPath'",
    ]) {
      expect(migration).not.toContain(forbidden);
    }
    expect(migration).toContain("message.role = 'user'");
    expect(migration).toContain('message.actor_user_id');
  });

  it('backfills current terminal runs without duplicating matching diagnostics', () => {
    expect(migration).toContain("where run.state in ('failed', 'interrupted')");
    expect(migration).toContain('and not exists (');
    expect(migration).toContain("audit.target_type = 'bot_run'");
    expect(migration).toContain("audit.metadata ->> 'terminalState' = run.state");
  });

  it('adds the issues index, keeps the trigger private, and advances the marker', () => {
    expect(migration).toContain('create index bot_audit_events_issues_time_idx');
    expect(migration).toContain("where result in ('failure', 'partial', 'unknown')");
    expect(migration).toContain('security invoker');
    expect(migration).toContain('set search_path = \'\'');
    expect(migration).toContain('from public, anon, authenticated');
    expect(migration).toContain('to service_role');
    expect(migration).toContain("select '20260828210316'::text");
  });
});
