-- Separate actionable defects from expected tool outcomes without deleting
-- forensic evidence. The nullable column keeps non-diagnostic activity rows
-- unchanged while managed error rows receive an immutable disposition.

alter table public.activity_logs
  add column diagnostic_disposition text;

alter table public.activity_logs
  add constraint activity_logs_diagnostic_disposition_check
    check (diagnostic_disposition in ('actionable', 'expected'));

drop trigger if exists activity_logs_preserve_diagnostic_classification
  on public.activity_logs;

update public.activity_logs
set diagnostic_disposition = 'actionable'
where action in ('session.error', 'tool.failed', 'managed_task.failed', 'client.error')
  and diagnostic_disposition is null;

with diagnostic_text as (
  select
    event_id,
    action,
    lower(coalesce(metadata ->> 'tool', '')) as tool_name,
    lower(concat_ws(
      ' ',
      metadata ->> 'failureText',
      metadata ->> 'errorCode',
      metadata ->> 'errorName',
      metadata ->> 'statusCode'
    )) as failure_text
  from public.activity_logs
  where action in ('tool.failed', 'managed_task.failed')
)
update public.activity_logs activity
set
  diagnostic_disposition = 'expected',
  diagnostic_impact = 'low'
from diagnostic_text diagnostic
where activity.event_id = diagnostic.event_id
  and (
    (
      diagnostic.action = 'managed_task.failed'
      and (
        diagnostic.failure_text like '%devryan_tool_input_invalid%'
        or diagnostic.failure_text ~ 'successful(ly)? completed task.{0,160}(action[ :=]*["'']?continue|use (the )?continue action)'
        or diagnostic.failure_text ~ 'retry.{0,160}(is unavailable|cannot be used).{0,160}(completed|successful)'
      )
    )
    or (
      diagnostic.action = 'tool.failed'
      and (
        diagnostic.failure_text ~ '(^|[^a-z])(enoent|enotdir|eisdir)([^a-z]|$)'
        or diagnostic.failure_text like '%no such file or directory%'
        or diagnostic.failure_text like '%path does not exist%'
        or diagnostic.failure_text like '%apply_patch verification failed%'
        or diagnostic.failure_text like '%failed to find expected lines%'
        or diagnostic.failure_text like '%patch context did not match%'
        or diagnostic.failure_text like '%patch context mismatch%'
        or diagnostic.failure_text like '%invalid patch text%'
        or diagnostic.failure_text like '%malformed patch%'
        or diagnostic.failure_text like '%resolves outside the project root%'
        or diagnostic.failure_text like '%context-mode confines ctx_execute_file to the workspace%'
        or diagnostic.failure_text like '%denied by policy%'
        or diagnostic.failure_text like '%policy denial%'
        or diagnostic.failure_text ~ 'json record.{0,100}(65,?536|65536).{0,100}(byte|limit)'
        or diagnostic.failure_text ~ '(element|target|frame|tab).{0,120}(not found|missing|not visible|covered)'
        or diagnostic.failure_text like '%coverage miss%'
        or diagnostic.failure_text like '%devryan_browser_turn_lookup_%'
        or diagnostic.failure_text ~ '(http|status)[ :]+404([^0-9]|$)'
        or diagnostic.failure_text like '%enotfound%'
        or diagnostic.failure_text like '%network is unreachable%'
        or diagnostic.failure_text ~ 'getaddrinfo.{0,80}not found'
        or diagnostic.failure_text ~ 'no matches? (found|returned)'
        or diagnostic.failure_text ~ 'no files? (found|matched)'
        or diagnostic.failure_text ~ 'pattern (did not match|was not found)'
        or (
          (diagnostic.tool_name like 'ctx[_]%' or diagnostic.tool_name in ('bash', 'exec', 'exec_command', 'shell'))
          and diagnostic.failure_text ~ '(exit code:[ ]*[1-9][0-9]*|exited with (code|status)[ ]*[1-9][0-9]*)'
        )
      )
    )
  );

create index activity_logs_diagnostic_disposition_error_idx
  on public.activity_logs (diagnostic_disposition, action, created_at desc, event_id desc)
  where action in ('session.error', 'tool.failed', 'managed_task.failed', 'client.error');

create or replace function public.devryan_preserve_activity_diagnostic_classification()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.diagnostic_impact is distinct from old.diagnostic_impact
    or new.diagnostic_source is distinct from old.diagnostic_source
    or new.diagnostic_disposition is distinct from old.diagnostic_disposition then
    raise exception 'activity diagnostic classification is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger activity_logs_preserve_diagnostic_classification
before update of diagnostic_impact, diagnostic_source, diagnostic_disposition
on public.activity_logs
for each row execute function public.devryan_preserve_activity_diagnostic_classification();

revoke all on function public.devryan_preserve_activity_diagnostic_classification()
  from public, anon, authenticated;
grant execute on function public.devryan_preserve_activity_diagnostic_classification()
  to service_role;

comment on column public.activity_logs.diagnostic_disposition is
  'Immutable managed diagnostic disposition: actionable defect or expected tool outcome.';
