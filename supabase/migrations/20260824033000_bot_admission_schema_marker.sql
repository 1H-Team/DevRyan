-- Advance the fail-closed Production Bots compatibility marker after repairing
-- atomic message admission in 20260824030000_bot_message_admission_timestamps.
create or replace function public.devryan_bot_schema_version()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select '20260824033000'::text;
$$;

revoke all on function public.devryan_bot_schema_version()
  from public, anon, authenticated;
grant execute on function public.devryan_bot_schema_version()
  to service_role;

comment on function public.devryan_bot_schema_version() is
  'Fail-closed compatibility marker for the Production Bots server runtime.';
