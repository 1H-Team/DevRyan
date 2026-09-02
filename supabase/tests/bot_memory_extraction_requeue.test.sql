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
select is((public.devryan_enqueue_bot_message_run(
  'f5000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000002',
  'e5000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000001',
  'd5000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001',
  'requeue-admission', '{}'::jsonb, '{}'::jsonb, 'requeue-fixture-scope',
  'a5000000-0000-4000-8000-000000000001', '{"ciphertext":"user"}'::jsonb,
  '{"ciphertext":"empty"}'::jsonb, 0, now(), '[]'::jsonb
)->>'created')::boolean, true, 'admission creates the run whose extraction is requeued');
select is((public.devryan_enqueue_bot_message_run(
  'f5000000-0000-4000-8000-000000000011', 'f5000000-0000-4000-8000-000000000012',
  'e5000000-0000-4000-8000-000000000011', 'b5000000-0000-4000-8000-000000000001',
  'd5000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001',
  'requeue-queued', '{}'::jsonb, '{}'::jsonb, 'requeue-fixture-scope',
  'a5000000-0000-4000-8000-000000000001', '{"ciphertext":"user"}'::jsonb,
  '{"ciphertext":"empty"}'::jsonb, 0, now(), '[]'::jsonb
)->>'created')::boolean, true, 'a second admission stays queued behind the first run');

update public.bot_runs set state = 'completed', finished_at = now()
where id = 'e5000000-0000-4000-8000-000000000001';
select is(
  (select state from public.bot_memory_extraction_jobs
   where run_id = 'e5000000-0000-4000-8000-000000000001'),
  'queued', 'completing the run enqueues its extraction job');

select is_empty(
  $$select run_id from public.devryan_requeue_bot_memory_extraction_job(
    'e5000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000001')$$,
  'a queued job is not touched by requeue');

update public.bot_memory_extraction_jobs
set state = 'leased', lease_owner = 'worker', lease_until = now() + interval '5 minutes',
    attempt_count = 1
where run_id = 'e5000000-0000-4000-8000-000000000001';
select is_empty(
  $$select run_id from public.devryan_requeue_bot_memory_extraction_job(
    'e5000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000001')$$,
  'a leased job is never interrupted by requeue');

update public.bot_memory_extraction_jobs
set state = 'succeeded', lease_owner = null, lease_until = null, completed_at = now()
where run_id = 'e5000000-0000-4000-8000-000000000001';
select is_empty(
  $$select run_id from public.devryan_requeue_bot_memory_extraction_job(
    'e5000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000001')$$,
  'a succeeded extraction is never repeated by requeue');

update public.bot_memory_extraction_jobs
set state = 'terminal', attempt_count = 4, completed_at = now(),
    last_phase = 'summary_commit', last_error_code = 'bot_summary_checkpoint_conflict',
    next_attempt_at = now() + interval '1 hour'
where run_id = 'e5000000-0000-4000-8000-000000000001';
select results_eq(
  $$select state, attempt_count, last_phase, last_error_code, completed_at::text,
      lease_owner, (next_attempt_at <= now())
    from public.devryan_requeue_bot_memory_extraction_job(
      'e5000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000001')$$,
  $$values ('queued'::text, 0, null::text, null::text, null::text, null::text, true)$$,
  'a terminal job is requeued as fresh, immediately due work');
select is(
  (select state from public.bot_memory_extraction_jobs
   where run_id = 'e5000000-0000-4000-8000-000000000001'),
  'queued', 'the requeued job is durable');
select is(
  (select count(*)::integer from public.devryan_claim_bot_memory_extraction_job(
    'requeue-worker', now() + interval '5 minutes')),
  0, 'the requeued job still waits while its channel has a queued run');

update public.bot_runs set state = 'completed', finished_at = now()
where id = 'e5000000-0000-4000-8000-000000000011';
delete from public.bot_memory_extraction_jobs
where run_id = 'e5000000-0000-4000-8000-000000000011';
select results_eq(
  $$select state, attempt_count, channel_id::text, revision_id::text
    from public.devryan_requeue_bot_memory_extraction_job(
      'e5000000-0000-4000-8000-000000000011', 'b5000000-0000-4000-8000-000000000001')$$,
  $$values ('queued'::text, 0, 'd5000000-0000-4000-8000-000000000001',
    'c5000000-0000-4000-8000-000000000001')$$,
  'a completed run without a job row gets a fresh queued job');

select throws_ok(
  $$select * from public.devryan_requeue_bot_memory_extraction_job(
    'e5000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000002')$$,
  'P0002', null, 'requeue is scoped to the owning Bot');
select throws_ok(
  $$select * from public.devryan_requeue_bot_memory_extraction_job(
    'e5000000-0000-4000-8000-0000000000ff', 'b5000000-0000-4000-8000-000000000001')$$,
  'P0002', null, 'requeue rejects an unknown run');

set local role postgres;
update public.bot_runs set state = 'failed', finished_at = now(),
  context_snapshot = '{"failurePhase":"execution","retryable":false}'::jsonb
where id = 'e5000000-0000-4000-8000-000000000011';
set local role service_role;
select throws_ok(
  $$select * from public.devryan_requeue_bot_memory_extraction_job(
    'e5000000-0000-4000-8000-000000000011', 'b5000000-0000-4000-8000-000000000001')$$,
  '23514', null, 'only completed runs can have their extraction requeued');

select ok(has_function_privilege('service_role',
  'public.devryan_requeue_bot_memory_extraction_job(uuid,uuid)', 'execute'),
  'the service role can requeue extraction');
select ok(not has_function_privilege('authenticated',
  'public.devryan_requeue_bot_memory_extraction_job(uuid,uuid)', 'execute'),
  'authenticated clients cannot requeue extraction directly');
select ok(not has_function_privilege('anon',
  'public.devryan_requeue_bot_memory_extraction_job(uuid,uuid)', 'execute'),
  'anonymous clients cannot requeue extraction');
select is(public.devryan_bot_schema_version(), '20260902120000',
  'the schema marker includes the latest Bot audit and retry migration');

select * from finish();
rollback;
