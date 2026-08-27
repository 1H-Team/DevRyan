-- Production Bot destructive cleanup is service-only and transactionally
-- enforces lifecycle plus Manager/global-administrator policy. Local Storage,
-- vault, Docker, and index cleanup is completed by the resumable host journal
-- before these control-plane mutations run.

-- Keep the baseline last-Manager protection for direct membership mutation,
-- but permit a parent Bot delete to complete its owned FK cascade. During that
-- cascade the parent is no longer visible to the child trigger; no other
-- bypass is accepted.
create or replace function public.devryan_preserve_final_bot_manager()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  active_manager_removed boolean;
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from public.bots where id = old.bot_id
  ) then
    return old;
  end if;

  if tg_op = 'DELETE' then
    active_manager_removed := old.role = 'manager' and old.revoked_at is null;
  else
    active_manager_removed := old.role = 'manager'
      and old.revoked_at is null
      and (new.role <> 'manager' or new.revoked_at is not null);
  end if;

  if not active_manager_removed then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(old.bot_id::text, 0)
  );
  if not exists (
    select 1
    from public.bot_memberships membership
    where membership.bot_id = old.bot_id
      and membership.user_id <> old.user_id
      and membership.role = 'manager'
      and membership.revoked_at is null
  ) then
    raise exception using errcode = '23514', message = 'Bot must retain at least one active Manager';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

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
  retained_shared_count bigint := 0;
begin
  if p_resource not in ('objects', 'credentials', 'channels', 'shared_memory', 'private_memory') then
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

  if p_resource = 'objects' then
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
begin
  select * into target_bot
  from public.bots
  where id = p_bot_id
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('deletedCount', 0, 'alreadyAbsent', true);
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

  delete from public.bots where id = p_bot_id;
  get diagnostics deleted_count = row_count;
  return pg_catalog.jsonb_build_object('deletedCount', deleted_count, 'alreadyAbsent', false);
end;
$$;

revoke all on function public.devryan_purge_bot_resource(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.devryan_purge_bot(uuid, uuid) from public, anon, authenticated;
grant execute on function public.devryan_purge_bot_resource(uuid, text, uuid) to service_role;
grant execute on function public.devryan_purge_bot(uuid, uuid) to service_role;

comment on function public.devryan_purge_bot_resource(uuid, text, uuid) is
  'Purges one reviewed Bot control-plane resource after host cleanup while preserving shared memory on channel deletion.';
comment on function public.devryan_purge_bot(uuid, uuid) is
  'Deletes one retired Bot and cascade-owned rows after all resumable host cleanup steps have completed.';
