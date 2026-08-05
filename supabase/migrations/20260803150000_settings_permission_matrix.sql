alter table public.role_policies
  add column if not exists settings_permissions jsonb not null default '{}'::jsonb;

alter table public.user_policies
  add column if not exists settings_permission_overrides jsonb not null default '{}'::jsonb;

comment on column public.role_policies.settings_permissions is
  'Canonical per-settings-page read/edit permissions. settings_pages is retained as a legacy read projection.';

comment on column public.user_policies.settings_permission_overrides is
  'Sparse per-user read/edit overrides. Missing cells inherit from the role policy.';

with settings_slugs(slug) as (
  values
    ('appearance'), ('notifications'), ('shortcuts'), ('voice'), ('about'),
    ('chat'), ('sessions'), ('agents'), ('skills.installed'), ('skills.catalog'),
    ('plugins'), ('magic-prompts'), ('providers'), ('usage'), ('mcp'),
    ('remote-instances'), ('tunnel'), ('users'), ('git'), ('projects'), ('commands')
), role_matrix as (
  select
    role_policies.role,
    jsonb_object_agg(
      settings_slugs.slug,
      jsonb_build_object(
        'read', role_policies.role = 'admin'
          or '*' = any(role_policies.settings_pages)
          or settings_slugs.slug = any(role_policies.settings_pages),
        'edit', role_policies.role = 'admin'
          or (
            settings_slugs.slug in ('appearance', 'notifications', 'shortcuts', 'voice', 'chat', 'sessions', 'usage')
            and ('*' = any(role_policies.settings_pages) or settings_slugs.slug = any(role_policies.settings_pages))
          )
      )
    ) as permissions
  from public.role_policies
  cross join settings_slugs
  group by role_policies.role
)
update public.role_policies
set settings_permissions = role_matrix.permissions
from role_matrix
where public.role_policies.role = role_matrix.role
  and public.role_policies.settings_permissions = '{}'::jsonb;

with settings_slugs(slug) as (
  values
    ('appearance'), ('notifications'), ('shortcuts'), ('voice'), ('about'),
    ('chat'), ('sessions'), ('agents'), ('skills.installed'), ('skills.catalog'),
    ('plugins'), ('magic-prompts'), ('providers'), ('usage'), ('mcp'),
    ('remote-instances'), ('tunnel'), ('users'), ('git'), ('projects'), ('commands')
), user_matrix as (
  select
    user_policies.user_id,
    jsonb_object_agg(
      settings_slugs.slug,
      jsonb_build_object(
        'read', '*' = any(user_policies.settings_pages)
          or settings_slugs.slug = any(user_policies.settings_pages),
        'edit', settings_slugs.slug in ('appearance', 'notifications', 'shortcuts', 'voice', 'chat', 'sessions', 'usage')
          and ('*' = any(user_policies.settings_pages) or settings_slugs.slug = any(user_policies.settings_pages))
      )
    ) as overrides
  from public.user_policies
  cross join settings_slugs
  where user_policies.settings_pages is not null
  group by user_policies.user_id
)
update public.user_policies
set settings_permission_overrides = user_matrix.overrides
from user_matrix
where public.user_policies.user_id = user_matrix.user_id
  and public.user_policies.settings_permission_overrides = '{}'::jsonb;
