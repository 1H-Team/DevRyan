-- Durable, content-free Bot run diagnostics. This trigger is intentionally
-- database-owned so every terminal transition is captured regardless of the
-- application path that produced it.

create or replace function public.devryan_capture_bot_run_terminal_audit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  originating_actor uuid;
  diagnostic_code text;
  failure_phase text;
  retryable_value jsonb;
  retry_count_value jsonb;
  audit_result text;
  audit_metadata jsonb;
begin
  select message.actor_user_id
  into originating_actor
  from public.bot_messages message
  where message.run_id = new.id
    and message.channel_id = new.channel_id
    and message.role = 'user'
  order by message.sequence asc
  limit 1;

  diagnostic_code := case
    when coalesce(new.interruption_kind, '') ~ '^[A-Za-z0-9_.:-]{1,160}$'
      then new.interruption_kind
    when new.state = 'interrupted'
      then 'bot_run_interrupted'
    else 'bot_run_failed'
  end;

  failure_phase := case
    when coalesce(new.context_snapshot ->> 'failurePhase', '') ~ '^[A-Za-z0-9_.:-]{1,120}$'
      then new.context_snapshot ->> 'failurePhase'
    else null
  end;

  retryable_value := case
    when pg_catalog.jsonb_typeof(new.context_snapshot -> 'retryable') = 'boolean'
      then new.context_snapshot -> 'retryable'
    else null
  end;

  retry_count_value := case
    when coalesce(new.context_snapshot ->> 'retryCount', '') ~ '^[0-9]{1,9}$'
      then pg_catalog.to_jsonb((new.context_snapshot ->> 'retryCount')::integer)
    else pg_catalog.to_jsonb(0)
  end;

  audit_result := case
    when diagnostic_code in ('bot_action_denied', 'bot_approval_expired') then 'denied'
    when new.state = 'interrupted' then 'unknown'
    else 'failure'
  end;

  audit_metadata := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'botId', new.bot_id,
    'runId', new.id,
    'channelId', new.channel_id,
    'revisionId', new.revision_id,
    'agentAdapter', new.agent_adapter,
    'agentThreadId', new.agent_thread_id,
    'terminalState', new.state,
    'code', diagnostic_code,
    'failurePhase', failure_phase,
    'retryable', retryable_value,
    'retryCount', retry_count_value
  ));

  insert into public.bot_audit_events (
    event_id,
    bot_id,
    actor_user_id,
    target_type,
    target_id,
    action,
    result,
    metadata,
    created_at
  ) values (
    gen_random_uuid(),
    new.bot_id,
    originating_actor,
    'bot_run',
    new.id::text,
    case when new.state = 'interrupted' then 'bot.run.interrupted' else 'bot.run.failed' end,
    audit_result,
    audit_metadata,
    coalesce(new.finished_at, new.updated_at, pg_catalog.now())
  );

  return new;
end;
$$;

revoke all on function public.devryan_capture_bot_run_terminal_audit()
  from public, anon, authenticated;
grant execute on function public.devryan_capture_bot_run_terminal_audit()
  to service_role;

drop trigger if exists bot_runs_terminal_audit on public.bot_runs;
create trigger bot_runs_terminal_audit
after update of state on public.bot_runs
for each row
when (
  old.state is distinct from new.state
  and new.state in ('failed', 'interrupted')
)
execute function public.devryan_capture_bot_run_terminal_audit();

-- Backfill only currently terminal runs that have no matching run diagnostic.
-- A later retry and terminal transition is deliberately a distinct event.
insert into public.bot_audit_events (
  event_id,
  bot_id,
  actor_user_id,
  target_type,
  target_id,
  action,
  result,
  metadata,
  created_at
)
select
  gen_random_uuid(),
  run.bot_id,
  origin.actor_user_id,
  'bot_run',
  run.id::text,
  case when run.state = 'interrupted' then 'bot.run.interrupted' else 'bot.run.failed' end,
  case
    when diagnostic.code in ('bot_action_denied', 'bot_approval_expired') then 'denied'
    when run.state = 'interrupted' then 'unknown'
    else 'failure'
  end,
  pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'botId', run.bot_id,
    'runId', run.id,
    'channelId', run.channel_id,
    'revisionId', run.revision_id,
    'agentAdapter', run.agent_adapter,
    'agentThreadId', run.agent_thread_id,
    'terminalState', run.state,
    'code', diagnostic.code,
    'failurePhase', diagnostic.failure_phase,
    'retryable', diagnostic.retryable,
    'retryCount', diagnostic.retry_count
  )),
  coalesce(run.finished_at, run.updated_at, run.created_at)
from public.bot_runs run
left join lateral (
  select message.actor_user_id
  from public.bot_messages message
  where message.run_id = run.id
    and message.channel_id = run.channel_id
    and message.role = 'user'
  order by message.sequence asc
  limit 1
) origin on true
cross join lateral (
  select
    case
      when coalesce(run.interruption_kind, '') ~ '^[A-Za-z0-9_.:-]{1,160}$'
        then run.interruption_kind
      when run.state = 'interrupted'
        then 'bot_run_interrupted'
      else 'bot_run_failed'
    end as code,
    case
      when coalesce(run.context_snapshot ->> 'failurePhase', '') ~ '^[A-Za-z0-9_.:-]{1,120}$'
        then run.context_snapshot ->> 'failurePhase'
      else null
    end as failure_phase,
    case
      when pg_catalog.jsonb_typeof(run.context_snapshot -> 'retryable') = 'boolean'
        then run.context_snapshot -> 'retryable'
      else null
    end as retryable,
    case
      when coalesce(run.context_snapshot ->> 'retryCount', '') ~ '^[0-9]{1,9}$'
        then pg_catalog.to_jsonb((run.context_snapshot ->> 'retryCount')::integer)
      else pg_catalog.to_jsonb(0)
    end as retry_count
) diagnostic
where run.state in ('failed', 'interrupted')
  and not exists (
    select 1
    from public.bot_audit_events audit
    where audit.target_type = 'bot_run'
      and audit.target_id = run.id::text
      and audit.action = case
        when run.state = 'interrupted' then 'bot.run.interrupted'
        else 'bot.run.failed'
      end
      and audit.metadata ->> 'terminalState' = run.state
  );

create index bot_audit_events_issues_time_idx
  on public.bot_audit_events (created_at desc, id desc)
  where result in ('failure', 'partial', 'unknown');

create or replace function public.devryan_bot_schema_version()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select '20260828210316'::text;
$$;

revoke all on function public.devryan_bot_schema_version()
  from public, anon, authenticated;
grant execute on function public.devryan_bot_schema_version()
  to service_role;

comment on function public.devryan_capture_bot_run_terminal_audit() is
  'Appends content-free Bot audit rows when runs enter failed or interrupted states.';
comment on index public.bot_audit_events_issues_time_idx is
  'Supports newest-first Bot Audit issue browsing without indexing success or denied rows.';
