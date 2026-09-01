-- Durable Bot memory extraction and replay-safe summary/memory commits.

create table public.bot_memory_extraction_jobs (
  run_id uuid primary key references public.bot_runs(id) on delete cascade,
  bot_id uuid not null references public.bots(id) on delete cascade,
  channel_id uuid not null references public.bot_channels(id) on delete cascade,
  revision_id uuid not null references public.bot_revisions(id) on delete restrict,
  state text not null default 'queued'
    check (state in ('queued', 'leased', 'succeeded', 'terminal')),
  candidate_envelope jsonb
    check (candidate_envelope is null or jsonb_typeof(candidate_envelope) = 'object'),
  candidate_persisted_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_owner text,
  lease_until timestamptz,
  last_phase text check (last_phase is null or char_length(last_phase) between 1 and 120),
  last_error_code text
    check (last_error_code is null or char_length(last_error_code) between 1 and 160),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bot_memory_extraction_jobs_run_identity_fkey
    foreign key (run_id, bot_id, revision_id)
    references public.bot_runs(id, bot_id, revision_id)
    on delete cascade,
  constraint bot_memory_extraction_jobs_channel_identity_fkey
    foreign key (bot_id, channel_id)
    references public.bot_channels(bot_id, id)
    on delete cascade,
  constraint bot_memory_extraction_jobs_lease_pair_check check (
    (lease_owner is null and lease_until is null)
    or (lease_owner is not null and lease_until is not null)
  ),
  constraint bot_memory_extraction_jobs_candidate_time_check check (
    (candidate_envelope is null and candidate_persisted_at is null)
    or (candidate_envelope is not null and candidate_persisted_at is not null)
  ),
  constraint bot_memory_extraction_jobs_terminal_time_check check (
    (state in ('succeeded', 'terminal') and completed_at is not null)
    or (state in ('queued', 'leased') and completed_at is null)
  ),
  constraint bot_memory_extraction_jobs_state_lease_check check (
    (state = 'leased' and lease_owner is not null)
    or (state <> 'leased' and lease_owner is null)
  )
);

create index bot_memory_extraction_jobs_due_idx
  on public.bot_memory_extraction_jobs(next_attempt_at, created_at, run_id)
  where state = 'queued';
create unique index bot_memory_extraction_jobs_one_leased_per_bot_idx
  on public.bot_memory_extraction_jobs(bot_id)
  where state = 'leased';

alter table public.bot_memory_extraction_jobs enable row level security;
alter table public.bot_memory_extraction_jobs force row level security;
revoke all on public.bot_memory_extraction_jobs from public, anon, authenticated;
grant select, insert, update, delete on public.bot_memory_extraction_jobs to service_role;

create or replace function public.devryan_enqueue_bot_memory_extraction_job(
  p_run_id uuid
)
returns setof public.bot_memory_extraction_jobs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_run public.bot_runs%rowtype;
begin
  select * into target_run
  from public.bot_runs
  where id = p_run_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Bot run not found';
  end if;
  if target_run.state <> 'completed' then
    raise exception using errcode = '23514', message = 'Only completed Bot runs can be extracted';
  end if;

  insert into public.bot_memory_extraction_jobs (
    run_id, bot_id, channel_id, revision_id
  ) values (
    target_run.id, target_run.bot_id, target_run.channel_id, target_run.revision_id
  )
  on conflict (run_id) do nothing;

  return query
  select * from public.bot_memory_extraction_jobs where run_id = p_run_id;
end;
$$;

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
  if p_lease_until is null or p_lease_until <= now() then
    raise exception using errcode = '22023', message = 'Memory extraction lease expiry must be in the future';
  end if;

  -- Expired workers relinquish their Bot before another claim is selected.
  update public.bot_memory_extraction_jobs
  set state = 'queued',
      lease_owner = null,
      lease_until = null,
      next_attempt_at = least(next_attempt_at, now()),
      updated_at = now()
  where state = 'leased' and lease_until <= now();

  select candidate.run_id into claimed_run_id
  from public.bot_memory_extraction_jobs candidate
  where candidate.state = 'queued'
    and candidate.next_attempt_at <= now()
    and not exists (
      select 1
      from public.bot_memory_extraction_jobs active
      where active.bot_id = candidate.bot_id and active.state = 'leased'
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
      updated_at = now()
  where run_id = claimed_run_id
  returning *;
end;
$$;

create or replace function public.devryan_persist_bot_memory_extraction_candidates(
  p_run_id uuid,
  p_lease_owner text,
  p_candidate_envelope jsonb
)
returns setof public.bot_memory_extraction_jobs
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_candidate_envelope is null or jsonb_typeof(p_candidate_envelope) <> 'object' then
    raise exception using errcode = '22023', message = 'Encrypted memory candidates are required';
  end if;

  return query
  update public.bot_memory_extraction_jobs
  set candidate_envelope = coalesce(candidate_envelope, p_candidate_envelope),
      candidate_persisted_at = coalesce(candidate_persisted_at, now()),
      last_phase = 'candidate_persistence',
      last_error_code = null,
      updated_at = now()
  where run_id = p_run_id
    and state = 'leased'
    and lease_owner = p_lease_owner
    and lease_until > now()
  returning *;

  if not found then
    raise exception using errcode = '40001', message = 'Memory extraction lease changed';
  end if;
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
  if p_disposition not in ('retry', 'succeeded', 'terminal') then
    raise exception using errcode = '22023', message = 'Memory extraction disposition is invalid';
  end if;
  if p_disposition = 'retry' and (p_next_attempt_at is null or p_next_attempt_at <= now()) then
    raise exception using errcode = '22023', message = 'Memory extraction retry time must be in the future';
  end if;

  return query
  update public.bot_memory_extraction_jobs
  set state = case when p_disposition = 'retry' then 'queued' else p_disposition end,
      next_attempt_at = case
        when p_disposition = 'retry' then p_next_attempt_at
        else next_attempt_at
      end,
      lease_owner = null,
      lease_until = null,
      last_phase = nullif(btrim(coalesce(p_phase, '')), ''),
      last_error_code = nullif(btrim(coalesce(p_error_code, '')), ''),
      completed_at = case when p_disposition = 'retry' then null else now() end,
      updated_at = now()
  where run_id = p_run_id
    and state = 'leased'
    and lease_owner = p_lease_owner
  returning *;

  if not found then
    raise exception using errcode = '40001', message = 'Memory extraction lease changed';
  end if;
end;
$$;

create or replace function public.devryan_commit_bot_channel_summary(
  p_channel_id uuid,
  p_bot_id uuid,
  p_expected_checkpoint_number bigint,
  p_summary_envelope jsonb
)
returns setof public.bot_channels
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_expected_checkpoint_number is null or p_expected_checkpoint_number < 0 then
    raise exception using errcode = '22023', message = 'Expected Bot summary checkpoint is invalid';
  end if;
  if p_summary_envelope is null or jsonb_typeof(p_summary_envelope) <> 'object' then
    raise exception using errcode = '22023', message = 'Encrypted Bot summary is required';
  end if;

  return query
  update public.bot_channels
  set current_checkpoint_number = p_expected_checkpoint_number + 1,
      summary_envelope = p_summary_envelope
  where id = p_channel_id
    and bot_id = p_bot_id
    and current_checkpoint_number = p_expected_checkpoint_number
  returning *;
end;
$$;

-- The public signature remains fixed. Classifier callers provide a stable
-- source id; replay returns that immutable source/version instead of inserting
-- a duplicate. Manager/system callers retain their existing behavior.
create or replace function public.devryan_commit_bot_memory_version(
  p_memory_id uuid,
  p_version_id uuid,
  p_source_id uuid,
  p_bot_id uuid,
  p_scope text,
  p_subject_user_id uuid,
  p_logical_key text,
  p_encrypted_content jsonb,
  p_sensitivity text,
  p_confidence numeric,
  p_classifier_metadata jsonb,
  p_creator_kind text,
  p_created_by uuid,
  p_channel_id uuid,
  p_run_id uuid,
  p_message_id uuid,
  p_source_kind text,
  p_source_metadata jsonb,
  p_expected_updated_at timestamptz
)
returns table(memory jsonb, version jsonb, source jsonb, activated boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_memory public.bot_memories%rowtype;
  inserted_version public.bot_memory_versions%rowtype;
  inserted_source public.bot_memory_sources%rowtype;
  replay_version public.bot_memory_versions%rowtype;
  replay_source public.bot_memory_sources%rowtype;
  next_version_number bigint;
  created_memory boolean := false;
  should_activate boolean := false;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_bot_id::text || ':shared:' || p_logical_key,
    0
  ));

  select * into replay_source
  from public.bot_memory_sources source_row
  where source_row.id = p_source_id;

  if found then
    select * into replay_version
    from public.bot_memory_versions
    where id = replay_source.memory_version_id;
    select * into target_memory
    from public.bot_memories
    where id = replay_version.memory_id;
    if not found
      or target_memory.bot_id <> p_bot_id
      or target_memory.logical_key <> p_logical_key
      or replay_source.run_id is distinct from p_run_id then
      raise exception using errcode = '23505', message = 'Bot memory source identity is already bound';
    end if;
    return query select
      pg_catalog.to_jsonb(target_memory),
      pg_catalog.to_jsonb(replay_version),
      pg_catalog.to_jsonb(replay_source) || pg_catalog.jsonb_build_object('_replayed', true),
      target_memory.active_version_id = replay_version.id;
    return;
  end if;

  select * into target_memory
  from public.bot_memories candidate
  where candidate.bot_id = p_bot_id
    and candidate.logical_key = p_logical_key
  for update;

  if not found then
    if p_expected_updated_at is not null then
      raise exception using errcode = '40001', message = 'Bot memory changed before version commit';
    end if;
    insert into public.bot_memories (
      id, bot_id, scope, subject_user_id, logical_key, encrypted_content,
      sensitivity, confidence
    ) values (
      p_memory_id, p_bot_id, 'shared', null, p_logical_key, p_encrypted_content,
      p_sensitivity, p_confidence
    )
    returning * into target_memory;
    created_memory := true;
  elsif target_memory.id <> p_memory_id then
    raise exception using errcode = '40001', message = 'Bot memory identity changed before version commit';
  end if;

  select coalesce(pg_catalog.max(existing.version_number), 0) + 1
  into next_version_number
  from public.bot_memory_versions existing
  where existing.memory_id = target_memory.id;

  insert into public.bot_memory_versions (
    id, memory_id, version_number, encrypted_content, classifier_metadata,
    creator_kind, created_by
  ) values (
    p_version_id, target_memory.id, next_version_number, p_encrypted_content,
    p_classifier_metadata, p_creator_kind, p_created_by
  ) returning * into inserted_version;

  should_activate := created_memory
    or (p_expected_updated_at is not null and target_memory.updated_at = p_expected_updated_at);
  if should_activate then
    update public.bot_memories current_memory
    set encrypted_content = p_encrypted_content,
        sensitivity = p_sensitivity,
        confidence = p_confidence,
        active_version_id = inserted_version.id,
        tombstoned_at = null
    where current_memory.id = target_memory.id
    returning * into target_memory;
  end if;

  insert into public.bot_memory_sources (
    id, memory_version_id, channel_id, run_id, message_id, source_kind, source_metadata
  ) values (
    p_source_id, inserted_version.id, p_channel_id, p_run_id, p_message_id,
    p_source_kind, p_source_metadata
  ) returning * into inserted_source;

  return query select
    pg_catalog.to_jsonb(target_memory),
    pg_catalog.to_jsonb(inserted_version),
    pg_catalog.to_jsonb(inserted_source),
    should_activate;
end;
$$;

create or replace function public.devryan_enqueue_completed_bot_memory_extraction()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.state = 'completed' and (tg_op = 'INSERT' or old.state is distinct from new.state) then
    perform public.devryan_enqueue_bot_memory_extraction_job(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists bot_runs_enqueue_memory_extraction on public.bot_runs;
create trigger bot_runs_enqueue_memory_extraction
after insert or update of state on public.bot_runs
for each row execute function public.devryan_enqueue_completed_bot_memory_extraction();

-- Immutable failures become resolved only in the projection when a later
-- successful extraction exists for the same run. The ledger itself is never
-- updated or deleted.
create view public.bot_audit_events_with_resolution with (security_invoker = true) as
select event.id, event.event_id, event.bot_id, event.actor_user_id,
  event.target_type, event.target_id, event.action, event.result,
  event.metadata, event.created_at,
  resolution.created_at as resolved_at,
  resolution.event_id as resolved_by_event_id
from public.bot_audit_events event
left join lateral (
  select later.created_at, later.event_id
  from public.bot_audit_events later
  where event.action = 'bot.memory.extract'
    and event.result in ('failure', 'partial', 'unknown')
    and later.action = event.action
    and later.target_type = event.target_type
    and later.target_id = event.target_id
    and later.result = 'success'
    and (later.created_at, later.id) > (event.created_at, event.id)
  order by later.created_at, later.id
  limit 1
) resolution on true;

create or replace view public.bot_audit_review_events with (security_invoker = true) as
select event.*
from public.bot_audit_events_with_resolution event
where not exists (
  select 1 from public.bot_audit_cleared_events cleared
  where cleared.event_id = event.event_id
);

revoke all on public.bot_audit_events_with_resolution from public, anon, authenticated;
grant select on public.bot_audit_events_with_resolution to service_role;
revoke all on public.bot_audit_review_events from public, anon, authenticated;
grant select on public.bot_audit_review_events to service_role;

-- Historical recovery: only failed/partial extraction outcomes without a
-- later success are queued. The worker reconstructs from encrypted messages
-- and the run's pinned revision; the completed Bot turn is never replayed.
insert into public.bot_memory_extraction_jobs (
  run_id, bot_id, channel_id, revision_id, next_attempt_at
)
select run.id, run.bot_id, run.channel_id, run.revision_id, now()
from public.bot_runs run
where run.state = 'completed'
  and exists (
    select 1 from public.bot_audit_events failure
    where failure.target_type = 'bot_run'
      and failure.target_id = run.id::text
      and failure.action = 'bot.memory.extract'
      and failure.result in ('failure', 'partial')
      and not exists (
        select 1 from public.bot_audit_events success
        where success.target_type = failure.target_type
          and success.target_id = failure.target_id
          and success.action = failure.action
          and success.result = 'success'
          and (success.created_at, success.id) > (failure.created_at, failure.id)
      )
  )
on conflict (run_id) do nothing;

revoke all on function public.devryan_enqueue_bot_memory_extraction_job(uuid)
  from public, anon, authenticated;
grant execute on function public.devryan_enqueue_bot_memory_extraction_job(uuid) to service_role;
revoke all on function public.devryan_claim_bot_memory_extraction_job(text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.devryan_claim_bot_memory_extraction_job(text, timestamptz) to service_role;
revoke all on function public.devryan_persist_bot_memory_extraction_candidates(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.devryan_persist_bot_memory_extraction_candidates(uuid, text, jsonb)
  to service_role;
revoke all on function public.devryan_settle_bot_memory_extraction_job(
  uuid, text, text, timestamptz, text, text
) from public, anon, authenticated;
grant execute on function public.devryan_settle_bot_memory_extraction_job(
  uuid, text, text, timestamptz, text, text
) to service_role;
revoke all on function public.devryan_commit_bot_channel_summary(uuid, uuid, bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.devryan_commit_bot_channel_summary(uuid, uuid, bigint, jsonb)
  to service_role;
revoke all on function public.devryan_commit_bot_memory_version(
  uuid, uuid, uuid, uuid, text, uuid, text, jsonb, text, numeric, jsonb, text,
  uuid, uuid, uuid, uuid, text, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.devryan_commit_bot_memory_version(
  uuid, uuid, uuid, uuid, text, uuid, text, jsonb, text, numeric, jsonb, text,
  uuid, uuid, uuid, uuid, text, jsonb, timestamptz
) to service_role;
revoke all on function public.devryan_enqueue_completed_bot_memory_extraction()
  from public, anon, authenticated;

create or replace function public.devryan_bot_schema_version()
returns text language sql stable security invoker set search_path = ''
as $$ select '20260901120000'::text; $$;
revoke all on function public.devryan_bot_schema_version() from public, anon, authenticated;
grant execute on function public.devryan_bot_schema_version() to service_role;
