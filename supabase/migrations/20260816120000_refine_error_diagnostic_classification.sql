-- Correct narrowly identified historical diagnostic classifications without
-- deleting or replacing their forensic evidence.

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
  and btrim(lower(coalesce(metadata ->> 'failureText', ''))) in (
    'tool execution aborted',
    'tool execution aborted.'
  );

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
  and lower(coalesce(metadata ->> 'tool', '')) in ('grep', 'rg', 'search')
  and lower(coalesce(metadata ->> 'failureText', '')) ~
    '(regex parse error|invalid (regular expression|regex)|unclosed (group|character class)|invalid repetition)';

update public.activity_logs
set
  diagnostic_impact = 'low',
  diagnostic_source = 'inferred',
  diagnostic_disposition = 'expected',
  metadata = metadata || jsonb_build_object(
    'failureClass', 'integration_runtime',
    'diagnosticDisposition', 'expected'
  )
where action = 'tool.failed'
  and lower(coalesce(metadata ->> 'tool', '')) = 'devryan_browser'
  and lower(coalesce(metadata ->> 'failureText', '')) ~
    '(err_connection_refused|econnrefused)';

update public.activity_logs
set
  diagnostic_impact = 'medium',
  diagnostic_source = 'inferred',
  diagnostic_disposition = 'actionable',
  metadata = metadata || jsonb_build_object(
    'failureClass', 'session_runtime',
    'diagnosticDisposition', 'actionable',
    'failureKind', 'request_timeout'
  )
where action = 'session.error'
  and lower(coalesce(metadata ->> 'errorName', '')) in ('unknownerror', 'unknown error')
  and btrim(lower(coalesce(metadata ->> 'failureText', ''))) in (
    'the operation timed out',
    'the operation timed out.'
  )
  and coalesce(jsonb_typeof(metadata -> 'retryable'), '') <> 'boolean';

create trigger activity_logs_preserve_diagnostic_classification
before update of diagnostic_impact, diagnostic_source, diagnostic_disposition
on public.activity_logs
for each row execute function public.devryan_preserve_activity_diagnostic_classification();

commit;
