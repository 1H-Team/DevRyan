alter table public.managed_projects
  add column if not exists icon text,
  add column if not exists color text,
  add column if not exists icon_background text,
  add column if not exists icon_image jsonb;
