-- Durable Bot profiles, encrypted profile avatars, and race-safe Draft publish.
-- Profile presentation is Bot-owned; revision identity remains accepted only for
-- compatibility with existing runtime contracts.

alter table public.bots
  add column title text,
  add column summary text not null default '',
  add column avatar_object_id uuid,
  add column avatar_fallback text;

update public.bots bot
set title = coalesce(
      nullif(btrim((
        select revision.contract #>> '{identity,title}'
        from public.bot_revisions revision
        where revision.id = bot.active_revision_id
          and revision.bot_id = bot.id
      )), ''),
      nullif(btrim((
        select revision.contract #>> '{identity,title}'
        from public.bot_revisions revision
        where revision.bot_id = bot.id
        order by revision.revision_number desc, revision.id desc
        limit 1
      )), ''),
      bot.name
    ),
    summary = coalesce(
      nullif(btrim((
        select revision.contract #>> '{identity,summary}'
        from public.bot_revisions revision
        where revision.id = bot.active_revision_id
          and revision.bot_id = bot.id
      )), ''),
      nullif(btrim((
        select revision.contract #>> '{identity,summary}'
        from public.bot_revisions revision
        where revision.bot_id = bot.id
        order by revision.revision_number desc, revision.id desc
        limit 1
      )), ''),
      ''
    ),
    avatar_fallback = coalesce(
      nullif(btrim((
        select revision.contract #>> '{identity,avatar}'
        from public.bot_revisions revision
        where revision.id = bot.active_revision_id
          and revision.bot_id = bot.id
      )), ''),
      nullif(btrim((
        select revision.contract #>> '{identity,avatar}'
        from public.bot_revisions revision
        where revision.bot_id = bot.id
        order by revision.revision_number desc, revision.id desc
        limit 1
      )), '')
    );

alter table public.bots
  alter column title set not null,
  add constraint bots_title_check
    check (char_length(btrim(title)) between 1 and 160),
  add constraint bots_summary_check
    check (char_length(summary) <= 500),
  add constraint bots_avatar_fallback_check
    check (
      avatar_fallback is null
      or char_length(btrim(avatar_fallback)) between 1 and 512
    );

alter table public.bot_objects
  drop constraint if exists bot_objects_visibility_check,
  drop constraint if exists bot_objects_private_channel_check,
  add constraint bot_objects_bot_id_fkey
    foreign key (bot_id) references public.bots(id) on delete cascade,
  add constraint bot_objects_visibility_check
    check (visibility in ('private', 'library', 'profile')),
  add constraint bot_objects_visibility_scope_check check (
    (visibility = 'private' and channel_id is not null)
    or (visibility in ('library', 'profile') and channel_id is null)
  ),
  add constraint bot_objects_profile_content_check check (
    visibility <> 'profile'
    or (
      content_type in ('image/png', 'image/jpeg', 'image/webp')
      and ciphertext_size <= 5242880
    )
  );

alter table public.bots
  add constraint bots_avatar_object_fkey
  foreign key (avatar_object_id)
  references public.bot_objects(id)
  on delete set null;

create index bot_objects_bot_id_idx
  on public.bot_objects (bot_id, id);
create index bot_objects_profile_bot_idx
  on public.bot_objects (bot_id, created_at desc, id desc)
  where visibility = 'profile' and deleted_at is null;
create index bots_avatar_object_id_idx
  on public.bots (avatar_object_id)
  where avatar_object_id is not null;

create or replace function public.devryan_validate_bot_avatar_pointer()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.avatar_object_id is null then
    return new;
  end if;
  if not exists (
    select 1
    from public.bot_objects object_row
    where object_row.id = new.avatar_object_id
      and object_row.bot_id = new.id
      and object_row.visibility = 'profile'
      and object_row.channel_id is null
      and object_row.deleted_at is null
  ) then
    raise exception using
      errcode = '23514',
      message = 'Bot avatar must reference a live profile object owned by the same Bot';
  end if;
  return new;
end;
$$;

create or replace function public.devryan_protect_referenced_bot_avatar()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.bots bot
    where bot.avatar_object_id = old.id
  ) and (
    new.bot_id is distinct from old.bot_id
    or new.visibility <> 'profile'
    or new.channel_id is not null
    or new.deleted_at is not null
  ) then
    raise exception using
      errcode = '23514',
      message = 'Referenced Bot avatar objects cannot be reassigned or deleted';
  end if;
  return new;
end;
$$;

create trigger bots_validate_avatar_pointer
before insert or update of avatar_object_id on public.bots
for each row execute function public.devryan_validate_bot_avatar_pointer();

create trigger bot_objects_protect_referenced_avatar
before update of bot_id, channel_id, visibility, deleted_at on public.bot_objects
for each row execute function public.devryan_protect_referenced_bot_avatar();

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
    coalesce(nullif(btrim(p_contract #>> '{identity,title}'), ''), p_name),
    coalesce(nullif(btrim(p_contract #>> '{identity,summary}'), ''), ''),
    nullif(btrim(p_contract #>> '{identity,avatar}'), ''),
    'draft',
    p_tenancy,
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
  if target_revision.contract->>'tenancy' is distinct from target_bot.tenancy then
    raise exception using errcode = '23514', message = 'Bot revision tenancy must match immutable Bot tenancy';
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
  if target_revision.contract->>'tenancy' is distinct from target_bot.tenancy then
    raise exception using errcode = '23514', message = 'Bot revision tenancy must match immutable Bot tenancy';
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

create or replace function public.devryan_bot_schema_version()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select '20260823202400'::text;
$$;

revoke all on function public.devryan_validate_bot_avatar_pointer()
  from public, anon, authenticated;
revoke all on function public.devryan_protect_referenced_bot_avatar()
  from public, anon, authenticated;
revoke all on function public.devryan_publish_bot_revision(uuid, uuid, timestamptz, text, uuid)
  from public, anon, authenticated;
revoke all on function public.devryan_bot_schema_version()
  from public, anon, authenticated;
grant execute on function public.devryan_publish_bot_revision(uuid, uuid, timestamptz, text, uuid)
  to service_role;
grant execute on function public.devryan_bot_schema_version()
  to service_role;

revoke all on table public.bots from public, anon, authenticated;
revoke all on table public.bot_objects from public, anon, authenticated;
grant all on table public.bots to service_role;
grant all on table public.bot_objects to service_role;

comment on column public.bots.title is
  'Durable Bot presentation title, independent of immutable runtime revisions.';
comment on column public.bots.summary is
  'Durable concise Bot profile summary.';
comment on column public.bots.avatar_object_id is
  'Encrypted profile avatar object owned by the same Bot.';
comment on function public.devryan_publish_bot_revision(uuid, uuid, timestamptz, text, uuid) is
  'Publishes only the exact Draft revision version and hash that passed host activation gates.';
comment on function public.devryan_bot_schema_version() is
  'Fail-closed compatibility marker for the Production Bots server runtime.';
