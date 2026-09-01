-- Let the explicit administrator per-user purge clear the target's complete
-- analytics snapshot without weakening retention for direct deletes, global
-- activity clearing, or any other user. The bypass is transaction-local and
-- carries the exact target UUID so the trigger remains a second scope check.

create or replace function public.devryan_preserve_locked_user_activity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  analytics_clear_target text;
begin
  if current_setting('devryan.error_log_clear_scope', true) = 'diagnostics'
    and old.action in (
      'session.error',
      'tool.failed',
      'managed_task.failed',
      'client.error',
      'diagnostic.recovered',
      'diagnostic.unresolved'
    )
  then
    return old;
  end if;

  analytics_clear_target := current_setting(
    'devryan.user_analytics_clear_target',
    true
  );
  if analytics_clear_target is not null
    and analytics_clear_target <> ''
    and analytics_clear_target <> 'off'
    and analytics_clear_target in (
      old.actor_user_id::text,
      old.target_user_id::text
    )
  then
    return old;
  end if;

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
  deleted_count bigint := 0;
  remaining_count bigint := 0;
begin
  if p_user_id is null then
    raise exception using
      errcode = '22023',
      message = 'p_user_id is required';
  end if;

  perform set_config(
    'devryan.user_analytics_clear_target',
    p_user_id::text,
    true
  );

  delete from public.activity_logs activity
  where activity.event_id is distinct from p_preserve_event_id
    and p_user_id in (activity.actor_user_id, activity.target_user_id);
  get diagnostics deleted_count = row_count;

  select count(*) into remaining_count
  from public.activity_logs activity
  where activity.event_id is distinct from p_preserve_event_id
    and p_user_id in (activity.actor_user_id, activity.target_user_id);

  if remaining_count <> 0 then
    raise exception using
      errcode = 'P0001',
      message = 'User analytics purge did not clear the complete target snapshot';
  end if;

  perform set_config('devryan.user_analytics_clear_target', 'off', true);

  return jsonb_build_object(
    'complete', true,
    'deletedCount', deleted_count,
    'remainingCount', remaining_count
  );
end;
$$;

revoke all on function public.devryan_purge_user_activity_logs(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.devryan_purge_user_activity_logs(uuid, uuid)
  to service_role;

comment on function public.devryan_purge_user_activity_logs(uuid, uuid) is
  'Atomically clears one user analytics snapshot through an exact-target, transaction-local retention bypass.';
