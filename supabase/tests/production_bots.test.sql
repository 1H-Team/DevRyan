begin;

set local role postgres;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

-- Every declared control-plane relation exists and is service-only with forced
-- RLS. Dynamic assertions keep this inventory coupled to the migration list.
with bot_relations(name) as (
  values
    ('bots'),
    ('bot_revisions'),
    ('bot_memberships'),
    ('bot_channels'),
    ('bot_channel_acl'),
    ('bot_messages'),
    ('bot_objects'),
    ('bot_runs'),
    ('bot_action_attempts'),
    ('bot_approvals'),
    ('bot_credentials'),
    ('bot_routines'),
    ('bot_routine_occurrences'),
    ('bot_memories'),
    ('bot_memory_versions'),
    ('bot_memory_sources'),
    ('bot_memory_extraction_jobs'),
    ('bot_library_sources'),
    ('bot_library_versions'),
    ('bot_audit_events'),
    ('bot_eval_cases'),
    ('bot_eval_runs'),
    ('bot_shared_files'),
    ('bot_environment_secrets')
)
select has_table('public', name, format('%s exists', name))
from bot_relations
order by name;

with bot_relations(name) as (
  values
    ('bots'), ('bot_revisions'), ('bot_memberships'), ('bot_channels'),
    ('bot_channel_acl'), ('bot_messages'), ('bot_objects'), ('bot_runs'),
    ('bot_action_attempts'), ('bot_approvals'), ('bot_credentials'), ('bot_routines'),
    ('bot_routine_occurrences'), ('bot_memories'), ('bot_memory_versions'),
    ('bot_memory_sources'), ('bot_memory_extraction_jobs'), ('bot_library_sources'), ('bot_library_versions'),
    ('bot_audit_events'), ('bot_eval_cases'), ('bot_eval_runs'),
    ('bot_shared_files'), ('bot_environment_secrets')
)
select ok(class.relrowsecurity, format('%s has RLS enabled', relation.name))
from bot_relations relation
join pg_class class on class.oid = format('public.%I', relation.name)::regclass
order by relation.name;

with bot_relations(name) as (
  values
    ('bots'), ('bot_revisions'), ('bot_memberships'), ('bot_channels'),
    ('bot_channel_acl'), ('bot_messages'), ('bot_objects'), ('bot_runs'),
    ('bot_action_attempts'), ('bot_approvals'), ('bot_credentials'), ('bot_routines'),
    ('bot_routine_occurrences'), ('bot_memories'), ('bot_memory_versions'),
    ('bot_memory_sources'), ('bot_memory_extraction_jobs'), ('bot_library_sources'), ('bot_library_versions'),
    ('bot_audit_events'), ('bot_eval_cases'), ('bot_eval_runs'),
    ('bot_shared_files'), ('bot_environment_secrets')
)
select ok(class.relforcerowsecurity, format('%s has forced RLS', relation.name))
from bot_relations relation
join pg_class class on class.oid = format('public.%I', relation.name)::regclass
order by relation.name;

with bot_relations(name) as (
  values
    ('bots'), ('bot_revisions'), ('bot_memberships'), ('bot_channels'),
    ('bot_channel_acl'), ('bot_messages'), ('bot_objects'), ('bot_runs'),
    ('bot_action_attempts'), ('bot_approvals'), ('bot_credentials'), ('bot_routines'),
    ('bot_routine_occurrences'), ('bot_memories'), ('bot_memory_versions'),
    ('bot_memory_sources'), ('bot_memory_extraction_jobs'), ('bot_library_sources'), ('bot_library_versions'),
    ('bot_audit_events'), ('bot_eval_cases'), ('bot_eval_runs'),
    ('bot_shared_files'), ('bot_environment_secrets')
)
select ok(
  not has_table_privilege('anon', format('public.%I', name), 'select'),
  format('anon cannot select %s', name)
)
from bot_relations
order by name;

with bot_relations(name) as (
  values
    ('bots'), ('bot_revisions'), ('bot_memberships'), ('bot_channels'),
    ('bot_channel_acl'), ('bot_messages'), ('bot_objects'), ('bot_runs'),
    ('bot_action_attempts'), ('bot_approvals'), ('bot_credentials'), ('bot_routines'),
    ('bot_routine_occurrences'), ('bot_memories'), ('bot_memory_versions'),
    ('bot_memory_sources'), ('bot_memory_extraction_jobs'), ('bot_library_sources'), ('bot_library_versions'),
    ('bot_audit_events'), ('bot_eval_cases'), ('bot_eval_runs'),
    ('bot_shared_files'), ('bot_environment_secrets')
)
select ok(
  not has_table_privilege('authenticated', format('public.%I', name), 'select'),
  format('authenticated cannot select %s', name)
)
from bot_relations
order by name;

with bot_relations(name) as (
  values
    ('bots'), ('bot_revisions'), ('bot_memberships'), ('bot_channels'),
    ('bot_channel_acl'), ('bot_messages'), ('bot_objects'), ('bot_runs'),
    ('bot_action_attempts'), ('bot_approvals'), ('bot_credentials'), ('bot_routines'),
    ('bot_routine_occurrences'), ('bot_memories'), ('bot_memory_versions'),
    ('bot_memory_sources'), ('bot_memory_extraction_jobs'), ('bot_library_sources'), ('bot_library_versions'),
    ('bot_audit_events'), ('bot_eval_cases'), ('bot_eval_runs'),
    ('bot_shared_files'), ('bot_environment_secrets')
)
select ok(
  has_table_privilege('service_role', format('public.%I', name), 'select,insert,update,delete'),
  format('service_role owns the complete %s data contract', name)
)
from bot_relations
order by name;

select ok(
  not exists (
    select 1
    from pg_class class
    cross join lateral aclexplode(coalesce(class.relacl, acldefault('r', class.relowner))) acl
    where class.oid in (
      'public.bots'::regclass,
      'public.bot_revisions'::regclass,
      'public.bot_memberships'::regclass,
      'public.bot_channels'::regclass,
      'public.bot_channel_acl'::regclass,
      'public.bot_messages'::regclass,
      'public.bot_objects'::regclass,
      'public.bot_runs'::regclass,
      'public.bot_action_attempts'::regclass,
      'public.bot_approvals'::regclass,
      'public.bot_credentials'::regclass,
      'public.bot_routines'::regclass,
      'public.bot_routine_occurrences'::regclass,
      'public.bot_memories'::regclass,
      'public.bot_memory_versions'::regclass,
      'public.bot_memory_sources'::regclass,
      'public.bot_memory_extraction_jobs'::regclass,
      'public.bot_library_sources'::regclass,
      'public.bot_library_versions'::regclass,
      'public.bot_audit_events'::regclass,
      'public.bot_eval_cases'::regclass,
      'public.bot_eval_runs'::regclass,
      'public.bot_shared_files'::regclass,
      'public.bot_environment_secrets'::regclass
    )
      and acl.grantee = 0
  ),
  'PUBLIC has no Bot relation privileges'
);

select is(
  (select count(*)::integer from pg_policies
   where schemaname = 'public' and tablename like 'bot%'),
  0,
  'no browser-facing Bot RLS policies exist'
);

select ok(
  exists (
    select 1 from storage.buckets
    where id = 'devryan-bot-objects'
      and name = 'devryan-bot-objects'
      and public = false
  ),
  'the Bot object bucket is private'
);

select has_index('public', 'bot_channels', 'bot_channels_active_owner_idx', 'active owner channel index exists');
select has_index(
  'public',
  'bot_channel_acl',
  'bot_channel_acl_active_channel_idx',
  'active channel audience index exists'
);
select has_index('public', 'bot_runs', 'bot_runs_queued_scope_idx', 'FIFO queue index exists');
select has_index('public', 'bot_runs', 'bot_runs_one_active_computer_scope_idx', 'one-computer lease index exists');
select has_index('public', 'bot_action_attempts', 'bot_action_attempts_pending_approval_idx', 'pending approval index exists');
select has_index('public', 'bot_action_attempts', 'bot_action_attempts_pending_expiry_idx', 'pending approval expiry index exists');
select has_index('public', 'bot_objects', 'bot_objects_expiry_idx', 'expiring evidence object index exists');
select has_index('public', 'bot_routines', 'bot_routines_due_idx', 'due routine index exists');
select has_index('public', 'bot_memories', 'bot_memories_active_scope_idx', 'active memory scope index exists');
select has_index('public', 'bot_memory_sources', 'bot_memory_sources_channel_idx', 'memory provenance index exists');
select has_index('public', 'bot_memory_extraction_jobs', 'bot_memory_extraction_jobs_due_idx', 'memory extraction retry queue index exists');
select has_index('public', 'bot_memory_extraction_jobs', 'bot_memory_extraction_jobs_one_leased_per_bot_idx', 'one extraction lease per Bot index exists');
select has_index('public', 'bot_library_versions', 'bot_library_versions_published_idx', 'Library version index exists');
select has_index('public', 'bot_audit_events', 'bot_audit_events_target_time_idx', 'audit target cursor index exists');
select has_index('public', 'bot_audit_events', 'bot_audit_events_issues_time_idx', 'audit issues cursor index exists');
select has_index('public', 'bot_shared_files', 'bot_shared_files_channel_created_idx', 'Shared conversation index exists');
select has_index('public', 'bot_shared_files', 'bot_shared_files_retry_idx', 'Shared retry queue index exists');
select has_index('public', 'bot_shared_files', 'bot_shared_files_source_key_idx', 'generated-image source key is unique');
select has_index('public', 'bot_environment_secrets', 'bot_environment_secrets_bot_name_idx', 'secret names are unique per Bot');
select has_column('public', 'bot_shared_files', 'source_key', 'Shared files carry an idempotent source key');
select has_column('public', 'bot_objects', 'expires_at', 'Bot objects carry a durable evidence expiry');
select has_column('public', 'bot_action_attempts', 'policy_effect', 'action attempts retain the policy effect');
select has_column('public', 'bot_action_attempts', 'policy_rule_ids', 'action attempts retain policy rule identities');
select has_column('public', 'bot_action_attempts', 'decision_expires_at', 'action decisions have a durable expiry');
select has_column('public', 'bot_action_attempts', 'requires_distinct_approver', 'action decisions retain separation of duties');
select has_column('public', 'bot_action_attempts', 'retain_evidence', 'action decisions retain evidence policy');
select has_column('public', 'bot_revisions', 'updated_at', 'Draft revisions carry optimistic update state');
select has_column('public', 'bot_messages', 'assistant_phase', 'Bot assistant messages carry a response phase');
select has_index(
  'public',
  'bot_messages',
  'bot_messages_one_assistant_phase_per_run_idx',
  'a run has at most one assistant message per response phase'
);

select has_trigger('public', 'bots', 'bots_updated_at', 'Bot controls use the shared updated-at trigger');
select has_trigger('public', 'bot_runs', 'bot_runs_updated_at', 'run state uses the shared updated-at trigger');
select has_trigger('public', 'bot_runs', 'bot_runs_terminal_audit', 'terminal run states append Bot audit events');
select has_trigger('public', 'bot_runs', 'bot_runs_enqueue_memory_extraction', 'completed runs enqueue durable memory extraction');
select has_trigger('public', 'bot_revisions', 'bot_revisions_protect_activated', 'activated revisions are protected');
select has_trigger('public', 'bot_revisions', 'bot_revisions_updated_at', 'Draft revisions use optimistic updated-at state');
select has_trigger('public', 'bot_memberships', 'bot_memberships_preserve_final_manager', 'the final active Manager is protected');
select has_trigger('public', 'bot_messages', 'bot_messages_protect_finalized', 'finalized messages are protected');
select has_trigger('public', 'bot_audit_events', 'bot_audit_events_append_only', 'Bot audit is append-only');
select has_trigger('public', 'bot_shared_files', 'bot_shared_files_updated_at', 'Shared copy state uses the shared updated-at trigger');
select has_trigger('public', 'bot_shared_files', 'bot_shared_files_protect_identity', 'Shared file identity is immutable');
select has_trigger('public', 'bot_environment_secrets', 'bot_environment_secrets_updated_at', 'environment secrets use optimistic timestamps');

select ok(
  to_regprocedure('public.devryan_allocate_bot_message_sequence(uuid)') is not null,
  'message sequence RPC exists'
);
select ok(
  to_regprocedure('public.devryan_enqueue_bot_message_run(uuid,uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,uuid,jsonb,integer,timestamp with time zone)') is not null,
  'atomic message/run admission RPC exists'
);
select ok(
  to_regprocedure('public.devryan_enqueue_bot_message_run(uuid,uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,uuid,jsonb,integer,timestamp with time zone,jsonb)') is not null,
  'atomic message/run/Shared admission RPC exists'
);
select ok(
  to_regprocedure('public.devryan_enqueue_bot_message_run(uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,uuid,jsonb,jsonb,integer,timestamp with time zone,jsonb)') is not null,
  'atomic message/run/acknowledgment admission RPC exists'
);
select ok(
  to_regprocedure('public.devryan_claim_bot_run(text,text,timestamp with time zone)') is not null,
  'run claim RPC exists'
);
select ok(
  to_regprocedure('public.devryan_settle_bot_run_terminal(uuid,text,text,jsonb,timestamp with time zone)') is not null,
  'idempotent terminal run settlement RPC exists'
);
select ok(
  to_regprocedure('public.devryan_expire_bot_approvals(text,timestamp with time zone)') is not null,
  'approval expiry reconciliation RPC exists'
);
select ok(
  to_regprocedure('public.devryan_claim_bot_routine_occurrence(uuid,timestamp with time zone,uuid)') is not null,
  'routine occurrence claim RPC exists'
);
select ok(
  to_regprocedure('public.devryan_create_bot(uuid,uuid,text,text,jsonb,text,uuid)') is not null,
  'atomic Bot creation RPC exists'
);
select ok(
  to_regprocedure('public.devryan_activate_bot_revision(uuid,uuid,uuid)') is not null,
  'revision activation RPC exists'
);
select ok(
  to_regprocedure('public.devryan_commit_bot_memory_version(uuid,uuid,uuid,uuid,text,uuid,text,jsonb,text,numeric,jsonb,text,uuid,uuid,uuid,uuid,text,jsonb,timestamp with time zone)') is not null,
  'atomic memory version RPC exists'
);
select ok(
  to_regprocedure('public.devryan_commit_bot_channel_summary(uuid,uuid,bigint,jsonb)') is not null,
  'checkpoint-CAS summary RPC exists'
);
select ok(
  to_regprocedure('public.devryan_enqueue_bot_memory_extraction_job(uuid)') is not null
  and to_regprocedure('public.devryan_claim_bot_memory_extraction_job(text,timestamp with time zone)') is not null
  and to_regprocedure('public.devryan_persist_bot_memory_extraction_candidates(uuid,text,jsonb)') is not null
  and to_regprocedure('public.devryan_settle_bot_memory_extraction_job(uuid,text,text,timestamp with time zone,text,text)') is not null,
  'durable memory extraction job RPCs exist'
);
select ok(
  to_regprocedure('public.devryan_delete_bot_channel(uuid,uuid)') is not null,
  'channel deletion and shared-memory retention RPC exists'
);
select ok(
  to_regprocedure('public.devryan_prune_bot_audit(timestamp with time zone)') is not null,
  'audit prune RPC exists'
);
select ok(
  to_regprocedure('public.devryan_bot_schema_version()') is not null,
  'Bot schema marker exists'
);
select ok(
  to_regprocedure('public.devryan_bot_send_context(uuid,uuid)') is not null,
  'joined Bot send-context RPC exists'
);
select ok(
  to_regprocedure('public.devryan_bot_channel_audience(uuid)') is not null,
  'joined Bot channel-audience RPC exists'
);
select ok(
  to_regprocedure('public.devryan_retry_bot_run(uuid,uuid,timestamp with time zone)') is not null,
  'atomic safe Bot run retry RPC exists'
);
select ok(
  to_regprocedure('public.devryan_requeue_bot_memory_extraction_job(uuid,uuid)') is not null,
  'memory extraction requeue RPC exists'
);

with bot_functions(signature) as (
  values
    ('public.devryan_allocate_bot_message_sequence(uuid)'),
    ('public.devryan_enqueue_bot_message_run(uuid,uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,uuid,jsonb,integer,timestamp with time zone)'),
    ('public.devryan_enqueue_bot_message_run(uuid,uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,uuid,jsonb,integer,timestamp with time zone,jsonb)'),
    ('public.devryan_enqueue_bot_message_run(uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,uuid,jsonb,jsonb,integer,timestamp with time zone,jsonb)'),
    ('public.devryan_claim_bot_run(text,text,timestamp with time zone)'),
    ('public.devryan_settle_bot_run_terminal(uuid,text,text,jsonb,timestamp with time zone)'),
    ('public.devryan_expire_bot_approvals(text,timestamp with time zone)'),
    ('public.devryan_claim_bot_routine_occurrence(uuid,timestamp with time zone,uuid)'),
    ('public.devryan_create_bot(uuid,uuid,text,text,jsonb,text,uuid)'),
    ('public.devryan_activate_bot_revision(uuid,uuid,uuid)'),
    ('public.devryan_commit_bot_memory_version(uuid,uuid,uuid,uuid,text,uuid,text,jsonb,text,numeric,jsonb,text,uuid,uuid,uuid,uuid,text,jsonb,timestamp with time zone)'),
    ('public.devryan_commit_bot_channel_summary(uuid,uuid,bigint,jsonb)'),
    ('public.devryan_enqueue_bot_memory_extraction_job(uuid)'),
    ('public.devryan_claim_bot_memory_extraction_job(text,timestamp with time zone)'),
    ('public.devryan_persist_bot_memory_extraction_candidates(uuid,text,jsonb)'),
    ('public.devryan_settle_bot_memory_extraction_job(uuid,text,text,timestamp with time zone,text,text)'),
    ('public.devryan_delete_bot_channel(uuid,uuid)'),
    ('public.devryan_prune_bot_audit(timestamp with time zone)'),
    ('public.devryan_bot_send_context(uuid,uuid)'),
    ('public.devryan_bot_channel_audience(uuid)'),
    ('public.devryan_retry_bot_run(uuid,uuid,timestamp with time zone)'),
    ('public.devryan_requeue_bot_memory_extraction_job(uuid,uuid)'),
    ('public.devryan_bot_schema_version()')
)
select ok(
  not has_function_privilege('anon', signature, 'execute')
  and not has_function_privilege('authenticated', signature, 'execute')
  and has_function_privilege('service_role', signature, 'execute'),
  format('%s is service-role-only', signature)
)
from bot_functions
order by signature;

with bot_functions(signature) as (
  values
    ('public.devryan_allocate_bot_message_sequence(uuid)'),
    ('public.devryan_enqueue_bot_message_run(uuid,uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,uuid,jsonb,integer,timestamp with time zone)'),
    ('public.devryan_enqueue_bot_message_run(uuid,uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,uuid,jsonb,integer,timestamp with time zone,jsonb)'),
    ('public.devryan_enqueue_bot_message_run(uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,uuid,jsonb,jsonb,integer,timestamp with time zone,jsonb)'),
    ('public.devryan_claim_bot_run(text,text,timestamp with time zone)'),
    ('public.devryan_settle_bot_run_terminal(uuid,text,text,jsonb,timestamp with time zone)'),
    ('public.devryan_expire_bot_approvals(text,timestamp with time zone)'),
    ('public.devryan_claim_bot_routine_occurrence(uuid,timestamp with time zone,uuid)'),
    ('public.devryan_create_bot(uuid,uuid,text,text,jsonb,text,uuid)'),
    ('public.devryan_activate_bot_revision(uuid,uuid,uuid)'),
    ('public.devryan_commit_bot_memory_version(uuid,uuid,uuid,uuid,text,uuid,text,jsonb,text,numeric,jsonb,text,uuid,uuid,uuid,uuid,text,jsonb,timestamp with time zone)'),
    ('public.devryan_commit_bot_channel_summary(uuid,uuid,bigint,jsonb)'),
    ('public.devryan_enqueue_bot_memory_extraction_job(uuid)'),
    ('public.devryan_claim_bot_memory_extraction_job(text,timestamp with time zone)'),
    ('public.devryan_persist_bot_memory_extraction_candidates(uuid,text,jsonb)'),
    ('public.devryan_settle_bot_memory_extraction_job(uuid,text,text,timestamp with time zone,text,text)'),
    ('public.devryan_delete_bot_channel(uuid,uuid)'),
    ('public.devryan_prune_bot_audit(timestamp with time zone)'),
    ('public.devryan_bot_send_context(uuid,uuid)'),
    ('public.devryan_bot_channel_audience(uuid)'),
    ('public.devryan_retry_bot_run(uuid,uuid,timestamp with time zone)'),
    ('public.devryan_requeue_bot_memory_extraction_job(uuid,uuid)'),
    ('public.devryan_bot_schema_version()')
)
select ok(
  not (select prosecdef from pg_proc where oid = signature::regprocedure),
  format('%s is security invoker', signature)
)
from bot_functions
order by signature;

select ok(
  not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'bot_credentials'
      and column_name in ('token', 'access_token', 'refresh_token', 'secret', 'key_bytes', 'cookie')
  ),
  'Bot credential metadata has no secret-bearing columns'
);

-- Fixture principals are administrators so the base control-plane assignment
-- trigger does not require repository grants (Bots are deployment entities).
insert into auth.users (id, email)
values
  ('a0000000-0000-4000-8000-000000000001', 'bot-manager@example.test'),
  ('a0000000-0000-4000-8000-000000000002', 'bot-member@example.test'),
  ('a0000000-0000-4000-8000-000000000003', 'bot-outsider@example.test');

insert into public.user_profiles (id, email, display_name, role)
values
  ('a0000000-0000-4000-8000-000000000001', 'bot-manager@example.test', 'Bot Manager', 'admin'),
  ('a0000000-0000-4000-8000-000000000002', 'bot-member@example.test', 'Bot Member', 'admin'),
  ('a0000000-0000-4000-8000-000000000003', 'bot-outsider@example.test', 'Bot Outsider', 'admin');

insert into public.bots (id, name, title, tenancy, created_by)
values (
  'b0000000-0000-4000-8000-000000000001',
  'Operations Bot',
  'Operations assistant',
  'team',
  'a0000000-0000-4000-8000-000000000001'
);

insert into public.bot_revisions (
  id,
  bot_id,
  revision_number,
  contract,
  compiled_hash,
  created_by
) values (
  'c0000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000001',
  1,
  '{"model":{"providerId":"openai","modelId":"gpt-5"}}'::jsonb,
  repeat('a', 64),
  'a0000000-0000-4000-8000-000000000001'
);

select throws_ok(
  $$insert into public.bot_revisions
    (bot_id, revision_number, contract, compiled_hash, created_by)
    values (
      'b0000000-0000-4000-8000-000000000001',
      1,
      '{}'::jsonb,
      repeat('b', 64),
      'a0000000-0000-4000-8000-000000000001'
    )$$,
  '23505', null, 'revision numbers are unique per Bot'
);

select lives_ok(
  $$insert into public.bot_revisions
    (id, bot_id, revision_number, contract, compiled_hash, created_by)
    values (
      'c0000000-0000-4000-8000-000000000002',
      'b0000000-0000-4000-8000-000000000001',
      2,
      '{"model":{"providerId":"openai","modelId":"gpt-5"}}'::jsonb,
      repeat('a', 64),
      'a0000000-0000-4000-8000-000000000001'
    )$$,
  'guided editing may copy an identical immutable contract to a new revision number'
);

delete from public.bot_revisions
where id = 'c0000000-0000-4000-8000-000000000002';

select throws_ok(
  $$insert into public.bot_revisions
    (bot_id, revision_number, contract, compiled_hash, created_by)
    values (
      'b0000000-0000-4000-8000-000000000001',
      2,
      '[]'::jsonb,
      repeat('b', 64),
      'a0000000-0000-4000-8000-000000000001'
    )$$,
  '23514', null, 'revision contracts must be JSON objects'
);

insert into public.bot_memberships (bot_id, user_id, role, assigned_by)
values
  (
    'b0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    'manager',
    'a0000000-0000-4000-8000-000000000001'
  ),
  (
    'b0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000002',
    'member',
    'a0000000-0000-4000-8000-000000000001'
  );

select throws_ok(
  $$update public.bot_memberships
    set revoked_at = now()
    where bot_id = 'b0000000-0000-4000-8000-000000000001'
      and user_id = 'a0000000-0000-4000-8000-000000000001'$$,
  '23514', 'Bot must retain at least one active Manager',
  'the final active Manager cannot be revoked'
);

select lives_ok(
  $$update public.bot_memberships
    set role = 'manager'
    where bot_id = 'b0000000-0000-4000-8000-000000000001'
      and user_id = 'a0000000-0000-4000-8000-000000000002';
    update public.bot_memberships
    set revoked_at = now()
    where bot_id = 'b0000000-0000-4000-8000-000000000001'
      and user_id = 'a0000000-0000-4000-8000-000000000001';
    update public.bot_memberships
    set revoked_at = null
    where bot_id = 'b0000000-0000-4000-8000-000000000001'
      and user_id = 'a0000000-0000-4000-8000-000000000001';
    update public.bot_memberships
    set role = 'member'
    where bot_id = 'b0000000-0000-4000-8000-000000000001'
      and user_id = 'a0000000-0000-4000-8000-000000000002'$$,
  'a replacement Manager makes revocation and restoration safe'
);

insert into public.bot_channels (id, bot_id, owner_user_id)
values (
  'd0000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001'
);

select throws_ok(
  $$insert into public.bot_channels (bot_id, owner_user_id)
    values (
      'b0000000-0000-4000-8000-000000000001',
      'a0000000-0000-4000-8000-000000000001'
    )$$,
  '23505', null, 'one active owner channel exists per user and Bot'
);

select throws_ok(
  $$insert into public.bot_channels (bot_id, owner_user_id)
    values (
      'b0000000-0000-4000-8000-000000000001',
      'a0000000-0000-4000-8000-000000000003'
    )$$,
  '23514', 'active Bot channel owner must be an active Bot member',
  'active channels require owner membership'
);

select throws_ok(
  $$insert into public.bot_channel_acl (channel_id, user_id, role, invited_by)
    values (
      'd0000000-0000-4000-8000-000000000001',
      'a0000000-0000-4000-8000-000000000003',
      'reader',
      'a0000000-0000-4000-8000-000000000001'
    )$$,
  '23514', 'Bot channel ACL requires an active Bot member',
  'channel ACL rejects non-members'
);

select throws_ok(
  $$insert into public.bot_channel_acl (channel_id, user_id, role, invited_by)
    values (
      'd0000000-0000-4000-8000-000000000001',
      'a0000000-0000-4000-8000-000000000001',
      'reader',
      'a0000000-0000-4000-8000-000000000001'
    )$$,
  '23514', 'Bot channel owner ACL is implicit',
  'channel owner cannot receive a redundant ACL'
);

select lives_ok(
  $$insert into public.bot_channel_acl (channel_id, user_id, role, invited_by)
    values (
      'd0000000-0000-4000-8000-000000000001',
      'a0000000-0000-4000-8000-000000000002',
      'collaborator',
      'a0000000-0000-4000-8000-000000000001'
    )$$,
  'active members may receive a channel ACL'
);

set local role service_role;

select results_eq(
  $$select id from public.devryan_activate_bot_revision(
    'b0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001'
  )$$,
  $$values ('b0000000-0000-4000-8000-000000000001'::uuid)$$,
  'a Manager activates the Bot revision atomically'
);

select lives_ok(
  $$select id from public.devryan_activate_bot_revision(
    'b0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000003'
  )$$,
  'a global administrator may perform Bot-level activation without transcript access'
);

select is(
  public.devryan_bot_send_context(
    'd0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001'
  )->'channel'->>'owner_user_id',
  'a0000000-0000-4000-8000-000000000001',
  'joined send context returns the authoritative owner channel'
);

select is(
  public.devryan_bot_send_context(
    'd0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000002'
  )->'acl'->>'role',
  'collaborator',
  'joined send context returns the active collaborator ACL for JavaScript policy'
);

select results_eq(
  $$select user_id from public.devryan_bot_channel_audience(
      'd0000000-0000-4000-8000-000000000001'
    ) order by user_id$$,
  $$values
      ('a0000000-0000-4000-8000-000000000001'::uuid),
      ('a0000000-0000-4000-8000-000000000002'::uuid)$$,
  'joined audience includes the owner and active collaborator once'
);

update public.bot_channel_acl
set revoked_at = now()
where channel_id = 'd0000000-0000-4000-8000-000000000001'
  and user_id = 'a0000000-0000-4000-8000-000000000002';

select results_eq(
  $$select user_id from public.devryan_bot_channel_audience(
      'd0000000-0000-4000-8000-000000000001'
    ) order by user_id$$,
  $$values ('a0000000-0000-4000-8000-000000000001'::uuid)$$,
  'joined audience synchronously excludes revoked channel access'
);

update public.bot_channel_acl
set revoked_at = null
where channel_id = 'd0000000-0000-4000-8000-000000000001'
  and user_id = 'a0000000-0000-4000-8000-000000000002';

reset role;
set local role postgres;
set local enable_seqscan = off;
set local enable_indexscan = off;
set local enable_indexonlyscan = off;
create or replace function pg_temp.devryan_bot_audience_plan()
returns text
language plpgsql
as $$
declare
  plan_line record;
  plan_text text := '';
begin
  for plan_line in execute $plan$
    explain (costs off)
    select distinct membership.user_id
    from public.bot_channels channel
    join public.bot_memberships membership
      on membership.bot_id = channel.bot_id
     and membership.revoked_at is null
     and membership.activated_at <= pg_catalog.now()
    left join public.bot_channel_acl acl
      on acl.channel_id = channel.id
     and acl.user_id = membership.user_id
     and acl.revoked_at is null
    where channel.id = 'd0000000-0000-4000-8000-000000000001'
      and channel.lifecycle = 'active'
      and channel.archived_at is null
      and (membership.user_id = channel.owner_user_id or acl.user_id is not null)
  $plan$
  loop
    plan_text := plan_text || plan_line."QUERY PLAN" || E'\n';
  end loop;
  return plan_text;
end;
$$;
select ok(
  position('bot_channel_acl_active_channel_idx' in pg_temp.devryan_bot_audience_plan()) > 0,
  'joined audience query uses the active channel ACL partial index'
);
set local enable_seqscan = on;
set local enable_indexscan = on;
set local enable_indexonlyscan = on;
set local role service_role;

select is(
  public.devryan_allocate_bot_message_sequence('d0000000-0000-4000-8000-000000000001'),
  1::bigint,
  'the first message sequence is one'
);
select is(
  public.devryan_allocate_bot_message_sequence('d0000000-0000-4000-8000-000000000001'),
  2::bigint,
  'message sequence allocation is monotonic'
);

reset role;
set local role postgres;

select is(
  (select lifecycle from public.bots where id = 'b0000000-0000-4000-8000-000000000001'),
  'active',
  'revision activation moves a Draft Bot to Active'
);
select ok(
  (select activated_at is not null from public.bot_revisions
   where id = 'c0000000-0000-4000-8000-000000000001'),
  'revision activation stamps immutable activation metadata'
);

select throws_ok(
  $$update public.bot_revisions
    set contract = '{"mutated":true}'::jsonb
    where id = 'c0000000-0000-4000-8000-000000000001'$$,
  '23514', 'activated Bot revision content is immutable',
  'activated revision content cannot change'
);

insert into public.bot_messages (
  id,
  channel_id,
  actor_user_id,
  role,
  sequence,
  body_envelope,
  finalized_at
) values (
  'e0000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001',
  'user',
  1,
  '{"ciphertext":"encrypted"}'::jsonb,
  now()
);

select throws_ok(
  $$update public.bot_messages
    set body_envelope = '{"ciphertext":"changed"}'::jsonb
    where id = 'e0000000-0000-4000-8000-000000000001'$$,
  '23514', 'finalized Bot message is immutable',
  'finalized message content cannot change'
);

set local role service_role;

select is(
  (public.devryan_enqueue_bot_message_run(
    'e0000000-0000-4000-8000-000000000002',
    'f0000000-0000-4000-8000-000000000004',
    'b0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'atomic-message-one',
    '{"providerId":"openai","modelId":"gpt-5"}'::jsonb,
    '{"version":1}'::jsonb,
    'bot:b0000000-0000-4000-8000-000000000001:atomic',
    'a0000000-0000-4000-8000-000000000001',
    '{"ciphertext":"encrypted-atomic"}'::jsonb,
    0,
    now()
  )->>'created')::boolean,
  true,
  'atomic admission creates the user message and queued run together'
);

select is(
  (public.devryan_enqueue_bot_message_run(
    'e0000000-0000-4000-8000-000000000002',
    'f0000000-0000-4000-8000-000000000005',
    'b0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'atomic-message-one',
    '{"providerId":"openai","modelId":"gpt-5"}'::jsonb,
    '{"version":1}'::jsonb,
    'bot:b0000000-0000-4000-8000-000000000001:atomic',
    'a0000000-0000-4000-8000-000000000001',
    '{"ciphertext":"different-random-iv"}'::jsonb,
    0,
    now()
  )->>'created')::boolean,
  false,
  'client-stable message admission is idempotent despite randomized ciphertext'
);

select is(
  (select count(*) from public.bot_runs where idempotency_key = 'atomic-message-one'),
  1::bigint,
  'idempotent atomic admission leaves exactly one run'
);
select is(
  (select sequence from public.bot_messages
   where id = 'e0000000-0000-4000-8000-000000000002'),
  3::bigint,
  'atomic admission allocates the next channel message sequence'
);

select is(
  (public.devryan_enqueue_bot_message_run(
    'e0000000-0000-4000-8000-000000000006',
    'e0000000-0000-4000-8000-000000000007',
    'f0000000-0000-4000-8000-000000000009',
    'b0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'atomic-acknowledgment-one',
    '{"providerId":"openai","modelId":"gpt-5"}'::jsonb,
    '{"version":1}'::jsonb,
    'bot:b0000000-0000-4000-8000-000000000001:atomic-acknowledgment',
    'a0000000-0000-4000-8000-000000000001',
    '{"ciphertext":"encrypted-with-ack"}'::jsonb,
    '{"ciphertext":"encrypted-empty-ack"}'::jsonb,
    0,
    now(),
    '[]'::jsonb
  )->'acknowledgment'->>'id'),
  'e0000000-0000-4000-8000-000000000007',
  'atomic admission returns its unresolved assistant response'
);

select is(
  (select acknowledgment.sequence - user_message.sequence
   from public.bot_messages acknowledgment
   join public.bot_messages user_message
     on user_message.run_id = acknowledgment.run_id
    and user_message.role = 'user'
   where acknowledgment.id = 'e0000000-0000-4000-8000-000000000007'
     and acknowledgment.role = 'assistant'
     and acknowledgment.assistant_phase = 'pending'
     and acknowledgment.finalized_at is null),
  1::bigint,
  'the pending response follows its accepted user message without synthetic text'
);

update public.bot_messages
set assistant_phase = 'acknowledgment', finalized_at = now()
where id = 'e0000000-0000-4000-8000-000000000007';

select is(
  (public.devryan_enqueue_bot_message_run(
    'e0000000-0000-4000-8000-000000000006',
    'e0000000-0000-4000-8000-000000000007',
    'f0000000-0000-4000-8000-000000000010',
    'b0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'atomic-acknowledgment-one',
    '{"providerId":"openai","modelId":"gpt-5"}'::jsonb,
    '{"version":1}'::jsonb,
    'bot:b0000000-0000-4000-8000-000000000001:atomic-acknowledgment',
    'a0000000-0000-4000-8000-000000000001',
    '{"ciphertext":"different-message-iv"}'::jsonb,
    '{"ciphertext":"different-ack-iv"}'::jsonb,
    0,
    now(),
    '[]'::jsonb
  )->>'created')::boolean,
  false,
  'retrying after contextual acknowledgment promotion reconciles without duplicates'
);

select is(
  (select count(*) from public.bot_messages
   where run_id = 'f0000000-0000-4000-8000-000000000009'
     and role = 'assistant'
     and assistant_phase = 'acknowledgment'),
  1::bigint,
  'idempotent response admission leaves exactly one contextual acknowledgment'
);

select is(
  (public.devryan_enqueue_bot_message_run(
    'e0000000-0000-4000-8000-000000000003',
    'f0000000-0000-4000-8000-000000000006',
    'b0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'host-clock-message',
    '{"providerId":"openai","modelId":"gpt-5"}'::jsonb,
    '{"version":1}'::jsonb,
    'bot:b0000000-0000-4000-8000-000000000001:host-clock',
    'a0000000-0000-4000-8000-000000000001',
    '{"ciphertext":"encrypted-host-clock"}'::jsonb,
    0,
    now() - interval '1 minute'
  )->>'created')::boolean,
  true,
  'atomic admission tolerates a host timestamp earlier than the database clock'
);

select is(
  (select created_at from public.bot_messages
   where id = 'e0000000-0000-4000-8000-000000000003'),
  (select finalized_at from public.bot_messages
   where id = 'e0000000-0000-4000-8000-000000000003'),
  'atomic admission records one authoritative timestamp for an accepted user message'
);

select is(
  public.devryan_bot_schema_version(),
  '20260901160000',
  'the Bot schema marker includes runtime-scope and terminal-audit repair'
);

insert into public.bot_messages (
  id, channel_id, run_id, role, assistant_phase, sequence, body_envelope
) values (
  'e0000000-0000-4000-8000-000000000090',
  'd0000000-0000-4000-8000-000000000001',
  'f0000000-0000-4000-8000-000000000004',
  'assistant',
  'pending',
  9000,
  '{"ciphertext":"encrypted-pending"}'::jsonb
);

update public.bot_messages
set assistant_phase = 'acknowledgment', finalized_at = now()
where id = 'e0000000-0000-4000-8000-000000000090';

insert into public.bot_messages (
  id, channel_id, run_id, role, assistant_phase, sequence, body_envelope
) values (
  'e0000000-0000-4000-8000-000000000091',
  'd0000000-0000-4000-8000-000000000001',
  'f0000000-0000-4000-8000-000000000004',
  'assistant',
  'result',
  9001,
  '{"ciphertext":"encrypted-result"}'::jsonb
);

select is(
  (select count(*) from public.bot_messages
   where run_id = 'f0000000-0000-4000-8000-000000000004'
     and role = 'assistant'),
  2::bigint,
  'one run stores a separate acknowledgment and result message'
);

select throws_ok(
  $$update public.bot_messages
    set assistant_phase = 'result'
    where id = 'e0000000-0000-4000-8000-000000000090'$$,
  '23514', 'Bot assistant message phase is immutable',
  'a finalized acknowledgment cannot change phase'
);

select throws_ok(
  $$insert into public.bot_messages (
      id, channel_id, run_id, role, assistant_phase, sequence, body_envelope
    ) values (
      'e0000000-0000-4000-8000-000000000092',
      'd0000000-0000-4000-8000-000000000001',
      'f0000000-0000-4000-8000-000000000004',
      'user', 'pending', 9002, '{"ciphertext":"invalid-user-phase"}'::jsonb
    )$$,
  '23514', null,
  'non-assistant messages cannot carry an assistant phase'
);

select throws_ok(
  $$insert into public.bot_messages (
      id, channel_id, run_id, role, assistant_phase, sequence, body_envelope
    ) values (
      'e0000000-0000-4000-8000-000000000092',
      'd0000000-0000-4000-8000-000000000001',
      'f0000000-0000-4000-8000-000000000004',
      'assistant', 'result', 9002, '{"ciphertext":"duplicate-result"}'::jsonb
    )$$,
  '23505', null,
  'a run cannot store two assistant messages for the same phase'
);

insert into public.bot_messages (
  id, channel_id, run_id, role, assistant_phase, sequence, body_envelope
) values (
  'e0000000-0000-4000-8000-000000000093',
  'd0000000-0000-4000-8000-000000000001',
  'f0000000-0000-4000-8000-000000000006',
  'assistant',
  'pending',
  9003,
  '{"ciphertext":"encrypted-no-tool-result"}'::jsonb
);

update public.bot_messages
set assistant_phase = 'result', finalized_at = now()
where id = 'e0000000-0000-4000-8000-000000000093';

select is(
  (select assistant_phase from public.bot_messages
   where id = 'e0000000-0000-4000-8000-000000000093'),
  'result',
  'a pending no-tool checkpoint may promote to a finalized result'
);

insert into public.bot_objects (
  id,
  bot_id,
  channel_id,
  visibility,
  storage_object_name,
  object_key_envelope,
  ciphertext_hash,
  ciphertext_size,
  wrapped_key,
  content_type,
  created_by
) values (
  '90000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000001',
  'private',
  'tests/shared/fixture.txt.enc',
  '{"ciphertext":"object-key"}'::jsonb,
  repeat('c', 64),
  64,
  '{"ciphertext":"wrapped-key"}'::jsonb,
  'text/plain',
  'a0000000-0000-4000-8000-000000000001'
);

select is(
  (public.devryan_enqueue_bot_message_run(
    'e0000000-0000-4000-8000-000000000004',
    'f0000000-0000-4000-8000-000000000007',
    'b0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'shared-gated-message',
    '{"providerId":"openai","modelId":"gpt-5"}'::jsonb,
    '{"version":1}'::jsonb,
    'bot:b0000000-0000-4000-8000-000000000001:shared-gate',
    'a0000000-0000-4000-8000-000000000001',
    '{"ciphertext":"encrypted-shared"}'::jsonb,
    1,
    now(),
    jsonb_build_array(jsonb_build_object(
      'id', '91000000-0000-4000-8000-000000000001',
      'objectId', '90000000-0000-4000-8000-000000000001',
      'filename', 'fixture.txt',
      'computerPath', '/workspace/Shared/d0000000-0000-4000-8000-000000000001/e0000000-0000-4000-8000-000000000004/fixture.txt'
    ))
  )->>'created')::boolean,
  true,
  'Shared admission atomically creates its message, run, and copy projection'
);

select is_empty(
  $$select id from public.devryan_claim_bot_run(
    'bot:b0000000-0000-4000-8000-000000000001:shared-gate',
    'runtime-shared',
    now() + interval '5 minutes'
  )$$,
  'a pending Shared copy blocks run claiming'
);

select throws_ok(
  $$update public.bot_shared_files
    set safe_filename = 'renamed.txt'
    where id = '91000000-0000-4000-8000-000000000001'$$,
  '23514', 'Bot Shared file identity is immutable',
  'Shared file identity cannot be rewritten after admission'
);

update public.bot_shared_files
set copy_state = 'ready',
    plaintext_sha256 = repeat('d', 64),
    plaintext_size = 17,
    error_code = null
where id = '91000000-0000-4000-8000-000000000001';

select results_eq(
  $$select id from public.devryan_claim_bot_run(
    'bot:b0000000-0000-4000-8000-000000000001:shared-gate',
    'runtime-shared',
    now() + interval '5 minutes'
  )$$,
  $$values ('f0000000-0000-4000-8000-000000000007'::uuid)$$,
  'a verified Shared copy releases the queued run'
);

select throws_ok(
  $$select public.devryan_enqueue_bot_message_run(
    'e0000000-0000-4000-8000-000000000005',
    'f0000000-0000-4000-8000-000000000008',
    'b0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'shared-traversal-message',
    '{"providerId":"openai","modelId":"gpt-5"}'::jsonb,
    '{"version":1}'::jsonb,
    'bot:b0000000-0000-4000-8000-000000000001:shared-traversal',
    'a0000000-0000-4000-8000-000000000001',
    '{"ciphertext":"encrypted-shared"}'::jsonb,
    1,
    now(),
    jsonb_build_array(jsonb_build_object(
      'id', '91000000-0000-4000-8000-000000000002',
      'objectId', '90000000-0000-4000-8000-000000000001',
      'filename', 'fixture.txt',
      'computerPath', '/workspace/Shared/d0000000-0000-4000-8000-000000000001/e0000000-0000-4000-8000-000000000005/../fixture.txt'
    ))
  )$$,
  '22023', 'Bot Shared file path is invalid',
  'Shared admission rejects traversal-like computer paths before enqueueing'
);

select is(
  (select count(*) from public.bot_runs where id = 'f0000000-0000-4000-8000-000000000008'),
  0::bigint,
  'invalid Shared admission leaves no orphaned run'
);

reset role;
set local role postgres;

insert into public.bot_runs (
  id,
  bot_id,
  channel_id,
  revision_id,
  idempotency_key,
  model_snapshot,
  computer_scope_key
) values
  (
    'f0000000-0000-4000-8000-000000000001',
    'b0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'run-one',
    '{"providerId":"openai","modelId":"gpt-5"}'::jsonb,
    'bot:b0000000-0000-4000-8000-000000000001'
  ),
  (
    'f0000000-0000-4000-8000-000000000002',
    'b0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'run-two',
    '{"providerId":"openai","modelId":"gpt-5"}'::jsonb,
    'bot:b0000000-0000-4000-8000-000000000001'
  ),
  (
    'f0000000-0000-4000-8000-000000000003',
    'b0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'run-other-scope',
    '{"providerId":"openai","modelId":"gpt-5"}'::jsonb,
    'bot:b0000000-0000-4000-8000-000000000001:user:other'
  );

set local role service_role;

select results_eq(
  $$select id from public.devryan_claim_bot_run(
    'bot:b0000000-0000-4000-8000-000000000001',
    'runtime-a',
    now() + interval '5 minutes'
  )$$,
  $$values ('f0000000-0000-4000-8000-000000000001'::uuid)$$,
  'the first queued Team run is claimed first'
);

select is_empty(
  $$select id from public.devryan_claim_bot_run(
    'bot:b0000000-0000-4000-8000-000000000001',
    'runtime-b',
    now() + interval '5 minutes'
  )$$,
  'a second run cannot claim the leased computer scope'
);

select results_eq(
  $$select id from public.devryan_claim_bot_run(
    'bot:b0000000-0000-4000-8000-000000000001:user:other',
    'runtime-b',
    now() + interval '5 minutes'
  )$$,
  $$values ('f0000000-0000-4000-8000-000000000003'::uuid)$$,
  'an independent Personalized scope may claim in parallel'
);

update public.bot_runs
set state = 'completed', finished_at = now()
where id = 'f0000000-0000-4000-8000-000000000001';

select results_eq(
  $$select id from public.devryan_claim_bot_run(
    'bot:b0000000-0000-4000-8000-000000000001',
    'runtime-b',
    now() + interval '5 minutes'
  )$$,
  $$values ('f0000000-0000-4000-8000-000000000002'::uuid)$$,
  'the next FIFO run claims after the prior lease settles'
);

select throws_ok(
  $$select * from public.devryan_claim_bot_run(
    'bot:b0000000-0000-4000-8000-000000000001',
    'runtime-b',
    now() - interval '1 second'
  )$$,
  '22023', 'lease expiry must be in the future',
  'run claims reject expired lease requests'
);

reset role;
set local role postgres;

insert into public.bot_runs (
  id, bot_id, channel_id, revision_id, idempotency_key, model_snapshot,
  computer_scope_key, state, lease_owner, lease_until, started_at
) values
  (
    'f1000000-0000-4000-8000-000000000001',
    'b0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'expired-approval-run',
    '{"providerId":"openai","modelId":"gpt-5"}'::jsonb,
    'bot:expiry-fixture', 'waiting_approval', 'expired-runtime', now() - interval '1 minute',
    null
  ),
  (
    'f1000000-0000-4000-8000-000000000002',
    'b0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'after-expired-approval',
    '{"providerId":"openai","modelId":"gpt-5"}'::jsonb,
    'bot:expiry-fixture', 'queued', null, null, null
  ),
  (
    'f1000000-0000-4000-8000-000000000003',
    'b0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'unexpired-approval-run',
    '{"providerId":"openai","modelId":"gpt-5"}'::jsonb,
    'bot:unexpired-fixture', 'waiting_approval', 'live-runtime', now() + interval '5 minutes',
    null
  ),
  (
    'f1000000-0000-4000-8000-000000000004',
    'b0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'after-unexpired-approval',
    '{"providerId":"openai","modelId":"gpt-5"}'::jsonb,
    'bot:unexpired-fixture', 'queued', null, null, null
  ),
  (
    'f1000000-0000-4000-8000-000000000005',
    'b0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'reconciliation-run',
    '{"providerId":"openai","modelId":"gpt-5"}'::jsonb,
    'bot:reconciliation-fixture', 'needs_reconciliation', 'reconcile-runtime', now() + interval '5 minutes',
    null
  ),
  (
    'f1000000-0000-4000-8000-000000000006',
    'b0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'after-reconciliation',
    '{"providerId":"openai","modelId":"gpt-5"}'::jsonb,
    'bot:reconciliation-fixture', 'queued', null, null, null
  );

insert into public.bot_action_attempts (
  id, run_id, bot_id, revision_id, computer_scope_key, action_hash,
  idempotency_key, tool, action, target, encrypted_args, args_digest,
  risk, approval_class, policy_effect, decision_expires_at, state, initiated_by, created_at
) values
  (
    'a1000000-0000-4000-8000-000000000001',
    'f1000000-0000-4000-8000-000000000001',
    'b0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'bot:expiry-fixture', 'sha256:' || repeat('a', 64), 'expired-action',
    'connector:workspace', 'write', '{}'::jsonb, '{"ciphertext":"sealed"}'::jsonb,
    repeat('b', 64), 'sensitive', 'operator', 'prompt', now() - interval '1 minute',
    'pending_approval', 'a0000000-0000-4000-8000-000000000001', now() - interval '10 minutes'
  ),
  (
    'a1000000-0000-4000-8000-000000000002',
    'f1000000-0000-4000-8000-000000000003',
    'b0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'bot:unexpired-fixture', 'sha256:' || repeat('c', 64), 'unexpired-action',
    'connector:workspace', 'write', '{}'::jsonb, '{"ciphertext":"sealed"}'::jsonb,
    repeat('d', 64), 'sensitive', 'operator', 'prompt', now() + interval '5 minutes',
    'pending_approval', 'a0000000-0000-4000-8000-000000000001', now() - interval '2 minutes'
  );

set local role service_role;

select is(
  jsonb_array_length(public.devryan_expire_bot_approvals('bot:expiry-fixture', now())->'actions'),
  1,
  'an expired approval is reconciled exactly once'
);
select is(
  (select state from public.bot_action_attempts where id = 'a1000000-0000-4000-8000-000000000001'),
  'cancelled',
  'expiry cancels the pending action without an approval decision'
);
select results_eq(
  $$select state, interruption_kind, lease_owner is null, finished_at is not null
    from public.bot_runs where id = 'f1000000-0000-4000-8000-000000000001'$$,
  $$values ('failed'::text, 'bot_approval_expired'::text, true, true)$$,
  'expiry atomically fails and releases the waiting run'
);
select is(
  jsonb_array_length(public.devryan_expire_bot_approvals('bot:expiry-fixture', now())->'actions'),
  0,
  'repeated or concurrent expiry reconciliation is idempotent'
);
select results_eq(
  $$select id from public.devryan_claim_bot_run(
    'bot:expiry-fixture', 'runtime-after-expiry', now() + interval '5 minutes'
  )$$,
  $$values ('f1000000-0000-4000-8000-000000000002'::uuid)$$,
  'the next FIFO run claims immediately after expiry releases its scope'
);
select is(
  jsonb_array_length(public.devryan_expire_bot_approvals('bot:unexpired-fixture', now())->'actions'),
  0,
  'an unexpired approval remains pending'
);
select is_empty(
  $$select id from public.devryan_claim_bot_run(
    'bot:unexpired-fixture', 'runtime-unexpired', now() + interval '5 minutes'
  )$$,
  'an unexpired approval continues blocking only its own scope'
);
select is_empty(
  $$select id from public.devryan_claim_bot_run(
    'bot:reconciliation-fixture', 'runtime-reconciliation', now() + interval '5 minutes'
  )$$,
  'a needs-reconciliation run remains a durable scope blocker'
);

reset role;
set local role postgres;

insert into public.bot_routines (
  id,
  bot_id,
  name,
  schedule_contract,
  timezone,
  missed_policy,
  created_by,
  managed_by
) values (
  '10000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000001',
  'Daily review',
  '{"type":"cron","expression":"0 9 * * *"}'::jsonb,
  'UTC',
  'run_once',
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001'
);

set local role service_role;

select results_eq(
  $$select id from public.devryan_claim_bot_routine_occurrence(
    '10000000-0000-4000-8000-000000000001',
    '2026-08-22T09:00:00Z',
    '20000000-0000-4000-8000-000000000001'
  )$$,
  $$values ('20000000-0000-4000-8000-000000000001'::uuid)$$,
  'the scheduler atomically creates an occurrence claim'
);

select results_eq(
  $$select id from public.devryan_claim_bot_routine_occurrence(
    '10000000-0000-4000-8000-000000000001',
    '2026-08-22T09:00:00Z',
    '20000000-0000-4000-8000-000000000002'
  )$$,
  $$values ('20000000-0000-4000-8000-000000000001'::uuid)$$,
  'a duplicate scheduled occurrence returns the original claim'
);

reset role;
set local role postgres;

select is(
  (select count(*)::integer from public.bot_routine_occurrences
   where routine_id = '10000000-0000-4000-8000-000000000001'
     and scheduled_for = '2026-08-22T09:00:00Z'),
  1,
  'only one routine occurrence exists for a scheduled instant'
);

select throws_ok(
  $$insert into public.bot_memories (
      bot_id,
      scope,
      subject_user_id,
      logical_key,
      encrypted_content,
      sensitivity,
      confidence
    ) values (
      'b0000000-0000-4000-8000-000000000001',
      'shared',
      'a0000000-0000-4000-8000-000000000002',
      'invalid-shared-subject',
      '{"ciphertext":"encrypted"}'::jsonb,
      'confidential',
      0.9
    )$$,
  '23514', null, 'shared memory cannot carry a private user subject'
);

insert into public.bot_channels (id, bot_id, owner_user_id)
values (
  'd0000000-0000-4000-8000-000000000002',
  'b0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000002'
);

set local role service_role;

select is(
  (select activated from public.devryan_commit_bot_memory_version(
    '40000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    'b0000000-0000-4000-8000-000000000001',
    'shared', null, 'deployment.region',
    '{"ciphertext":"shared-v1"}'::jsonb, 'normal', 0.9,
    '{"classifierVersion":1}'::jsonb, 'classifier',
    'a0000000-0000-4000-8000-000000000002',
    'd0000000-0000-4000-8000-000000000002', null, null,
    'run', '{"messageIds":[]}'::jsonb, null
  )),
  true,
  'automatic memory creates an active immutable version'
);

select is(
  (select activated from public.devryan_commit_bot_memory_version(
    '40000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000002',
    '42000000-0000-4000-8000-000000000002',
    'b0000000-0000-4000-8000-000000000001',
    'shared', null, 'deployment.region',
    '{"ciphertext":"manager-v2"}'::jsonb, 'normal', 0.98,
    '{"managerEdit":true}'::jsonb, 'manager',
    'a0000000-0000-4000-8000-000000000001',
    null, null, null,
    'manager', '{"operation":"edit"}'::jsonb,
    (select updated_at from public.bot_memories
     where id = '40000000-0000-4000-8000-000000000001')
  )),
  true,
  'a Manager edit activates against the captured memory revision'
);

select is(
  (select activated from public.devryan_commit_bot_memory_version(
    '40000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000003',
    '42000000-0000-4000-8000-000000000003',
    'b0000000-0000-4000-8000-000000000001',
    'shared', null, 'deployment.region',
    '{"ciphertext":"stale-v3"}'::jsonb, 'normal', 0.5,
    '{"consolidation":true}'::jsonb, 'system', null,
    null, null, null,
    'consolidation', '{"sourceCount":1}'::jsonb,
    '2000-01-01T00:00:00Z'
  )),
  false,
  'stale consolidation is preserved but cannot overwrite a newer Manager edit'
);

select is(
  (select active_version_id from public.bot_memories
   where id = '40000000-0000-4000-8000-000000000001'),
  '41000000-0000-4000-8000-000000000002'::uuid,
  'the Manager version remains active after a stale consolidation'
);

select is(
  (select count(*) from public.bot_memory_versions
   where memory_id = '40000000-0000-4000-8000-000000000001'),
  3::bigint,
  'every automatic, Manager, and stale update remains immutable history'
);

select is(
  (select activated from public.devryan_commit_bot_memory_version(
    '40000000-0000-4000-8000-000000000002',
    '41000000-0000-4000-8000-000000000004',
    '42000000-0000-4000-8000-000000000004',
    'b0000000-0000-4000-8000-000000000001',
    'user_private', 'a0000000-0000-4000-8000-000000000002', 'report.preference',
    '{"ciphertext":"private-v1"}'::jsonb, 'confidential', 0.9,
    '{"classifierVersion":1}'::jsonb, 'classifier',
    'a0000000-0000-4000-8000-000000000002',
    'd0000000-0000-4000-8000-000000000002', null, null,
    'run', '{"messageIds":[]}'::jsonb, null
  )),
  true,
  'user-private memory is versioned in its owner scope'
);

select throws_ok(
  $$select * from public.devryan_delete_bot_channel(
    'd0000000-0000-4000-8000-000000000002',
    'a0000000-0000-4000-8000-000000000001'
  )$$,
  '42501', 'Bot channel owner required',
  'only the channel owner may delete private channel memory'
);

select results_eq(
  $$select deleted_private_memories, retained_shared_memories
    from public.devryan_delete_bot_channel(
      'd0000000-0000-4000-8000-000000000002',
      'a0000000-0000-4000-8000-000000000002'
  )$$,
  $$values (0::bigint, 2::bigint)$$,
  'channel deletion retains every Bot-wide memory while tombstoning its source'
);

reset role;
set local role postgres;

select ok(
  exists (select 1 from public.bot_memories
          where id = '40000000-0000-4000-8000-000000000001'),
  'shared learning survives source channel deletion'
);
select ok(
  exists (select 1 from public.bot_memories
          where id = '40000000-0000-4000-8000-000000000002'),
  'former user-private memory remains available as Bot-wide shared memory'
);
select ok(
  exists (
    select 1
    from public.bot_memory_sources source
    join public.bot_memory_versions version on version.id = source.memory_version_id
    where version.memory_id = '40000000-0000-4000-8000-000000000001'
      and source.source_tombstoned_at is not null
      and source.source_metadata->>'channelDeleted' = 'true'
  ),
  'surviving shared memory records that its source channel was deleted'
);

-- A retry requeues only a failure that is known to have happened before any
-- OpenCode session, prompt segment, assistant output, or action attempt. Keep
-- each forbidden phase separate so a future broadening cannot hide behind a
-- different guard.
insert into public.bot_revisions (
  id, bot_id, revision_number, contract, compiled_hash, created_by,
  created_at, activated_at, retired_at
) values (
  'c2000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000001',
  99,
  '{"model":{"providerId":"openai","modelId":"gpt-5"}}'::jsonb,
  repeat('9', 64),
  'a0000000-0000-4000-8000-000000000001',
  now() - interval '3 minutes',
  now() - interval '2 minutes',
  now() - interval '1 minute'
);

insert into public.bot_runs (
  id, bot_id, channel_id, revision_id, idempotency_key, model_snapshot,
  context_snapshot, computer_scope_key, opencode_session_id,
  opencode_segment_id, state, created_at, finished_at
) values
  (
    'f2000000-0000-4000-8000-000000000001',
    'b0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'retry-safe', '{"version":1,"state":"pending"}'::jsonb,
    '{"retryable":true,"failurePhase":"startup"}'::jsonb,
    'bot:retry-safe', null, null, 'failed', now() - interval '1 minute', now()
  ),
  (
    'f2000000-0000-4000-8000-000000000002',
    'b0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'retry-session', '{"version":1,"state":"pending"}'::jsonb,
    '{"retryable":true,"failurePhase":"startup"}'::jsonb, 'bot:retry-session', 'session-existing', null,
    'failed', now() - interval '1 minute', now()
  ),
  (
    'f2000000-0000-4000-8000-000000000003',
    'b0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'retry-segment', '{"version":1,"state":"pending"}'::jsonb,
    '{"retryable":true,"failurePhase":"startup"}'::jsonb, 'bot:retry-segment', null, 'segment-existing',
    'failed', now() - interval '1 minute', now()
  ),
  (
    'f2000000-0000-4000-8000-000000000004',
    'b0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'retry-assistant', '{"version":1,"state":"pending"}'::jsonb,
    '{"retryable":true,"failurePhase":"startup"}'::jsonb, 'bot:retry-assistant', null, null,
    'failed', now() - interval '1 minute', now()
  ),
  (
    'f2000000-0000-4000-8000-000000000005',
    'b0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'retry-action', '{"version":1,"state":"pending"}'::jsonb,
    '{"retryable":true,"failurePhase":"startup"}'::jsonb, 'bot:retry-action', null, null,
    'failed', now() - interval '1 minute', now()
  ),
  (
    'f2000000-0000-4000-8000-000000000006',
    'b0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'retry-not-retryable', '{"version":1,"state":"pending"}'::jsonb,
    '{"retryable":false}'::jsonb, 'bot:retry-not-retryable', null, null,
    'failed', now() - interval '1 minute', now()
  ),
  (
    'f2000000-0000-4000-8000-000000000007',
    'b0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'c2000000-0000-4000-8000-000000000001',
    'retry-retired', '{"version":1,"state":"pending"}'::jsonb,
    '{"retryable":true,"failurePhase":"startup"}'::jsonb, 'bot:retry-retired', null, null,
    'failed', now() - interval '1 minute', now()
  ),
  (
    'f2000000-0000-4000-8000-000000000008',
    'b0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'retry-concurrent-failed', '{"version":1,"state":"pending"}'::jsonb,
    '{"retryable":true,"failurePhase":"startup"}'::jsonb, 'bot:retry-concurrent', null, null,
    'failed', now() - interval '1 minute', now()
  ),
  (
    'f2000000-0000-4000-8000-000000000009',
    'b0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'retry-concurrent-active', '{"version":1,"state":"pending"}'::jsonb,
    '{}'::jsonb, 'bot:retry-concurrent', null, null,
    'starting', now() - interval '1 minute', null
  );

insert into public.bot_messages (
  id, channel_id, run_id, actor_user_id, role, sequence, body_envelope, finalized_at
)
select
  ('e2' || pg_catalog.lpad(run_number::text, 30, '0'))::uuid,
  'd0000000-0000-4000-8000-000000000001'::uuid,
  run_id,
  'a0000000-0000-4000-8000-000000000001'::uuid,
  'user',
  900 + run_number,
  '{"ciphertext":"retry-fixture"}'::jsonb,
  now()
from (values
  (1, 'f2000000-0000-4000-8000-000000000001'::uuid),
  (2, 'f2000000-0000-4000-8000-000000000002'::uuid),
  (3, 'f2000000-0000-4000-8000-000000000003'::uuid),
  (4, 'f2000000-0000-4000-8000-000000000004'::uuid),
  (5, 'f2000000-0000-4000-8000-000000000005'::uuid),
  (6, 'f2000000-0000-4000-8000-000000000006'::uuid),
  (7, 'f2000000-0000-4000-8000-000000000007'::uuid),
  (8, 'f2000000-0000-4000-8000-000000000008'::uuid)
) as retry_fixture(run_number, run_id);

insert into public.bot_messages (
  id, channel_id, run_id, role, sequence, body_envelope
) values (
  'e2000000-0000-4000-8000-000000000104',
  'd0000000-0000-4000-8000-000000000001',
  'f2000000-0000-4000-8000-000000000004',
  'assistant', 1004, '{"ciphertext":"partial-assistant-output"}'::jsonb
);

insert into public.bot_action_attempts (
  id, run_id, bot_id, revision_id, computer_scope_key, action_hash,
  idempotency_key, tool, action, target, encrypted_args, args_digest, risk,
  approval_class, policy_effect, decision_expires_at, initiated_by
) values (
  'a2000000-0000-4000-8000-000000000005',
  'f2000000-0000-4000-8000-000000000005',
  'b0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000001',
  'bot:retry-action', 'sha256:' || repeat('5', 64), 'retry-action-attempt',
  'browser', 'navigate', '{}'::jsonb, '{"ciphertext":"args"}'::jsonb,
  repeat('5', 64), 'low', 'none', 'allow', now() + interval '5 minutes',
  'a0000000-0000-4000-8000-000000000001'
);

set local role service_role;

select is(
  public.devryan_retry_bot_run(
    'f2000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000002', now()
  )->>'reason',
  'wrong_actor',
  'only the initiating user may retry a failed Bot run'
);

select is(
  (public.devryan_retry_bot_run(
    'f2000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001', now()
  )->>'ok')::boolean,
  true,
  'a pre-execution retryable failure atomically requeues the same run'
);

select results_eq(
  $$select state, model_snapshot->>'state', context_snapshot->>'retryCount',
      started_at is null, finished_at is null
    from public.bot_runs
    where id = 'f2000000-0000-4000-8000-000000000001'$$,
  $$values ('queued'::text, 'pending'::text, '1'::text, true, true)$$,
  'safe retry resets execution state while retaining the pinned run identity'
);

select is(
  public.devryan_retry_bot_run(
    'f2000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001', now()
  )->>'reason',
  'not_retryable',
  'an already requeued run cannot be retried a second time'
);

select is(
  public.devryan_retry_bot_run(
    'f2000000-0000-4000-8000-000000000002',
    'a0000000-0000-4000-8000-000000000001', now()
  )->>'reason',
  'execution_started',
  'an existing OpenCode session forbids same-run retry'
);

select is(
  public.devryan_retry_bot_run(
    'f2000000-0000-4000-8000-000000000003',
    'a0000000-0000-4000-8000-000000000001', now()
  )->>'reason',
  'execution_started',
  'an existing prompt segment forbids same-run retry'
);

select is(
  public.devryan_retry_bot_run(
    'f2000000-0000-4000-8000-000000000004',
    'a0000000-0000-4000-8000-000000000001', now()
  )->>'reason',
  'execution_started',
  'partial assistant output forbids same-run retry'
);

select is(
  public.devryan_retry_bot_run(
    'f2000000-0000-4000-8000-000000000005',
    'a0000000-0000-4000-8000-000000000001', now()
  )->>'reason',
  'execution_started',
  'an action attempt forbids same-run retry'
);

select is(
  public.devryan_retry_bot_run(
    'f2000000-0000-4000-8000-000000000006',
    'a0000000-0000-4000-8000-000000000001', now()
  )->>'reason',
  'not_retryable',
  'a terminal non-retryable failure remains visible without requeueing'
);

select is(
  public.devryan_retry_bot_run(
    'f2000000-0000-4000-8000-000000000007',
    'a0000000-0000-4000-8000-000000000001', now()
  )->>'reason',
  'revision_changed',
  'a retired pinned revision forbids same-run retry'
);

select is(
  public.devryan_retry_bot_run(
    'f2000000-0000-4000-8000-000000000008',
    'a0000000-0000-4000-8000-000000000001', now()
  )->>'reason',
  'concurrent_active_run',
  'an active run in the same computer scope forbids concurrent retry'
);

reset role;
set local role postgres;

select throws_ok(
  $$insert into public.bot_audit_events (
      event_id,
      target_type,
      action,
      result,
      metadata
    ) values (
      '30000000-0000-4000-8000-000000000003',
      'bot',
      'bot.oversized',
      'failure',
      jsonb_build_object('details', repeat('x', 17000))
    )$$,
  '23514', null, 'Bot audit metadata is size-bounded'
);

insert into public.bot_audit_events (
  event_id,
  bot_id,
  actor_user_id,
  target_type,
  target_id,
  action,
  result,
  created_at
) values
  (
    '30000000-0000-4000-8000-000000000001',
    'b0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    'bot',
    'b0000000-0000-4000-8000-000000000001',
    'bot.created',
    'success',
    now() - interval '2 years'
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    'b0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    'bot',
    'b0000000-0000-4000-8000-000000000001',
    'bot.updated',
    'success',
    now() - interval '10 days'
  );

select throws_ok(
  $$update public.bot_audit_events
    set result = 'failure'
    where event_id = '30000000-0000-4000-8000-000000000002'$$,
  '23514', 'Bot audit events are append-only',
  'Bot audit rows cannot be updated'
);

set local role service_role;

select throws_ok(
  $$select public.devryan_prune_bot_audit(now() - interval '7 days')$$,
  '22023', 'Bot audit retention cannot be shorter than 30 days',
  'audit pruning enforces the hard retention floor'
);

select is(
  public.devryan_prune_bot_audit(now() - interval '1 year'),
  1::bigint,
  'the default retention horizon removes only older audit history'
);

reset role;
set local role postgres;

select ok(
  not exists (select 1 from public.bot_audit_events
              where event_id = '30000000-0000-4000-8000-000000000001'),
  'old Bot audit history is pruned'
);
select ok(
  exists (select 1 from public.bot_audit_events
          where event_id = '30000000-0000-4000-8000-000000000002'),
  'audit history inside the retention floor survives'
);

-- Durable memory extraction jobs recover leases without exposing candidates.
delete from public.bot_memory_extraction_jobs
where run_id <> 'f0000000-0000-4000-8000-000000000001';

set local role service_role;

select is(
  (select state from public.bot_memory_extraction_jobs
   where run_id = 'f0000000-0000-4000-8000-000000000001'),
  'queued',
  'a completed run automatically owns a queued extraction job'
);

select is_empty(
  $$select run_id from public.devryan_claim_bot_memory_extraction_job(
    'memory-worker-blocked', now() + interval '5 minutes'
  )$$,
  'memory extraction is not claimed while its channel has an active Bot run'
);

select results_eq(
  $$select id, state from public.devryan_settle_bot_run_terminal(
    'f0000000-0000-4000-8000-000000000002',
    'failed', 'bot_opencode_request_failed',
    '{"failurePhase":"execution","retryable":false}'::jsonb,
    now()
  )$$,
  $$values (
    'f0000000-0000-4000-8000-000000000002'::uuid,
    'failed'::text
  )$$,
  'terminal settlement releases the active channel transactionally'
);

select lives_ok(
  $$select public.devryan_settle_bot_run_terminal(
    'f0000000-0000-4000-8000-000000000002',
    'failed', 'bot_opencode_request_failed',
    '{"failurePhase":"execution","retryable":false}'::jsonb,
    now()
  )$$,
  'terminal settlement is idempotent after an uncertain commit'
);

select is(
  (select count(*) from public.bot_audit_events
   where target_type = 'bot_run'
     and target_id = 'f0000000-0000-4000-8000-000000000002'
     and action = 'bot.run.failed'),
  1::bigint,
  'idempotent terminal settlement creates exactly one immutable audit event'
);

select is(
  (select count(*) from public.bot_audit_review_events
   where target_type = 'bot_run'
     and target_id = 'f0000000-0000-4000-8000-000000000002'
     and action = 'bot.run.failed'
     and result = 'failure'),
  1::bigint,
  'a persisted failed response appears in the default Bot Audit issues source'
);

-- Earlier FIFO/approval/recovery fixtures intentionally leave other runs live
-- on this shared channel. Settle them before testing the idle-channel claim.
update public.bot_runs
set state = 'interrupted',
    interruption_kind = 'test_fixture_settled',
    finished_at = now()
where channel_id = 'd0000000-0000-4000-8000-000000000001'
  and id <> 'f0000000-0000-4000-8000-000000000001'
  and state in (
    'queued', 'starting', 'running', 'waiting_approval',
    'waiting_control', 'needs_reconciliation'
  );

select results_eq(
  $$select run_id, attempt_count
    from public.devryan_claim_bot_memory_extraction_job(
      'memory-worker-a', now() + interval '5 minutes'
    )$$,
  $$values ('f0000000-0000-4000-8000-000000000001'::uuid, 1)$$,
  'the first memory worker leases the completed run'
);

select lives_ok(
  $$select public.devryan_settle_bot_memory_extraction_job(
    'f0000000-0000-4000-8000-000000000001',
    'memory-worker-a', 'defer', now() + interval '1 second',
    'admission', 'bot_runtime_scope_busy'
  )$$,
  'a late runtime admission race defers without failing extraction'
);

select results_eq(
  $$select state, attempt_count
    from public.bot_memory_extraction_jobs
    where run_id = 'f0000000-0000-4000-8000-000000000001'$$,
  $$values ('queued'::text, 0)$$,
  'runtime-scope deferral does not consume an extraction attempt'
);

update public.bot_memory_extraction_jobs
set next_attempt_at = now()
where run_id = 'f0000000-0000-4000-8000-000000000001';

select results_eq(
  $$select run_id, attempt_count
    from public.devryan_claim_bot_memory_extraction_job(
      'memory-worker-b', now() + interval '5 minutes'
    )$$,
  $$values ('f0000000-0000-4000-8000-000000000001'::uuid, 1)$$,
  'a deferred extraction resumes with its original attempt budget'
);

select lives_ok(
  $$select public.devryan_persist_bot_memory_extraction_candidates(
    'f0000000-0000-4000-8000-000000000001',
    'memory-worker-b',
    '{"ciphertext":"encrypted-candidates"}'::jsonb
  )$$,
  'classified candidates persist before commit'
);

update public.bot_memory_extraction_jobs
set lease_until = now() - interval '1 second'
where run_id = 'f0000000-0000-4000-8000-000000000001';

select results_eq(
  $$select run_id, attempt_count, candidate_envelope
    from public.devryan_claim_bot_memory_extraction_job(
      'memory-worker-c', now() + interval '5 minutes'
    )$$,
  $$values (
    'f0000000-0000-4000-8000-000000000001'::uuid,
    2,
    '{"ciphertext":"encrypted-candidates"}'::jsonb
  )$$,
  'an expired lease is reclaimed without losing classified candidates'
);

select lives_ok(
  $$select public.devryan_settle_bot_memory_extraction_job(
    'f0000000-0000-4000-8000-000000000001',
    'memory-worker-c', 'succeeded', null, 'complete', null
  )$$,
  'the recovered extraction settles durably'
);

-- Summary CAS ignores unrelated channel timestamps and conflicts only on its
-- monotonic checkpoint.
update public.bot_channels
set last_message_at = now()
where id = 'd0000000-0000-4000-8000-000000000001';

select results_eq(
  $$select current_checkpoint_number
    from public.devryan_commit_bot_channel_summary(
      'd0000000-0000-4000-8000-000000000001',
      'b0000000-0000-4000-8000-000000000001',
      0,
      '{"ciphertext":"summary-one"}'::jsonb
    )$$,
  $$values (1::bigint)$$,
  'unrelated channel activity does not invalidate summary commit'
);

select is_empty(
  $$select * from public.devryan_commit_bot_channel_summary(
    'd0000000-0000-4000-8000-000000000001',
    'b0000000-0000-4000-8000-000000000001',
    0,
    '{"ciphertext":"stale-summary"}'::jsonb
  )$$,
  'a stale summary checkpoint cannot overwrite the committed summary'
);

select is(
  (select source->>'_replayed'
   from public.devryan_commit_bot_memory_version(
    '40000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000099',
    '42000000-0000-4000-8000-000000000001',
    'b0000000-0000-4000-8000-000000000001',
    'shared', null, 'deployment.region',
    '{"ciphertext":"ignored-replay"}'::jsonb, 'normal', 0.9,
    '{"classifierVersion":1}'::jsonb, 'classifier',
    'a0000000-0000-4000-8000-000000000002',
    'd0000000-0000-4000-8000-000000000002', null, null,
    'run', '{"messageIds":[]}'::jsonb, null
  )),
  'true',
  'a stable automatic source returns its existing immutable version on replay'
);

insert into public.bot_audit_events (
  event_id, target_type, target_id, action, result, created_at
) values
  ('30000000-0000-4000-8000-000000000090', 'bot_run',
   'f0000000-0000-4000-8000-000000000090', 'bot.memory.extract', 'failure',
   '2026-08-31T12:00:00Z'),
  ('30000000-0000-4000-8000-000000000091', 'bot_run',
   'f0000000-0000-4000-8000-000000000090', 'bot.memory.extract', 'success',
   '2026-08-31T12:01:00Z');

select is(
  (select resolved_by_event_id
   from public.bot_audit_events_with_resolution
   where event_id = '30000000-0000-4000-8000-000000000090'),
  '30000000-0000-4000-8000-000000000091'::uuid,
  'a later extraction success resolves the earlier immutable issue projection'
);

select is(
  (select count(*) from public.bot_audit_events
   where event_id in (
     '30000000-0000-4000-8000-000000000090',
     '30000000-0000-4000-8000-000000000091'
   )),
  2::bigint,
  'audit resolution preserves both historical events'
);

select * from finish();
rollback;
