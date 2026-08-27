-- One-shot Bot deletion aligns granular resource cleanup with the existing
-- terminal delete contract: never-activated Drafts and Retired Bots are safe
-- purge targets, while Active and Paused Bots must first be retired by the
-- authenticated server workflow.

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

create or replace function public.devryan_bot_schema_version()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select '20260824213000'::text;
$$;

revoke all on function public.devryan_purge_bot_resource(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.devryan_purge_bot_resource(uuid, text, uuid)
  to service_role;
revoke all on function public.devryan_bot_schema_version()
  from public, anon, authenticated;
grant execute on function public.devryan_bot_schema_version()
  to service_role;

comment on function public.devryan_purge_bot_resource(uuid, text, uuid) is
  'Purges one reviewed Draft or Retired Bot resource after host cleanup.';
