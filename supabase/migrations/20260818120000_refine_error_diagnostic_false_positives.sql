-- Reclassify only the recovered target/input signatures confirmed in the
-- retained diagnostic evidence. Preserve every forensic row and identifier.

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
  and lower(coalesce(metadata ->> 'tool', '')) = 'devryan_browser'
  and position(
    'could not locate element'
    in lower(coalesce(metadata ->> 'failureText', ''))
  ) > 0;

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
  and lower(coalesce(metadata ->> 'tool', '')) in ('webfetch', 'web_fetch')
  and position(
    'status code: 404'
    in lower(coalesce(metadata ->> 'failureText', ''))
  ) > 0;

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
  and lower(coalesce(metadata ->> 'tool', '')) in ('glob', 'grep', 'rg', 'search')
  and position(
    'stdout maxbuffer length exceeded'
    in lower(coalesce(metadata ->> 'failureText', ''))
  ) > 0;

create trigger activity_logs_preserve_diagnostic_classification
before update of diagnostic_impact, diagnostic_source, diagnostic_disposition
on public.activity_logs
for each row execute function public.devryan_preserve_activity_diagnostic_classification();

commit;
