-- One verified GitHub identity belongs to the user profile. Project access
-- keeps a synchronized mirror for compatibility with existing runtime data.

alter table public.user_profiles
  add column github_account_id text;

-- Pick one deterministic legacy association per user, then keep each GitHub
-- identity with its oldest DevRyan owner. This lets the uniqueness constraint
-- be installed without silently deleting the host credential itself.
with profile_candidates as (
  select
    profile.id,
    profile.created_at,
    coalesce(
      (
        select nullif(trim(access.github_account_id), '')
        from public.user_project_access access
        where access.user_id = profile.id
          and access.is_default
          and nullif(trim(access.github_account_id), '') is not null
        order by access.project_id
        limit 1
      ),
      (
        select nullif(trim(access.github_account_id), '')
        from public.user_project_access access
        where access.user_id = profile.id
          and nullif(trim(access.github_account_id), '') is not null
        order by access.created_at, access.project_id
        limit 1
      )
    ) as github_account_id
  from public.user_profiles profile
), ranked_candidates as (
  select
    id,
    github_account_id,
    row_number() over (
      partition by github_account_id
      order by created_at, id
    ) as owner_rank
  from profile_candidates
  where github_account_id is not null
)
update public.user_profiles profile
set github_account_id = candidate.github_account_id
from ranked_candidates candidate
where profile.id = candidate.id
  and candidate.owner_rank = 1;

update public.user_project_access access
set github_account_id = profile.github_account_id
from public.user_profiles profile
where profile.id = access.user_id
  and access.github_account_id is distinct from profile.github_account_id;

create or replace function public.devryan_apply_profile_github_account()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  select profile.github_account_id
  into new.github_account_id
  from public.user_profiles profile
  where profile.id = new.user_id;
  return new;
end;
$$;

revoke all on function public.devryan_apply_profile_github_account() from public, anon, authenticated;

create trigger user_project_access_apply_profile_github_account
before insert or update
on public.user_project_access
for each row execute function public.devryan_apply_profile_github_account();

create or replace function public.devryan_sync_profile_github_account()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.user_project_access
  set github_account_id = new.github_account_id
  where user_id = new.id
    and github_account_id is distinct from new.github_account_id;
  return new;
end;
$$;

revoke all on function public.devryan_sync_profile_github_account() from public, anon, authenticated;

create trigger user_profiles_sync_github_account
after update of github_account_id
on public.user_profiles
for each row
when (old.github_account_id is distinct from new.github_account_id)
execute function public.devryan_sync_profile_github_account();

create unique index user_profiles_github_account_id_idx
  on public.user_profiles (github_account_id)
  where github_account_id is not null;

comment on column public.user_profiles.github_account_id is
  'Authoritative DevRyan GitHub credential association for this user.';

comment on column public.user_project_access.github_account_id is
  'Compatibility mirror of user_profiles.github_account_id; maintained by triggers.';
