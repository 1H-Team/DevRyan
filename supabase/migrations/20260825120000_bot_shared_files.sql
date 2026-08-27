-- Durable conversation-scoped projections for files copied into each Bot's
-- persistent, Bot-wide /workspace/Shared volume. Admission and claiming stay
-- atomic: a queued run cannot start until every required copy is verified.

create table public.bot_shared_files (
  id uuid primary key,
  bot_id uuid not null references public.bots(id) on delete cascade,
  channel_id uuid not null references public.bot_channels(id) on delete cascade,
  message_id uuid not null references public.bot_messages(id) on delete cascade,
  object_id uuid not null references public.bot_objects(id) on delete cascade,
  sender_user_id uuid references public.user_profiles(id) on delete set null,
  direction text not null check (direction in ('user', 'bot')),
  safe_filename text not null
    check (safe_filename ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  content_type text not null
    check (char_length(btrim(content_type)) between 1 and 255),
  plaintext_sha256 text check (plaintext_sha256 is null or plaintext_sha256 ~ '^[0-9a-f]{64}$'),
  plaintext_size bigint check (plaintext_size is null or plaintext_size between 1 and 26214400),
  computer_path text not null,
  copy_state text not null default 'pending'
    check (copy_state in ('pending', 'copying', 'ready', 'failed')),
  copy_attempts integer not null default 0 check (copy_attempts >= 0),
  error_code text check (
    error_code is null
    or (
      char_length(error_code) between 1 and 120
      and error_code ~ '^[A-Za-z0-9._:-]+$'
    )
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bot_shared_files_message_object_key unique (message_id, object_id),
  constraint bot_shared_files_computer_path_key unique (bot_id, computer_path),
  constraint bot_shared_files_sender_check check (
    (direction = 'user' and sender_user_id is not null)
    or (direction = 'bot' and sender_user_id is null)
  ),
  constraint bot_shared_files_path_check check (
    computer_path = '/workspace/Shared/' || channel_id::text || '/' || message_id::text || '/' || safe_filename
  ),
  constraint bot_shared_files_copy_consistency_check check (
    (copy_state = 'ready' and plaintext_sha256 is not null and plaintext_size is not null and error_code is null)
    or (copy_state = 'failed' and error_code is not null)
    or copy_state in ('pending', 'copying')
  )
);

create index bot_shared_files_channel_created_idx
  on public.bot_shared_files (channel_id, created_at desc, id desc);
create index bot_shared_files_message_state_idx
  on public.bot_shared_files (message_id, copy_state);
create index bot_shared_files_object_idx
  on public.bot_shared_files (object_id);
create index bot_shared_files_sender_idx
  on public.bot_shared_files (sender_user_id)
  where sender_user_id is not null;
create index bot_shared_files_retry_idx
  on public.bot_shared_files (copy_state, updated_at, id)
  where copy_state in ('pending', 'copying', 'failed');

alter table public.bot_shared_files enable row level security;
alter table public.bot_shared_files force row level security;
revoke all on table public.bot_shared_files from public, anon, authenticated;
grant all on table public.bot_shared_files to service_role;

create trigger bot_shared_files_updated_at
before update on public.bot_shared_files
for each row execute function public.devryan_set_updated_at();

create or replace function public.devryan_protect_bot_shared_file_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.id <> old.id
    or new.bot_id <> old.bot_id
    or new.channel_id <> old.channel_id
    or new.message_id <> old.message_id
    or new.object_id <> old.object_id
    or new.sender_user_id is distinct from old.sender_user_id
    or new.direction <> old.direction
    or new.safe_filename <> old.safe_filename
    or new.content_type <> old.content_type
    or new.computer_path <> old.computer_path
    or new.created_at <> old.created_at then
    raise exception using errcode = '23514', message = 'Bot Shared file identity is immutable';
  end if;
  return new;
end;
$$;

create trigger bot_shared_files_protect_identity
before update on public.bot_shared_files
for each row execute function public.devryan_protect_bot_shared_file_identity();

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
  shared_file jsonb;
  shared_id uuid;
  shared_object_id uuid;
  shared_filename text;
  shared_path text;
begin
  if p_shared_files is null or pg_catalog.jsonb_typeof(p_shared_files) <> 'array'
    or pg_catalog.jsonb_array_length(p_shared_files) <> p_attachment_count then
    raise exception using errcode = '22023', message = 'Bot Shared file admission is invalid';
  end if;

  for shared_file in select value from pg_catalog.jsonb_array_elements(p_shared_files) loop
    if pg_catalog.jsonb_typeof(shared_file) <> 'object'
      or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(shared_file)) <> 4 then
      raise exception using errcode = '22023', message = 'Bot Shared file admission is invalid';
    end if;
    shared_id := (shared_file->>'id')::uuid;
    shared_object_id := (shared_file->>'objectId')::uuid;
    shared_filename := shared_file->>'filename';
    shared_path := shared_file->>'computerPath';
    if shared_filename is null
      or shared_filename !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
      or shared_path <> '/workspace/Shared/' || p_channel_id::text || '/' || p_message_id::text || '/' || shared_filename then
      raise exception using errcode = '22023', message = 'Bot Shared file path is invalid';
    end if;
  end loop;

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
    p_finalized_at
  );

  for shared_file in select value from pg_catalog.jsonb_array_elements(p_shared_files) loop
    shared_id := (shared_file->>'id')::uuid;
    shared_object_id := (shared_file->>'objectId')::uuid;
    shared_filename := shared_file->>'filename';
    shared_path := shared_file->>'computerPath';

    insert into public.bot_shared_files (
      id,
      bot_id,
      channel_id,
      message_id,
      object_id,
      sender_user_id,
      direction,
      safe_filename,
      content_type,
      computer_path,
      copy_state
    )
    select
      shared_id,
      p_bot_id,
      p_channel_id,
      p_message_id,
      object_row.id,
      p_actor_user_id,
      'user',
      shared_filename,
      object_row.content_type,
      shared_path,
      'pending'
    from public.bot_objects object_row
    where object_row.id = shared_object_id
      and object_row.bot_id = p_bot_id
      and object_row.channel_id = p_channel_id
      and object_row.visibility = 'private'
      and object_row.deleted_at is null
    on conflict (message_id, object_id) do nothing;

    if not found and not exists (
      select 1
      from public.bot_shared_files existing
      where existing.message_id = p_message_id
        and existing.object_id = shared_object_id
        and existing.safe_filename = shared_filename
        and existing.computer_path = shared_path
    ) then
      raise exception using errcode = '23505', message = 'Bot Shared file idempotency conflict';
    end if;
  end loop;

  if (select pg_catalog.count(*) from public.bot_shared_files row where row.message_id = p_message_id)
    <> p_attachment_count then
    raise exception using errcode = '23505', message = 'Bot Shared file attachment mismatch';
  end if;

  return admitted;
end;
$$;

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
      and active_run.state in ('starting', 'running', 'waiting_approval', 'needs_reconciliation')
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

-- Cancelling a run must also terminalize any action that never left the
-- approval queue, without manufacturing an approval or an execution time.
alter table public.bot_action_attempts
  drop constraint bot_action_attempts_state_check;
alter table public.bot_action_attempts
  add constraint bot_action_attempts_state_check check (state in (
    'proposed', 'pending_approval', 'approved', 'executing',
    'succeeded', 'failed', 'unknown', 'reconciled', 'denied', 'cancelled'
  ));

create or replace function public.devryan_bot_schema_version()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select '20260825120000'::text;
$$;

revoke all on function public.devryan_protect_bot_shared_file_identity()
  from public, anon, authenticated;
revoke all on function public.devryan_enqueue_bot_message_run(
  uuid, uuid, uuid, uuid, uuid, text, jsonb, jsonb, text, uuid, jsonb, integer, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.devryan_enqueue_bot_message_run(
  uuid, uuid, uuid, uuid, uuid, text, jsonb, jsonb, text, uuid, jsonb, integer, timestamptz, jsonb
) to service_role;
revoke all on function public.devryan_claim_bot_run(text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.devryan_claim_bot_run(text, text, timestamptz)
  to service_role;
revoke all on function public.devryan_bot_schema_version()
  from public, anon, authenticated;
grant execute on function public.devryan_bot_schema_version()
  to service_role;

comment on table public.bot_shared_files is
  'Service-only conversation projection for verified files in a Bot-wide persistent Shared volume.';
comment on function public.devryan_claim_bot_run(text, text, timestamptz) is
  'Claims the FIFO queued Bot run only after all required Shared copies are verified ready.';
