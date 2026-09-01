-- Admit one unresolved assistant response in the same transaction as the user
-- message and run. The model promotes this row to a contextual acknowledgment
-- only when it actually begins tool work; otherwise the same row becomes the
-- direct conversational result.
create or replace function public.devryan_enqueue_bot_message_run(
  p_message_id uuid,
  p_acknowledgment_id uuid,
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
  p_acknowledgment_body_envelope jsonb,
  p_attachment_count integer,
  p_finalized_at timestamptz,
  p_shared_files jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  admitted jsonb;
  admitted_run_id uuid;
  acknowledgment public.bot_messages%rowtype;
  conflicting_response public.bot_messages%rowtype;
  allocated_sequence bigint;
begin
  if p_acknowledgment_id is null
    or p_acknowledgment_body_envelope is null
    or pg_catalog.jsonb_typeof(p_acknowledgment_body_envelope) <> 'object' then
    raise exception using errcode = '22023', message = 'Bot response admission is invalid';
  end if;

  admitted := public.devryan_enqueue_bot_message_run(
    p_message_id,
    p_run_id,
    p_bot_id,
    p_channel_id,
    p_revision_id,
    p_idempotency_key,
    p_model_snapshot,
    p_context_snapshot,
    p_computer_scope,
    p_actor_user_id,
    p_body_envelope,
    p_attachment_count,
    p_finalized_at,
    p_shared_files
  );

  admitted_run_id := (admitted->'run'->>'id')::uuid;
  select * into acknowledgment
  from public.bot_messages
  where id = p_acknowledgment_id;

  if found then
    if acknowledgment.run_id is distinct from admitted_run_id
      or acknowledgment.channel_id is distinct from p_channel_id
      or acknowledgment.role <> 'assistant'
      or acknowledgment.actor_user_id is not null
      or acknowledgment.assistant_phase not in ('pending', 'acknowledgment', 'result') then
      raise exception using errcode = '23505', message = 'Bot response idempotency conflict';
    end if;
  else
    select * into conflicting_response
    from public.bot_messages
    where run_id = admitted_run_id
      and role = 'assistant'
      and assistant_phase in ('pending', 'acknowledgment', 'result')
    limit 1;
    if found then
      raise exception using errcode = '23505', message = 'Bot response idempotency conflict';
    end if;

    update public.bot_channels
    set next_message_sequence = next_message_sequence + 1
    where id = p_channel_id
      and bot_id = p_bot_id
      and lifecycle = 'active'
    returning next_message_sequence - 1 into allocated_sequence;
    if allocated_sequence is null then
      raise exception using errcode = 'P0002', message = 'Active Bot channel not found';
    end if;

    insert into public.bot_messages (
      id,
      channel_id,
      run_id,
      actor_user_id,
      role,
      assistant_phase,
      sequence,
      body_envelope,
      attachment_count,
      created_at,
      finalized_at
    ) values (
      p_acknowledgment_id,
      p_channel_id,
      admitted_run_id,
      null,
      'assistant',
      'pending',
      allocated_sequence,
      p_acknowledgment_body_envelope,
      0,
      p_finalized_at,
      null
    )
    returning * into acknowledgment;
  end if;

  return admitted || pg_catalog.jsonb_build_object(
    'acknowledgment', pg_catalog.to_jsonb(acknowledgment)
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
  select '20260829130000'::text;
$$;

revoke all on function public.devryan_enqueue_bot_message_run(
  uuid, uuid, uuid, uuid, uuid, uuid, text, jsonb, jsonb, text, uuid, jsonb, jsonb,
  integer, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.devryan_enqueue_bot_message_run(
  uuid, uuid, uuid, uuid, uuid, uuid, text, jsonb, jsonb, text, uuid, jsonb, jsonb,
  integer, timestamptz, jsonb
) to service_role;
revoke all on function public.devryan_bot_schema_version()
  from public, anon, authenticated;
grant execute on function public.devryan_bot_schema_version()
  to service_role;

comment on function public.devryan_enqueue_bot_message_run(
  uuid, uuid, uuid, uuid, uuid, uuid, text, jsonb, jsonb, text, uuid, jsonb, jsonb,
  integer, timestamptz, jsonb
) is 'Atomically admits one user message, one Bot run, its Shared-file rows, and one unresolved assistant response for contextual phase promotion.';
