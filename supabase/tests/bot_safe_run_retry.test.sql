begin;

set local role postgres;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into auth.users (id, email)
values ('a3000000-0000-4000-8000-000000000001', 'bot-retry@example.com');
insert into public.user_profiles (id, email, display_name, role)
values ('a3000000-0000-4000-8000-000000000001', 'bot-retry@example.com', 'Control Tester', 'admin');
insert into public.bots (id, name, title, tenancy, created_by)
values ('b3000000-0000-4000-8000-000000000001', 'Control Bot', 'Control Bot', 'team',
  'a3000000-0000-4000-8000-000000000001');
insert into public.bot_revisions (id, bot_id, revision_number, contract, compiled_hash, created_by)
values ('c3000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001',
  1, '{}'::jsonb, repeat('a', 64), 'a3000000-0000-4000-8000-000000000001');
insert into public.bot_memberships (bot_id, user_id, role, assigned_by)
values ('b3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001',
  'manager', 'a3000000-0000-4000-8000-000000000001');
insert into public.bot_channels (id, bot_id, owner_user_id)
values ('d3000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000001');
insert into auth.users (id, email) values
 ('a3000000-0000-4000-8000-000000000002', 'bot-retry-manager@example.com');
insert into public.user_profiles (id, email, display_name, role) values
 ('a3000000-0000-4000-8000-000000000002', 'bot-retry-manager@example.com', 'Other Manager', 'admin');
insert into public.bot_memberships (bot_id, user_id, role, assigned_by) values
 ('b3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000002',
  'manager', 'a3000000-0000-4000-8000-000000000001');
update public.bot_revisions set activated_at = now()
 where id = 'c3000000-0000-4000-8000-000000000001';
update public.bots set active_revision_id = 'c3000000-0000-4000-8000-000000000001', lifecycle = 'active'
where id = 'b3000000-0000-4000-8000-000000000001';
set local role service_role;
select is((public.devryan_enqueue_bot_message_run(
  'f3000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000002',
  'e3000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001',
  'd3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001',
  'retry-admission', '{}'::jsonb, '{}'::jsonb, 'retry-fixture-scope',
  'a3000000-0000-4000-8000-000000000001', '{"ciphertext":"user"}'::jsonb,
  '{"ciphertext":"empty"}'::jsonb, 0, now(), '[]'::jsonb
)->>'created')::boolean, true, 'real admission creates user, run and pending response atomically');
update public.bot_runs set state = 'failed', finished_at = now(),
  context_snapshot = '{"failurePhase":"startup","retryable":true}'::jsonb
where id = 'e3000000-0000-4000-8000-000000000001';
select is((public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000001', now())->'run'->>'id'),
  'e3000000-0000-4000-8000-000000000001', 'startup retry retains run ID');
select is((select count(*)::integer from public.bot_messages where run_id =
  'e3000000-0000-4000-8000-000000000001'), 2, 'retry adds no messages');
select results_eq($$select id::text, assistant_phase, finalized_at::text from public.bot_messages
 where role = 'assistant' and run_id = 'e3000000-0000-4000-8000-000000000001'$$,
 $$values ('f3000000-0000-4000-8000-000000000002', 'pending', null::text)$$,
 'retry preserves original unresolved placeholder');
select is(public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000001',
 'a3000000-0000-4000-8000-000000000001', now())->>'reason', 'not_retryable',
 'a second racing retry cannot requeue an already queued run');
update public.bot_runs set state = 'failed', finished_at = now(),
  context_snapshot = '{"failurePhase":"startup","retryable":true}'::jsonb
where id = 'e3000000-0000-4000-8000-000000000001';
savepoint retry_case;
update public.bot_runs set agent_thread_id = 'thread' where id = 'e3000000-0000-4000-8000-000000000001';
select public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', now())->>'reason' as retry_reason \gset
rollback to retry_case;
select is(:'retry_reason'::text, 'execution_started', 'agent_thread_id prevents replay');
savepoint retry_case;
update public.bot_runs set agent_execution = '{"threadId":"thread"}'::jsonb where id = 'e3000000-0000-4000-8000-000000000001';
select public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', now())->>'reason' as retry_reason \gset
rollback to retry_case;
select is(:'retry_reason'::text, 'execution_started', 'agent_execution prevents replay');
savepoint retry_case;
update public.bot_runs set agent_execution = '{"segmentId":"segment"}'::jsonb where id = 'e3000000-0000-4000-8000-000000000001';
select public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', now())->>'reason' as retry_reason \gset
rollback to retry_case;
select is(:'retry_reason'::text, 'execution_started', 'agent_execution prevents replay');
savepoint retry_case;
update public.bot_runs set opencode_session_id = 'ses_1' where id = 'e3000000-0000-4000-8000-000000000001';
select public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', now())->>'reason' as retry_reason \gset
rollback to retry_case;
select is(:'retry_reason'::text, 'execution_started', 'opencode_session_id prevents replay');
savepoint retry_case;
update public.bot_runs set opencode_segment_id = 'segment' where id = 'e3000000-0000-4000-8000-000000000001';
select public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', now())->>'reason' as retry_reason \gset
rollback to retry_case;
select is(:'retry_reason'::text, 'execution_started', 'opencode_segment_id prevents replay');
savepoint retry_case;
update public.bot_messages set assistant_phase = 'acknowledgment' where run_id = 'e3000000-0000-4000-8000-000000000001' and role = 'assistant';
select public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', now())->>'reason' as retry_reason \gset
rollback to retry_case;
select is(:'retry_reason'::text, 'execution_started', 'acknowledgment prevents replay');
savepoint retry_case;
update public.bot_messages set assistant_phase = 'result' where run_id = 'e3000000-0000-4000-8000-000000000001' and role = 'assistant';
select public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', now())->>'reason' as retry_reason \gset
rollback to retry_case;
select is(:'retry_reason'::text, 'execution_started', 'result prevents replay');
savepoint retry_case;
update public.bot_messages set finalized_at = now() where run_id = 'e3000000-0000-4000-8000-000000000001' and role = 'assistant';
select public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', now())->>'reason' as retry_reason \gset
rollback to retry_case;
select is(:'retry_reason'::text, 'execution_started', 'finalized pending prevents replay');
savepoint retry_case;
update public.bot_messages set attachment_count = 1 where run_id = 'e3000000-0000-4000-8000-000000000001' and role = 'assistant';
select public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', now())->>'reason' as retry_reason \gset
rollback to retry_case;
select is(:'retry_reason'::text, 'execution_started', 'pending attachment prevents replay');
savepoint retry_case;
update public.bot_runs set agent_thread_id = 'partial-thread' where id = 'e3000000-0000-4000-8000-000000000001'; update public.bot_messages set body_envelope = '{"ciphertext":"partial"}' where run_id = 'e3000000-0000-4000-8000-000000000001' and role = 'assistant';
select public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', now())->>'reason' as retry_reason \gset
rollback to retry_case;
select is(:'retry_reason'::text, 'execution_started', 'partial output in a still pending response prevents replay');
savepoint retry_case;
update public.bot_memberships set revoked_at = now() where user_id = 'a3000000-0000-4000-8000-000000000001';
select public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', now())->>'reason' as retry_reason \gset
rollback to retry_case;
select is(:'retry_reason'::text, 'access_revoked', 'revoked membership prevents replay');
savepoint retry_case;
update public.user_profiles set status = 'suspended' where id = 'a3000000-0000-4000-8000-000000000001';
select public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', now())->>'reason' as retry_reason \gset
rollback to retry_case;
select is(:'retry_reason'::text, 'access_revoked', 'disabled user prevents replay');
savepoint retry_case;
update public.bot_revisions set retired_at = now() where id = 'c3000000-0000-4000-8000-000000000001';
select public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', now())->>'reason' as retry_reason \gset
rollback to retry_case;
select is(:'retry_reason'::text, 'revision_changed', 'retired pinned revision prevents replay');
savepoint retry_case;
update public.bot_channels set lifecycle = 'archived', archived_at = now() where id = 'd3000000-0000-4000-8000-000000000001';
select public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', now())->>'reason' as retry_reason \gset
rollback to retry_case;
select is(:'retry_reason'::text, 'channel_unavailable', 'archived channel prevents replay');
savepoint retry_case;
update public.bot_runs set context_snapshot = '{"failurePhase":"execution","retryable":true}' where id = 'e3000000-0000-4000-8000-000000000001';
select public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', now())->>'ok' as retry_ok \gset
rollback to retry_case;
select is(:'retry_ok'::boolean, true, 'an execution failure with no visible output can be replayed');
savepoint retry_case;
update public.bot_runs set context_snapshot = '{"failurePhase":"execution","retryable":true}',
  agent_adapter = 'opencode', agent_thread_id = 'thread', opencode_session_id = 'ses_1', opencode_segment_id = 'segment',
  agent_execution = '{"threadId":"thread","segmentId":"segment"}'::jsonb
  where id = 'e3000000-0000-4000-8000-000000000001';
select r->>'ok' as retry_ok, r->'run'->>'state' as retry_state, r->'run'->>'agent_thread_id' as retry_thread,
  r->'run'->>'opencode_session_id' as retry_session, r->'run'->>'opencode_segment_id' as retry_segment,
  r->'run'->'agent_execution' as retry_execution, r->'run'->'context_snapshot'->>'retryCount' as retry_count
  from public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', now()) as r \gset
rollback to retry_case;
select is(:'retry_ok'::boolean, true, 'a dead execution identity alone no longer blocks an evidence-cleared replay');
select is(:'retry_state'::text, 'queued', 'the evidence-cleared replay requeues the same run');
select is(:'retry_thread'::text, null::text, 'the stale agent thread is cleared for a fresh execution');
select is(:'retry_session'::text, null::text, 'the stale session identity is cleared for a fresh execution');
select is(:'retry_segment'::text, null::text, 'the stale segment identity is cleared for a fresh execution');
select is(:'retry_execution'::text, null::text, 'the stale generic execution is cleared for a fresh execution');
select is(:'retry_count'::text, '1', 'the replay records its retry count');
savepoint retry_case;
update public.bot_runs set context_snapshot = '{"failurePhase":"execution","retryable":true}', agent_thread_id = 'thread' where id = 'e3000000-0000-4000-8000-000000000001';
update public.bot_messages set assistant_phase = 'acknowledgment' where run_id = 'e3000000-0000-4000-8000-000000000001' and role = 'assistant';
select public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', now())->>'reason' as retry_reason \gset
rollback to retry_case;
select is(:'retry_reason'::text, 'execution_started', 'a visible acknowledgment still prevents an execution-phase replay');
savepoint retry_case;
update public.bot_runs set context_snapshot = '{"failurePhase":"execution","retryable":true}', agent_thread_id = 'thread' where id = 'e3000000-0000-4000-8000-000000000001';
insert into public.bot_action_attempts (id, run_id, bot_id, revision_id, computer_scope_key,
 action_hash, idempotency_key, tool, action, target, encrypted_args, args_digest, risk,
 approval_class, policy_effect, decision_expires_at, state, initiated_by, started_at)
 select 'f3000000-0000-4000-8000-000000000004', id, bot_id, revision_id, computer_scope_key,
 'sha256:' || repeat('c',64), 'execution-action', 'browser', 'navigate', '{}'::jsonb, '{}'::jsonb,
 repeat('d',64), 'sensitive', 'none', 'allow', now() + interval '5 minutes', 'cancelled',
 'a3000000-0000-4000-8000-000000000001', now() from public.bot_runs where id = 'e3000000-0000-4000-8000-000000000001';
select public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', now())->>'reason' as retry_reason \gset
rollback to retry_case;
select is(:'retry_reason'::text, 'execution_started', 'a governed action still prevents an execution-phase replay');
savepoint retry_case;
update public.bot_runs set context_snapshot = '{"failurePhase":"execution","retryable":false}', agent_thread_id = 'thread' where id = 'e3000000-0000-4000-8000-000000000001';
select public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', now())->>'reason' as retry_reason \gset
rollback to retry_case;
select is(:'retry_reason'::text, 'not_retryable', 'the dispatcher verdict is required for an execution-phase replay');
savepoint retry_case;
update public.bot_runs set context_snapshot = '{"failurePhase":"completion","retryable":true}' where id = 'e3000000-0000-4000-8000-000000000001';
select public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', now())->>'reason' as retry_reason \gset
rollback to retry_case;
select is(:'retry_reason'::text, 'not_retryable', 'only startup and execution failures can be replayed');
savepoint retry_case;
insert into public.bot_runs (id, bot_id, channel_id, revision_id, idempotency_key,
 model_snapshot, context_snapshot, computer_scope_key, state) select
 'e3000000-0000-4000-8000-000000000002', bot_id, channel_id, revision_id, 'concurrent',
 '{}'::jsonb, '{}'::jsonb, computer_scope_key, 'waiting_control' from public.bot_runs where id = 'e3000000-0000-4000-8000-000000000001';
select public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', now())->>'reason' as retry_reason \gset
rollback to retry_case;
select is(:'retry_reason'::text, 'concurrent_active_run', 'waiting control holds the scope against retry');
savepoint retry_case;
insert into public.bot_action_attempts (id, run_id, bot_id, revision_id, computer_scope_key,
 action_hash, idempotency_key, tool, action, target, encrypted_args, args_digest, risk,
 approval_class, policy_effect, decision_expires_at, state, initiated_by, started_at)
 select 'f3000000-0000-4000-8000-000000000003', id, bot_id, revision_id, computer_scope_key,
 'sha256:' || repeat('a',64), 'action', 'browser', 'navigate', '{}'::jsonb, '{}'::jsonb,
 repeat('b',64), 'sensitive', 'none', 'allow', now() + interval '5 minutes', 'cancelled',
 'a3000000-0000-4000-8000-000000000001', now() from public.bot_runs where id = 'e3000000-0000-4000-8000-000000000001';
select public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', now())->>'reason' as retry_reason \gset
rollback to retry_case;
select is(:'retry_reason'::text, 'execution_started', 'even a cancelled action attempt prevents replay');
savepoint retry_case;
update public.bot_runs set agent_execution = '{"invocationId":"invoke"}' where id = 'e3000000-0000-4000-8000-000000000001';
select public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', now())->>'reason' as retry_reason \gset
rollback to retry_case;
select is(:'retry_reason'::text, 'execution_started', 'generic invocation ID prevents replay');
savepoint retry_case;
insert into public.bot_revisions (id, bot_id, revision_number, contract, compiled_hash, created_by, activated_at)
values ('c3000000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-000000000001', 2, '{}'::jsonb, repeat('b',64), 'a3000000-0000-4000-8000-000000000001', now()); update public.bots set active_revision_id = 'c3000000-0000-4000-8000-000000000002' where id = 'b3000000-0000-4000-8000-000000000001';
select public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', now())->>'reason' as retry_reason \gset
rollback to retry_case;
select is(:'retry_reason'::text, 'revision_changed', 'changed active revision prevents replay even if pinned revision is not retired');
savepoint retry_case;
update public.bot_channels set owner_user_id = 'a3000000-0000-4000-8000-000000000002' where id = 'd3000000-0000-4000-8000-000000000001';
insert into public.bot_channel_acl (channel_id, user_id, role, invited_by, revoked_at)
values ('d3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'collaborator', 'a3000000-0000-4000-8000-000000000001', now());
select public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', now())->>'reason' as retry_reason \gset
rollback to retry_case;
select is(:'retry_reason'::text, 'access_revoked', 'revoked collaborator access prevents replay');
savepoint retry_attachment;
insert into public.bot_objects (id, bot_id, channel_id, visibility, storage_object_name,
 object_key_envelope, ciphertext_hash, ciphertext_size, wrapped_key, content_type, created_by,
 created_at, expires_at) values ('93000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'private', 'tests/retry/attachment', '{}'::jsonb, repeat('c',64), 16,
 '{}'::jsonb, 'text/plain', 'a3000000-0000-4000-8000-000000000001', now() - interval '1 hour', now() + interval '1 hour');
select public.devryan_enqueue_bot_message_run(
 'f3000000-0000-4000-8000-000000000011', 'f3000000-0000-4000-8000-000000000012',
 'e3000000-0000-4000-8000-000000000011', 'b3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001',
 'c3000000-0000-4000-8000-000000000001', 'retry-with-attachment', '{}'::jsonb, '{}'::jsonb,
 'retry-attachment-scope', 'a3000000-0000-4000-8000-000000000001', '{}'::jsonb, '{}'::jsonb, 1, now(),
 '[{"id":"93000000-0000-4000-8000-000000000002","objectId":"93000000-0000-4000-8000-000000000001",
 "filename":"file.txt","computerPath":"/workspace/Shared/d3000000-0000-4000-8000-000000000001/f3000000-0000-4000-8000-000000000011/file.txt"}]'::jsonb
) as attachment_admitted \gset
update public.bot_runs set state = 'failed', finished_at = now(),
 context_snapshot = '{"failurePhase":"startup","retryable":true}'
where id = 'e3000000-0000-4000-8000-000000000011';
select public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000011', 'a3000000-0000-4000-8000-000000000001', now())->>'ok' as attachment_retried \gset
update public.bot_runs set state = 'failed', finished_at = now(),
 context_snapshot = '{"failurePhase":"startup","retryable":true}'
where id = 'e3000000-0000-4000-8000-000000000011';
update public.bot_objects set expires_at = now() - interval '1 minute'
where id = '93000000-0000-4000-8000-000000000001';
select public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000011', 'a3000000-0000-4000-8000-000000000001', now())->>'reason' as attachment_refused \gset
delete from public.bot_shared_files where object_id = '93000000-0000-4000-8000-000000000001';
select public.devryan_retry_bot_run('e3000000-0000-4000-8000-000000000011', 'a3000000-0000-4000-8000-000000000001', now())->>'reason' as attachment_missing \gset
rollback to retry_attachment;
select is(:'attachment_retried'::boolean, true, 'valid original attachments remain retryable');
select is(:'attachment_refused'::text, 'attachments_expired', 'expired original attachments are rejected');
select is(:'attachment_missing'::text, 'attachments_expired', 'missing original attachment mapping prevents replay');
select * from finish();
rollback;
