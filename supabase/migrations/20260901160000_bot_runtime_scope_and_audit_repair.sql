-- Keep provisional memory extraction from competing with an active Bot turn,
-- and make terminal run persistence and its audit evidence one transaction.

create or replace function public.devryan_claim_bot_memory_extraction_job(
  p_lease_owner text,
  p_lease_until timestamptz
)
returns setof public.bot_memory_extraction_jobs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  claimed_run_id uuid;
begin
  if char_length(btrim(coalesce(p_lease_owner, ''))) = 0 then
    raise exception using errcode = '22023', message = 'Memory extraction lease owner is required';
  end if;
  if p_lease_until is null or p_lease_until <= pg_catalog.now() then
    raise exception using errcode = '22023', message = 'Memory extraction lease expiry must be in the future';
  end if;

  update public.bot_memory_extraction_jobs
  set state = 'queued',
      lease_owner = null,
      lease_until = null,
      next_attempt_at = least(next_attempt_at, pg_catalog.now()),
      updated_at = pg_catalog.now()
  where state = 'leased' and lease_until <= pg_catalog.now();

  select candidate.run_id into claimed_run_id
  from public.bot_memory_extraction_jobs candidate
  where candidate.state = 'queued'
    and candidate.next_attempt_at <= pg_catalog.now()
    and not exists (
      select 1
      from public.bot_memory_extraction_jobs active
      where active.bot_id = candidate.bot_id and active.state = 'leased'
    )
    and not exists (
      select 1
      from public.bot_runs active_run
      where active_run.channel_id = candidate.channel_id
        and active_run.state in (
          'queued', 'starting', 'running', 'waiting_approval',
          'waiting_control', 'needs_reconciliation'
        )
    )
  order by candidate.next_attempt_at, candidate.created_at, candidate.run_id
  for update skip locked
  limit 1;

  if claimed_run_id is null then return; end if;

  return query
  update public.bot_memory_extraction_jobs
  set state = 'leased',
      attempt_count = attempt_count + 1,
      lease_owner = p_lease_owner,
      lease_until = p_lease_until,
      updated_at = pg_catalog.now()
  where run_id = claimed_run_id
  returning *;
end;
$$;

create or replace function public.devryan_settle_bot_memory_extraction_job(
  p_run_id uuid,
  p_lease_owner text,
  p_disposition text,
  p_next_attempt_at timestamptz,
  p_phase text,
  p_error_code text
)
returns setof public.bot_memory_extraction_jobs
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_disposition is null
    or p_disposition not in ('defer', 'retry', 'succeeded', 'terminal') then
    raise exception using errcode = '22023', message = 'Memory extraction disposition is invalid';
  end if;
  if p_disposition in ('defer', 'retry')
    and (p_next_attempt_at is null or p_next_attempt_at <= pg_catalog.now()) then
    raise exception using errcode = '22023', message = 'Memory extraction retry time must be in the future';
  end if;

  return query
  update public.bot_memory_extraction_jobs
  set state = case when p_disposition in ('defer', 'retry') then 'queued' else p_disposition end,
      attempt_count = case
        when p_disposition = 'defer' then greatest(attempt_count - 1, 0)
        else attempt_count
      end,
      next_attempt_at = case
        when p_disposition in ('defer', 'retry') then p_next_attempt_at
        else next_attempt_at
      end,
      lease_owner = null,
      lease_until = null,
      last_phase = nullif(btrim(coalesce(p_phase, '')), ''),
      last_error_code = nullif(btrim(coalesce(p_error_code, '')), ''),
      completed_at = case when p_disposition in ('defer', 'retry') then null else pg_catalog.now() end,
      updated_at = pg_catalog.now()
  where run_id = p_run_id
    and state = 'leased'
    and lease_owner = p_lease_owner
  returning *;

  if not found then
    raise exception using errcode = '40001', message = 'Memory extraction lease changed';
  end if;
end;
$$;

create or replace function public.devryan_settle_bot_run_terminal(
  p_run_id uuid,
  p_state text,
  p_interruption_kind text,
  p_context_snapshot jsonb,
  p_finished_at timestamptz
)
returns setof public.bot_runs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_run public.bot_runs%rowtype;
begin
  if p_state is null or p_state not in ('failed', 'interrupted') then
    raise exception using errcode = '22023', message = 'Terminal Bot run state is invalid';
  end if;
  if coalesce(p_interruption_kind, '') !~ '^[A-Za-z0-9_.:-]{1,160}$' then
    raise exception using errcode = '22023', message = 'Bot run interruption kind is invalid';
  end if;
  if p_context_snapshot is null or pg_catalog.jsonb_typeof(p_context_snapshot) <> 'object' then
    raise exception using errcode = '22023', message = 'Bot run context snapshot is invalid';
  end if;
  if p_finished_at is null then
    raise exception using errcode = '22023', message = 'Bot run finish time is required';
  end if;

  select * into current_run
  from public.bot_runs
  where id = p_run_id
  for update;

  if not found then return; end if;
  if current_run.state in ('completed', 'failed', 'cancelled', 'interrupted') then
    return query select * from public.bot_runs where id = current_run.id;
    return;
  end if;

  return query
  update public.bot_runs
  set state = p_state,
      interruption_kind = p_interruption_kind,
      context_snapshot = p_context_snapshot,
      lease_owner = null,
      lease_until = null,
      finished_at = p_finished_at,
      updated_at = pg_catalog.now()
  where id = p_run_id
  returning *;
end;
$$;

-- Repair missing immutable ledger evidence without reviving cleared review items.
insert into public.bot_audit_events (
  event_id, bot_id, actor_user_id, target_type, target_id,
  action, result, metadata, created_at
)
select
  gen_random_uuid(),
  run.bot_id,
  origin.actor_user_id,
  'bot_run',
  run.id::text,
  case when run.state = 'interrupted' then 'bot.run.interrupted' else 'bot.run.failed' end,
  case
    when diagnostic.code in ('bot_action_denied', 'bot_approval_expired') then 'denied'
    when run.state = 'interrupted' then 'unknown'
    else 'failure'
  end,
  pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'botId', run.bot_id,
    'runId', run.id,
    'channelId', run.channel_id,
    'revisionId', run.revision_id,
    'agentAdapter', run.agent_adapter,
    'agentThreadId', run.agent_thread_id,
    'terminalState', run.state,
    'code', diagnostic.code,
    'failurePhase', diagnostic.failure_phase,
    'retryable', diagnostic.retryable,
    'retryCount', diagnostic.retry_count
  )),
  coalesce(run.finished_at, run.updated_at, run.created_at)
from public.bot_runs run
left join lateral (
  select message.actor_user_id
  from public.bot_messages message
  where message.run_id = run.id
    and message.channel_id = run.channel_id
    and message.role = 'user'
  order by message.sequence asc
  limit 1
) origin on true
cross join lateral (
  select
    case
      when coalesce(run.interruption_kind, '') ~ '^[A-Za-z0-9_.:-]{1,160}$'
        then run.interruption_kind
      when run.state = 'interrupted' then 'bot_run_interrupted'
      else 'bot_run_failed'
    end as code,
    case
      when coalesce(run.context_snapshot ->> 'failurePhase', '') ~ '^[A-Za-z0-9_.:-]{1,120}$'
        then run.context_snapshot ->> 'failurePhase'
      else null
    end as failure_phase,
    case
      when pg_catalog.jsonb_typeof(run.context_snapshot -> 'retryable') = 'boolean'
        then run.context_snapshot -> 'retryable'
      else null
    end as retryable,
    case
      when coalesce(run.context_snapshot ->> 'retryCount', '') ~ '^[0-9]{1,9}$'
        then pg_catalog.to_jsonb((run.context_snapshot ->> 'retryCount')::integer)
      else pg_catalog.to_jsonb(0)
    end as retry_count
) diagnostic
where run.state in ('failed', 'interrupted')
  and not exists (
    select 1
    from public.bot_audit_events audit
    where audit.target_type = 'bot_run'
      and audit.target_id = run.id::text
      and audit.action = case
        when run.state = 'interrupted' then 'bot.run.interrupted'
        else 'bot.run.failed'
      end
      and audit.metadata ->> 'terminalState' = run.state
  );

revoke all on function public.devryan_claim_bot_memory_extraction_job(text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.devryan_claim_bot_memory_extraction_job(text, timestamptz)
  to service_role;
revoke all on function public.devryan_settle_bot_memory_extraction_job(
  uuid, text, text, timestamptz, text, text
) from public, anon, authenticated;
grant execute on function public.devryan_settle_bot_memory_extraction_job(
  uuid, text, text, timestamptz, text, text
) to service_role;
revoke all on function public.devryan_settle_bot_run_terminal(
  uuid, text, text, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.devryan_settle_bot_run_terminal(
  uuid, text, text, jsonb, timestamptz
) to service_role;

create or replace function public.devryan_bot_schema_version()
returns text language sql stable security invoker set search_path = ''
as $$ select '20260901160000'::text; $$;
revoke all on function public.devryan_bot_schema_version() from public, anon, authenticated;
grant execute on function public.devryan_bot_schema_version() to service_role;
