-- Managed accounts now inherit model defaults from the live host agent catalog.
-- Remove only the legacy model-selection keys from non-admin policies. Other
-- preferences remain personal, and administrator policy rows are untouched.
update public.user_policies as policy
set settings_overrides = policy.settings_overrides
  - 'agentModelSelections'
  - 'defaultModel'
  - 'defaultVariant'
where exists (
  select 1
  from public.user_profiles as profile
  where profile.id = policy.user_id
    and profile.role <> 'admin'
)
and (
  policy.settings_overrides ? 'agentModelSelections'
  or policy.settings_overrides ? 'defaultModel'
  or policy.settings_overrides ? 'defaultVariant'
);
