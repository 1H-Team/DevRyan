-- Human browser control is a durable pre-execution wait. It owns the same
-- computer scope as an executing run and can resume the same action attempt.

alter table public.bot_runs
  drop constraint bot_runs_state_check;
alter table public.bot_runs
  add constraint bot_runs_state_check check (state in (
    'queued', 'starting', 'running', 'waiting_approval', 'waiting_control',
    'needs_reconciliation', 'completed', 'failed', 'cancelled', 'interrupted'
  ));

alter table public.bot_action_attempts
  drop constraint bot_action_attempts_state_check;
alter table public.bot_action_attempts
  add constraint bot_action_attempts_state_check check (state in (
    'proposed', 'pending_approval', 'approved', 'executing', 'waiting_control',
    'succeeded', 'failed', 'unknown', 'reconciled', 'denied', 'cancelled'
  ));

drop index public.bot_runs_one_active_computer_scope_idx;
create unique index bot_runs_one_active_computer_scope_idx
  on public.bot_runs (computer_scope_key)
  where state in (
    'starting', 'running', 'waiting_approval', 'waiting_control', 'needs_reconciliation'
  );

create or replace function public.devryan_claim_bot_run(
  p_computer_scope text,
  p_runtime_owner text,
  p_lease_until timestamptz
)
returns setof public.bot_runs
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if char_length(btrim(coalesce(p_computer_scope, ''))) = 0
    or char_length(btrim(coalesce(p_runtime_owner, ''))) = 0 then
    raise exception using errcode = '22023', message = 'computer scope and runtime owner are required';
  end if;
  if p_lease_until is null or p_lease_until <= now() then
    raise exception using errcode = '22023', message = 'lease expiry must be in the future';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_computer_scope, 0)
  );
  if exists (
    select 1
    from public.bot_runs active_run
    where active_run.computer_scope_key = p_computer_scope
      and active_run.state in (
        'starting', 'running', 'waiting_approval', 'waiting_control', 'needs_reconciliation'
      )
  ) then
    return;
  end if;

  return query
  with candidate as (
    select queued.id
    from public.bot_runs queued
    where queued.computer_scope_key = p_computer_scope
      and queued.state = 'queued'
    order by queued.queue_sequence
    limit 1
    for update skip locked
  ), ready_candidate as (
    select candidate.id
    from candidate
    where not exists (
      select 1
      from public.bot_messages message_row
      join public.bot_shared_files shared_file on shared_file.message_id = message_row.id
      where message_row.run_id = candidate.id
        and shared_file.copy_state <> 'ready'
    )
  )
  update public.bot_runs claimed
  set state = 'starting',
      lease_owner = p_runtime_owner,
      lease_until = p_lease_until,
      lease_generation = claimed.lease_generation + 1,
      started_at = coalesce(claimed.started_at, now())
  from ready_candidate
  where claimed.id = ready_candidate.id
  returning claimed.*;
end;
$$;

create or replace function public.devryan_retry_bot_run(
  p_run_id uuid,
  p_actor_user_id uuid,
  p_now timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_run public.bot_runs%rowtype;
  retried_run public.bot_runs%rowtype;
  retry_count integer;
begin
  if p_run_id is null or p_actor_user_id is null or p_now is null then
    raise exception using errcode = '22023', message = 'Bot run retry is invalid';
  end if;

  select * into current_run
  from public.bot_runs
  where id = p_run_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if not exists (
    select 1
    from public.bot_messages message
    where message.run_id = current_run.id
      and message.channel_id = current_run.channel_id
      and message.role = 'user'
      and message.actor_user_id = p_actor_user_id
  ) then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'wrong_actor');
  end if;

  if current_run.state <> 'failed'
    or coalesce(current_run.context_snapshot ->> 'retryable', 'false') <> 'true' then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'not_retryable');
  end if;

  if current_run.opencode_session_id is not null
    or current_run.opencode_segment_id is not null
    or exists (
      select 1 from public.bot_messages assistant_message
      where assistant_message.run_id = current_run.id
        and assistant_message.channel_id = current_run.channel_id
        and assistant_message.role = 'assistant'
    )
    or exists (
      select 1 from public.bot_action_attempts action_attempt
      where action_attempt.run_id = current_run.id
    ) then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'execution_started');
  end if;

  if not exists (
    select 1
    from public.bots bot
    join public.bot_revisions revision
      on revision.id = current_run.revision_id
     and revision.bot_id = bot.id
    where bot.id = current_run.bot_id
      and bot.lifecycle = 'active'
      and revision.activated_at is not null
      and revision.retired_at is null
  ) then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'revision_changed');
  end if;

  if not exists (
    select 1
    from public.bot_channels channel
    where channel.id = current_run.channel_id
      and channel.bot_id = current_run.bot_id
      and channel.lifecycle = 'active'
      and channel.archived_at is null
  ) then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'channel_unavailable');
  end if;

  if exists (
    select 1
    from public.bot_runs active_run
    where active_run.id <> current_run.id
      and active_run.computer_scope_key = current_run.computer_scope_key
      and active_run.state in (
        'starting', 'running', 'waiting_approval', 'waiting_control', 'needs_reconciliation'
      )
  ) then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'concurrent_active_run');
  end if;

  retry_count := case
    when current_run.context_snapshot ->> 'retryCount' ~ '^[0-9]+$'
      then (current_run.context_snapshot ->> 'retryCount')::integer + 1
    else 1
  end;

  update public.bot_runs
  set state = 'queued',
      model_snapshot = pg_catalog.jsonb_build_object('version', 1, 'state', 'pending'),
      context_snapshot = (
        current_run.context_snapshot
        - 'failure'
        - 'failurePhase'
        - 'retryable'
      ) || pg_catalog.jsonb_build_object(
        'state', 'queued',
        'retryCount', retry_count,
        'retriedAt', p_now
      ),
      lease_generation = current_run.lease_generation + 1,
      lease_owner = null,
      lease_until = null,
      interruption_kind = null,
      reconciliation_state = null,
      started_at = null,
      finished_at = null
  where id = current_run.id
  returning * into retried_run;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'run', pg_catalog.to_jsonb(retried_run)
  );
end;
$$;

create or replace function public.devryan_delete_bot_channel(
  p_channel_id uuid,
  p_actor_id uuid
)
returns table(
  deleted_private_memories bigint,
  retained_shared_memories bigint,
  deleted_messages bigint
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_channel public.bot_channels%rowtype;
  shared_count bigint := 0;
  message_count bigint := 0;
begin
  select * into target_channel
  from public.bot_channels channel_row
  where channel_row.id = p_channel_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Bot channel not found';
  end if;
  if target_channel.owner_user_id <> p_actor_id then
    raise exception using errcode = '42501', message = 'Bot channel owner required';
  end if;
  if exists (
    select 1 from public.bot_runs active_run
    where active_run.channel_id = p_channel_id
      and active_run.state in (
        'queued', 'starting', 'running', 'waiting_approval', 'waiting_control', 'needs_reconciliation'
      )
  ) then
    raise exception using errcode = '23514', message = 'Bot channel has unfinished runs';
  end if;

  select pg_catalog.count(*) into message_count
  from public.bot_messages message_row
  where message_row.channel_id = p_channel_id;

  select pg_catalog.count(distinct shared_memory.id) into shared_count
  from public.bot_memory_sources memory_source
  join public.bot_memory_versions memory_version
    on memory_version.id = memory_source.memory_version_id
  join public.bot_memories shared_memory
    on shared_memory.id = memory_version.memory_id
  where memory_source.channel_id = p_channel_id;

  update public.bot_memory_sources memory_source
  set source_tombstoned_at = coalesce(memory_source.source_tombstoned_at, now()),
      source_metadata = memory_source.source_metadata
        || pg_catalog.jsonb_build_object('channelDeleted', true)
  from public.bot_memory_versions memory_version,
       public.bot_memories shared_memory
  where memory_source.channel_id = p_channel_id
    and memory_version.id = memory_source.memory_version_id
    and shared_memory.id = memory_version.memory_id;

  delete from public.bot_channels channel_row
  where channel_row.id = p_channel_id;

  return query select 0::bigint, shared_count, message_count;
end;
$$;

create or replace function public.devryan_bot_schema_version()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select '20260830150000'::text;
$$;

revoke all on function public.devryan_claim_bot_run(text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.devryan_claim_bot_run(text, text, timestamptz)
  to service_role;
revoke all on function public.devryan_retry_bot_run(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.devryan_retry_bot_run(uuid, uuid, timestamptz)
  to service_role;
revoke all on function public.devryan_delete_bot_channel(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.devryan_delete_bot_channel(uuid, uuid)
  to service_role;
revoke all on function public.devryan_bot_schema_version()
  from public, anon, authenticated;
grant execute on function public.devryan_bot_schema_version()
  to service_role;
