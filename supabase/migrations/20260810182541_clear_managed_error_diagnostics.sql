-- Clear the administrator Error Logs snapshot without weakening indefinite
-- analytics retention for any other activity. The transaction-local setting
-- is intentionally useful only for the five diagnostic actions below.

create or replace function public.devryan_preserve_locked_user_activity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_setting('devryan.error_log_clear_scope', true) = 'diagnostics'
    and old.action in (
      'session.error',
      'tool.failed',
      'managed_task.failed',
      'diagnostic.recovered',
      'diagnostic.unresolved'
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

create or replace function public.devryan_clear_error_logs(
  p_since timestamptz,
  p_until timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  linked_resolution_count bigint := 0;
  cleared_count bigint := 0;
begin
  if p_until is null then
    raise exception using
      errcode = '22023',
      message = 'p_until is required';
  end if;
  if p_since is not null and p_since > p_until then
    raise exception using
      errcode = '22023',
      message = 'p_since must be earlier than or equal to p_until';
  end if;

  perform set_config('devryan.error_log_clear_scope', 'diagnostics', true);

  delete from public.activity_logs resolution
  where resolution.action in ('diagnostic.recovered', 'diagnostic.unresolved')
    and resolution.target_type = 'activity_event'
    and exists (
      select 1
      from public.activity_logs failure
      where failure.event_id::text = resolution.target_id
        and failure.action in ('session.error', 'tool.failed', 'managed_task.failed')
        and failure.created_at <= p_until
        and (p_since is null or failure.created_at >= p_since)
    );
  get diagnostics linked_resolution_count = row_count;

  delete from public.activity_logs failure
  where failure.action in ('session.error', 'tool.failed', 'managed_task.failed')
    and failure.created_at <= p_until
    and (p_since is null or failure.created_at >= p_since);
  get diagnostics cleared_count = row_count;

  perform set_config('devryan.error_log_clear_scope', 'off', true);

  return jsonb_build_object(
    'clearedCount', cleared_count,
    'linkedResolutionCount', linked_resolution_count
  );
end;
$$;

revoke all on function public.devryan_clear_error_logs(timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.devryan_clear_error_logs(timestamptz, timestamptz)
  to service_role;

comment on function public.devryan_clear_error_logs(timestamptz, timestamptz) is
  'Atomically clears one administrator Error Logs snapshot and its linked diagnostic resolution evidence.';
