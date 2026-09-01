-- Requeue only the synthetic-run preparation failures caused by the durable
-- credential path. The immutable audit ledger is resolved by the later
-- successful extraction; completed Bot turns are never replayed.

update public.bot_memory_extraction_jobs job
set state = 'queued',
    attempt_count = 0,
    next_attempt_at = now(),
    lease_owner = null,
    lease_until = null,
    last_phase = null,
    last_error_code = null,
    completed_at = null,
    updated_at = now()
where job.state = 'terminal'
  and job.last_phase = 'classification'
  and job.last_error_code = 'bot_revision_conflict'
  and exists (
    select 1
    from public.bot_runs run
    where run.id = job.run_id
      and run.state = 'completed'
  )
  and not exists (
    select 1
    from public.bot_audit_events success
    where success.target_type = 'bot_run'
      and success.target_id = job.run_id::text
      and success.action = 'bot.memory.extract'
      and success.result = 'success'
  );

create or replace function public.devryan_bot_schema_version()
returns text language sql stable security invoker set search_path = ''
as $$ select '20260901130000'::text; $$;
revoke all on function public.devryan_bot_schema_version() from public, anon, authenticated;
grant execute on function public.devryan_bot_schema_version() to service_role;
