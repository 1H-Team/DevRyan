begin;

set local role postgres;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into auth.users (id, email)
values ('a5000000-0000-4000-8000-000000000001', 'bot-requeue@example.com');
insert into public.user_profiles (id, email, display_name, role)
values ('a5000000-0000-4000-8000-000000000001', 'bot-requeue@example.com', 'Requeue Tester', 'admin');
insert into public.bots (id, name, title, tenancy, created_by)
values ('b5000000-0000-4000-8000-000000000001', 'Requeue Bot', 'Requeue Bot', 'team',
  'a5000000-0000-4000-8000-000000000001');
insert into public.bots (id, name, title, tenancy, created_by)
values ('b5000000-0000-4000-8000-000000000002', 'Other Bot', 'Other Bot', 'team',
  'a5000000-0000-4000-8000-000000000001');
insert into public.bot_revisions (id, bot_id, revision_number, contract, compiled_hash, created_by)
values ('c5000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000001',
  1, '{}'::jsonb, repeat('a', 64), 'a5000000-0000-4000-8000-000000000001');
insert into public.bot_memberships (bot_id, user_id, role, assigned_by)
values ('b5000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001',
  'manager', 'a5000000-0000-4000-8000-000000000001');
insert into public.bot_channels (id, bot_id, owner_user_id)
values ('d5000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000001',
  'a5000000-0000-4000-8000-000000000001');
update public.bot_revisions set activated_at = now()
 where id = 'c5000000-0000-4000-8000-000000000001';
update public.bots set active_revision_id = 'c5000000-0000-4000-8000-000000000001', lifecycle = 'active'
where id = 'b5000000-0000-4000-8000-000000000001';

set local role service_role;
do $$
begin
  for i in 1..235 loop
    perform public.devryan_enqueue_bot_message_run(
      md5('recovery-user-' || i)::uuid, md5('recovery-assistant-' || i)::uuid,
      md5('recovery-run-' || i)::uuid, 'b5000000-0000-4000-8000-000000000001',
      'd5000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001',
      'recovery-admission-' || i, '{}'::jsonb, '{}'::jsonb, 'recovery-fixture-scope',
      'a5000000-0000-4000-8000-000000000001', '{"ciphertext":"user"}'::jsonb,
      '{"ciphertext":"empty"}'::jsonb, 0, now(), '[]'::jsonb);
  end loop;
end;
$$;
update public.bot_runs set state = 'completed', finished_at = now()
where bot_id = 'b5000000-0000-4000-8000-000000000001';
update public.bot_memory_extraction_jobs set state = 'terminal',
  last_error_code = 'bot_opencode_request_invalid', completed_at = now(), attempt_count = 3
where run_id in (select md5('recovery-run-' || i)::uuid from generate_series(1,110) i);
update public.bot_memory_extraction_jobs set state = 'succeeded', completed_at = now(),
  candidate_envelope = '{"ciphertext":"legacy-rejected"}'::jsonb, candidate_persisted_at = now()
where run_id in (select md5('recovery-run-' || i)::uuid from generate_series(111,120) i);

select is((public.devryan_bot_memory_extraction_summary('b5000000-0000-4000-8000-000000000001')->>'failed')::integer,
  110, 'aggregate failures are not capped at 100');
select is((public.devryan_bot_memory_extraction_summary('b5000000-0000-4000-8000-000000000001')->>'pending')::integer,
  115, 'aggregate pending jobs are not capped at 100');
select is(jsonb_array_length(public.devryan_bot_memory_extraction_summary('b5000000-0000-4000-8000-000000000001')->'recent'),
  20, 'preview remains independently bounded');

select is((select count(*)::integer from public.bot_memory_extraction_jobs job
  cross join lateral public.devryan_recover_bot_memory_extraction_job(job.run_id, job.updated_at, 2, 'requeue') recovered
  where job.state = 'terminal'), 110, 'all eligible historical failures recover');
select is((select count(*)::integer from public.bot_memory_extraction_jobs job
  cross join lateral public.devryan_recover_bot_memory_extraction_job(job.run_id, job.updated_at, 2, 'requeue') recovered
  where job.recovery_version = 2), 0, 'concurrent or repeated recovery cannot reset versioned jobs');
select is((select count(*)::integer from public.bot_memory_extraction_jobs job
  cross join lateral public.devryan_recover_bot_memory_extraction_job(job.run_id, job.updated_at, 2, 'reextract') recovered
  where job.state = 'succeeded'), 10, 'legacy rejected-only envelopes may be reset once');
select is((select count(*)::integer from public.bot_memory_extraction_jobs where candidate_envelope is not null),
  0, 're-extraction clears the old rejected-only envelope');
select is((public.devryan_bot_memory_extraction_summary('b5000000-0000-4000-8000-000000000001')->>'recovering')::integer,
  120, 'summary distinguishes jobs undergoing automatic recovery');

create temporary table recovery_claim as select * from public.devryan_claim_bot_memory_extraction_job('worker-a', now() + interval '5 minutes');
select is((select count(*)::integer from recovery_claim), 1, 'recovered jobs use normal leases');
select is((select count(*)::integer from public.devryan_claim_bot_memory_extraction_job('worker-b', now() + interval '5 minutes')),
  0, 'a concurrent worker cannot acquire the same Bot scope');
select throws_ok($$select public.devryan_settle_bot_memory_extraction_job_v2(
  (select run_id from recovery_claim), 'worker-b', 'succeeded', null, 'complete', null, 2, '{}')$$,
  '40001', null, 'settlement preserves lease ownership');
select throws_ok($$select public.devryan_settle_bot_memory_extraction_job_v2(
  (select run_id from recovery_claim), 'worker-a', 'succeeded', null, 'complete', null, 2,
  '{"rejectionReasons":{"private text":1}}')$$,
  '22023', null, 'diagnostics reject arbitrary rejection text');
select is((select defer_count from public.devryan_settle_bot_memory_extraction_job_v2(
  (select run_id from recovery_claim), 'worker-a', 'defer', now() + interval '1 minute', 'admission',
  'bot_runtime_scope_busy', 2, '{}')), 1, 'busy deferrals are persisted separately');
select is((select attempt_count from public.bot_memory_extraction_jobs where run_id = (select run_id from recovery_claim)),
  0, 'busy deferrals do not consume extraction attempts');
select public.devryan_wake_bot_memory_extraction_jobs('d5000000-0000-4000-8000-000000000001');
select ok((select next_attempt_at <= now() from public.bot_memory_extraction_jobs where run_id = (select run_id from recovery_claim)),
  'channel availability wakes admission deferrals');

select ok(not has_function_privilege('authenticated',
  'public.devryan_recover_bot_memory_extraction_job(uuid,timestamptz,integer,text)', 'execute'),
  'browser roles cannot invoke recovery');
select ok(not has_function_privilege('anon',
  'public.devryan_bot_memory_extraction_summary(uuid)', 'execute'), 'anonymous access to aggregate diagnostics is denied');
select is((select count(*)::integer from public.bot_runs where bot_id = 'b5000000-0000-4000-8000-000000000001'),
  235, 'recovery preserves original conversation runs');
select is(public.devryan_bot_schema_version(), '20260908182901', 'worker gate includes recovery migration');
select * from finish();
rollback;
