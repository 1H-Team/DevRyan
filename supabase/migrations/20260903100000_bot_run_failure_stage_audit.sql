-- Surface the runtime startup stage of a terminal Bot run in the immutable
-- audit ledger.
--
-- `failurePhase` already separates failures that happened before the agent
-- started answering ('startup') from failures during the answer
-- ('execution'). `failureStage` names the startup step that failed
-- (container, readiness, oauth_readiness, credentials, admission, config,
-- gateway, environment, artifacts) so an operator can tell a local runtime
-- problem apart from a model provider failure without opening the run's
-- context snapshot. The value is content-free and bounded; anything else is
-- omitted rather than rejected so the terminal transition is never blocked.

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
  failure_stage text;
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

  failure_stage := case
    when coalesce(new.context_snapshot ->> 'failureStage', '') ~ '^[A-Za-z0-9_.:-]{1,80}$'
      then new.context_snapshot ->> 'failureStage'
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
    'failureStage', failure_stage,
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

-- The trigger created by 20260828210316_bot_terminal_error_audit.sql keeps
-- pointing at the replaced function body; it is deliberately not recreated.

create or replace function public.devryan_bot_schema_version()
returns text language sql stable security invoker set search_path = ''
as $$ select '20260903100000'::text; $$;
revoke all on function public.devryan_bot_schema_version() from public, anon, authenticated;
grant execute on function public.devryan_bot_schema_version() to service_role;
