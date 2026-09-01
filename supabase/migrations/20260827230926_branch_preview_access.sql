-- Branch-specific preview metadata. Cloudflare client credentials remain in
-- the host-owned encrypted vault; Supabase stores only the opaque reference.

create table public.user_branch_previews (
  user_id uuid not null,
  project_id uuid not null,
  branch_name text not null,
  preview_url text not null check (
    char_length(btrim(preview_url)) between 1 and 4096
  ),
  service_token_vault_ref text check (
    service_token_vault_ref is null
    or char_length(btrim(service_token_vault_ref)) between 1 and 256
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, project_id, branch_name),
  foreign key (user_id, project_id, branch_name)
    references public.user_project_branches(user_id, project_id, branch_name)
    on delete cascade
);

create index user_branch_previews_project_idx
  on public.user_branch_previews (project_id, user_id);

create trigger user_branch_previews_updated_at
before update on public.user_branch_previews
for each row execute function public.devryan_set_updated_at();

alter table public.user_branch_previews enable row level security;
alter table public.user_branch_previews force row level security;
revoke all on table public.user_branch_previews from public, anon, authenticated;
grant all on table public.user_branch_previews to service_role;

comment on table public.user_branch_previews is
  'Server-only branch preview URLs and opaque references to host-vault Cloudflare service tokens.';
comment on column public.user_branch_previews.service_token_vault_ref is
  'Opaque reference only; the Client ID and Client Secret never enter Supabase.';
