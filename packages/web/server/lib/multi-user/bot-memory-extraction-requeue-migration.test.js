import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
  '../../../../../supabase/migrations/20260901230000_bot_memory_extraction_requeue.sql',
  import.meta.url,
), 'utf8');

describe('Bot memory extraction requeue migration', () => {
  it('requeues only terminal extraction jobs for completed runs and resets their attempts', () => {
    expect(migration).toContain('function public.devryan_requeue_bot_memory_extraction_job');
    expect(migration).toContain("if target_run.state <> 'completed' then");
    expect(migration).toContain("if current_job.state <> 'terminal' then");
    expect(migration).toContain('attempt_count = 0');
    expect(migration).toContain('next_attempt_at = pg_catalog.now()');
    expect(migration).toContain('last_error_code = null');
    expect(migration).toContain('completed_at = null');
    expect(migration).toContain("and state = 'terminal'");
    expect(migration).toContain(
      'grant execute on function public.devryan_requeue_bot_memory_extraction_job(uuid, uuid)',
    );
  });

  it('keeps the retry RPC evidence-based instead of identity-based', () => {
    expect(migration).toContain('function public.devryan_retry_bot_run');
    expect(migration).toContain("assistant_message.assistant_phase is distinct from 'pending'");
    expect(migration).toContain('from public.bot_action_attempts action_attempt');
    expect(migration).toContain("not in ('startup', 'execution')");
    expect(migration).toContain(
      "coalesce(current_run.context_snapshot ->> 'failurePhase', '') <> 'execution'",
    );
    expect(migration).toContain('agent_thread_id = null');
    expect(migration).toContain('agent_execution = null');
    expect(migration).toContain('opencode_session_id = null');
    expect(migration).toContain('opencode_segment_id = null');
    expect(migration).toContain("- 'failureStage'");
  });

  it('bumps the schema marker', () => {
    expect(migration).toContain("select '20260901230000'::text");
    expect(migration).not.toMatch(/drop\s+(table|column|function)/i);
  });
});
