-- Reclassify only confirmed routine-input and benign-browser signatures from
-- the retained Error Logs investigation. Preserve every forensic row/event id.

begin;

drop trigger if exists activity_logs_preserve_diagnostic_classification
  on public.activity_logs;

update public.activity_logs
set
  diagnostic_impact = 'low',
  diagnostic_source = 'inferred',
  diagnostic_disposition = 'expected',
  metadata = metadata || jsonb_build_object(
    'failureClass', 'input',
    'diagnosticDisposition', 'expected'
  )
where action = 'tool.failed'
  and (
    (
      lower(coalesce(metadata ->> 'tool', '')) = 'skill'
      and coalesce(metadata ->> 'failureText', '') ~* 'skill\s+"[^"]+"\s+not found'
    )
    or coalesce(metadata ->> 'failureText', '') ~* '(permission denied by (tool )?policy|tool permission.{0,80}(denied|blocked))'
    or coalesce(metadata ->> 'failureText', '') ~* '(managed task barrier|task barrier (is )?active|result is already acknowledged)'
    or coalesce(metadata ->> 'failureText', '') ~* '(filePath|oldString).{0,80}(is required|must be|did not match|not found)'
    or (
      lower(coalesce(metadata ->> 'tool', '')) = 'devryan_browser'
      and coalesce(metadata ->> 'failureText', '') ~* '(stale (element|reference|ref)|could not locate element|missing selector|invalid selector|unsafe (eval|evaluation)|unsupported command|SecurityError.{0,160}(localStorage|cross-origin|sandboxed)|(localStorage|cross-origin|sandboxed).{0,160}SecurityError|DEVRYAN_BROWSER_(STALE_REF|INVALID_COMMAND|UNSAFE_EVAL))'
      and coalesce(metadata ->> 'failureText', '') !~* '(lease_acquire_failed|browser host|cannot resolve session lineage|browser_owner_context_unavailable)'
    )
  );

update public.activity_logs activity
set
  diagnostic_impact = 'low',
  diagnostic_source = 'inferred',
  diagnostic_disposition = 'expected',
  metadata = activity.metadata || jsonb_build_object(
    'failureClass', 'command_exit',
    'diagnosticDisposition', 'expected'
  )
where activity.action = 'tool.failed'
  and lower(coalesce(activity.metadata ->> 'tool', '')) in (
    'bash', 'exec', 'exec_command', 'shell', 'ctx_execute', 'ctx_execute_file'
  )
  and coalesce(activity.metadata ->> 'failureText', '') ~* '(command|process|execution) timed out after [0-9,]+ (ms|milliseconds?|seconds?)'
  and exists (
    select 1
    from public.activity_logs resolution
    where resolution.action = 'diagnostic.recovered'
      and resolution.target_type = 'activity_event'
      and resolution.target_id = activity.event_id::text
  );

update public.activity_logs
set
  diagnostic_impact = 'low',
  diagnostic_source = 'inferred',
  diagnostic_disposition = 'expected',
  metadata = metadata || jsonb_build_object(
    'failureClass', case when action = 'client.error' then 'client_runtime' else 'input' end,
    'diagnosticDisposition', 'expected'
  )
where (
    action = 'client.error'
    and trim(coalesce(metadata ->> 'failureText', '')) ~* '^ResizeObserver loop completed with undelivered notifications\.?$'
  ) or (
    action = 'managed_task.failed'
    and trim(coalesce(metadata ->> 'failureText', '')) ~* '^managed task (was )?aborted\.?$'
  );

create trigger activity_logs_preserve_diagnostic_classification
before update of diagnostic_impact, diagnostic_source, diagnostic_disposition
on public.activity_logs
for each row execute function public.devryan_preserve_activity_diagnostic_classification();

commit;
