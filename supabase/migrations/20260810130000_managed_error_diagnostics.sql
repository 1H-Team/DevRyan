-- Additive diagnostic classification for managed runtime failures. Impact is
-- immutable on the original activity row; recovery is recorded separately as
-- diagnostic.recovered / diagnostic.unresolved activity events.

alter table public.activity_logs
  add column diagnostic_impact text,
  add column diagnostic_source text;

alter table public.activity_logs
  add constraint activity_logs_diagnostic_impact_check
    check (diagnostic_impact in ('low', 'medium', 'high', 'critical')),
  add constraint activity_logs_diagnostic_source_check
    check (diagnostic_source in ('observed', 'inferred'));

update public.activity_logs
set
  diagnostic_impact = case
    when action = 'managed_task.failed' then 'high'
    when action = 'session.error' and metadata -> 'retryable' = 'true'::jsonb then 'medium'
    when action = 'session.error' then 'high'
    when action = 'tool.failed' and lower(coalesce(metadata ->> 'tool', '')) in (
      'apply_patch',
      'bash',
      'file_read',
      'glob',
      'grep',
      'oc_read',
      'read',
      'rg',
      'search',
      'shell',
      'skill',
      'stat'
    ) then 'low'
    when action = 'tool.failed' then 'medium'
    else diagnostic_impact
  end,
  diagnostic_source = 'inferred'
where action in ('session.error', 'tool.failed', 'managed_task.failed')
  and diagnostic_impact is null;

create index activity_logs_diagnostic_impact_created_idx
  on public.activity_logs (diagnostic_impact, action, created_at desc, event_id desc)
  where action in ('session.error', 'tool.failed', 'managed_task.failed');

create function public.devryan_preserve_activity_diagnostic_classification()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.diagnostic_impact is distinct from old.diagnostic_impact
    or new.diagnostic_source is distinct from old.diagnostic_source then
    raise exception 'activity diagnostic classification is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger activity_logs_preserve_diagnostic_classification
before update of diagnostic_impact, diagnostic_source on public.activity_logs
for each row execute function public.devryan_preserve_activity_diagnostic_classification();

revoke all on function public.devryan_preserve_activity_diagnostic_classification()
  from public, anon, authenticated;
grant execute on function public.devryan_preserve_activity_diagnostic_classification()
  to service_role;

comment on column public.activity_logs.diagnostic_impact is
  'Immutable managed diagnostic severity: low, medium, high, or trusted-core critical.';
comment on column public.activity_logs.diagnostic_source is
  'Whether diagnostic classification was observed at capture time or inferred for a legacy row.';
