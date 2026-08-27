-- Expired approvals are terminal runtime facts, not approval decisions. Reconcile
-- each expired action and its waiting run atomically so the Bot's FIFO scope can
-- continue without weakening the approval policy.

create index if not exists bot_action_attempts_pending_expiry_idx
  on public.bot_action_attempts (decision_expires_at, id)
  where state = 'pending_approval';

create or replace function public.devryan_expire_bot_approvals(
  p_computer_scope text,
  p_now timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  result jsonb;
begin
  if p_now is null then
    raise exception using errcode = '22023', message = 'Bot approval expiry time is required';
  end if;
  if p_computer_scope is not null
    and (char_length(p_computer_scope) < 1 or char_length(p_computer_scope) > 512) then
    raise exception using errcode = '22023', message = 'Bot computer scope is invalid';
  end if;

  with locked_actions as materialized (
    select action_attempt.id, action_attempt.run_id
    from public.bot_action_attempts action_attempt
    join public.bot_runs run on run.id = action_attempt.run_id
    where action_attempt.state = 'pending_approval'
      and action_attempt.decision_expires_at <= p_now
      and run.state = 'waiting_approval'
      and (p_computer_scope is null or run.computer_scope_key = p_computer_scope)
    order by action_attempt.decision_expires_at, action_attempt.id
    for update of action_attempt skip locked
  ),
  expired_actions as (
    update public.bot_action_attempts action_attempt
    set state = 'cancelled'
    from locked_actions locked
    where action_attempt.id = locked.id
      and action_attempt.state = 'pending_approval'
    returning action_attempt.*
  ),
  expired_run_ids as materialized (
    select distinct action_attempt.run_id
    from expired_actions action_attempt
  ),
  expired_runs as (
    update public.bot_runs run
    set state = 'failed',
        interruption_kind = 'bot_approval_expired',
        lease_owner = null,
        lease_until = null,
        finished_at = p_now
    from expired_run_ids expired
    where run.id = expired.run_id
      and run.state = 'waiting_approval'
    returning run.*
  )
  select pg_catalog.jsonb_build_object(
    'actions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(action_attempt) order by action_attempt.created_at, action_attempt.id)
      from expired_actions action_attempt
    ), '[]'::jsonb),
    'runs', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(run) order by run.queue_sequence, run.id)
      from expired_runs run
    ), '[]'::jsonb),
    'scopeKeys', coalesce((
      select pg_catalog.jsonb_agg(scope.computer_scope_key order by scope.computer_scope_key)
      from (
        select distinct run.computer_scope_key
        from expired_runs run
      ) scope
    ), '[]'::jsonb)
  ) into result;

  return coalesce(result, pg_catalog.jsonb_build_object(
    'actions', '[]'::jsonb,
    'runs', '[]'::jsonb,
    'scopeKeys', '[]'::jsonb
  ));
end;
$$;

create or replace function public.devryan_bot_schema_version()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select '20260825190000'::text;
$$;

revoke all on function public.devryan_expire_bot_approvals(text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.devryan_expire_bot_approvals(text, timestamptz)
  to service_role;
revoke all on function public.devryan_bot_schema_version()
  from public, anon, authenticated;
grant execute on function public.devryan_bot_schema_version()
  to service_role;

comment on function public.devryan_expire_bot_approvals(text, timestamptz) is
  'Atomically cancels expired pending Bot actions and fails their waiting runs without creating approval decisions.';
