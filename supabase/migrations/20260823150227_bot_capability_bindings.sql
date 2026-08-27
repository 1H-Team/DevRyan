-- Immutable, service-only Production Bot capability snapshots. Draft revision
-- contracts reference these rows by id + digest; active revisions never follow
-- mutable host configuration. Secret bytes remain in the existing local Bot
-- credential vault and encrypted package/descriptor bytes remain in Bot objects
-- or deployment-key envelopes.

alter table public.bot_objects
  add constraint bot_objects_bot_id_id_key unique (bot_id, id);

create table public.bot_skill_packages (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bots(id) on delete cascade,
  skill_name text not null
    check (skill_name ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'),
  display_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(display_metadata) = 'object'),
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  package_object_id uuid not null,
  package_digest text not null check (package_digest ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references public.user_profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint bot_skill_packages_object_fkey
    foreign key (bot_id, package_object_id)
    references public.bot_objects(bot_id, id)
    on delete restrict,
  constraint bot_skill_packages_bot_id_id_key unique (bot_id, id)
);

create index bot_skill_packages_bot_id_idx
  on public.bot_skill_packages (bot_id, created_at desc, id desc);
create index bot_skill_packages_object_id_idx
  on public.bot_skill_packages (package_object_id);
create index bot_skill_packages_created_by_idx
  on public.bot_skill_packages (created_by);

create table public.bot_mcp_bindings (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bots(id) on delete cascade,
  server_name text not null check (char_length(btrim(server_name)) between 1 and 120),
  transport text not null check (transport in ('stdio', 'streamable_http', 'sse')),
  display_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(display_metadata) = 'object'),
  descriptor_envelope jsonb not null check (jsonb_typeof(descriptor_envelope) = 'object'),
  descriptor_digest text not null check (descriptor_digest ~ '^[0-9a-f]{64}$'),
  tool_manifest jsonb not null check (jsonb_typeof(tool_manifest) = 'array'),
  manifest_digest text not null check (manifest_digest ~ '^[0-9a-f]{64}$'),
  credential_provider text not null
    check (char_length(btrim(credential_provider)) between 1 and 120),
  credential_kind text not null
    check (char_length(btrim(credential_kind)) between 1 and 120),
  created_by uuid not null references public.user_profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint bot_mcp_bindings_credential_provider_key unique (credential_provider),
  constraint bot_mcp_bindings_bot_id_id_key unique (bot_id, id)
);

create index bot_mcp_bindings_bot_id_idx
  on public.bot_mcp_bindings (bot_id, created_at desc, id desc);
create index bot_mcp_bindings_created_by_idx
  on public.bot_mcp_bindings (created_by);

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
    delete from public.bot_memories where bot_id = p_bot_id and scope = 'shared';
    get diagnostics affected_count = row_count;
  elsif p_resource = 'private_memory' then
    delete from public.bot_memories where bot_id = p_bot_id and scope = 'user_private';
    get diagnostics affected_count = row_count;
  elsif p_resource = 'channels' then
    select count(distinct shared_memory.id) into retained_shared_count
    from public.bot_memory_sources memory_source
    join public.bot_memory_versions memory_version on memory_version.id = memory_source.memory_version_id
    join public.bot_memories shared_memory on shared_memory.id = memory_version.memory_id
    join public.bot_channels channel_row on channel_row.id = memory_source.channel_id
    where channel_row.bot_id = p_bot_id
      and shared_memory.scope = 'shared';

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
      and shared_memory.id = memory_version.memory_id
      and shared_memory.scope = 'shared';

    delete from public.bot_memories private_memory
    where private_memory.bot_id = p_bot_id
      and private_memory.scope = 'user_private'
      and exists (
        select 1
        from public.bot_memory_versions memory_version
        join public.bot_memory_sources memory_source
          on memory_source.memory_version_id = memory_version.id
        join public.bot_channels channel_row on channel_row.id = memory_source.channel_id
        where memory_version.memory_id = private_memory.id
          and channel_row.bot_id = p_bot_id
      );

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

-- Retained audit references are nulled by the Bot foreign key during a full
-- purge. Permit only that single system-generated field change while keeping
-- every other audit mutation append-only.
create or replace function public.devryan_guard_bot_audit_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
    and current_setting('devryan.bot_audit_prune', true) = 'on'
  then
    return old;
  end if;
  if tg_op = 'UPDATE'
    and current_setting('devryan.bot_audit_reference_cleanup', true) = 'on'
    and old.bot_id is not null
    and new.bot_id is null
    and (pg_catalog.to_jsonb(new) - 'bot_id')
      is not distinct from (pg_catalog.to_jsonb(old) - 'bot_id')
  then
    return new;
  end if;
  raise exception using errcode = '23514', message = 'Bot audit events are append-only';
end;
$$;

-- The reviewed host purge still admits only Retired Bots. The service-only
-- terminal transaction also accepts a never-activated Draft so failed setup
-- and verification fixtures do not have to be activated merely to be removed.
create or replace function public.devryan_purge_bot(
  p_bot_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_bot public.bots%rowtype;
  deleted_count bigint := 0;
  previous_reference_cleanup text;
begin
  select * into target_bot
  from public.bots
  where id = p_bot_id
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('deletedCount', 0, 'alreadyAbsent', true);
  end if;
  if target_bot.lifecycle not in ('draft', 'retired') then
    raise exception using errcode = '23514', message = 'Bot must be Draft or Retired before purge';
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

  previous_reference_cleanup := current_setting(
    'devryan.bot_audit_reference_cleanup',
    true
  );
  perform set_config('devryan.bot_audit_reference_cleanup', 'on', true);
  delete from public.bots where id = p_bot_id;
  get diagnostics deleted_count = row_count;
  perform set_config(
    'devryan.bot_audit_reference_cleanup',
    coalesce(previous_reference_cleanup, ''),
    true
  );

  return pg_catalog.jsonb_build_object(
    'deletedCount',
    deleted_count,
    'alreadyAbsent',
    false
  );
end;
$$;

create trigger bot_skill_packages_immutable
before update on public.bot_skill_packages
for each row execute function public.devryan_reject_bot_record_update();

create trigger bot_mcp_bindings_immutable
before update on public.bot_mcp_bindings
for each row execute function public.devryan_reject_bot_record_update();

alter table public.bot_skill_packages enable row level security;
alter table public.bot_skill_packages force row level security;
alter table public.bot_mcp_bindings enable row level security;
alter table public.bot_mcp_bindings force row level security;

revoke all on table public.bot_skill_packages from public, anon, authenticated;
revoke all on table public.bot_mcp_bindings from public, anon, authenticated;
revoke all on function public.devryan_purge_bot_resource(uuid, text, uuid)
  from public, anon, authenticated;
revoke all on function public.devryan_purge_bot(uuid, uuid)
  from public, anon, authenticated;
grant all on table public.bot_skill_packages to service_role;
grant all on table public.bot_mcp_bindings to service_role;
grant execute on function public.devryan_purge_bot_resource(uuid, text, uuid) to service_role;
grant execute on function public.devryan_purge_bot(uuid, uuid) to service_role;

comment on table public.bot_skill_packages is
  'Service-only immutable encrypted Bot skill snapshots with sanitized manifests and pinned content digests.';
comment on table public.bot_mcp_bindings is
  'Service-only immutable encrypted host MCP descriptors with safe metadata and pinned discovered tool manifests.';
comment on function public.devryan_purge_bot_resource(uuid, text, uuid) is
  'Purges one reviewed Bot control-plane resource, including capability snapshots, after host cleanup.';
comment on function public.devryan_purge_bot(uuid, uuid) is
  'Deletes one Draft fixture or Retired Bot while retaining append-only audit rows with a nulled Bot reference.';
