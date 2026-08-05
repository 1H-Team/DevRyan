alter table public.user_profiles
  add column account_kind text not null default 'human',
  add constraint user_profiles_account_kind_check
    check (account_kind in ('human', 'agent_test'));

comment on column public.user_profiles.account_kind is
  'Classifies normal human accounts and AI-agent-only feature-test identities.';

update public.user_profiles
set
  account_kind = 'agent_test',
  display_name = case lower(email)
    when 'admin@1health.ae' then 'Test Administrator'
    when 'developer@1health.ae' then 'Test Developer'
    else display_name
  end
where lower(email) in ('admin@1health.ae', 'developer@1health.ae');
