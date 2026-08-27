import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
  '../../../../../supabase/migrations/20260826120000_bot_chat_latency.sql',
  import.meta.url,
), 'utf8');

describe('Production Bot chat latency migration', () => {
  it('keeps every new RPC service-role-only and security-invoker', () => {
    for (const name of [
      'devryan_bot_send_context',
      'devryan_bot_channel_audience',
      'devryan_retry_bot_run',
    ]) {
      expect(migration).toContain(`function public.${name}`);
    }
    expect(migration.match(/security invoker/g)).toHaveLength(4);
    expect(migration.match(/set search_path = ''/g)).toHaveLength(4);
    expect(migration.match(/from public, anon, authenticated/g)).toHaveLength(4);
    expect(migration.match(/to service_role/g)).toHaveLength(4);
    expect(migration).not.toMatch(
      /grant execute[^;]+(?:devryan_bot_send_context|devryan_bot_channel_audience|devryan_retry_bot_run)[^;]+to (?:anon|authenticated)/i,
    );
  });

  it('uses joined reads and an active channel audience index', () => {
    expect(migration).toContain('bot_channel_acl_active_channel_idx');
    expect(migration).toContain('on public.bot_channel_acl (channel_id, user_id)');
    expect(migration).toContain('where revoked_at is null');
    expect(migration).toContain('join public.bot_memberships membership');
    expect(migration).toContain('left join public.bot_channel_acl acl');
    expect(migration).toContain("channel.lifecycle = 'active'");
  });

  it('requeues only failed pre-execution runs for the initiating actor and pinned revision', () => {
    expect(migration).toContain("current_run.state <> 'failed'");
    expect(migration).toContain("current_run.context_snapshot ->> 'retryable'");
    expect(migration).toContain('message.actor_user_id = p_actor_user_id');
    expect(migration).toContain('current_run.opencode_session_id is not null');
    expect(migration).toContain('current_run.opencode_segment_id is not null');
    expect(migration).toContain("assistant_message.role = 'assistant'");
    expect(migration).toContain('from public.bot_action_attempts action_attempt');
    expect(migration).toContain('revision.id = current_run.revision_id');
    expect(migration).toContain('revision.retired_at is null');
    expect(migration).toContain("set state = 'queued'");
    expect(migration).toContain("'state', 'pending'");
    expect(migration).toContain("select '20260826120000'::text");
  });
});
