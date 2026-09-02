-- Memory extraction can now run on the still-active reasoning runtime of the
-- run that just completed, instead of cold-starting a second container per
-- turn. The worker needs to claim that run's job specifically, honouring the
-- same one-leased-job-per-bot rule as the queue claim, without stealing a job
-- another worker already holds.

create or replace function public.devryan_claim_bot_memory_extraction_job_by_run(
  p_run_id uuid,
  p_lease_owner text,
  p_lease_until timestamptz
)
returns setof public.bot_memory_extraction_jobs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  claimed_run_id uuid;
begin
  if p_run_id is null then
    raise exception using errcode = '22023', message = 'Memory extraction run is required';
  end if;
  if char_length(btrim(coalesce(p_lease_owner, ''))) = 0 then
    raise exception using errcode = '22023', message = 'Memory extraction lease owner is required';
  end if;
  if p_lease_until is null or p_lease_until <= pg_catalog.now() then
    raise exception using errcode = '22023', message = 'Memory extraction lease expiry must be in the future';
  end if;

  select candidate.run_id into claimed_run_id
  from public.bot_memory_extraction_jobs candidate
  where candidate.run_id = p_run_id
    and candidate.state = 'queued'
    and candidate.candidate_envelope is null
    and not exists (
      select 1
      from public.bot_memory_extraction_jobs active
      where active.bot_id = candidate.bot_id and active.state = 'leased'
    )
  for update skip locked
  limit 1;

  if claimed_run_id is null then return; end if;

  return query
  update public.bot_memory_extraction_jobs
  set state = 'leased',
      attempt_count = attempt_count + 1,
      lease_owner = p_lease_owner,
      lease_until = p_lease_until,
      updated_at = pg_catalog.now()
  where run_id = claimed_run_id
  returning *;
end;
$$;

revoke all on function public.devryan_claim_bot_memory_extraction_job_by_run(uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.devryan_claim_bot_memory_extraction_job_by_run(uuid, text, timestamptz)
  to service_role;

create or replace function public.devryan_bot_schema_version()
returns text language sql stable security invoker set search_path = ''
as $$ select '20260903110000'::text; $$;
revoke all on function public.devryan_bot_schema_version() from public, anon, authenticated;
grant execute on function public.devryan_bot_schema_version() to service_role;
