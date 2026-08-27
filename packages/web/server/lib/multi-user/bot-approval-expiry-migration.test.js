import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
  '../../../../../supabase/migrations/20260825190000_bot_approval_expiry.sql',
  import.meta.url,
), 'utf8');

describe('Bot approval expiry migration', () => {
  it('keeps the atomic reconciliation RPC service-only and security-invoker', () => {
    expect(migration).toContain('create or replace function public.devryan_expire_bot_approvals');
    expect(migration).toContain('security invoker');
    expect(migration).toContain('set search_path = \'\'');
    expect(migration).toContain('for update of action_attempt skip locked');
    expect(migration).toContain('from public, anon, authenticated');
    expect(migration).toContain('to service_role');
  });

  it('cancels only expired pending actions and fails only their waiting runs', () => {
    expect(migration).toContain("action_attempt.state = 'pending_approval'");
    expect(migration).toContain('action_attempt.decision_expires_at <= p_now');
    expect(migration).toContain("run.state = 'waiting_approval'");
    expect(migration).toContain("set state = 'cancelled'");
    expect(migration).toContain("interruption_kind = 'bot_approval_expired'");
    expect(migration).toContain('lease_owner = null');
    expect(migration).not.toContain('insert into public.bot_approvals');
    expect(migration).toContain("select '20260825190000'::text");
  });
});
