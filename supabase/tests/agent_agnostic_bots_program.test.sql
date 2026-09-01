begin;

set local role postgres;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(61);

select has_column('public', 'bot_runs', 'agent_adapter', 'runs record the reasoning adapter');
select has_column('public', 'bot_runs', 'agent_thread_id', 'runs record the generic thread');
select has_column('public', 'bot_runs', 'agent_execution', 'runs record versioned adapter execution');
select has_column('public', 'bot_revisions', 'portable_spec', 'revisions retain portable specs');
select has_column('public', 'bot_revisions', 'spec_hash', 'revisions retain portable spec hashes');
select has_column('public', 'bot_signer_trust', 'updated_at', 'signer trust changes use optimistic revisions');
select has_column('public', 'bot_action_attempts', 'matcher_version', 'actions bind matcher versions');
select has_column('public', 'bot_action_attempts', 'policy_facts_digest', 'actions bind policy facts');
select has_column('public', 'bot_action_attempts', 'authoritative_actor_role', 'actions bind live actor roles');
select has_column('public', 'bot_action_attempts', 'quota_binding', 'actions bind quota reservations');
select has_column('public', 'bot_approvals', 'matcher_version', 'approvals bind matcher versions');
select has_column('public', 'bot_approvals', 'policy_facts_digest', 'approvals bind policy facts');
select has_column('public', 'bot_approvals', 'authoritative_actor_role', 'approvals bind actor roles');
select has_column('public', 'bot_approvals', 'quota_binding', 'approvals bind quota reservations');

with relations(name) as (values
  ('bot_agent_connections'),
  ('bot_revision_binding_resolutions'),
  ('bot_revision_signatures'),
  ('bot_signer_trust'),
  ('bot_quota_buckets'),
  ('bot_quota_reservations')
)
select has_table('public', name, format('%s exists', name)) from relations order by name;

with relations(name) as (values
  ('bot_agent_connections'),
  ('bot_revision_binding_resolutions'),
  ('bot_revision_signatures'),
  ('bot_signer_trust'),
  ('bot_quota_buckets'),
  ('bot_quota_reservations')
)
select ok(class.relrowsecurity, format('%s has RLS', relation.name))
from relations relation
join pg_class class on class.oid = format('public.%I', relation.name)::regclass
order by relation.name;

with relations(name) as (values
  ('bot_agent_connections'),
  ('bot_revision_binding_resolutions'),
  ('bot_revision_signatures'),
  ('bot_signer_trust'),
  ('bot_quota_buckets'),
  ('bot_quota_reservations')
)
select ok(class.relforcerowsecurity, format('%s has forced RLS', relation.name))
from relations relation
join pg_class class on class.oid = format('public.%I', relation.name)::regclass
order by relation.name;

with relations(name) as (values
  ('bot_agent_connections'),
  ('bot_revision_binding_resolutions'),
  ('bot_revision_signatures'),
  ('bot_signer_trust'),
  ('bot_quota_buckets'),
  ('bot_quota_reservations')
)
select ok(
  not has_table_privilege('anon', format('public.%I', name), 'select'),
  format('anon cannot read %s', name)
) from relations order by name;

with relations(name) as (values
  ('bot_agent_connections'),
  ('bot_revision_binding_resolutions'),
  ('bot_revision_signatures'),
  ('bot_signer_trust'),
  ('bot_quota_buckets'),
  ('bot_quota_reservations')
)
select ok(
  not has_table_privilege('authenticated', format('public.%I', name), 'select'),
  format('authenticated cannot read %s', name)
) from relations order by name;

with relations(name) as (values
  ('bot_agent_connections'),
  ('bot_revision_binding_resolutions'),
  ('bot_revision_signatures'),
  ('bot_signer_trust'),
  ('bot_quota_buckets'),
  ('bot_quota_reservations')
)
select ok(
  has_table_privilege('service_role', format('public.%I', name), 'select,insert,update,delete'),
  format('service_role owns %s', name)
) from relations order by name;

select has_trigger(
  'public',
  'bot_revision_binding_resolutions',
  'bot_revision_binding_resolutions_immutable',
  'binding resolutions are immutable'
);
select has_trigger(
  'public',
  'bot_revision_signatures',
  'bot_revision_signatures_immutable',
  'revision signatures are immutable'
);
select has_index('public', 'bot_runs', 'bot_runs_agent_thread_idx', 'generic execution handles are indexed');
select has_index('public', 'bot_quota_buckets', 'bot_quota_buckets_expiry_idx', 'quota windows are indexed');
select has_index('public', 'bot_quota_reservations', 'bot_quota_reservations_action_idx', 'action quota bindings are indexed');
select has_index('public', 'bot_quota_reservations', 'bot_quota_reservations_expiry_idx', 'quota expiry is indexed');
select has_function(
  'public',
  'devryan_attach_bot_revision_spec',
  array['uuid', 'jsonb', 'text', 'text'],
  'portable specs attach through a fixed service transaction'
);
select has_function(
  'public',
  'devryan_reserve_bot_action_quotas',
  array['uuid', 'uuid', 'uuid', 'jsonb', 'timestamp with time zone'],
  'quota slots reserve through one service transaction'
);
select has_function(
  'public',
  'devryan_consume_bot_action_quotas',
  array['uuid', 'timestamp with time zone'],
  'quota slots consume immediately before execution'
);
select has_function(
  'public',
  'devryan_release_bot_action_quotas',
  array['uuid', 'text', 'timestamp with time zone'],
  'unused quota slots have an explicit release transaction'
);
select is(
  public.devryan_bot_schema_version(),
  '20260901160000'::text,
  'schema marker includes terminal settlement and audit repair'
);

select * from finish();
rollback;
