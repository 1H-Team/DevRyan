-- Guided editing starts from an immutable copy of the active revision. Equal
-- content is therefore valid at two revision numbers; revision identity and
-- optimistic concurrency come from (bot_id, revision_number) and updated_at,
-- not from content-hash deduplication.
alter table public.bot_revisions
  drop constraint if exists bot_revisions_bot_hash_key;

-- Advance the fail-closed runtime marker with the revision-history contract.
create or replace function public.devryan_bot_schema_version()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select '20260824040000'::text;
$$;

revoke all on function public.devryan_bot_schema_version()
  from public, anon, authenticated;
grant execute on function public.devryan_bot_schema_version()
  to service_role;

comment on function public.devryan_bot_schema_version() is
  'Fail-closed compatibility marker for the Production Bots server runtime.';
