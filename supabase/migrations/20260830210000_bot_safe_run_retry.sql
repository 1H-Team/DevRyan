-- Safe same-run retry with pending-response and generic adapter parity.
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
  scope_key text;
begin
  if p_run_id is null or p_actor_user_id is null or p_now is null then
    raise exception using errcode = '22023', message = 'Bot run retry is invalid';
  end if;

  -- Match the claim lock order: scope first, then run. This serializes retry
  -- with claims without reopening a run behind a concurrently admitted lease.
  select computer_scope_key into scope_key from public.bot_runs where id = p_run_id;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(scope_key, 0));

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

  if current_run.agent_thread_id is not null
    or current_run.agent_execution ->> 'threadId' is not null
    or current_run.agent_execution ->> 'invocationId' is not null
    or current_run.agent_execution ->> 'segmentId' is not null
    or current_run.opencode_session_id is not null
    or current_run.opencode_segment_id is not null
    or exists (
      select 1 from public.bot_messages assistant_message
      where assistant_message.run_id = current_run.id
        and assistant_message.role = 'assistant'
        and (
          assistant_message.channel_id <> current_run.channel_id
          or assistant_message.assistant_phase is distinct from 'pending'
          or assistant_message.finalized_at is not null
          or assistant_message.attachment_count <> 0
          or assistant_message.actor_user_id is not null
        )
    )
    or exists (
      select 1 from public.bot_action_attempts action_attempt
      where action_attempt.run_id = current_run.id
    ) then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'execution_started');
  end if;

  if current_run.state <> 'failed'
    or coalesce(current_run.context_snapshot ->> 'failurePhase', '') <> 'startup'
    or coalesce(current_run.context_snapshot ->> 'retryable', 'false') <> 'true' then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'not_retryable');
  end if;

  if not exists (
    select 1
    from public.bots bot
    join public.bot_revisions revision
      on revision.id = current_run.revision_id
     and revision.bot_id = bot.id
    where bot.id = current_run.bot_id
      and bot.lifecycle = 'active'
      and bot.active_revision_id = current_run.revision_id
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

  -- Revalidate current access inside the transaction, even when the host
  -- authorized before a concurrent membership/channel change.
  perform 1 from public.user_profiles profile
  where profile.id = p_actor_user_id and profile.status = 'active'
  for share;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'access_revoked');
  end if;
  perform 1 from public.bot_memberships membership
  where membership.bot_id = current_run.bot_id
    and membership.user_id = p_actor_user_id
    and membership.revoked_at is null and membership.activated_at <= pg_catalog.now()
  for share;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'access_revoked');
  end if;
  if not exists (select 1 from public.bot_channels channel
    where channel.id = current_run.channel_id and channel.owner_user_id = p_actor_user_id) then
    perform 1 from public.bot_channel_acl acl
    where acl.channel_id = current_run.channel_id and acl.user_id = p_actor_user_id
      and acl.role = 'collaborator' and acl.revoked_at is null
    for share;
    if not found then
      return pg_catalog.jsonb_build_object('ok', false, 'reason', 'access_revoked');
    end if;
  end if;

  if exists (
    select 1 from public.bot_messages message
    where message.run_id = current_run.id and message.role = 'user'
      and message.attachment_count <> (
        select pg_catalog.count(*) from public.bot_shared_files shared_file
        where shared_file.message_id = message.id and shared_file.direction = 'user'
      )
  ) or exists (
    select 1 from public.bot_messages message
    join public.bot_shared_files shared_file on shared_file.message_id = message.id
    left join public.bot_objects object on object.id = shared_file.object_id
    where message.run_id = current_run.id and message.role = 'user'
      and (object.id is null or object.deleted_at is not null
        or object.expires_at <= p_now)
  ) then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'attachments_expired');
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

revoke all on function public.devryan_retry_bot_run(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.devryan_retry_bot_run(uuid, uuid, timestamptz) to service_role;

create or replace function public.devryan_bot_schema_version()
returns text language sql stable security invoker set search_path = ''
as $$ select '20260830210000'::text; $$;
revoke all on function public.devryan_bot_schema_version() from public, anon, authenticated;
grant execute on function public.devryan_bot_schema_version() to service_role;
