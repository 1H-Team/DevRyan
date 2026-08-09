-- Keep a managed developer's complete user-centric analytics history after a
-- permanent session deletion. The lock is monotonic and protects both existing
-- rows and audit-outbox rows delivered after an administrator purge.

alter table public.user_profiles
  add column if not exists analytics_retention_locked_at timestamptz;

comment on column public.user_profiles.analytics_retention_locked_at is
  'Monotonic lock preserving developer actor/target analytics from application-level purges.';

create or replace function public.devryan_lock_user_analytics_retention(
  p_user_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  protected_at timestamptz;
begin
  update public.user_profiles profile
  set analytics_retention_locked_at = coalesce(profile.analytics_retention_locked_at, now())
  where profile.id = p_user_id
    and profile.role in ('developer', 'senior_developer')
  returning profile.analytics_retention_locked_at into protected_at;

  return jsonb_build_object(
    'locked', protected_at is not null,
    'protectedAt', protected_at
  );
end;
$$;

revoke all on function public.devryan_lock_user_analytics_retention(uuid)
  from public, anon, authenticated;
grant execute on function public.devryan_lock_user_analytics_retention(uuid)
  to service_role;

create or replace function public.devryan_preserve_locked_user_activity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.user_profiles profile
    where profile.analytics_retention_locked_at is not null
      and profile.id in (old.actor_user_id, old.target_user_id)
  ) then
    return null;
  end if;
  return old;
end;
$$;

revoke all on function public.devryan_preserve_locked_user_activity()
  from public, anon, authenticated;

drop trigger if exists activity_logs_preserve_locked_user_analytics
  on public.activity_logs;
create trigger activity_logs_preserve_locked_user_analytics
before delete on public.activity_logs
for each row execute function public.devryan_preserve_locked_user_activity();

create or replace function public.devryan_purge_unprotected_activity_logs(
  p_preserve_event_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  protected_count bigint;
  deleted_count bigint;
begin
  select count(*) into protected_count
  from public.activity_logs activity
  where activity.event_id is distinct from p_preserve_event_id
    and exists (
      select 1
      from public.user_profiles profile
      where profile.analytics_retention_locked_at is not null
        and profile.id in (activity.actor_user_id, activity.target_user_id)
    );

  with deleted as (
    delete from public.activity_logs activity
    where activity.event_id is distinct from p_preserve_event_id
      and not exists (
        select 1
        from public.user_profiles profile
        where profile.analytics_retention_locked_at is not null
          and profile.id in (activity.actor_user_id, activity.target_user_id)
      )
    returning 1
  )
  select count(*) into deleted_count from deleted;

  return jsonb_build_object(
    'deletedCount', deleted_count,
    'protectedCount', protected_count
  );
end;
$$;

revoke all on function public.devryan_purge_unprotected_activity_logs(uuid)
  from public, anon, authenticated;
grant execute on function public.devryan_purge_unprotected_activity_logs(uuid)
  to service_role;

comment on function public.devryan_lock_user_analytics_retention(uuid) is
  'Monotonically protects one managed non-admin user analytics history after session deletion.';
comment on function public.devryan_purge_unprotected_activity_logs(uuid) is
  'Purges ordinary audit rows while retaining analytics for retention-locked developers.';
