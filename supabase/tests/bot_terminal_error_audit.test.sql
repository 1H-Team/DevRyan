begin;

set local role postgres;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

select has_trigger(
  'public',
  'bot_runs',
  'bot_runs_terminal_audit',
  'terminal Bot runs append audit diagnostics'
);
select has_index(
  'public',
  'bot_audit_events',
  'bot_audit_events_issues_time_idx',
  'issues-first Bot audit queries have a partial time index'
);
select is(
  public.devryan_bot_schema_version(),
  '20260901160000'::text,
  'the Bot schema marker includes terminal settlement and audit repair'
);

insert into auth.users (id, email)
values ('a1000000-0000-4000-8000-000000000001', 'bot-audit@example.com');

insert into public.user_profiles (id, email, display_name, role)
values (
  'a1000000-0000-4000-8000-000000000001',
  'bot-audit@example.com',
  'Bot Audit Tester',
  'admin'
);

insert into public.bots (id, name, title, tenancy, created_by)
values (
  'b1000000-0000-4000-8000-000000000001',
  'Audit Bot',
  'Audit Bot',
  'team',
  'a1000000-0000-4000-8000-000000000001'
);

insert into public.bot_revisions (
  id, bot_id, revision_number, contract, compiled_hash, created_by
) values (
  'c1000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001',
  1,
  '{}'::jsonb,
  repeat('a', 64),
  'a1000000-0000-4000-8000-000000000001'
);

insert into public.bot_memberships (bot_id, user_id, role, assigned_by)
values (
  'b1000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000001',
  'manager',
  'a1000000-0000-4000-8000-000000000001'
);

insert into public.bot_channels (id, bot_id, owner_user_id)
values (
  'd1000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000001'
);

insert into public.bot_runs (
  id, bot_id, channel_id, revision_id, idempotency_key, model_snapshot,
  context_snapshot, computer_scope_key, agent_adapter, agent_thread_id
) values (
  'e1000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'bot-terminal-audit-test',
  '{}'::jsonb,
  '{"failurePhase":"dispatch","retryable":true,"retryCount":0}'::jsonb,
  'audit-test-scope',
  'opencode',
  'audit-thread-1'
);

insert into public.bot_messages (
  id, channel_id, run_id, actor_user_id, role, sequence, body_envelope
) values (
  'f1000000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000001',
  'e1000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000001',
  'user',
  1,
  '{}'::jsonb
);

update public.bot_runs
set state = 'failed', interruption_kind = 'bot_run_timeout', finished_at = now()
where id = 'e1000000-0000-4000-8000-000000000001';

select is(
  (select count(*)::integer from public.bot_audit_events
   where target_type = 'bot_run' and target_id = 'e1000000-0000-4000-8000-000000000001'),
  1,
  'a failed transition appends one audit row'
);
select results_eq(
  $$select result, action, actor_user_id, metadata ->> 'code'
    from public.bot_audit_events
    where target_id = 'e1000000-0000-4000-8000-000000000001'
    order by id$$,
  $$values (
    'failure'::text,
    'bot.run.failed'::text,
    'a1000000-0000-4000-8000-000000000001'::uuid,
    'bot_run_timeout'::text
  )$$,
  'failed diagnostics retain the originating actor and safe code'
);
select ok(
  not ((select metadata from public.bot_audit_events
        where target_id = 'e1000000-0000-4000-8000-000000000001'
        order by id limit 1) ?| array[
    'prompt', 'transcript', 'output', 'credential', 'secret', 'cookie', 'screenshot', 'hostPath'
  ]),
  'terminal metadata contains no content-bearing keys'
);

update public.bot_runs
set updated_at = now()
where id = 'e1000000-0000-4000-8000-000000000001';
select is(
  (select count(*)::integer from public.bot_audit_events
   where target_id = 'e1000000-0000-4000-8000-000000000001'),
  1,
  'a no-op terminal-state write appends nothing'
);

update public.bot_runs
set state = 'queued', interruption_kind = null, finished_at = null
where id = 'e1000000-0000-4000-8000-000000000001';
update public.bot_runs
set state = 'failed', interruption_kind = 'bot_action_denied', finished_at = now()
where id = 'e1000000-0000-4000-8000-000000000001';
select is(
  (select count(*)::integer from public.bot_audit_events
   where target_id = 'e1000000-0000-4000-8000-000000000001'),
  2,
  'a later failed retry appends a distinct audit event'
);
select is(
  (select result from public.bot_audit_events
   where target_id = 'e1000000-0000-4000-8000-000000000001'
   order by id desc limit 1),
  'denied',
  'action denial is classified as denied'
);

update public.bot_runs
set state = 'queued', interruption_kind = null, finished_at = null
where id = 'e1000000-0000-4000-8000-000000000001';
update public.bot_runs
set state = 'interrupted', interruption_kind = 'runtime_loss_after_write', finished_at = now()
where id = 'e1000000-0000-4000-8000-000000000001';
select is(
  (select result from public.bot_audit_events
   where target_id = 'e1000000-0000-4000-8000-000000000001'
   order by id desc limit 1),
  'unknown',
  'ordinary interruption is classified as unknown'
);

update public.bot_runs
set state = 'queued', interruption_kind = null, finished_at = null
where id = 'e1000000-0000-4000-8000-000000000001';
update public.bot_runs
set state = 'failed', interruption_kind = 'bot_approval_expired', finished_at = now()
where id = 'e1000000-0000-4000-8000-000000000001';
select is(
  (select result from public.bot_audit_events
   where target_id = 'e1000000-0000-4000-8000-000000000001'
   order by id desc limit 1),
  'denied',
  'approval expiry is classified as denied'
);

update public.bot_runs
set state = 'queued', interruption_kind = null, finished_at = null
where id = 'e1000000-0000-4000-8000-000000000001';
update public.bot_runs set state = 'completed', finished_at = now()
where id = 'e1000000-0000-4000-8000-000000000001';
update public.bot_runs set state = 'queued', finished_at = null
where id = 'e1000000-0000-4000-8000-000000000001';
update public.bot_runs set state = 'cancelled', finished_at = now()
where id = 'e1000000-0000-4000-8000-000000000001';
select is(
  (select count(*)::integer from public.bot_audit_events
   where target_id = 'e1000000-0000-4000-8000-000000000001'),
  4,
  'completed and cancelled transitions append nothing'
);

select * from finish();
rollback;
