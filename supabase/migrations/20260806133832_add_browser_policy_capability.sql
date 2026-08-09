-- Browser is a first-class role capability. Existing and future developer
-- roles inherit enabled access unless an administrator explicitly disables it.
alter table public.role_policies
  add column if not exists can_use_browser boolean not null default true;

update public.role_policies
set can_use_browser = true
where role in ('admin', 'senior_developer', 'developer');
