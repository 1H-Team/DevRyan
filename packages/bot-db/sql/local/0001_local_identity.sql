-- Local identity additions, applied after the unchanged Supabase migrations.
--
-- In the local Bot database `user_profiles` rows are identity/display
-- projections: the workstation owner, mirrored managed accounts and the
-- minimal projection of imported users. They never authorize a request; the
-- host decides authority from the local owner session or current Supabase
-- authorization. The shared-host account-administration triggers therefore do
-- not apply here.
drop trigger if exists user_profiles_require_active_assignment on public.user_profiles;
drop trigger if exists user_profiles_protect_final_admin on public.user_profiles;
drop trigger if exists user_project_access_suspend_unassigned on public.user_project_access;

-- The shared-host control plane is not replicated locally. Its relations stay
-- empty and unreachable, including through the service role.
do $$
declare
  relation_name text;
begin
  foreach relation_name in array array[
    'role_policies',
    'user_policies',
    'managed_projects',
    'user_project_access',
    'user_project_branches',
    'access_invites',
    'app_sessions',
    'opencode_session_ownership',
    'activity_logs',
    'audit_outbox'
  ] loop
    execute format('revoke all on table public.%I from service_role', relation_name);
  end loop;
end $$;
revoke all on sequence public.activity_logs_id_seq from service_role;

-- Sparse, local-only mapping from an imported Bot to the verified source
-- owner whose UUID the workstation owner acts as for that Bot. Bots created
-- locally have no row: the owner acts as the host's immutable local identity.
create table public.bot_local_owner_mappings (
  bot_id uuid primary key references public.bots(id) on delete cascade,
  source_owner_user_id uuid not null references public.user_profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

alter table public.bot_local_owner_mappings enable row level security;
alter table public.bot_local_owner_mappings force row level security;
revoke all on table public.bot_local_owner_mappings from public, anon, authenticated;
grant select on table public.bot_local_owner_mappings to service_role;

comment on table public.bot_local_owner_mappings is
  'Local-only imported-Bot owner identities. Written only by the host import, never through the Data API.';

-- Upserts one identity/display projection. Another stale projection holding the
-- same email is renamed rather than blocking the current identity.
create or replace function public.devryan_local_upsert_identity(
  p_user_id uuid,
  p_email text,
  p_display_name text,
  p_account_kind text,
  p_role text,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null
    or p_email is null or length(p_email) not between 3 and 320 or position('@' in p_email) < 2
    or p_display_name is null or length(btrim(p_display_name)) not between 1 and 200
    or p_account_kind not in ('human', 'agent_test')
    or p_role not in ('admin', 'senior_developer', 'developer')
    or p_status not in ('active', 'suspended', 'archived') then
    raise exception using errcode = '22023', message = 'local identity projection is invalid';
  end if;

  update public.user_profiles
    set email = 'stale+' || id::text || '@identity.invalid'
    where lower(email) = lower(p_email) and id <> p_user_id;

  insert into auth.users (id, email)
    values (p_user_id, p_email)
    on conflict (id) do update set email = excluded.email;

  insert into public.user_profiles (id, email, display_name, role, status, account_kind)
    values (p_user_id, p_email, btrim(p_display_name), p_role, p_status, p_account_kind)
    on conflict (id) do update
      set email = excluded.email,
          display_name = excluded.display_name,
          role = excluded.role,
          status = excluded.status,
          account_kind = excluded.account_kind;
end;
$$;

revoke all on function public.devryan_local_upsert_identity(uuid, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.devryan_local_upsert_identity(uuid, text, text, text, text, text)
  to service_role;

-- Reads the imported-Bot owner mapping for a bounded set of Bot identities.
create or replace function public.devryan_local_bot_owner_mappings()
returns table (bot_id uuid, source_owner_user_id uuid)
language sql
stable
security invoker
set search_path = ''
as $$
  select mapping.bot_id, mapping.source_owner_user_id
  from public.bot_local_owner_mappings mapping
  order by mapping.bot_id;
$$;

revoke all on function public.devryan_local_bot_owner_mappings() from public, anon, authenticated;
grant execute on function public.devryan_local_bot_owner_mappings() to service_role;
