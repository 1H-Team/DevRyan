-- Bot-wide environment-secret metadata. Values remain in the host-owned
-- encrypted vault and never enter Supabase or the Data API.

alter table public.bot_shared_files
  add column source_key text null check (
    source_key is null or char_length(source_key) between 1 and 256
  );

create unique index bot_shared_files_source_key_idx
  on public.bot_shared_files (bot_id, source_key)
  where source_key is not null;

create table public.bot_environment_secrets (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bots(id) on delete cascade,
  name text not null check (
    char_length(name) between 1 and 128
    and name ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'
  ),
  local_vault_reference text not null check (
    char_length(btrim(local_vault_reference)) between 1 and 512
  ),
  status text not null default 'active' check (status in ('active', 'error')),
  created_by uuid not null references public.user_profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index bot_environment_secrets_bot_name_idx
  on public.bot_environment_secrets (bot_id, name);

create trigger bot_environment_secrets_updated_at
before update on public.bot_environment_secrets
for each row execute function public.devryan_set_updated_at();

alter table public.bot_environment_secrets enable row level security;
alter table public.bot_environment_secrets force row level security;
revoke all on table public.bot_environment_secrets from public, anon, authenticated;
grant all on table public.bot_environment_secrets to service_role;

create or replace function public.devryan_bot_schema_version()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select '20260826140000'::text;
$$;

revoke all on function public.devryan_bot_schema_version()
  from public, anon, authenticated;
grant execute on function public.devryan_bot_schema_version()
  to service_role;

comment on table public.bot_environment_secrets is
  'Write-only host-vault references for Bot-wide reasoning environment variables.';

comment on column public.bot_shared_files.source_key is
  'Idempotent server-derived identity for automatic Bot output publication.';
