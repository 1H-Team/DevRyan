-- Additive rollout: older workers keep their original RPCs. Only the new
-- schema-gated worker performs versioned recovery; migration never replays work.
alter table public.bot_memory_extraction_jobs
  add column extraction_version integer not null default 1 check (extraction_version > 0),
  add column recovery_version integer not null default 1 check (recovery_version > 0),
  add column defer_count integer not null default 0 check (defer_count >= 0),
  add column outcome text check (outcome in ('saved', 'no_facts', 'filtered', 'invalid')),
  add column last_reason text check (last_reason ~ '^[a-z][a-z0-9_:]{0,63}$'),
  add column last_validator text check (last_validator ~ '^[a-z][a-z0-9_:]{0,63}$'),
  add column rejection_reasons jsonb not null default '{}'::jsonb
    check (jsonb_typeof(rejection_reasons) = 'object' and octet_length(rejection_reasons::text) <= 4096);

create index bot_memory_extraction_recovery_idx
  on public.bot_memory_extraction_jobs(recovery_version, created_at, run_id)
  where state in ('terminal', 'succeeded');
create index bot_memory_extraction_bot_state_idx
  on public.bot_memory_extraction_jobs(bot_id, state, created_at desc, run_id desc);

create function public.devryan_settle_bot_memory_extraction_job_v2(
  p_run_id uuid, p_lease_owner text, p_disposition text,
  p_next_attempt_at timestamptz, p_phase text, p_error_code text,
  p_extraction_version integer, p_diagnostics jsonb
)
returns setof public.bot_memory_extraction_jobs
language plpgsql security invoker set search_path = ''
as $$
begin
  if p_extraction_version <> 2 or p_extraction_version is null
    or p_diagnostics is null or pg_catalog.jsonb_typeof(p_diagnostics) <> 'object'
    or exists (select 1 from pg_catalog.jsonb_object_keys(p_diagnostics) key
      where key not in ('outcome', 'reason', 'validator', 'rejectionReasons')) then
    raise exception using errcode = '22023', message = 'Memory extraction diagnostics are invalid';
  end if;
  if exists (select 1 from pg_catalog.jsonb_each(coalesce(p_diagnostics->'rejectionReasons', '{}'::jsonb)) item
    where item.key not in ('schema_invalid', 'schema_statement_invalid', 'schema_key_invalid',
      'provenance_invalid', 'cross_user_scope_rejected', 'transcript_quote_rejected',
      'secret_rejected', 'too_many_candidates')
      or pg_catalog.jsonb_typeof(item.value) <> 'number'
      or item.value::text !~ '^[0-9]{1,6}$') then
    raise exception using errcode = '22023', message = 'Memory extraction rejection reasons are invalid';
  end if;

  perform public.devryan_settle_bot_memory_extraction_job(
    p_run_id, p_lease_owner, p_disposition, p_next_attempt_at, p_phase, p_error_code);
  return query update public.bot_memory_extraction_jobs
  set extraction_version = p_extraction_version,
      recovery_version = greatest(recovery_version, p_extraction_version),
      defer_count = case when p_disposition = 'defer' then least(defer_count, 2147483646) + 1 else 0 end,
      outcome = p_diagnostics->>'outcome',
      last_reason = p_diagnostics->>'reason',
      last_validator = p_diagnostics->>'validator',
      rejection_reasons = coalesce(p_diagnostics->'rejectionReasons', '{}'::jsonb)
  where run_id = p_run_id returning *;
end;
$$;

-- The host inspects encrypted legacy candidates. Compare-and-set prevents a
-- concurrent inspection or manual retry from resetting an already claimed job.
create function public.devryan_recover_bot_memory_extraction_job(
  p_run_id uuid, p_expected_updated_at timestamptz,
  p_recovery_version integer, p_decision text
)
returns setof public.bot_memory_extraction_jobs
language plpgsql security invoker set search_path = ''
as $$
declare
  job public.bot_memory_extraction_jobs%rowtype;
begin
  if p_recovery_version <> 2 or p_recovery_version is null
    or p_decision is null or p_decision not in ('retain', 'requeue', 'reextract', 'unreadable') then
    raise exception using errcode = '22023', message = 'Memory extraction recovery is invalid';
  end if;
  select * into job from public.bot_memory_extraction_jobs
  where run_id = p_run_id and updated_at = p_expected_updated_at
    and recovery_version < p_recovery_version and state in ('terminal', 'succeeded')
  for update;
  if not found then return; end if;

  if p_decision in ('requeue', 'reextract') and not exists (
    select 1 from public.bot_runs run where run.id = job.run_id and run.state = 'completed'
  ) then p_decision := 'retain'; end if;
  if p_decision = 'requeue' and (job.state <> 'terminal' or job.last_error_code is null
    or job.last_error_code not in (
      'bot_memory_extraction_invalid', 'bot_opencode_request_invalid', 'bot_opencode_response_invalid',
      'bot_opencode_request_timeout', 'bot_opencode_request_failed', 'bot_memory_provider_failed',
      'bot_memory_reasoning_unavailable', 'bot_indexer_unavailable', 'bot_memory_index_sync_failed',
      'bot_memory_commit_failed', 'bot_memory_candidate_persistence_failed',
      'bot_revision_conflict', 'bot_memory_version_conflict', 'bot_summary_checkpoint_conflict', '40001',
      'bot_runtime_scope_busy', 'bot_opencode_request_aborted', 'bot_opencode_run_not_found'
    )) then
    raise exception using errcode = '22023', message = 'Memory extraction failure is not recoverable';
  end if;
  if p_decision = 'reextract' and (job.state <> 'succeeded' or job.candidate_envelope is null) then
    raise exception using errcode = '22023', message = 'Memory extraction candidates are not recoverable';
  end if;

  return query update public.bot_memory_extraction_jobs
  set recovery_version = p_recovery_version,
      state = case when p_decision in ('requeue', 'reextract') then 'queued'
        when p_decision = 'unreadable' then 'terminal' else state end,
      attempt_count = case when p_decision in ('requeue', 'reextract') then 0 else attempt_count end,
      defer_count = 0,
      next_attempt_at = case when p_decision in ('requeue', 'reextract') then pg_catalog.now() else next_attempt_at end,
      completed_at = case when p_decision in ('requeue', 'reextract') then null else completed_at end,
      candidate_envelope = case when p_decision = 'reextract' then null else candidate_envelope end,
      candidate_persisted_at = case when p_decision = 'reextract' then null else candidate_persisted_at end,
      last_error_code = case when p_decision in ('requeue', 'reextract') then null
        when p_decision = 'unreadable' then 'bot_memory_candidate_envelope_invalid' else last_error_code end,
      last_phase = case when p_decision in ('requeue', 'reextract') then 'automatic_recovery'
        when p_decision = 'unreadable' then 'candidate_load' else last_phase end,
      updated_at = pg_catalog.now()
  where run_id = p_run_id returning *;
end;
$$;

create function public.devryan_bot_memory_extraction_summary(p_bot_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  with jobs as (
    select job.*, (job.state = 'queued' and (job.last_phase = 'admission' or exists (
      select 1 from public.bot_runs run where run.channel_id = job.channel_id
        and run.state in ('queued', 'starting', 'running', 'waiting_approval', 'waiting_control', 'needs_reconciliation')
    ))) as waiting_for_conversation
    from public.bot_memory_extraction_jobs job where job.bot_id = p_bot_id
  )
  select pg_catalog.jsonb_build_object(
    'pending', count(*) filter (where state in ('queued', 'leased')),
    'failed', count(*) filter (where state = 'terminal'),
    'waiting', count(*) filter (where waiting_for_conversation),
    'recovering', count(*) filter (where state in ('queued', 'leased') and recovery_version > extraction_version),
    'nextAttemptAt', min(next_attempt_at) filter (where state = 'queued'),
    'recent', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(recent)) from (
      select run_id, channel_id, state, last_phase, last_error_code, attempt_count,
        next_attempt_at, completed_at, created_at, updated_at, outcome, last_reason,
        last_validator, rejection_reasons, extraction_version, recovery_version
      from jobs where state <> 'succeeded' order by created_at desc, run_id desc limit 20
    ) recent), '[]'::jsonb)
  ) from jobs;
$$;

create or replace function public.devryan_requeue_bot_memory_extraction_job(
  p_run_id uuid,
  p_bot_id uuid
)
returns setof public.bot_memory_extraction_jobs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_run public.bot_runs%rowtype;
  current_job public.bot_memory_extraction_jobs%rowtype;
begin
  if p_run_id is null or p_bot_id is null then
    raise exception using errcode = '22023', message = 'Memory extraction requeue is invalid';
  end if;

  select * into target_run
  from public.bot_runs
  where id = p_run_id and bot_id = p_bot_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Bot run not found';
  end if;
  if target_run.state <> 'completed' then
    raise exception using errcode = '23514', message = 'Only completed Bot runs can be extracted';
  end if;

  select * into current_job
  from public.bot_memory_extraction_jobs
  where run_id = p_run_id and bot_id = p_bot_id
  for update;

  if not found then
    return query
    insert into public.bot_memory_extraction_jobs (
      run_id, bot_id, channel_id, revision_id
    ) values (
      target_run.id, target_run.bot_id, target_run.channel_id, target_run.revision_id
    )
    returning *;
    return;
  end if;

  if current_job.state <> 'terminal' then
    return;
  end if;

  return query
  update public.bot_memory_extraction_jobs
  set state = 'queued',
      attempt_count = 0,
      defer_count = 0,
      outcome = null,
      last_reason = null,
      last_validator = null,
      rejection_reasons = '{}'::jsonb,
      next_attempt_at = pg_catalog.now(),
      lease_owner = null,
      lease_until = null,
      last_phase = null,
      last_error_code = null,
      completed_at = null,
      updated_at = pg_catalog.now()
  where run_id = p_run_id
    and bot_id = p_bot_id
    and state = 'terminal'
  returning *;
end;
$$;

-- A released channel wakes deferred work without bypassing transport backoff.
create function public.devryan_wake_bot_memory_extraction_jobs(p_channel_id uuid)
returns void language sql security invoker set search_path = ''
as $$
  update public.bot_memory_extraction_jobs set next_attempt_at = pg_catalog.now(), updated_at = pg_catalog.now()
  where channel_id = p_channel_id and state = 'queued' and last_phase = 'admission';
$$;

revoke all on function public.devryan_settle_bot_memory_extraction_job_v2(uuid, text, text, timestamptz, text, text, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.devryan_settle_bot_memory_extraction_job_v2(uuid, text, text, timestamptz, text, text, integer, jsonb)
  to service_role;
revoke all on function public.devryan_recover_bot_memory_extraction_job(uuid, timestamptz, integer, text)
  from public, anon, authenticated;
grant execute on function public.devryan_recover_bot_memory_extraction_job(uuid, timestamptz, integer, text)
  to service_role;
revoke all on function public.devryan_bot_memory_extraction_summary(uuid) from public, anon, authenticated;
grant execute on function public.devryan_bot_memory_extraction_summary(uuid) to service_role;
revoke all on function public.devryan_wake_bot_memory_extraction_jobs(uuid) from public, anon, authenticated;
grant execute on function public.devryan_wake_bot_memory_extraction_jobs(uuid) to service_role;

create or replace function public.devryan_bot_schema_version()
returns text language sql stable security invoker set search_path = ''
as $$ select '20260908182901'::text; $$;
revoke all on function public.devryan_bot_schema_version() from public, anon, authenticated;
grant execute on function public.devryan_bot_schema_version() to service_role;
