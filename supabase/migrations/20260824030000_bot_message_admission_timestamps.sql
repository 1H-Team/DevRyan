-- Keep the user-message creation and finalization timestamps identical inside
-- the atomic admission transaction. The host-provided finalized timestamp can
-- precede PostgreSQL's statement timestamp by a few milliseconds, so relying
-- on the column default for created_at violates finalized_at >= created_at.
create or replace function public.devryan_enqueue_bot_message_run(
  p_message_id uuid,
  p_run_id uuid,
  p_bot_id uuid,
  p_channel_id uuid,
  p_revision_id uuid,
  p_idempotency_key text,
  p_model_snapshot jsonb,
  p_context_snapshot jsonb,
  p_computer_scope text,
  p_actor_user_id uuid,
  p_body_envelope jsonb,
  p_attachment_count integer,
  p_finalized_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing_message public.bot_messages%rowtype;
  existing_run public.bot_runs%rowtype;
  created_message public.bot_messages%rowtype;
  created_run public.bot_runs%rowtype;
  allocated_sequence bigint;
begin
  if char_length(btrim(coalesce(p_idempotency_key, ''))) = 0
    or char_length(btrim(coalesce(p_computer_scope, ''))) = 0
    or p_actor_user_id is null
    or p_finalized_at is null
    or coalesce(p_attachment_count, -1) < 0
    or p_model_snapshot is null
    or jsonb_typeof(p_model_snapshot) <> 'object'
    or p_context_snapshot is null
    or jsonb_typeof(p_context_snapshot) <> 'object'
    or p_body_envelope is null
    or jsonb_typeof(p_body_envelope) <> 'object' then
    raise exception using errcode = '22023', message = 'Bot message/run admission is invalid';
  end if;

  select * into existing_message
  from public.bot_messages
  where id = p_message_id;

  if found then
    select * into existing_run
    from public.bot_runs
    where id = existing_message.run_id;
    if existing_message.channel_id <> p_channel_id
      or existing_message.actor_user_id <> p_actor_user_id
      or existing_message.role <> 'user'
      or existing_run.id is null
      or existing_run.bot_id <> p_bot_id
      or existing_run.channel_id <> p_channel_id
      or existing_run.revision_id <> p_revision_id
      or existing_run.idempotency_key <> p_idempotency_key
      or existing_run.computer_scope_key <> p_computer_scope then
      raise exception using errcode = '23505', message = 'Bot message idempotency conflict';
    end if;
    return jsonb_build_object(
      'created', false,
      'message', to_jsonb(existing_message),
      'run', to_jsonb(existing_run)
    );
  end if;

  select * into existing_run
  from public.bot_runs
  where channel_id = p_channel_id
    and idempotency_key = p_idempotency_key;
  if found then
    select * into existing_message
    from public.bot_messages
    where run_id = existing_run.id
      and role = 'user'
    order by sequence
    limit 1;
    if existing_message.id = p_message_id
      and existing_message.actor_user_id = p_actor_user_id then
      return jsonb_build_object(
        'created', false,
        'message', to_jsonb(existing_message),
        'run', to_jsonb(existing_run)
      );
    end if;
    raise exception using errcode = '23505', message = 'Bot run idempotency conflict';
  end if;

  update public.bot_channels
  set next_message_sequence = next_message_sequence + 1,
      last_message_at = greatest(coalesce(last_message_at, p_finalized_at), p_finalized_at)
  where id = p_channel_id
    and bot_id = p_bot_id
    and lifecycle = 'active'
  returning next_message_sequence - 1 into allocated_sequence;
  if allocated_sequence is null then
    raise exception using errcode = 'P0002', message = 'Active Bot channel not found';
  end if;

  insert into public.bot_runs (
    id,
    bot_id,
    channel_id,
    revision_id,
    idempotency_key,
    model_snapshot,
    context_snapshot,
    computer_scope_key,
    state
  ) values (
    p_run_id,
    p_bot_id,
    p_channel_id,
    p_revision_id,
    p_idempotency_key,
    p_model_snapshot,
    p_context_snapshot,
    p_computer_scope,
    'queued'
  )
  returning * into created_run;

  insert into public.bot_messages (
    id,
    channel_id,
    run_id,
    actor_user_id,
    role,
    sequence,
    body_envelope,
    attachment_count,
    created_at,
    finalized_at
  ) values (
    p_message_id,
    p_channel_id,
    p_run_id,
    p_actor_user_id,
    'user',
    allocated_sequence,
    p_body_envelope,
    p_attachment_count,
    p_finalized_at,
    p_finalized_at
  )
  returning * into created_message;

  return jsonb_build_object(
    'created', true,
    'message', to_jsonb(created_message),
    'run', to_jsonb(created_run)
  );
end;
$$;
