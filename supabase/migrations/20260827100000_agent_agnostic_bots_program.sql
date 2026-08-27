-- Agent-agnostic Production Bots foundations.
--
-- This migration is intentionally additive. Existing OpenCode execution
-- columns and revision contracts remain authoritative for legacy rows while
-- the generic projections are populated by new runtime code.

alter table public.bot_runs
  add column agent_adapter text null
    check (agent_adapter is null or agent_adapter in ('opencode', 'ag_ui')),
  add column agent_thread_id text null
    check (
      agent_thread_id is null
      or char_length(agent_thread_id) between 1 and 512
    ),
  add column agent_execution jsonb null
    check (agent_execution is null or jsonb_typeof(agent_execution) = 'object');

update public.bot_runs
set
  agent_adapter = 'opencode',
  agent_thread_id = opencode_session_id,
  agent_execution = jsonb_strip_nulls(jsonb_build_object(
    'version', 1,
    'adapter', 'opencode',
    'threadId', opencode_session_id,
    'segmentId', opencode_segment_id,
    'checkpointVersion', 1
  ))
where (opencode_session_id is not null or opencode_segment_id is not null)
  and agent_adapter is null;

create index bot_runs_agent_thread_idx
  on public.bot_runs (agent_adapter, agent_thread_id)
  where agent_adapter is not null and agent_thread_id is not null;

alter table public.bot_revisions
  add column portable_spec jsonb null
    check (portable_spec is null or jsonb_typeof(portable_spec) = 'object'),
  add column spec_hash text null
    check (spec_hash is null or spec_hash ~ '^[0-9a-f]{64}$');

alter table public.bot_action_attempts
  add column matcher_version integer null
    check (matcher_version is null or matcher_version in (1, 2)),
  add column policy_facts_digest text null
    check (
      policy_facts_digest is null
      or policy_facts_digest ~ '^[0-9a-f]{64}$'
    ),
  add column authoritative_actor_role text null
    check (
      authoritative_actor_role is null
      or authoritative_actor_role in ('member', 'operator', 'manager')
    ),
  add column quota_binding jsonb null
    check (quota_binding is null or jsonb_typeof(quota_binding) = 'object');

alter table public.bot_approvals
  add column matcher_version integer null
    check (matcher_version is null or matcher_version in (1, 2)),
  add column policy_facts_digest text null
    check (
      policy_facts_digest is null
      or policy_facts_digest ~ '^[0-9a-f]{64}$'
    ),
  add column authoritative_actor_role text null
    check (
      authoritative_actor_role is null
      or authoritative_actor_role in ('member', 'operator', 'manager')
    ),
  add column quota_binding jsonb null
    check (quota_binding is null or jsonb_typeof(quota_binding) = 'object');

create table public.bot_agent_connections (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bots(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  endpoint_url text not null check (
    endpoint_url ~ '^https://'
    and char_length(endpoint_url) between 9 and 2048
  ),
  protocol_version text not null default 'ag-ui/v1'
    check (protocol_version = 'ag-ui/v1'),
  auth_mode text not null check (auth_mode in ('none', 'bearer')),
  credential_id uuid null references public.bot_credentials(id) on delete restrict,
  model_hint text null check (
    model_hint is null or char_length(model_hint) between 1 and 256
  ),
  limits jsonb not null default '{}'::jsonb
    check (jsonb_typeof(limits) = 'object'),
  descriptor_digest text not null check (descriptor_digest ~ '^[0-9a-f]{64}$'),
  status text not null default 'active'
    check (status in ('active', 'error', 'revoked')),
  health jsonb null check (health is null or jsonb_typeof(health) = 'object'),
  created_by uuid not null references public.user_profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz null,
  constraint bot_agent_connections_auth_check check (
    (auth_mode = 'none' and credential_id is null)
    or (auth_mode = 'bearer' and credential_id is not null)
  ),
  constraint bot_agent_connections_revocation_check check (
    (status = 'revoked' and revoked_at is not null)
    or (status <> 'revoked' and revoked_at is null)
  ),
  unique (bot_id, id)
);

create unique index bot_agent_connections_active_name_idx
  on public.bot_agent_connections (bot_id, name)
  where revoked_at is null;

create table public.bot_revision_binding_resolutions (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references public.bot_revisions(id) on delete cascade,
  binding_kind text not null
    check (binding_kind in ('credential', 'agent_connection', 'skill', 'mcp', 'library')),
  logical_key text not null check (char_length(logical_key) between 1 and 256),
  portable_digest text not null check (portable_digest ~ '^[0-9a-f]{64}$'),
  local_resource_id uuid not null,
  resolved_digest text not null check (resolved_digest ~ '^[0-9a-f]{64}$'),
  resolved_by uuid not null references public.user_profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (revision_id, binding_kind, logical_key)
);

create table public.bot_revision_signatures (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references public.bot_revisions(id) on delete cascade,
  spec_hash text not null check (spec_hash ~ '^[0-9a-f]{64}$'),
  compiled_hash text not null check (compiled_hash ~ '^[0-9a-f]{64}$'),
  compiler_version integer not null check (compiler_version > 0),
  signer_key_id text not null check (char_length(signer_key_id) between 1 and 160),
  signer_public_key text not null check (char_length(signer_public_key) between 40 and 512),
  signature text not null check (char_length(signature) between 40 and 512),
  created_by uuid not null references public.user_profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (revision_id, spec_hash, signer_key_id)
);

create table public.bot_signer_trust (
  id uuid primary key default gen_random_uuid(),
  scope text not null
    constraint bot_signer_trust_scope_value_check
    check (scope in ('global', 'bot')),
  bot_id uuid null references public.bots(id) on delete cascade,
  signer_key_id text not null check (char_length(signer_key_id) between 1 and 160),
  signer_public_key text not null check (char_length(signer_public_key) between 40 and 512),
  status text not null default 'trusted' check (status in ('trusted', 'revoked')),
  trusted_by uuid not null references public.user_profiles(id) on delete restrict,
  trusted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz null,
  constraint bot_signer_trust_scope_check check (
    (scope = 'global' and bot_id is null)
    or (scope = 'bot' and bot_id is not null)
  ),
  constraint bot_signer_trust_revocation_check check (
    (status = 'revoked' and revoked_at is not null)
    or (status = 'trusted' and revoked_at is null)
  )
);

create unique index bot_signer_trust_identity_idx
  on public.bot_signer_trust (
    scope,
    coalesce(bot_id, '00000000-0000-0000-0000-000000000000'::uuid),
    signer_key_id
  );

create table public.bot_quota_buckets (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references public.bot_revisions(id) on delete cascade,
  rule_id text not null check (char_length(rule_id) between 1 and 120),
  quota_scope text not null check (quota_scope in ('actor', 'bot')),
  scope_key text not null check (char_length(scope_key) between 1 and 160),
  window_start timestamptz not null,
  window_end timestamptz not null,
  limit_count integer not null check (limit_count between 1 and 1000000),
  reserved_count integer not null default 0 check (reserved_count >= 0),
  consumed_count integer not null default 0 check (consumed_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bot_quota_buckets_window_check check (window_end > window_start),
  constraint bot_quota_buckets_capacity_check check (
    reserved_count + consumed_count <= limit_count
  ),
  unique (revision_id, rule_id, quota_scope, scope_key, window_start)
);

create index bot_quota_buckets_expiry_idx
  on public.bot_quota_buckets (window_end, revision_id);

create table public.bot_quota_reservations (
  id uuid primary key default gen_random_uuid(),
  bucket_id uuid not null references public.bot_quota_buckets(id) on delete cascade,
  action_attempt_id uuid not null references public.bot_action_attempts(id) on delete cascade,
  state text not null default 'reserved'
    constraint bot_quota_reservations_state_value_check
    check (state in ('reserved', 'consumed', 'released', 'expired')),
  reserved_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz null,
  released_at timestamptz null,
  constraint bot_quota_reservations_state_check check (
    (state = 'reserved' and consumed_at is null and released_at is null)
    or (state = 'consumed' and consumed_at is not null and released_at is null)
    or (state in ('released', 'expired') and consumed_at is null and released_at is not null)
  ),
  unique (bucket_id, action_attempt_id)
);

create index bot_quota_reservations_action_idx
  on public.bot_quota_reservations (action_attempt_id, state);
create index bot_quota_reservations_expiry_idx
  on public.bot_quota_reservations (expires_at)
  where state = 'reserved';

create or replace function public.devryan_reserve_bot_action_quotas(
  p_action_attempt_id uuid,
  p_revision_id uuid,
  p_actor_user_id uuid,
  p_bindings jsonb,
  p_now timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  binding jsonb;
  bucket public.bot_quota_buckets%rowtype;
  existing_reservation public.bot_quota_reservations%rowtype;
  reservation_id uuid;
  binding_count integer;
  result jsonb := '[]'::jsonb;
begin
  if p_action_attempt_id is null or p_revision_id is null or p_actor_user_id is null
    or p_now is null or jsonb_typeof(p_bindings) <> 'array' then
    raise exception using errcode = '22023', message = 'quota reservation input is invalid';
  end if;
  binding_count := jsonb_array_length(p_bindings);
  if binding_count > 256 then
    raise exception using errcode = '22023', message = 'too many quota bindings';
  end if;
  if not exists (
    select 1 from public.bot_action_attempts action
    where action.id = p_action_attempt_id
      and action.revision_id = p_revision_id
      and action.initiated_by = p_actor_user_id
      and action.state = 'proposed'
  ) then
    raise exception using errcode = '23514', message = 'quota action binding is invalid';
  end if;

  -- One advisory lock per revision makes multi-rule reservation all-or-nothing
  -- without deadlocks from overlapping rule sets. The transaction remains short.
  perform pg_advisory_xact_lock(hashtextextended(p_revision_id::text, 72191));

  for binding in
    select value
    from jsonb_array_elements(p_bindings)
    order by value->>'ruleId', value->>'scope', value->>'scopeKey', value->>'windowStart'
  loop
    if jsonb_typeof(binding) <> 'object'
      or (select array_agg(key order by key) from jsonb_object_keys(binding) key)
        is distinct from array[
          'limit', 'reservationId', 'ruleId', 'scope', 'scopeKey',
          'windowEnd', 'windowStart'
        ]::text[]
      or binding->>'scope' not in ('actor', 'bot')
      or (binding->>'limit')::integer < 1
      or (binding->>'limit')::integer > 1000000
      or (binding->>'windowEnd')::timestamptz <= (binding->>'windowStart')::timestamptz
      or p_now < (binding->>'windowStart')::timestamptz
      or p_now >= (binding->>'windowEnd')::timestamptz
      or char_length(binding->>'ruleId') not between 1 and 120
      or char_length(binding->>'scopeKey') not between 1 and 160 then
      raise exception using errcode = '22023', message = 'quota binding is invalid';
    end if;
    reservation_id := (binding->>'reservationId')::uuid;

    insert into public.bot_quota_buckets (
      revision_id, rule_id, quota_scope, scope_key, window_start, window_end, limit_count
    ) values (
      p_revision_id,
      binding->>'ruleId',
      binding->>'scope',
      binding->>'scopeKey',
      (binding->>'windowStart')::timestamptz,
      (binding->>'windowEnd')::timestamptz,
      (binding->>'limit')::integer
    )
    on conflict (revision_id, rule_id, quota_scope, scope_key, window_start) do nothing;

    select * into bucket
    from public.bot_quota_buckets quota_bucket
    where quota_bucket.revision_id = p_revision_id
      and quota_bucket.rule_id = binding->>'ruleId'
      and quota_bucket.quota_scope = binding->>'scope'
      and quota_bucket.scope_key = binding->>'scopeKey'
      and quota_bucket.window_start = (binding->>'windowStart')::timestamptz
    for update;

    if bucket.window_end <> (binding->>'windowEnd')::timestamptz
      or bucket.limit_count <> (binding->>'limit')::integer then
      raise exception using errcode = '23514', message = 'quota bucket contract changed';
    end if;

    with expired as (
      update public.bot_quota_reservations reservation
      set state = 'expired', released_at = p_now
      where reservation.bucket_id = bucket.id
        and reservation.state = 'reserved'
        and reservation.expires_at <= p_now
      returning 1
    )
    update public.bot_quota_buckets quota_bucket
    set reserved_count = greatest(0, quota_bucket.reserved_count - (select count(*) from expired))
    where quota_bucket.id = bucket.id;

    select * into bucket
    from public.bot_quota_buckets quota_bucket
    where quota_bucket.id = bucket.id
    for update;

    -- Retrying the same proposed action is recovery, not another reservation.
    -- The revision advisory lock makes this exact-ID check deterministic even
    -- when two gateway processes race after the durable action insert.
    select * into existing_reservation
    from public.bot_quota_reservations quota_reservation
    where quota_reservation.bucket_id = bucket.id
      and quota_reservation.action_attempt_id = p_action_attempt_id;
    if found then
      if existing_reservation.id <> reservation_id
        or existing_reservation.state <> 'reserved'
        or existing_reservation.expires_at <> (binding->>'windowEnd')::timestamptz then
        raise exception using errcode = '23514', message = 'quota reservation binding changed';
      end if;
      result := result || jsonb_build_array(jsonb_build_object(
        'reservationId', existing_reservation.id,
        'bucketId', bucket.id,
        'ruleId', bucket.rule_id,
        'windowStart', bucket.window_start,
        'windowEnd', bucket.window_end
      ));
      continue;
    end if;

    if bucket.reserved_count + bucket.consumed_count >= bucket.limit_count then
      raise exception using errcode = 'P0001', message = 'bot_quota_exhausted';
    end if;

    insert into public.bot_quota_reservations (
      id, bucket_id, action_attempt_id, state, reserved_at, expires_at
    ) values (
      reservation_id, bucket.id, p_action_attempt_id, 'reserved', p_now,
      (binding->>'windowEnd')::timestamptz
    );
    update public.bot_quota_buckets
    set reserved_count = reserved_count + 1
    where id = bucket.id;
    result := result || jsonb_build_array(jsonb_build_object(
      'reservationId', reservation_id,
      'bucketId', bucket.id,
      'ruleId', bucket.rule_id,
      'windowStart', bucket.window_start,
      'windowEnd', bucket.window_end
    ));
  end loop;
  return result;
exception
  when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then
    raise exception using errcode = '22023', message = 'quota binding is invalid';
end;
$$;

create or replace function public.devryan_consume_bot_action_quotas(
  p_action_attempt_id uuid,
  p_now timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  reservation public.bot_quota_reservations%rowtype;
  consumed jsonb := '[]'::jsonb;
begin
  if p_action_attempt_id is null or p_now is null then
    raise exception using errcode = '22023', message = 'quota consumption input is invalid';
  end if;
  for reservation in
    select quota_reservation.*
    from public.bot_quota_reservations quota_reservation
    where quota_reservation.action_attempt_id = p_action_attempt_id
    order by quota_reservation.bucket_id, quota_reservation.id
    for update
  loop
    if reservation.state = 'consumed' then
      consumed := consumed || to_jsonb(reservation.id);
      continue;
    end if;
    if reservation.state <> 'reserved' or reservation.expires_at <= p_now then
      raise exception using errcode = 'P0001', message = 'bot_quota_reservation_invalid';
    end if;
    update public.bot_quota_reservations
    set state = 'consumed', consumed_at = p_now
    where id = reservation.id;
    update public.bot_quota_buckets
    set reserved_count = greatest(0, reserved_count - 1),
        consumed_count = consumed_count + 1
    where id = reservation.bucket_id;
    consumed := consumed || to_jsonb(reservation.id);
  end loop;
  return consumed;
end;
$$;

create or replace function public.devryan_release_bot_action_quotas(
  p_action_attempt_id uuid,
  p_disposition text,
  p_now timestamptz
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  released_count integer := 0;
  bucket_count record;
begin
  if p_action_attempt_id is null or p_now is null
    or p_disposition not in ('released', 'expired') then
    raise exception using errcode = '22023', message = 'quota release input is invalid';
  end if;
  for bucket_count in
    with released as (
      update public.bot_quota_reservations
      set state = p_disposition,
          released_at = p_now
      where action_attempt_id = p_action_attempt_id
        and state = 'reserved'
      returning bucket_id
    )
    select bucket_id, count(*)::integer as total
    from released
    group by bucket_id
  loop
    update public.bot_quota_buckets
    set reserved_count = greatest(0, reserved_count - bucket_count.total)
    where id = bucket_count.bucket_id;
    released_count := released_count + bucket_count.total;
  end loop;
  return released_count;
end;
$$;

create or replace function public.devryan_reject_bot_immutable_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using errcode = '23514', message = 'immutable Bot record cannot be changed';
end;
$$;

create trigger bot_revision_binding_resolutions_immutable
before update or delete on public.bot_revision_binding_resolutions
for each row execute function public.devryan_reject_bot_immutable_change();

create trigger bot_revision_signatures_immutable
before update or delete on public.bot_revision_signatures
for each row execute function public.devryan_reject_bot_immutable_change();

create trigger bot_agent_connections_updated_at
before update on public.bot_agent_connections
for each row execute function public.devryan_set_updated_at();

create trigger bot_signer_trust_updated_at
before update on public.bot_signer_trust
for each row execute function public.devryan_set_updated_at();

create trigger bot_quota_buckets_updated_at
before update on public.bot_quota_buckets
for each row execute function public.devryan_set_updated_at();

-- Extend activated-revision immutability to the portable representation while
-- preserving the one allowed retirement stamp.
create or replace function public.devryan_protect_activated_bot_revision()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.activated_at is not null then
    -- Existing active revisions may acquire their first portable projection
    -- after this migration. It is a one-time attachment; every compiled field
    -- and every subsequent portable change remains immutable.
    if new.id is distinct from old.id
      or new.bot_id is distinct from old.bot_id
      or new.revision_number is distinct from old.revision_number
      or new.contract is distinct from old.contract
      or new.compiled_hash is distinct from old.compiled_hash
      or (
        (new.portable_spec is distinct from old.portable_spec
          or new.spec_hash is distinct from old.spec_hash)
        and not (
          old.portable_spec is null
          and old.spec_hash is null
          and new.portable_spec is not null
          and new.spec_hash is not null
        )
      )
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

create or replace function public.devryan_attach_bot_revision_spec(
  p_revision_id uuid,
  p_portable_spec jsonb,
  p_spec_hash text,
  p_compiled_hash text
)
returns public.bot_revisions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_revision public.bot_revisions%rowtype;
begin
  if p_revision_id is null
    or jsonb_typeof(p_portable_spec) <> 'object'
    or p_spec_hash !~ '^[0-9a-f]{64}$'
    or p_compiled_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Bot portable specification input is invalid';
  end if;

  select * into target_revision
  from public.bot_revisions
  where id = p_revision_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Bot revision not found';
  end if;
  if target_revision.compiled_hash <> p_compiled_hash then
    raise exception using errcode = '23514', message = 'Bot compiled hash changed before specification attachment';
  end if;
  if target_revision.portable_spec is not null or target_revision.spec_hash is not null then
    if target_revision.portable_spec = p_portable_spec
      and target_revision.spec_hash = p_spec_hash then
      return target_revision;
    end if;
    raise exception using errcode = '23514', message = 'Bot portable specification is immutable';
  end if;

  update public.bot_revisions
  set portable_spec = p_portable_spec, spec_hash = p_spec_hash
  where id = p_revision_id
  returning * into target_revision;
  return target_revision;
end;
$$;

do $$
declare
  relation_name text;
begin
  foreach relation_name in array array[
    'bot_agent_connections',
    'bot_revision_binding_resolutions',
    'bot_revision_signatures',
    'bot_signer_trust',
    'bot_quota_buckets',
    'bot_quota_reservations'
  ] loop
    execute format('alter table public.%I enable row level security', relation_name);
    execute format('alter table public.%I force row level security', relation_name);
    execute format('revoke all on table public.%I from public, anon, authenticated', relation_name);
    execute format('grant all on table public.%I to service_role', relation_name);
  end loop;
end $$;

revoke all on function public.devryan_reject_bot_immutable_change()
  from public, anon, authenticated;
revoke all on function public.devryan_reserve_bot_action_quotas(uuid, uuid, uuid, jsonb, timestamptz)
  from public, anon, authenticated;
revoke all on function public.devryan_consume_bot_action_quotas(uuid, timestamptz)
  from public, anon, authenticated;
revoke all on function public.devryan_release_bot_action_quotas(uuid, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.devryan_attach_bot_revision_spec(uuid, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.devryan_reserve_bot_action_quotas(uuid, uuid, uuid, jsonb, timestamptz)
  to service_role;
grant execute on function public.devryan_consume_bot_action_quotas(uuid, timestamptz)
  to service_role;
grant execute on function public.devryan_release_bot_action_quotas(uuid, text, timestamptz)
  to service_role;
grant execute on function public.devryan_attach_bot_revision_spec(uuid, jsonb, text, text)
  to service_role;

create or replace function public.devryan_bot_schema_version()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select '20260827100000'::text;
$$;

revoke all on function public.devryan_bot_schema_version()
  from public, anon, authenticated;
grant execute on function public.devryan_bot_schema_version()
  to service_role;

comment on column public.bot_runs.agent_execution is
  'Versioned generic adapter execution handle; legacy OpenCode columns remain during migration.';
comment on column public.bot_revisions.portable_spec is
  'Canonical secret-free Bot-as-code payload used for signing and promotion.';
comment on table public.bot_agent_connections is
  'Bot-scoped public AG-UI endpoint descriptors; bearer values remain in the host credential vault.';
comment on table public.bot_quota_reservations is
  'Atomic fixed-window policy quota reservations bound to durable action attempts.';
