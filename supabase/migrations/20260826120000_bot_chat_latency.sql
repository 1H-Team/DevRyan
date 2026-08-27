-- Production Bot chat latency primitives. These functions are deliberately
-- service-role-only: browser principals continue to enter through the host's
-- JavaScript authorization and policy layer.

create index if not exists bot_channel_acl_active_channel_idx
  on public.bot_channel_acl (channel_id, user_id)
  where revoked_at is null;

create or replace function public.devryan_bot_send_context(
  p_channel_id uuid,
  p_user_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'channel', pg_catalog.to_jsonb(channel),
    'bot', pg_catalog.to_jsonb(bot),
    'revision', case
      when revision.id is null then null
      else pg_catalog.to_jsonb(revision)
    end,
    'membership', case
      when membership.user_id is null then null
      else pg_catalog.to_jsonb(membership)
    end,
    'acl', case
      when acl.user_id is null then null
      else pg_catalog.to_jsonb(acl)
    end
  )
  from public.bot_channels channel
  join public.bots bot
    on bot.id = channel.bot_id
  left join public.bot_revisions revision
    on revision.id = bot.active_revision_id
   and revision.bot_id = bot.id
  left join public.bot_memberships membership
    on membership.bot_id = bot.id
   and membership.user_id = p_user_id
  left join public.bot_channel_acl acl
    on acl.channel_id = channel.id
   and acl.user_id = p_user_id
  where channel.id = p_channel_id;
$$;

create or replace function public.devryan_bot_channel_audience(
  p_channel_id uuid
)
returns table(user_id uuid)
language sql
stable
security invoker
set search_path = ''
as $$
  select distinct membership.user_id
  from public.bot_channels channel
  join public.bot_memberships membership
    on membership.bot_id = channel.bot_id
   and membership.revoked_at is null
   and membership.activated_at <= pg_catalog.now()
  left join public.bot_channel_acl acl
    on acl.channel_id = channel.id
   and acl.user_id = membership.user_id
   and acl.revoked_at is null
  where channel.id = p_channel_id
    and channel.lifecycle = 'active'
    and channel.archived_at is null
    and (
      membership.user_id = channel.owner_user_id
      or acl.user_id is not null
    );
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
      and active_run.state in ('starting', 'running', 'waiting_approval', 'needs_reconciliation')
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

create or replace function public.devryan_bot_schema_version()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select '20260826120000'::text;
$$;

revoke all on function public.devryan_bot_send_context(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.devryan_bot_send_context(uuid, uuid)
  to service_role;
revoke all on function public.devryan_bot_channel_audience(uuid)
  from public, anon, authenticated;
grant execute on function public.devryan_bot_channel_audience(uuid)
  to service_role;
revoke all on function public.devryan_retry_bot_run(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.devryan_retry_bot_run(uuid, uuid, timestamptz)
  to service_role;
revoke all on function public.devryan_bot_schema_version()
  from public, anon, authenticated;
grant execute on function public.devryan_bot_schema_version()
  to service_role;

comment on function public.devryan_bot_send_context(uuid, uuid) is
  'Returns one authoritative service-only Bot send context for host policy evaluation.';
comment on function public.devryan_bot_channel_audience(uuid) is
  'Returns the active owner/collaborator audience for one Bot channel in one joined query.';
comment on function public.devryan_retry_bot_run(uuid, uuid, timestamptz) is
  'Atomically requeues a pre-execution retryable Bot run for its initiating user and pinned revision.';
