-- Production Bots service-only control plane.
-- Private content is encrypted by the Electron-owned deployment key before it
-- reaches these relations or the private Storage bucket. Browser Supabase roles
-- receive no relation or RPC privileges.

create extension if not exists pgcrypto;

create table public.bots (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  lifecycle text not null default 'draft'
    check (lifecycle in ('draft', 'active', 'paused', 'retired')),
  tenancy text not null check (tenancy in ('team', 'personalized')),
  active_revision_id uuid,
  created_by uuid not null references public.user_profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  retired_at timestamptz,
  constraint bots_lifecycle_revision_check check (
    (lifecycle = 'draft' and active_revision_id is null and retired_at is null)
    or (lifecycle in ('active', 'paused') and active_revision_id is not null and retired_at is null)
    or (lifecycle = 'retired' and active_revision_id is not null and retired_at is not null)
  ),
  constraint bots_retired_after_created_check check (
    retired_at is null or retired_at >= created_at
  )
);

create table public.bot_revisions (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bots(id) on delete cascade,
  revision_number bigint not null check (revision_number > 0),
  contract jsonb not null check (jsonb_typeof(contract) = 'object'),
  compiled_hash text not null check (compiled_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references public.user_profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  activated_at timestamptz,
  retired_at timestamptz,
  constraint bot_revisions_bot_number_key unique (bot_id, revision_number),
  constraint bot_revisions_bot_hash_key unique (bot_id, compiled_hash),
  constraint bot_revisions_bot_id_id_key unique (bot_id, id),
  constraint bot_revisions_activation_time_check check (
    activated_at is null or activated_at >= created_at
  ),
  constraint bot_revisions_retirement_time_check check (
    retired_at is null
    or (activated_at is not null and retired_at >= activated_at)
  )
);

alter table public.bots
  add constraint bots_active_revision_fkey
  foreign key (id, active_revision_id)
  references public.bot_revisions(bot_id, id)
  on delete no action
  deferrable initially deferred;

create table public.bot_memberships (
  bot_id uuid not null references public.bots(id) on delete cascade,
  user_id uuid not null references public.user_profiles(id) on delete cascade,
  role text not null check (role in ('member', 'operator', 'manager')),
  assigned_by uuid not null references public.user_profiles(id) on delete restrict,
  activated_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (bot_id, user_id),
  constraint bot_memberships_revocation_time_check check (
    revoked_at is null or revoked_at >= activated_at
  )
);

create index bot_memberships_active_user_idx
  on public.bot_memberships (user_id, bot_id, role)
  where revoked_at is null;
create index bot_memberships_active_bot_role_idx
  on public.bot_memberships (bot_id, role, user_id)
  where revoked_at is null;

create table public.bot_channels (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bots(id) on delete cascade,
  owner_user_id uuid not null references public.user_profiles(id) on delete restrict,
  lifecycle text not null default 'active'
    check (lifecycle in ('active', 'archived')),
  current_checkpoint_number bigint not null default 0
    check (current_checkpoint_number >= 0),
  next_message_sequence bigint not null default 1
    check (next_message_sequence > 0),
  summary_envelope jsonb
    check (summary_envelope is null or jsonb_typeof(summary_envelope) = 'object'),
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint bot_channels_bot_id_id_key unique (bot_id, id),
  constraint bot_channels_archive_state_check check (
    (lifecycle = 'active' and archived_at is null)
    or (lifecycle = 'archived' and archived_at is not null)
  ),
  constraint bot_channels_archive_time_check check (
    archived_at is null or archived_at >= created_at
  )
);

create unique index bot_channels_active_owner_idx
  on public.bot_channels (bot_id, owner_user_id)
  where lifecycle = 'active';
create index bot_channels_bot_activity_idx
  on public.bot_channels (bot_id, last_message_at desc nulls last, id desc);
create index bot_channels_owner_activity_idx
  on public.bot_channels (owner_user_id, last_message_at desc nulls last, id desc);

create table public.bot_channel_acl (
  channel_id uuid not null references public.bot_channels(id) on delete cascade,
  user_id uuid not null references public.user_profiles(id) on delete cascade,
  role text not null check (role in ('reader', 'collaborator')),
  invited_by uuid not null references public.user_profiles(id) on delete restrict,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (channel_id, user_id),
  constraint bot_channel_acl_revocation_time_check check (
    revoked_at is null or revoked_at >= granted_at
  )
);

create index bot_channel_acl_active_user_idx
  on public.bot_channel_acl (user_id, channel_id, role)
  where revoked_at is null;

create table public.bot_credentials (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bots(id) on delete cascade,
  provider text not null check (char_length(btrim(provider)) between 1 and 120),
  kind text not null check (char_length(btrim(kind)) between 1 and 120),
  credential_scope text not null check (credential_scope in ('team', 'user')),
  owner_user_id uuid references public.user_profiles(id) on delete cascade,
  local_vault_reference text not null
    check (char_length(btrim(local_vault_reference)) between 1 and 512),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  status text not null default 'active'
    check (status in ('active', 'revoked', 'error')),
  created_by uuid not null references public.user_profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint bot_credentials_scope_owner_check check (
    (credential_scope = 'team' and owner_user_id is null)
    or (credential_scope = 'user' and owner_user_id is not null)
  ),
  constraint bot_credentials_revocation_state_check check (
    (status = 'revoked' and revoked_at is not null)
    or (status <> 'revoked' and revoked_at is null)
  )
);

create unique index bot_credentials_active_team_identity_idx
  on public.bot_credentials (bot_id, provider, kind)
  where credential_scope = 'team' and revoked_at is null;
create unique index bot_credentials_active_user_identity_idx
  on public.bot_credentials (bot_id, owner_user_id, provider, kind)
  where credential_scope = 'user' and revoked_at is null;
create index bot_credentials_owner_idx
  on public.bot_credentials (owner_user_id, bot_id)
  where owner_user_id is not null;

create table public.bot_runs (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null,
  channel_id uuid not null,
  revision_id uuid not null,
  idempotency_key text not null
    check (char_length(btrim(idempotency_key)) between 1 and 512),
  model_snapshot jsonb not null check (jsonb_typeof(model_snapshot) = 'object'),
  context_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(context_snapshot) = 'object'),
  computer_scope_key text not null
    check (char_length(btrim(computer_scope_key)) between 1 and 512),
  queue_sequence bigint generated always as identity,
  opencode_segment_id text,
  opencode_session_id text,
  state text not null default 'queued'
    check (state in (
      'queued', 'starting', 'running', 'waiting_approval',
      'needs_reconciliation', 'completed', 'failed', 'cancelled', 'interrupted'
    )),
  lease_generation bigint not null default 0 check (lease_generation >= 0),
  lease_owner text,
  lease_until timestamptz,
  interruption_kind text,
  reconciliation_state jsonb
    check (reconciliation_state is null or jsonb_typeof(reconciliation_state) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  constraint bot_runs_channel_idempotency_key unique (channel_id, idempotency_key),
  constraint bot_runs_id_bot_revision_key unique (id, bot_id, revision_id),
  constraint bot_runs_channel_fkey
    foreign key (bot_id, channel_id)
    references public.bot_channels(bot_id, id)
    on delete cascade,
  constraint bot_runs_revision_fkey
    foreign key (bot_id, revision_id)
    references public.bot_revisions(bot_id, id)
    on delete restrict,
  constraint bot_runs_lease_pair_check check (
    (lease_owner is null and lease_until is null)
    or (lease_owner is not null and lease_until is not null)
  ),
  constraint bot_runs_started_time_check check (
    started_at is null or started_at >= created_at
  ),
  constraint bot_runs_finished_time_check check (
    finished_at is null
    or (
      finished_at >= created_at
      and (started_at is null or finished_at >= started_at)
    )
  )
);

create unique index bot_runs_one_active_computer_scope_idx
  on public.bot_runs (computer_scope_key)
  where state in ('starting', 'running', 'waiting_approval', 'needs_reconciliation');
create index bot_runs_queued_scope_idx
  on public.bot_runs (computer_scope_key, queue_sequence)
  where state = 'queued';
create index bot_runs_channel_state_idx
  on public.bot_runs (channel_id, state, created_at desc, id desc);
create index bot_runs_revision_idx on public.bot_runs (revision_id);

create table public.bot_messages (
  id uuid primary key,
  channel_id uuid not null references public.bot_channels(id) on delete cascade,
  run_id uuid references public.bot_runs(id) on delete set null,
  actor_user_id uuid references public.user_profiles(id) on delete set null,
  role text not null check (role in ('user', 'assistant', 'system')),
  sequence bigint not null check (sequence > 0),
  body_envelope jsonb not null check (jsonb_typeof(body_envelope) = 'object'),
  attachment_count integer not null default 0 check (attachment_count >= 0),
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  constraint bot_messages_channel_sequence_key unique (channel_id, sequence),
  constraint bot_messages_actor_role_check check (
    role <> 'user' or actor_user_id is not null
  ),
  constraint bot_messages_finalized_time_check check (
    finalized_at is null or finalized_at >= created_at
  )
);

create index bot_messages_run_idx on public.bot_messages (run_id)
  where run_id is not null;
create unique index bot_messages_one_assistant_per_run_idx
  on public.bot_messages (run_id)
  where run_id is not null and role = 'assistant';
create index bot_messages_channel_created_idx
  on public.bot_messages (channel_id, created_at desc, id desc);

create table public.bot_objects (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null,
  channel_id uuid,
  visibility text not null check (visibility in ('private', 'library')),
  storage_bucket text not null default 'devryan-bot-objects'
    check (storage_bucket = 'devryan-bot-objects'),
  storage_object_name text not null unique
    check (char_length(btrim(storage_object_name)) between 1 and 512),
  object_key_envelope jsonb not null check (jsonb_typeof(object_key_envelope) = 'object'),
  ciphertext_hash text not null check (ciphertext_hash ~ '^[0-9a-f]{64}$'),
  ciphertext_size bigint not null check (ciphertext_size >= 0),
  wrapped_key jsonb not null check (jsonb_typeof(wrapped_key) = 'object'),
  content_type text not null check (char_length(btrim(content_type)) between 1 and 255),
  provenance jsonb not null default '{}'::jsonb check (jsonb_typeof(provenance) = 'object'),
  created_by uuid not null references public.user_profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz,
  deleted_at timestamptz,
  constraint bot_objects_channel_fkey
    foreign key (bot_id, channel_id)
    references public.bot_channels(bot_id, id)
    on delete cascade,
  constraint bot_objects_private_channel_check check (
    visibility <> 'private' or channel_id is not null
  ),
  constraint bot_objects_deleted_time_check check (
    deleted_at is null or deleted_at >= created_at
  ),
  constraint bot_objects_expiry_time_check check (
    expires_at is null or expires_at > created_at
  )
);

create index bot_objects_private_channel_idx
  on public.bot_objects (channel_id, created_at desc, id desc)
  where visibility = 'private' and deleted_at is null;
create index bot_objects_library_bot_idx
  on public.bot_objects (bot_id, created_at desc, id desc)
  where visibility = 'library' and deleted_at is null;
create index bot_objects_expiry_idx
  on public.bot_objects (expires_at, id)
  where expires_at is not null and deleted_at is null;

create table public.bot_action_attempts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  bot_id uuid not null,
  revision_id uuid not null,
  credential_id uuid references public.bot_credentials(id) on delete set null,
  computer_scope_key text not null
    check (char_length(btrim(computer_scope_key)) between 1 and 512),
  action_hash text not null check (action_hash ~ '^sha256:[0-9a-f]{64}$'),
  idempotency_key text not null
    check (char_length(btrim(idempotency_key)) between 1 and 512),
  tool text not null check (char_length(btrim(tool)) between 1 and 120),
  action text not null check (char_length(btrim(action)) between 1 and 120),
  target jsonb not null check (jsonb_typeof(target) = 'object'),
  encrypted_args jsonb not null check (jsonb_typeof(encrypted_args) = 'object'),
  args_digest text not null check (args_digest ~ '^[0-9a-f]{64}$'),
  risk text not null check (risk in ('low', 'sensitive', 'critical')),
  approval_class text not null check (approval_class in ('none', 'requester', 'operator', 'manager')),
  policy_effect text not null check (policy_effect in ('deny', 'prompt', 'allow')),
  policy_rule_ids text[] not null default '{}'::text[],
  decision_expires_at timestamptz not null,
  requires_distinct_approver boolean not null default false,
  retain_evidence boolean not null default false,
  state text not null default 'proposed'
    check (state in (
      'proposed', 'pending_approval', 'approved', 'executing',
      'succeeded', 'failed', 'unknown', 'reconciled', 'denied'
    )),
  execution_receipt jsonb
    check (execution_receipt is null or jsonb_typeof(execution_receipt) = 'object'),
  unknown_outcome boolean not null default false,
  reconciliation_decision text
    check (reconciliation_decision is null or reconciliation_decision in ('complete', 'retry_new', 'abandon')),
  initiated_by uuid not null references public.user_profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  constraint bot_action_attempts_run_idempotency_key unique (run_id, idempotency_key),
  constraint bot_action_attempts_approval_identity_key
    unique (id, action_hash, revision_id, args_digest),
  constraint bot_action_attempts_run_fkey
    foreign key (run_id, bot_id, revision_id)
    references public.bot_runs(id, bot_id, revision_id)
    on delete cascade,
  constraint bot_action_attempts_policy_approval_check check (
    (policy_effect = 'prompt' and approval_class <> 'none')
    or (policy_effect <> 'prompt' and approval_class = 'none')
  ),
  constraint bot_action_attempts_policy_expiry_check check (
    decision_expires_at > created_at
  ),
  constraint bot_action_attempts_unknown_state_check check (
    (state = 'unknown' and unknown_outcome)
    or (state <> 'unknown' and not unknown_outcome)
  ),
  constraint bot_action_attempts_reconciliation_check check (
    reconciliation_decision is null or state = 'reconciled'
  ),
  constraint bot_action_attempts_finished_time_check check (
    finished_at is null
    or (started_at is not null and finished_at >= started_at)
  )
);

create index bot_action_attempts_run_state_idx
  on public.bot_action_attempts (run_id, state, created_at, id);
create index bot_action_attempts_pending_approval_idx
  on public.bot_action_attempts (created_at, id)
  where state = 'pending_approval';
create index bot_action_attempts_unknown_idx
  on public.bot_action_attempts (computer_scope_key, created_at, id)
  where state = 'unknown';
create index bot_action_attempts_credential_idx
  on public.bot_action_attempts (credential_id)
  where credential_id is not null;

create table public.bot_approvals (
  id uuid primary key default gen_random_uuid(),
  action_attempt_id uuid not null,
  action_hash text not null check (action_hash ~ '^sha256:[0-9a-f]{64}$'),
  revision_id uuid not null,
  args_digest text not null check (args_digest ~ '^[0-9a-f]{64}$'),
  approver_user_id uuid not null references public.user_profiles(id) on delete restrict,
  decision text not null check (decision in ('approved', 'denied')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint bot_approvals_action_approver_key unique (action_attempt_id, approver_user_id),
  constraint bot_approvals_action_binding_fkey
    foreign key (action_attempt_id, action_hash, revision_id, args_digest)
    references public.bot_action_attempts(id, action_hash, revision_id, args_digest)
    on delete cascade,
  constraint bot_approvals_expiry_check check (expires_at > created_at)
);

create index bot_approvals_valid_action_idx
  on public.bot_approvals (action_attempt_id, decision, expires_at);
create index bot_approvals_approver_created_idx
  on public.bot_approvals (approver_user_id, created_at desc, id desc);

create table public.bot_routines (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bots(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 160),
  schedule_contract jsonb not null check (jsonb_typeof(schedule_contract) = 'object'),
  timezone text not null check (char_length(btrim(timezone)) between 1 and 120),
  missed_policy text not null check (missed_policy in ('skip', 'run_once', 'replay_capped')),
  missed_run_cap integer not null default 1 check (missed_run_cap between 1 and 3),
  status text not null default 'draft'
    check (status in ('draft', 'active', 'paused', 'retired')),
  revision_behavior text not null default 'current_active'
    check (revision_behavior = 'current_active'),
  next_occurrence_at timestamptz,
  last_occurrence_at timestamptz,
  created_by uuid not null references public.user_profiles(id) on delete restrict,
  managed_by uuid not null references public.user_profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  retired_at timestamptz,
  constraint bot_routines_retirement_state_check check (
    (status = 'retired' and retired_at is not null)
    or (status <> 'retired' and retired_at is null)
  )
);

create index bot_routines_due_idx
  on public.bot_routines (next_occurrence_at, id)
  where status = 'active' and next_occurrence_at is not null;
create index bot_routines_bot_status_idx
  on public.bot_routines (bot_id, status, updated_at desc, id desc);

create table public.bot_routine_occurrences (
  id uuid primary key,
  routine_id uuid not null references public.bot_routines(id) on delete cascade,
  scheduled_for timestamptz not null,
  run_id uuid references public.bot_runs(id) on delete set null,
  recovery_disposition text not null default 'scheduled'
    check (recovery_disposition in ('scheduled', 'skip', 'run_once', 'replay')),
  state text not null default 'claimed'
    check (state in ('claimed', 'dispatched', 'skipped', 'completed', 'failed')),
  claimed_by text not null check (char_length(btrim(claimed_by)) between 1 and 255),
  claimed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bot_routine_occurrences_schedule_key unique (routine_id, scheduled_for)
);

create index bot_routine_occurrences_run_idx
  on public.bot_routine_occurrences (run_id)
  where run_id is not null;
create index bot_routine_occurrences_routine_state_idx
  on public.bot_routine_occurrences (routine_id, state, scheduled_for, id);

create table public.bot_memories (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bots(id) on delete cascade,
  scope text not null check (scope in ('shared', 'user_private')),
  subject_user_id uuid references public.user_profiles(id) on delete cascade,
  logical_key text not null check (char_length(btrim(logical_key)) between 1 and 512),
  encrypted_content jsonb not null check (jsonb_typeof(encrypted_content) = 'object'),
  sensitivity text not null check (sensitivity in ('normal', 'confidential', 'restricted')),
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  active_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  tombstoned_at timestamptz,
  constraint bot_memories_scope_subject_check check (
    (scope = 'shared' and subject_user_id is null)
    or (scope = 'user_private' and subject_user_id is not null)
  ),
  constraint bot_memories_bot_id_id_key unique (bot_id, id)
);

create unique index bot_memories_shared_identity_idx
  on public.bot_memories (bot_id, logical_key)
  where scope = 'shared';
create unique index bot_memories_private_identity_idx
  on public.bot_memories (bot_id, subject_user_id, logical_key)
  where scope = 'user_private';
create index bot_memories_active_scope_idx
  on public.bot_memories (bot_id, scope, subject_user_id, updated_at desc, id desc)
  where tombstoned_at is null;

create table public.bot_memory_versions (
  id uuid primary key default gen_random_uuid(),
  memory_id uuid not null references public.bot_memories(id) on delete cascade,
  version_number bigint not null check (version_number > 0),
  encrypted_content jsonb not null check (jsonb_typeof(encrypted_content) = 'object'),
  classifier_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(classifier_metadata) = 'object'),
  creator_kind text not null check (creator_kind in ('classifier', 'manager', 'system')),
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint bot_memory_versions_memory_number_key unique (memory_id, version_number),
  constraint bot_memory_versions_memory_id_id_key unique (memory_id, id)
);

alter table public.bot_memories
  add constraint bot_memories_active_version_fkey
  foreign key (id, active_version_id)
  references public.bot_memory_versions(memory_id, id)
  on delete no action
  deferrable initially deferred;

create table public.bot_memory_sources (
  id uuid primary key default gen_random_uuid(),
  memory_version_id uuid not null references public.bot_memory_versions(id) on delete cascade,
  channel_id uuid references public.bot_channels(id) on delete set null,
  run_id uuid references public.bot_runs(id) on delete set null,
  message_id uuid references public.bot_messages(id) on delete set null,
  source_kind text not null check (source_kind in ('message', 'run', 'manager', 'consolidation')),
  source_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(source_metadata) = 'object'),
  source_tombstoned_at timestamptz,
  created_at timestamptz not null default now()
);

create index bot_memory_sources_version_idx
  on public.bot_memory_sources (memory_version_id, created_at, id);
create index bot_memory_sources_channel_idx
  on public.bot_memory_sources (channel_id, created_at, id)
  where channel_id is not null;
create index bot_memory_sources_run_idx
  on public.bot_memory_sources (run_id)
  where run_id is not null;
create index bot_memory_sources_message_idx
  on public.bot_memory_sources (message_id)
  where message_id is not null;

create table public.bot_library_sources (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bots(id) on delete cascade,
  descriptor jsonb not null check (jsonb_typeof(descriptor) = 'object'),
  exclusions jsonb not null default '{}'::jsonb check (jsonb_typeof(exclusions) = 'object'),
  provenance jsonb not null default '{}'::jsonb check (jsonb_typeof(provenance) = 'object'),
  host_path_envelope jsonb
    check (host_path_envelope is null or jsonb_typeof(host_path_envelope) = 'object'),
  current_published_version_id uuid,
  created_by uuid not null references public.user_profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  retired_at timestamptz,
  constraint bot_library_sources_bot_id_id_key unique (bot_id, id)
);

create index bot_library_sources_bot_active_idx
  on public.bot_library_sources (bot_id, updated_at desc, id desc)
  where retired_at is null;

create table public.bot_library_versions (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.bot_library_sources(id) on delete cascade,
  version_number bigint not null check (version_number > 0),
  manifest_envelope jsonb not null check (jsonb_typeof(manifest_envelope) = 'object'),
  diff_envelope jsonb check (diff_envelope is null or jsonb_typeof(diff_envelope) = 'object'),
  object_ids uuid[] not null default '{}',
  published_by uuid not null references public.user_profiles(id) on delete restrict,
  published_at timestamptz not null default now(),
  constraint bot_library_versions_source_number_key unique (source_id, version_number),
  constraint bot_library_versions_source_id_id_key unique (source_id, id)
);

alter table public.bot_library_sources
  add constraint bot_library_sources_current_version_fkey
  foreign key (id, current_published_version_id)
  references public.bot_library_versions(source_id, id)
  on delete no action
  deferrable initially deferred;

create index bot_library_versions_published_idx
  on public.bot_library_versions (source_id, published_at desc, id desc);

create table public.bot_audit_events (
  id bigint generated always as identity primary key,
  event_id uuid not null unique,
  bot_id uuid references public.bots(id) on delete set null,
  actor_user_id uuid references public.user_profiles(id) on delete set null,
  target_type text not null check (char_length(btrim(target_type)) between 1 and 120),
  target_id text check (target_id is null or char_length(target_id) <= 512),
  action text not null check (char_length(btrim(action)) between 1 and 160),
  result text not null check (result in ('success', 'failure', 'denied', 'partial', 'unknown')),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 16384),
  created_at timestamptz not null default now()
);

create index bot_audit_events_time_idx
  on public.bot_audit_events (created_at desc, id desc);
create index bot_audit_events_bot_time_idx
  on public.bot_audit_events (bot_id, created_at desc, id desc)
  where bot_id is not null;
create index bot_audit_events_target_time_idx
  on public.bot_audit_events (target_type, target_id, created_at desc, id desc);
create index bot_audit_events_actor_time_idx
  on public.bot_audit_events (actor_user_id, created_at desc, id desc)
  where actor_user_id is not null;

create table public.bot_eval_cases (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bots(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 160),
  input_envelope jsonb not null check (jsonb_typeof(input_envelope) = 'object'),
  expected_outcome jsonb not null check (jsonb_typeof(expected_outcome) = 'object'),
  created_by uuid not null references public.user_profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index bot_eval_cases_bot_active_idx
  on public.bot_eval_cases (bot_id, updated_at desc, id desc)
  where archived_at is null;

create table public.bot_eval_runs (
  id uuid primary key default gen_random_uuid(),
  eval_case_id uuid not null references public.bot_eval_cases(id) on delete cascade,
  revision_id uuid not null references public.bot_revisions(id) on delete restrict,
  mode text not null check (mode in ('simulation', 'live_canary')),
  state text not null default 'queued'
    check (state in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  result jsonb check (result is null or jsonb_typeof(result) = 'object'),
  initiated_by uuid not null references public.user_profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  constraint bot_eval_runs_finished_time_check check (
    finished_at is null
    or (started_at is not null and finished_at >= started_at)
  )
);

create index bot_eval_runs_case_created_idx
  on public.bot_eval_runs (eval_case_id, created_at desc, id desc);
create index bot_eval_runs_revision_idx on public.bot_eval_runs (revision_id);

-- Cross-table integrity for private channels and ACLs. The service remains the
-- authorization owner, while these triggers prevent invalid rows from being
-- persisted by a buggy service mutation.
create or replace function public.devryan_validate_bot_channel_owner()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.lifecycle = 'active' and not exists (
    select 1
    from public.bot_memberships membership
    where membership.bot_id = new.bot_id
      and membership.user_id = new.owner_user_id
      and membership.revoked_at is null
  ) then
    raise exception using
      errcode = '23514',
      message = 'active Bot channel owner must be an active Bot member';
  end if;
  return new;
end;
$$;

create trigger bot_channels_validate_owner
before insert or update of bot_id, owner_user_id, lifecycle
on public.bot_channels
for each row execute function public.devryan_validate_bot_channel_owner();

create or replace function public.devryan_validate_bot_channel_acl()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  channel_bot_id uuid;
  channel_owner_user_id uuid;
begin
  if new.revoked_at is not null then return new; end if;

  select channel.bot_id, channel.owner_user_id
    into channel_bot_id, channel_owner_user_id
  from public.bot_channels channel
  where channel.id = new.channel_id;

  if channel_bot_id is null then
    raise exception using errcode = '23503', message = 'Bot channel does not exist';
  end if;
  if new.user_id = channel_owner_user_id then
    raise exception using errcode = '23514', message = 'Bot channel owner ACL is implicit';
  end if;
  if not exists (
    select 1
    from public.bot_memberships membership
    where membership.bot_id = channel_bot_id
      and membership.user_id = new.user_id
      and membership.revoked_at is null
  ) then
    raise exception using
      errcode = '23514',
      message = 'Bot channel ACL requires an active Bot member';
  end if;
  return new;
end;
$$;

create trigger bot_channel_acl_validate_membership
before insert or update of channel_id, user_id, revoked_at
on public.bot_channel_acl
for each row execute function public.devryan_validate_bot_channel_acl();

-- Activated revisions are immutable except for their one retirement stamp.
create or replace function public.devryan_protect_activated_bot_revision()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.activated_at is not null then
    if new.id is distinct from old.id
      or new.bot_id is distinct from old.bot_id
      or new.revision_number is distinct from old.revision_number
      or new.contract is distinct from old.contract
      or new.compiled_hash is distinct from old.compiled_hash
      or new.created_by is distinct from old.created_by
      or new.created_at is distinct from old.created_at
      or new.activated_at is distinct from old.activated_at then
      raise exception using errcode = '23514', message = 'activated Bot revision content is immutable';
    end if;
    if old.retired_at is not null and new.retired_at is distinct from old.retired_at then
      raise exception using errcode = '23514', message = 'Bot revision retirement metadata is immutable once set';
    end if;
  elsif new.retired_at is not null then
    raise exception using errcode = '23514', message = 'Draft Bot revision cannot be retired';
  end if;
  return new;
end;
$$;

create trigger bot_revisions_protect_activated
before update on public.bot_revisions
for each row execute function public.devryan_protect_activated_bot_revision();

-- Membership mutations serialize per Bot so concurrent revocations cannot
-- remove every Manager. Global administrators still use the service boundary;
-- the database invariant is intentionally role-agnostic.
create or replace function public.devryan_preserve_final_bot_manager()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  active_manager_removed boolean;
begin
  if tg_op = 'DELETE' then
    active_manager_removed := old.role = 'manager' and old.revoked_at is null;
  else
    active_manager_removed := old.role = 'manager'
      and old.revoked_at is null
      and (new.role <> 'manager' or new.revoked_at is not null);
  end if;

  if not active_manager_removed then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(old.bot_id::text, 0)
  );
  if not exists (
    select 1
    from public.bot_memberships membership
    where membership.bot_id = old.bot_id
      and membership.user_id <> old.user_id
      and membership.role = 'manager'
      and membership.revoked_at is null
  ) then
    raise exception using errcode = '23514', message = 'Bot must retain at least one active Manager';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger bot_memberships_preserve_final_manager
before update of role, revoked_at or delete on public.bot_memberships
for each row execute function public.devryan_preserve_final_bot_manager();

-- Assistant checkpoint bodies may coalesce before finalization. Identity is
-- always fixed and a finalized message is completely immutable.
create or replace function public.devryan_protect_bot_message()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
    or new.channel_id is distinct from old.channel_id
    or new.run_id is distinct from old.run_id
    or new.actor_user_id is distinct from old.actor_user_id
    or new.role is distinct from old.role
    or new.sequence is distinct from old.sequence
    or new.created_at is distinct from old.created_at then
    raise exception using errcode = '23514', message = 'Bot message identity is immutable';
  end if;
  if old.finalized_at is not null and new is distinct from old then
    raise exception using errcode = '23514', message = 'finalized Bot message is immutable';
  end if;
  return new;
end;
$$;

create trigger bot_messages_protect_finalized
before update on public.bot_messages
for each row execute function public.devryan_protect_bot_message();

create or replace function public.devryan_reject_bot_record_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using errcode = '23514', message = format('%s records are immutable', tg_table_name);
end;
$$;

create trigger bot_approvals_immutable
before update on public.bot_approvals
for each row execute function public.devryan_reject_bot_record_update();
create trigger bot_memory_versions_immutable
before update on public.bot_memory_versions
for each row execute function public.devryan_reject_bot_record_update();
create trigger bot_library_versions_immutable
before update on public.bot_library_versions
for each row execute function public.devryan_reject_bot_record_update();

create or replace function public.devryan_guard_bot_audit_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and current_setting('devryan.bot_audit_prune', true) = 'on' then
    return old;
  end if;
  raise exception using errcode = '23514', message = 'Bot audit events are append-only';
end;
$$;

create trigger bot_audit_events_append_only
before update or delete on public.bot_audit_events
for each row execute function public.devryan_guard_bot_audit_mutation();

-- Mutable control/state rows share the existing monotonic updated_at trigger.
do $$
declare
  relation_name text;
begin
  foreach relation_name in array array[
    'bots',
    'bot_revisions',
    'bot_memberships',
    'bot_channels',
    'bot_channel_acl',
    'bot_credentials',
    'bot_runs',
    'bot_objects',
    'bot_action_attempts',
    'bot_routines',
    'bot_routine_occurrences',
    'bot_memories',
    'bot_library_sources',
    'bot_eval_cases',
    'bot_eval_runs'
  ] loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.devryan_set_updated_at()',
      relation_name || '_updated_at',
      relation_name
    );
  end loop;
end $$;

create or replace function public.devryan_allocate_bot_message_sequence(
  p_channel_id uuid
)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  allocated_sequence bigint;
begin
  update public.bot_channels
  set next_message_sequence = next_message_sequence + 1
  where id = p_channel_id
  returning next_message_sequence - 1 into allocated_sequence;

  if allocated_sequence is null then
    raise exception using errcode = 'P0002', message = 'Bot channel not found';
  end if;
  return allocated_sequence;
end;
$$;

create or replace function public.devryan_enqueue_bot_message_run(
  p_message_id uuid,
  p_run_id uuid,
  p_bot_id uuid,
  p_channel_id uuid,
  p_revision_id uuid,
  p_idempotency_key text,
  p_model_snapshot jsonb,
  p_context_snapshot jsonb,
  p_computer_scope text,
  p_actor_user_id uuid,
  p_body_envelope jsonb,
  p_attachment_count integer,
  p_finalized_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing_message public.bot_messages%rowtype;
  existing_run public.bot_runs%rowtype;
  created_message public.bot_messages%rowtype;
  created_run public.bot_runs%rowtype;
  allocated_sequence bigint;
begin
  if char_length(btrim(coalesce(p_idempotency_key, ''))) = 0
    or char_length(btrim(coalesce(p_computer_scope, ''))) = 0
    or p_actor_user_id is null
    or p_finalized_at is null
    or coalesce(p_attachment_count, -1) < 0
    or p_model_snapshot is null
    or jsonb_typeof(p_model_snapshot) <> 'object'
    or p_context_snapshot is null
    or jsonb_typeof(p_context_snapshot) <> 'object'
    or p_body_envelope is null
    or jsonb_typeof(p_body_envelope) <> 'object' then
    raise exception using errcode = '22023', message = 'Bot message/run admission is invalid';
  end if;

  select * into existing_message
  from public.bot_messages
  where id = p_message_id;

  if found then
    select * into existing_run
    from public.bot_runs
    where id = existing_message.run_id;
    if existing_message.channel_id <> p_channel_id
      or existing_message.actor_user_id <> p_actor_user_id
      or existing_message.role <> 'user'
      or existing_run.id is null
      or existing_run.bot_id <> p_bot_id
      or existing_run.channel_id <> p_channel_id
      or existing_run.revision_id <> p_revision_id
      or existing_run.idempotency_key <> p_idempotency_key
      or existing_run.computer_scope_key <> p_computer_scope then
      raise exception using errcode = '23505', message = 'Bot message idempotency conflict';
    end if;
    return jsonb_build_object(
      'created', false,
      'message', to_jsonb(existing_message),
      'run', to_jsonb(existing_run)
    );
  end if;

  select * into existing_run
  from public.bot_runs
  where channel_id = p_channel_id
    and idempotency_key = p_idempotency_key;
  if found then
    select * into existing_message
    from public.bot_messages
    where run_id = existing_run.id
      and role = 'user'
    order by sequence
    limit 1;
    if existing_message.id = p_message_id
      and existing_message.actor_user_id = p_actor_user_id then
      return jsonb_build_object(
        'created', false,
        'message', to_jsonb(existing_message),
        'run', to_jsonb(existing_run)
      );
    end if;
    raise exception using errcode = '23505', message = 'Bot run idempotency conflict';
  end if;

  update public.bot_channels
  set next_message_sequence = next_message_sequence + 1,
      last_message_at = greatest(coalesce(last_message_at, p_finalized_at), p_finalized_at)
  where id = p_channel_id
    and bot_id = p_bot_id
    and lifecycle = 'active'
  returning next_message_sequence - 1 into allocated_sequence;
  if allocated_sequence is null then
    raise exception using errcode = 'P0002', message = 'Active Bot channel not found';
  end if;

  insert into public.bot_runs (
    id,
    bot_id,
    channel_id,
    revision_id,
    idempotency_key,
    model_snapshot,
    context_snapshot,
    computer_scope_key,
    state
  ) values (
    p_run_id,
    p_bot_id,
    p_channel_id,
    p_revision_id,
    p_idempotency_key,
    p_model_snapshot,
    p_context_snapshot,
    p_computer_scope,
    'queued'
  )
  returning * into created_run;

  insert into public.bot_messages (
    id,
    channel_id,
    run_id,
    actor_user_id,
    role,
    sequence,
    body_envelope,
    attachment_count,
    finalized_at
  ) values (
    p_message_id,
    p_channel_id,
    p_run_id,
    p_actor_user_id,
    'user',
    allocated_sequence,
    p_body_envelope,
    p_attachment_count,
    p_finalized_at
  )
  returning * into created_message;

  return jsonb_build_object(
    'created', true,
    'message', to_jsonb(created_message),
    'run', to_jsonb(created_run)
  );
end;
$$;

create or replace function public.devryan_claim_bot_run(
  p_computer_scope text,
  p_runtime_owner text,
  p_lease_until timestamptz
)
returns setof public.bot_runs
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if char_length(btrim(coalesce(p_computer_scope, ''))) = 0
    or char_length(btrim(coalesce(p_runtime_owner, ''))) = 0 then
    raise exception using errcode = '22023', message = 'computer scope and runtime owner are required';
  end if;
  if p_lease_until is null or p_lease_until <= now() then
    raise exception using errcode = '22023', message = 'lease expiry must be in the future';
  end if;

  -- Serialize only contenders for the same scope. SKIP LOCKED then protects the
  -- selected queue row without letting another owner claim a later row in that scope.
  perform pg_advisory_xact_lock(hashtextextended(p_computer_scope, 0));
  if exists (
    select 1
    from public.bot_runs active_run
    where active_run.computer_scope_key = p_computer_scope
      and active_run.state in ('starting', 'running', 'waiting_approval', 'needs_reconciliation')
  ) then
    return;
  end if;

  return query
  with candidate as (
    select queued.id
    from public.bot_runs queued
    where queued.computer_scope_key = p_computer_scope
      and queued.state = 'queued'
    order by queued.queue_sequence
    limit 1
    for update skip locked
  )
  update public.bot_runs claimed
  set state = 'starting',
      lease_owner = p_runtime_owner,
      lease_until = p_lease_until,
      lease_generation = claimed.lease_generation + 1,
      started_at = coalesce(claimed.started_at, now())
  from candidate
  where claimed.id = candidate.id
  returning claimed.*;
end;
$$;

create or replace function public.devryan_claim_bot_routine_occurrence(
  p_routine_id uuid,
  p_scheduled_for timestamptz,
  p_occurrence_id uuid
)
returns setof public.bot_routine_occurrences
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_routine_id is null or p_scheduled_for is null or p_occurrence_id is null then
    raise exception using errcode = '22023', message = 'routine, occurrence, and scheduled time are required';
  end if;

  return query
  insert into public.bot_routine_occurrences (
    id,
    routine_id,
    scheduled_for,
    claimed_by
  ) values (
    p_occurrence_id,
    p_routine_id,
    p_scheduled_for,
    'routine-scheduler'
  )
  on conflict (routine_id, scheduled_for) do update
    set scheduled_for = excluded.scheduled_for
  returning *;
end;
$$;

create or replace function public.devryan_create_bot(
  p_bot_id uuid,
  p_revision_id uuid,
  p_name text,
  p_tenancy text,
  p_contract jsonb,
  p_compiled_hash text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  created_bot public.bots%rowtype;
  created_revision public.bot_revisions%rowtype;
  created_membership public.bot_memberships%rowtype;
begin
  insert into public.bots (
    id, name, lifecycle, tenancy, active_revision_id, created_by
  ) values (
    p_bot_id, p_name, 'draft', p_tenancy, null, p_actor_id
  ) returning * into created_bot;

  insert into public.bot_revisions (
    id, bot_id, revision_number, contract, compiled_hash, created_by
  ) values (
    p_revision_id, p_bot_id, 1, p_contract, p_compiled_hash, p_actor_id
  ) returning * into created_revision;

  insert into public.bot_memberships (
    bot_id, user_id, role, assigned_by
  ) values (
    p_bot_id, p_actor_id, 'manager', p_actor_id
  ) returning * into created_membership;

  return pg_catalog.jsonb_build_object(
    'bot', pg_catalog.to_jsonb(created_bot),
    'revision', pg_catalog.to_jsonb(created_revision),
    'membership', pg_catalog.to_jsonb(created_membership)
  );
end;
$$;

create or replace function public.devryan_activate_bot_revision(
  p_bot_id uuid,
  p_revision_id uuid,
  p_actor_id uuid
)
returns setof public.bots
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_revision public.bot_revisions%rowtype;
  target_bot public.bots%rowtype;
begin
  select * into target_bot
  from public.bots
  where id = p_bot_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Bot not found';
  end if;
  if target_bot.lifecycle = 'retired' then
    raise exception using errcode = '23514', message = 'retired Bot cannot activate a revision';
  end if;
  if not exists (
    select 1
    from public.bot_memberships membership
    where membership.bot_id = p_bot_id
      and membership.user_id = p_actor_id
      and membership.role = 'manager'
      and membership.revoked_at is null
  ) and not exists (
    select 1
    from public.user_profiles profile
    where profile.id = p_actor_id
      and profile.role = 'admin'
      and profile.status = 'active'
  ) then
    raise exception using
      errcode = '42501',
      message = 'active Bot Manager or global administrator required';
  end if;

  select * into target_revision
  from public.bot_revisions
  where id = p_revision_id and bot_id = p_bot_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Bot revision not found';
  end if;
  if target_revision.retired_at is not null then
    raise exception using errcode = '23514', message = 'retired Bot revision cannot be reactivated';
  end if;

  update public.bot_revisions
  set retired_at = now()
  where bot_id = p_bot_id
    and id <> p_revision_id
    and activated_at is not null
    and retired_at is null;

  update public.bot_revisions
  set activated_at = coalesce(activated_at, now())
  where id = p_revision_id;

  return query
  update public.bots bot
  set active_revision_id = p_revision_id,
      lifecycle = case when bot.lifecycle = 'draft' then 'active' else bot.lifecycle end,
      name = coalesce(nullif(btrim(target_revision.contract #>> '{identity,title}'), ''), bot.name),
      tenancy = case
        when target_revision.contract->>'tenancy' in ('team', 'personalized')
          then target_revision.contract->>'tenancy'
        else bot.tenancy
      end
  where bot.id = p_bot_id
  returning bot.*;
end;
$$;

create or replace function public.devryan_commit_bot_memory_version(
  p_memory_id uuid,
  p_version_id uuid,
  p_source_id uuid,
  p_bot_id uuid,
  p_scope text,
  p_subject_user_id uuid,
  p_logical_key text,
  p_encrypted_content jsonb,
  p_sensitivity text,
  p_confidence numeric,
  p_classifier_metadata jsonb,
  p_creator_kind text,
  p_created_by uuid,
  p_channel_id uuid,
  p_run_id uuid,
  p_message_id uuid,
  p_source_kind text,
  p_source_metadata jsonb,
  p_expected_updated_at timestamptz
)
returns table(memory jsonb, version jsonb, source jsonb, activated boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_memory public.bot_memories%rowtype;
  inserted_version public.bot_memory_versions%rowtype;
  inserted_source public.bot_memory_sources%rowtype;
  next_version_number bigint;
  created_memory boolean := false;
  should_activate boolean := false;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    p_bot_id::text || ':' || p_scope || ':' || coalesce(p_subject_user_id::text, '') || ':' || p_logical_key,
    0
  ));

  select * into target_memory
  from public.bot_memories candidate
  where candidate.bot_id = p_bot_id
    and candidate.scope = p_scope
    and candidate.logical_key = p_logical_key
    and candidate.subject_user_id is not distinct from p_subject_user_id
  for update;

  if not found then
    if p_expected_updated_at is not null then
      raise exception using errcode = '40001', message = 'Bot memory changed before version commit';
    end if;
    insert into public.bot_memories (
      id,
      bot_id,
      scope,
      subject_user_id,
      logical_key,
      encrypted_content,
      sensitivity,
      confidence
    ) values (
      p_memory_id,
      p_bot_id,
      p_scope,
      p_subject_user_id,
      p_logical_key,
      p_encrypted_content,
      p_sensitivity,
      p_confidence
    )
    returning * into target_memory;
    created_memory := true;
  elsif target_memory.id <> p_memory_id then
    raise exception using errcode = '40001', message = 'Bot memory identity changed before version commit';
  end if;

  select coalesce(max(existing.version_number), 0) + 1
  into next_version_number
  from public.bot_memory_versions existing
  where existing.memory_id = target_memory.id;

  insert into public.bot_memory_versions (
    id,
    memory_id,
    version_number,
    encrypted_content,
    classifier_metadata,
    creator_kind,
    created_by
  ) values (
    p_version_id,
    target_memory.id,
    next_version_number,
    p_encrypted_content,
    p_classifier_metadata,
    p_creator_kind,
    p_created_by
  )
  returning * into inserted_version;

  should_activate := created_memory
    or (p_expected_updated_at is not null and target_memory.updated_at = p_expected_updated_at);
  if should_activate then
    update public.bot_memories current_memory
    set encrypted_content = p_encrypted_content,
        sensitivity = p_sensitivity,
        confidence = p_confidence,
        active_version_id = inserted_version.id,
        tombstoned_at = null
    where current_memory.id = target_memory.id
    returning * into target_memory;
  end if;

  insert into public.bot_memory_sources (
    id,
    memory_version_id,
    channel_id,
    run_id,
    message_id,
    source_kind,
    source_metadata
  ) values (
    p_source_id,
    inserted_version.id,
    p_channel_id,
    p_run_id,
    p_message_id,
    p_source_kind,
    p_source_metadata
  )
  returning * into inserted_source;

  return query select
    to_jsonb(target_memory),
    to_jsonb(inserted_version),
    to_jsonb(inserted_source),
    should_activate;
end;
$$;

create or replace function public.devryan_delete_bot_channel(
  p_channel_id uuid,
  p_actor_id uuid
)
returns table(
  deleted_private_memories bigint,
  retained_shared_memories bigint,
  deleted_messages bigint
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_channel public.bot_channels%rowtype;
  private_count bigint := 0;
  shared_count bigint := 0;
  message_count bigint := 0;
begin
  select * into target_channel
  from public.bot_channels channel_row
  where channel_row.id = p_channel_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Bot channel not found';
  end if;
  if target_channel.owner_user_id <> p_actor_id then
    raise exception using errcode = '42501', message = 'Bot channel owner required';
  end if;
  if exists (
    select 1 from public.bot_runs active_run
    where active_run.channel_id = p_channel_id
      and active_run.state in ('queued', 'starting', 'running', 'waiting_approval', 'needs_reconciliation')
  ) then
    raise exception using errcode = '23514', message = 'Bot channel has unfinished runs';
  end if;

  select count(*) into message_count
  from public.bot_messages message_row
  where message_row.channel_id = p_channel_id;

  select count(distinct shared_memory.id) into shared_count
  from public.bot_memory_sources memory_source
  join public.bot_memory_versions memory_version on memory_version.id = memory_source.memory_version_id
  join public.bot_memories shared_memory on shared_memory.id = memory_version.memory_id
  where memory_source.channel_id = p_channel_id
    and shared_memory.scope = 'shared';

  update public.bot_memory_sources memory_source
  set source_tombstoned_at = coalesce(memory_source.source_tombstoned_at, now()),
      source_metadata = memory_source.source_metadata || jsonb_build_object('channelDeleted', true)
  from public.bot_memory_versions memory_version,
       public.bot_memories shared_memory
  where memory_source.channel_id = p_channel_id
    and memory_version.id = memory_source.memory_version_id
    and shared_memory.id = memory_version.memory_id
    and shared_memory.scope = 'shared';

  delete from public.bot_memories private_memory
  where private_memory.scope = 'user_private'
    and exists (
      select 1
      from public.bot_memory_versions memory_version
      join public.bot_memory_sources memory_source
        on memory_source.memory_version_id = memory_version.id
      where memory_version.memory_id = private_memory.id
        and memory_source.channel_id = p_channel_id
    );
  get diagnostics private_count = row_count;

  delete from public.bot_channels channel_row
  where channel_row.id = p_channel_id;

  return query select private_count, shared_count, message_count;
end;
$$;

create or replace function public.devryan_prune_bot_audit(
  p_retain_after timestamptz default (now() - interval '1 year')
)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  deleted_count bigint;
  previous_guard text;
begin
  if p_retain_after is null then
    raise exception using errcode = '22023', message = 'audit retention cutoff is required';
  end if;
  if p_retain_after > now() - interval '30 days' then
    raise exception using errcode = '22023', message = 'Bot audit retention cannot be shorter than 30 days';
  end if;

  previous_guard := current_setting('devryan.bot_audit_prune', true);
  perform set_config('devryan.bot_audit_prune', 'on', true);
  delete from public.bot_audit_events
  where created_at < p_retain_after;
  get diagnostics deleted_count = row_count;
  perform set_config('devryan.bot_audit_prune', coalesce(previous_guard, ''), true);
  return deleted_count;
end;
$$;

-- The bucket name and stored object names are opaque metadata. File bytes and
-- logical keys are encrypted before upload; no browser Storage policy is added.
insert into storage.buckets (id, name, public)
values ('devryan-bot-objects', 'devryan-bot-objects', false)
on conflict (id) do update
set name = excluded.name,
    public = false;

-- Defense in depth: all Bot relations are forced-RLS with no policies and only
-- service_role table privileges. Explicit grants avoid relying on changing
-- Supabase Data API exposure defaults.
do $$
declare
  relation_name text;
begin
  foreach relation_name in array array[
    'bots',
    'bot_revisions',
    'bot_memberships',
    'bot_channels',
    'bot_channel_acl',
    'bot_messages',
    'bot_objects',
    'bot_runs',
    'bot_action_attempts',
    'bot_approvals',
    'bot_credentials',
    'bot_routines',
    'bot_routine_occurrences',
    'bot_memories',
    'bot_memory_versions',
    'bot_memory_sources',
    'bot_library_sources',
    'bot_library_versions',
    'bot_audit_events',
    'bot_eval_cases',
    'bot_eval_runs'
  ] loop
    execute format('alter table public.%I enable row level security', relation_name);
    execute format('alter table public.%I force row level security', relation_name);
    execute format('revoke all on table public.%I from public, anon, authenticated', relation_name);
    execute format('grant all on table public.%I to service_role', relation_name);
  end loop;
end $$;

revoke all on sequence public.bot_runs_queue_sequence_seq from public, anon, authenticated;
grant usage, select on sequence public.bot_runs_queue_sequence_seq to service_role;
revoke all on sequence public.bot_audit_events_id_seq from public, anon, authenticated;
grant usage, select on sequence public.bot_audit_events_id_seq to service_role;

do $$
declare
  function_signature text;
begin
  foreach function_signature in array array[
    'public.devryan_validate_bot_channel_owner()',
    'public.devryan_validate_bot_channel_acl()',
    'public.devryan_protect_activated_bot_revision()',
    'public.devryan_preserve_final_bot_manager()',
    'public.devryan_protect_bot_message()',
    'public.devryan_reject_bot_record_update()',
    'public.devryan_guard_bot_audit_mutation()',
    'public.devryan_allocate_bot_message_sequence(uuid)',
    'public.devryan_enqueue_bot_message_run(uuid,uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,uuid,jsonb,integer,timestamp with time zone)',
    'public.devryan_claim_bot_run(text,text,timestamp with time zone)',
    'public.devryan_claim_bot_routine_occurrence(uuid,timestamp with time zone,uuid)',
    'public.devryan_create_bot(uuid,uuid,text,text,jsonb,text,uuid)',
    'public.devryan_activate_bot_revision(uuid,uuid,uuid)',
    'public.devryan_commit_bot_memory_version(uuid,uuid,uuid,uuid,text,uuid,text,jsonb,text,numeric,jsonb,text,uuid,uuid,uuid,uuid,text,jsonb,timestamp with time zone)',
    'public.devryan_delete_bot_channel(uuid,uuid)',
    'public.devryan_prune_bot_audit(timestamp with time zone)'
  ] loop
    execute format(
      'revoke all on function %s from public, anon, authenticated',
      function_signature
    );
  end loop;
end $$;

grant execute on function public.devryan_allocate_bot_message_sequence(uuid) to service_role;
grant execute on function public.devryan_enqueue_bot_message_run(
  uuid, uuid, uuid, uuid, uuid, text, jsonb, jsonb, text, uuid, jsonb, integer, timestamptz
) to service_role;
grant execute on function public.devryan_claim_bot_run(text, text, timestamptz) to service_role;
grant execute on function public.devryan_claim_bot_routine_occurrence(uuid, timestamptz, uuid) to service_role;
grant execute on function public.devryan_create_bot(uuid, uuid, text, text, jsonb, text, uuid) to service_role;
grant execute on function public.devryan_activate_bot_revision(uuid, uuid, uuid) to service_role;
grant execute on function public.devryan_commit_bot_memory_version(
  uuid, uuid, uuid, uuid, text, uuid, text, jsonb, text, numeric, jsonb, text,
  uuid, uuid, uuid, uuid, text, jsonb, timestamptz
) to service_role;
grant execute on function public.devryan_delete_bot_channel(uuid, uuid) to service_role;
grant execute on function public.devryan_prune_bot_audit(timestamptz) to service_role;

comment on table public.bots is
  'Service-only deployment/team Bot catalog. Bots are not repository or worktree entities.';
comment on table public.bot_channels is
  'Service-only continuous private user/Bot channels with encrypted summaries.';
comment on table public.bot_messages is
  'Service-only encrypted canonical Bot timeline; finalized rows are immutable.';
comment on table public.bot_credentials is
  'Non-secret Bot credential metadata. Secret bytes remain in the local OS-sealed vault.';
comment on table public.bot_audit_events is
  'Append-only sanitized Production Bots audit ledger; no transcript, secret, frame, or host path.';
comment on function public.devryan_claim_bot_run(text, text, timestamptz) is
  'Atomically claims the FIFO queued run for one computer scope without admitting concurrent ownership.';
comment on function public.devryan_commit_bot_memory_version(
  uuid, uuid, uuid, uuid, text, uuid, text, jsonb, text, numeric, jsonb, text,
  uuid, uuid, uuid, uuid, text, jsonb, timestamptz
) is 'Serializes immutable memory versions and activates them only against the captured current revision.';
comment on function public.devryan_delete_bot_channel(uuid, uuid) is
  'Owner-only channel deletion that removes private memory while tombstoning provenance and retaining shared learning.';
comment on function public.devryan_prune_bot_audit(timestamptz) is
  'Prunes Bot audit history older than the requested cutoff with a hard 30-day minimum and one-year default.';
