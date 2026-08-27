-- Bots simplification: one shared memory per Bot, one shared computer per Bot.
--
-- Two product concepts are removed here:
--   1. user-private memory. Every memory a Bot holds is now shared with every
--      member. Existing private rows are converted rather than dropped.
--   2. personalized computer tenancy. Every Bot now runs a single team-scoped
--      computer, so `bot:<botId>` is the only computer scope key.
--
-- Stored revision contracts are deliberately NOT rewritten: `compiled_hash` is
-- derived from the contract, so editing contracts in place would invalidate
-- every activated revision. The server-side normalizer coerces `tenancy` to
-- 'team' when it compiles, and the obsolete tenancy-consistency guard is
-- dropped from the activate/publish RPCs below.

-- ---------------------------------------------------------------------------
-- Memory: collapse the two scopes into 'shared'
-- ---------------------------------------------------------------------------

-- The scope/subject pairing and the private identity index both have to go
-- before rows can move, otherwise the conversion violates them mid-statement.
alter table public.bot_memories
  drop constraint if exists bot_memories_scope_subject_check;
drop index if exists public.bot_memories_private_identity_idx;

-- Converted rows keep their subject in the logical key so two members who each
-- taught the Bot the same key survive as distinct shared memories. The full
-- uuid (not a prefix) is appended so no two subjects can collide, and the
-- original key is truncated to keep the result inside the 512-character check.
-- A converted key can in principle collide with a pre-existing shared key of
-- the identical ':u:<uuid>' shape; the unique index then aborts the migration
-- loudly, which is the intended outcome rather than silently dropping a memory.
update public.bot_memories
set scope = 'shared',
    subject_user_id = null,
    logical_key = left(logical_key, 470) || ':u:' || subject_user_id::text
where scope = 'user_private';

alter table public.bot_memories
  drop constraint if exists bot_memories_scope_check;
alter table public.bot_memories
  add constraint bot_memories_scope_check check (scope = 'shared');
alter table public.bot_memories
  add constraint bot_memories_scope_subject_check check (subject_user_id is null);

-- Scope and subject are constant now, so the retrieval index no longer needs
-- to lead with them.
drop index if exists public.bot_memories_active_scope_idx;
create index bot_memories_active_scope_idx
  on public.bot_memories (bot_id, updated_at desc, id desc)
  where tombstoned_at is null;

-- ---------------------------------------------------------------------------
-- Tenancy: every Bot shares one computer
-- ---------------------------------------------------------------------------

update public.bots
set tenancy = 'team'
where tenancy <> 'team';

alter table public.bots
  drop constraint if exists bots_tenancy_check;
alter table public.bots
  add constraint bots_tenancy_check check (tenancy = 'team');

-- Personalized computers left `bot:<botId>:user:<uuid>` scope keys on finished
-- runs. Those rows stay for audit; their Docker profile/scratch volumes are
-- orphaned and are reclaimed by the supervisor's reset path, not from SQL.

-- ---------------------------------------------------------------------------
-- RPC updates
-- ---------------------------------------------------------------------------

-- Signature is unchanged so in-flight callers keep working; p_scope and
-- p_subject_user_id are accepted and ignored.
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
  next_version_number bigint;
  created_memory boolean := false;
  should_activate boolean := false;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_bot_id::text || ':shared:' || p_logical_key,
    0
  ));

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
      id,
      bot_id,
      scope,
      subject_user_id,
      logical_key,
      encrypted_content,
      sensitivity,
      confidence
    ) values (
      p_memory_id,
      p_bot_id,
      'shared',
      null,
      p_logical_key,
      p_encrypted_content,
      p_sensitivity,
      p_confidence
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
    id,
    memory_id,
    version_number,
    encrypted_content,
    classifier_metadata,
    creator_kind,
    created_by
  ) values (
    p_version_id,
    target_memory.id,
    next_version_number,
    p_encrypted_content,
    p_classifier_metadata,
    p_creator_kind,
    p_created_by
  )
  returning * into inserted_version;

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
    id,
    memory_version_id,
    channel_id,
    run_id,
    message_id,
    source_kind,
    source_metadata
  ) values (
    p_source_id,
    inserted_version.id,
    p_channel_id,
    p_run_id,
    p_message_id,
    p_source_kind,
    p_source_metadata
  )
  returning * into inserted_source;

  return query select
    pg_catalog.to_jsonb(target_memory),
    pg_catalog.to_jsonb(inserted_version),
    pg_catalog.to_jsonb(inserted_source),
    should_activate;
end;
$$;

-- Channel deletion no longer hard-deletes anything: every memory is shared, so
-- the source-level tombstone is the only retention path. The
-- deleted_private_memories column is retained (always 0) so callers that
-- destructure the result keep working.
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
      and active_run.state in ('queued', 'starting', 'running', 'waiting_approval', 'needs_reconciliation')
  ) then
    raise exception using errcode = '23514', message = 'Bot channel has unfinished runs';
  end if;

  select pg_catalog.count(*) into message_count
  from public.bot_messages message_row
  where message_row.channel_id = p_channel_id;

  select pg_catalog.count(distinct shared_memory.id) into shared_count
  from public.bot_memory_sources memory_source
  join public.bot_memory_versions memory_version on memory_version.id = memory_source.memory_version_id
  join public.bot_memories shared_memory on shared_memory.id = memory_version.memory_id
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

-- Tenancy is no longer a per-Bot variable, so the create RPC ignores the
-- requested tenancy and always provisions the shared team computer.
create or replace function public.devryan_create_bot(
  p_bot_id uuid,
  p_revision_id uuid,
  p_name text,
  p_tenancy text,
  p_contract jsonb,
  p_compiled_hash text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  created_bot public.bots%rowtype;
  created_revision public.bot_revisions%rowtype;
  created_membership public.bot_memberships%rowtype;
begin
  insert into public.bots (
    id,
    name,
    title,
    summary,
    avatar_fallback,
    lifecycle,
    tenancy,
    active_revision_id,
    created_by
  ) values (
    p_bot_id,
    p_name,
    coalesce(nullif(pg_catalog.btrim(p_contract #>> '{identity,title}'), ''), p_name),
    coalesce(nullif(pg_catalog.btrim(p_contract #>> '{identity,summary}'), ''), ''),
    nullif(pg_catalog.btrim(p_contract #>> '{identity,avatar}'), ''),
    'draft',
    'team',
    null,
    p_actor_id
  ) returning * into created_bot;

  insert into public.bot_revisions (
    id, bot_id, revision_number, contract, compiled_hash, created_by
  ) values (
    p_revision_id, p_bot_id, 1, p_contract, p_compiled_hash, p_actor_id
  ) returning * into created_revision;

  insert into public.bot_memberships (
    bot_id, user_id, role, assigned_by
  ) values (
    p_bot_id, p_actor_id, 'manager', p_actor_id
  ) returning * into created_membership;

  return pg_catalog.jsonb_build_object(
    'bot', pg_catalog.to_jsonb(created_bot),
    'revision', pg_catalog.to_jsonb(created_revision),
    'membership', pg_catalog.to_jsonb(created_membership)
  );
end;
$$;

-- The tenancy-consistency guard is dropped from both publication paths. It
-- existed to keep a per-Bot setting immutable; with a single tenancy the guard
-- can only reject legacy contracts that still carry 'personalized'.
create or replace function public.devryan_activate_bot_revision(
  p_bot_id uuid,
  p_revision_id uuid,
  p_actor_id uuid
)
returns setof public.bots
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_revision public.bot_revisions%rowtype;
  target_bot public.bots%rowtype;
begin
  select * into target_bot
  from public.bots
  where id = p_bot_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Bot not found';
  end if;
  if target_bot.lifecycle = 'retired' then
    raise exception using errcode = '23514', message = 'retired Bot cannot activate a revision';
  end if;
  if not exists (
    select 1
    from public.bot_memberships membership
    where membership.bot_id = p_bot_id
      and membership.user_id = p_actor_id
      and membership.role = 'manager'
      and membership.revoked_at is null
  ) and not exists (
    select 1
    from public.user_profiles profile
    where profile.id = p_actor_id
      and profile.role = 'admin'
      and profile.status = 'active'
  ) then
    raise exception using
      errcode = '42501',
      message = 'active Bot Manager or global administrator required';
  end if;

  select * into target_revision
  from public.bot_revisions
  where id = p_revision_id and bot_id = p_bot_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Bot revision not found';
  end if;
  if target_revision.retired_at is not null then
    raise exception using errcode = '23514', message = 'retired Bot revision cannot be reactivated';
  end if;

  update public.bot_revisions
  set retired_at = now()
  where bot_id = p_bot_id
    and id <> p_revision_id
    and activated_at is not null
    and retired_at is null;

  update public.bot_revisions
  set activated_at = coalesce(activated_at, now())
  where id = p_revision_id;

  return query
  update public.bots bot
  set active_revision_id = p_revision_id,
      lifecycle = case when bot.lifecycle = 'draft' then 'active' else bot.lifecycle end
  where bot.id = p_bot_id
  returning bot.*;
end;
$$;

create or replace function public.devryan_publish_bot_revision(
  p_bot_id uuid,
  p_revision_id uuid,
  p_expected_updated_at timestamptz,
  p_compiled_hash text,
  p_actor_id uuid
)
returns setof public.bots
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_revision public.bot_revisions%rowtype;
  target_bot public.bots%rowtype;
begin
  select * into target_bot
  from public.bots
  where id = p_bot_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Bot not found';
  end if;
  if target_bot.lifecycle = 'retired' then
    raise exception using errcode = '23514', message = 'retired Bot cannot publish a revision';
  end if;
  if not exists (
    select 1
    from public.bot_memberships membership
    where membership.bot_id = p_bot_id
      and membership.user_id = p_actor_id
      and membership.role = 'manager'
      and membership.revoked_at is null
  ) and not exists (
    select 1
    from public.user_profiles profile
    where profile.id = p_actor_id
      and profile.role = 'admin'
      and profile.status = 'active'
  ) then
    raise exception using
      errcode = '42501',
      message = 'active Bot Manager or global administrator required';
  end if;

  select * into target_revision
  from public.bot_revisions
  where id = p_revision_id and bot_id = p_bot_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Bot revision not found';
  end if;
  if target_revision.activated_at is not null or target_revision.retired_at is not null then
    raise exception using errcode = '23514', message = 'Only a live Draft revision can be published';
  end if;
  if target_revision.updated_at is distinct from p_expected_updated_at
    or target_revision.compiled_hash is distinct from p_compiled_hash
  then
    return;
  end if;

  update public.bot_revisions
  set retired_at = now()
  where bot_id = p_bot_id
    and id <> p_revision_id
    and activated_at is not null
    and retired_at is null;

  update public.bot_revisions
  set activated_at = now()
  where id = p_revision_id;

  return query
  update public.bots bot
  set active_revision_id = p_revision_id,
      lifecycle = case when bot.lifecycle = 'draft' then 'active' else bot.lifecycle end
  where bot.id = p_bot_id
  returning bot.*;
end;
$$;

-- Granular purge keeps both memory resource names for API stability. With one
-- scope, 'private_memory' now matches nothing and reports a zero count.
create or replace function public.devryan_purge_bot_resource(
  p_bot_id uuid,
  p_resource text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_bot public.bots%rowtype;
  affected_count bigint := 0;
  step_count bigint := 0;
  retained_shared_count bigint := 0;
begin
  if p_resource is null or p_resource not in (
    'capability_bindings',
    'objects',
    'credentials',
    'channels',
    'shared_memory',
    'private_memory'
  ) then
    raise exception using errcode = '22023', message = 'unsupported Bot purge resource';
  end if;

  select * into target_bot
  from public.bots
  where id = p_bot_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Bot not found';
  end if;
  if target_bot.lifecycle <> 'retired' then
    raise exception using errcode = '23514', message = 'Bot must be retired before purge';
  end if;
  if not exists (
    select 1
    from public.bot_memberships membership
    where membership.bot_id = p_bot_id
      and membership.user_id = p_actor_id
      and membership.role = 'manager'
      and membership.revoked_at is null
  ) and not exists (
    select 1
    from public.user_profiles profile
    where profile.id = p_actor_id
      and profile.role = 'admin'
      and profile.status = 'active'
  ) then
    raise exception using errcode = '42501', message = 'active Bot Manager or global administrator required';
  end if;

  if p_resource = 'capability_bindings' then
    delete from public.bot_skill_packages where bot_id = p_bot_id;
    get diagnostics affected_count = row_count;
    delete from public.bot_mcp_bindings where bot_id = p_bot_id;
    get diagnostics step_count = row_count;
    affected_count := affected_count + step_count;
  elsif p_resource = 'objects' then
    delete from public.bot_objects where bot_id = p_bot_id;
    get diagnostics affected_count = row_count;
  elsif p_resource = 'credentials' then
    delete from public.bot_credentials where bot_id = p_bot_id;
    get diagnostics affected_count = row_count;
  elsif p_resource = 'shared_memory' then
    delete from public.bot_memories where bot_id = p_bot_id;
    get diagnostics affected_count = row_count;
  elsif p_resource = 'private_memory' then
    affected_count := 0;
  elsif p_resource = 'channels' then
    select pg_catalog.count(distinct shared_memory.id) into retained_shared_count
    from public.bot_memory_sources memory_source
    join public.bot_memory_versions memory_version on memory_version.id = memory_source.memory_version_id
    join public.bot_memories shared_memory on shared_memory.id = memory_version.memory_id
    join public.bot_channels channel_row on channel_row.id = memory_source.channel_id
    where channel_row.bot_id = p_bot_id;

    update public.bot_memory_sources memory_source
    set source_tombstoned_at = coalesce(memory_source.source_tombstoned_at, now()),
        source_metadata = memory_source.source_metadata
          || pg_catalog.jsonb_build_object('channelDeleted', true)
    from public.bot_memory_versions memory_version,
         public.bot_memories shared_memory,
         public.bot_channels channel_row
    where memory_source.channel_id = channel_row.id
      and channel_row.bot_id = p_bot_id
      and memory_version.id = memory_source.memory_version_id
      and shared_memory.id = memory_version.memory_id;

    delete from public.bot_channels where bot_id = p_bot_id;
    get diagnostics affected_count = row_count;
  end if;

  return pg_catalog.jsonb_build_object(
    'resource', p_resource,
    'deletedCount', affected_count,
    'retainedSharedMemoryCount', retained_shared_count
  );
end;
$$;

-- Advance the fail-closed runtime marker.
create or replace function public.devryan_bot_schema_version()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select '20260824120000'::text;
$$;

revoke all on function public.devryan_bot_schema_version()
  from public, anon, authenticated;
grant execute on function public.devryan_bot_schema_version()
  to service_role;

revoke all on function public.devryan_commit_bot_memory_version(
  uuid, uuid, uuid, uuid, text, uuid, text, jsonb, text, numeric, jsonb, text,
  uuid, uuid, uuid, uuid, text, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.devryan_commit_bot_memory_version(
  uuid, uuid, uuid, uuid, text, uuid, text, jsonb, text, numeric, jsonb, text,
  uuid, uuid, uuid, uuid, text, jsonb, timestamptz
) to service_role;

revoke all on function public.devryan_delete_bot_channel(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.devryan_delete_bot_channel(uuid, uuid)
  to service_role;

revoke all on function public.devryan_create_bot(uuid, uuid, text, text, jsonb, text, uuid)
  from public, anon, authenticated;
grant execute on function public.devryan_create_bot(uuid, uuid, text, text, jsonb, text, uuid)
  to service_role;

revoke all on function public.devryan_activate_bot_revision(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.devryan_activate_bot_revision(uuid, uuid, uuid)
  to service_role;

revoke all on function public.devryan_publish_bot_revision(uuid, uuid, timestamptz, text, uuid)
  from public, anon, authenticated;
grant execute on function public.devryan_publish_bot_revision(uuid, uuid, timestamptz, text, uuid)
  to service_role;

revoke all on function public.devryan_purge_bot_resource(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.devryan_purge_bot_resource(uuid, text, uuid)
  to service_role;

comment on function public.devryan_bot_schema_version() is
  'Fail-closed compatibility marker for the Production Bots server runtime.';
