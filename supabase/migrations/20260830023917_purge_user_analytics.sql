-- Allow an administrator to clear one human user's analytics without weakening
-- the monotonic retention lock installed for session-deletion evidence.

create or replace function public.devryan_purge_user_activity_logs(
  p_user_id uuid,
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
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;

  select count(*) into protected_count
  from public.activity_logs activity
  where activity.event_id is distinct from p_preserve_event_id
    and p_user_id in (activity.actor_user_id, activity.target_user_id)
    and exists (
      select 1
      from public.user_profiles profile
      where profile.analytics_retention_locked_at is not null
        and profile.id in (activity.actor_user_id, activity.target_user_id)
    );

  with deleted as (
    delete from public.activity_logs activity
    where activity.event_id is distinct from p_preserve_event_id
      and p_user_id in (activity.actor_user_id, activity.target_user_id)
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

revoke all on function public.devryan_purge_user_activity_logs(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.devryan_purge_user_activity_logs(uuid, uuid)
  to service_role;

comment on function public.devryan_purge_user_activity_logs(uuid, uuid) is
  'Purges one user analytics while retaining rows linked to any retention-locked profile.';
