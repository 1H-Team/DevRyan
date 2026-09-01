import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
  '../../../../../supabase/migrations/20260830150000_bot_waiting_control.sql',
  import.meta.url,
), 'utf8');

describe('Production Bot waiting-control migration', () => {
  it('adds durable run and action states and keeps the computer scope exclusive', () => {
    expect(migration).toContain('bot_runs_state_check');
    expect(migration).toContain('bot_action_attempts_state_check');
    expect(migration).toContain("'executing', 'waiting_control'");
    expect(migration).toContain('bot_runs_one_active_computer_scope_idx');
    expect(migration).toMatch(/where state in \([\s\S]*'waiting_control'/);
  });

  it('treats waiting control as active in claim, retry, and channel deletion', () => {
    for (const name of [
      'devryan_claim_bot_run',
      'devryan_retry_bot_run',
      'devryan_delete_bot_channel',
    ]) {
      const start = migration.indexOf(`function public.${name}`);
      expect(start).toBeGreaterThan(-1);
      expect(migration.slice(start, start + 6_000)).toContain("'waiting_control'");
    }
  });

  it('keeps replaced functions service-role-only and advances the schema marker', () => {
    expect(migration.match(/security invoker/g)).toHaveLength(4);
    expect(migration.match(/set search_path = ''/g)).toHaveLength(4);
    expect(migration.match(/from public, anon, authenticated/g)).toHaveLength(4);
    expect(migration.match(/to service_role/g)).toHaveLength(4);
    expect(migration).toContain("select '20260830150000'::text");
  });
});
