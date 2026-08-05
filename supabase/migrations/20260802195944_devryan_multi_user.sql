-- DevRyan multi-user control plane.
-- The browser never talks to these tables directly. The web runtime uses a
-- Supabase secret key and exposes a narrower, policy-checked API.

create extension if not exists pgcrypto;

create table public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text not null,
  role text not null check (role in ('admin', 'senior_developer', 'developer')),
  status text not null default 'active' check (status in ('active', 'suspended', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index user_profiles_email_lower_idx on public.user_profiles (lower(email));

create table public.role_policies (
  role text primary key check (role in ('admin', 'senior_developer', 'developer')),
  settings_pages text[] not null default '{}',
  can_use_files boolean not null default false,
  can_use_terminal boolean not null default false,
  can_manage_projects boolean not null default false,
  can_manage_users boolean not null default false,
  can_manage_global_settings boolean not null default false,
  can_manage_git boolean not null default false,
  can_push boolean not null default false,
  can_use_github boolean not null default true,
  feature_flags jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.user_policies (
  user_id uuid primary key references public.user_profiles(id) on delete cascade,
  settings_pages text[] null,
  capabilities jsonb not null default '{}'::jsonb,
  settings_overrides jsonb not null default '{}'::jsonb,
  session_folders jsonb not null default '{"version":1,"foldersMap":{},"collapsedFolderIds":[],"updatedAt":0}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.managed_projects (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  repository_path text not null,
  remote_url text,
  default_branch text not null,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index managed_projects_repository_path_idx on public.managed_projects (repository_path);
create index managed_projects_created_by_idx on public.managed_projects (created_by);

create table public.user_project_access (
  user_id uuid not null references public.user_profiles(id) on delete cascade,
  project_id uuid not null references public.managed_projects(id) on delete cascade,
  github_account_id text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, project_id)
);

create unique index user_project_access_one_default_idx
  on public.user_project_access (user_id)
  where is_default;
create index user_project_access_project_idx on public.user_project_access (project_id);

create table public.user_project_branches (
  user_id uuid not null,
  project_id uuid not null,
  branch_name text not null,
  workspace_path text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (user_id, project_id, branch_name),
  foreign key (user_id, project_id)
    references public.user_project_access(user_id, project_id)
    on delete cascade
);

create unique index user_project_branches_one_default_idx
  on public.user_project_branches (user_id, project_id)
  where is_default;
create index user_project_branches_project_idx on public.user_project_branches (project_id, user_id);

create table public.access_invites (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  email text not null,
  display_name text,
  role text not null check (role in ('admin', 'senior_developer', 'developer')),
  project_id uuid references public.managed_projects(id) on delete set null,
  branch_name text,
  github_account_id text,
  created_by uuid references public.user_profiles(id) on delete set null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by uuid references public.user_profiles(id) on delete set null,
  revoked_at timestamptz,
  claim_id uuid,
  claim_expires_at timestamptz,
  created_at timestamptz not null default now()
);

create index access_invites_email_lower_idx on public.access_invites (lower(email));
create index access_invites_expires_at_idx on public.access_invites (expires_at);
create index access_invites_claim_expires_at_idx on public.access_invites (claim_expires_at)
  where consumed_at is null and revoked_at is null;
create index access_invites_project_idx on public.access_invites (project_id);
create index access_invites_created_by_idx on public.access_invites (created_by);
create index access_invites_consumed_by_idx on public.access_invites (consumed_by);

create table public.app_sessions (
  id uuid primary key,
  user_id uuid not null references public.user_profiles(id) on delete cascade,
  active_project_id uuid references public.managed_projects(id) on delete set null,
  active_branch text,
  session_token_hash text not null unique,
  user_agent_hash text,
  ip_hash text,
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index app_sessions_user_id_idx on public.app_sessions (user_id);
create index app_sessions_expires_at_idx on public.app_sessions (expires_at);
create index app_sessions_active_project_idx on public.app_sessions (active_project_id);

create table public.opencode_session_ownership (
  session_id text primary key,
  user_id uuid not null references public.user_profiles(id) on delete cascade,
  project_id uuid not null references public.managed_projects(id) on delete cascade,
  branch_name text not null,
  public_directory text not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index opencode_session_ownership_user_idx
  on public.opencode_session_ownership (user_id, updated_at desc);
create index opencode_session_ownership_project_idx
  on public.opencode_session_ownership (project_id, branch_name);
create index opencode_session_ownership_active_user_idx
  on public.opencode_session_ownership (user_id, updated_at desc)
  where archived_at is null;

create table public.activity_logs (
  id bigint generated always as identity primary key,
  event_id uuid not null unique,
  actor_user_id uuid references public.user_profiles(id) on delete set null,
  actor_role text,
  action text not null,
  target_type text,
  target_id text,
  target_user_id uuid references public.user_profiles(id) on delete set null,
  project_id uuid references public.managed_projects(id) on delete set null,
  session_id text,
  request_id text,
  success boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index activity_logs_actor_created_idx on public.activity_logs (actor_user_id, created_at desc);
create index activity_logs_project_created_idx on public.activity_logs (project_id, created_at desc);
create index activity_logs_action_created_idx on public.activity_logs (action, created_at desc);
create index activity_logs_target_created_idx on public.activity_logs (target_type, target_id, created_at desc, id desc);
create index activity_logs_target_user_created_idx on public.activity_logs (target_user_id, created_at desc, id desc);

create table public.audit_outbox (
  id uuid primary key,
  payload jsonb not null,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create index audit_outbox_pending_idx
  on public.audit_outbox (next_attempt_at)
  where delivered_at is null;

create or replace function public.devryan_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.devryan_set_updated_at() from public, anon, authenticated;

create trigger user_profiles_updated_at
before update on public.user_profiles
for each row execute function public.devryan_set_updated_at();

create trigger role_policies_updated_at
before update on public.role_policies
for each row execute function public.devryan_set_updated_at();

create trigger user_policies_updated_at
before update on public.user_policies
for each row execute function public.devryan_set_updated_at();

create trigger managed_projects_updated_at
before update on public.managed_projects
for each row execute function public.devryan_set_updated_at();

create trigger user_project_access_updated_at
before update on public.user_project_access
for each row execute function public.devryan_set_updated_at();

create trigger opencode_session_ownership_updated_at
before update on public.opencode_session_ownership
for each row execute function public.devryan_set_updated_at();

create or replace function public.devryan_protect_final_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  remaining_admins integer;
begin
  if old.role = 'admin' and old.status = 'active' and (
    tg_op = 'DELETE'
    or new.role <> 'admin'
    or new.status <> 'active'
  ) then
    select count(*) into remaining_admins
      from public.user_profiles
      where id <> old.id and role = 'admin' and status = 'active';
    if remaining_admins = 0 then
      raise exception 'the final enabled administrator cannot be removed, disabled, or demoted';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.devryan_protect_final_admin() from public, anon, authenticated;

create trigger user_profiles_protect_final_admin
before update or delete on public.user_profiles
for each row execute function public.devryan_protect_final_admin();

create or replace function public.devryan_require_active_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role <> 'admin' and new.status = 'active' and not exists (
    select 1 from public.user_project_access where user_id = new.id
  ) then
    raise exception 'non-admin users must remain suspended until a project is assigned';
  end if;
  return new;
end;
$$;

revoke all on function public.devryan_require_active_assignment() from public, anon, authenticated;

create trigger user_profiles_require_active_assignment
before insert or update of role, status on public.user_profiles
for each row execute function public.devryan_require_active_assignment();

create or replace function public.devryan_suspend_unassigned_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.user_project_access where user_id = old.user_id) then
    update public.user_profiles
      set status = 'suspended'
      where id = old.user_id and role <> 'admin' and status = 'active';
  end if;
  return old;
end;
$$;

revoke all on function public.devryan_suspend_unassigned_user() from public, anon, authenticated;

create trigger user_project_access_suspend_unassigned
after delete on public.user_project_access
for each row execute function public.devryan_suspend_unassigned_user();

insert into public.role_policies (
  role,
  settings_pages,
  can_use_files,
  can_use_terminal,
  can_manage_projects,
  can_manage_users,
  can_manage_global_settings,
  can_manage_git,
  can_push,
  can_use_github,
  feature_flags
) values
  (
    'admin',
    array['*'],
    true, true, true, true, true, true, true, true,
    '{"admin":true}'::jsonb
  ),
  (
    'senior_developer',
    array['home','appearance','chat','sessions','shortcuts','notifications','users'],
    false, true, false, false, false, true, true, true,
    '{}'::jsonb
  ),
  (
    'developer',
    array['home','appearance','chat','sessions','shortcuts','notifications'],
    false, false, false, false, false, true, true, true,
    '{}'::jsonb
  );

-- The Data API must remain service-only. RLS is defense in depth; privileges
-- are also removed so neither browser key role can access these relations.
do $$
declare
  relation_name text;
begin
  foreach relation_name in array array[
    'user_profiles',
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
    execute format('alter table public.%I enable row level security', relation_name);
    execute format('alter table public.%I force row level security', relation_name);
    execute format('revoke all on table public.%I from public, anon, authenticated', relation_name);
    execute format('grant all on table public.%I to service_role', relation_name);
  end loop;
end $$;

revoke all on sequence public.activity_logs_id_seq from public, anon, authenticated;
grant usage, select on sequence public.activity_logs_id_seq to service_role;

comment on table public.user_profiles is 'Server-only DevRyan user profile and role state.';
comment on table public.managed_projects is 'Server-only host repository registrations; repository_path must never be returned to remote clients.';
comment on table public.app_sessions is 'Opaque DevRyan application sessions; Supabase refresh tokens are kept in the encrypted host vault, never here.';
comment on table public.activity_logs is 'Append-only actor-attributed DevRyan audit trail.';
