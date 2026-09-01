-- Native Telegram transport. The Data API is service-only; tokens live in a
-- separate encrypted host vault, never in model credentials or this database.
create table public.bot_telegram_connections (
  bot_id uuid primary key references public.bots(id) on delete cascade,
  generation uuid not null default gen_random_uuid(),
  enabled boolean not null default false,
  telegram_bot_id text not null unique check (telegram_bot_id ~ '^[1-9][0-9]{0,15}$'),
  username text not null check (username ~ '^[A-Za-z0-9_]{5,32}$'),
  credential_id uuid null,
  update_offset bigint not null default 0 check (update_offset >= 0),
  state text not null default 'disabled' check (state in ('disabled','connecting','connected','error','conflict')),
  error_code text null check (error_code ~ '^[a-z0-9_]{1,100}$'),
  lease_owner uuid null,
  lease_until timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not enabled or credential_id is not null)
);
create table public.bot_telegram_pairings (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bot_telegram_connections(bot_id) on delete cascade,
  generation uuid not null,
  user_id uuid not null references public.user_profiles(id) on delete cascade,
  channel_id uuid not null references public.bot_channels(id) on delete cascade,
  nonce_hash text null unique check (nonce_hash ~ '^[0-9a-f]{64}$'),
  state text not null default 'pending' check (state in ('pending','claimed','confirmed','revoked')),
  telegram_user_id text null check (telegram_user_id ~ '^[1-9][0-9]{0,15}$'),
  chat_id text null check (chat_id = telegram_user_id),
  display_name text null check (char_length(display_name) <= 100),
  routine_delivery boolean not null default false,
  routine_subscribed_at timestamptz null,
  voice_replies boolean not null default true,
  expires_at timestamptz not null,
  confirmed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (state not in ('claimed','confirmed') or (telegram_user_id is not null and chat_id is not null)),
  check (state <> 'confirmed' or confirmed_at is not null)
);
create index bot_telegram_pairings_bot_idx on public.bot_telegram_pairings(bot_id, generation, state);
create index bot_telegram_pairings_user_idx on public.bot_telegram_pairings(user_id);
create index bot_telegram_pairings_channel_idx on public.bot_telegram_pairings(channel_id);
create unique index bot_telegram_pairings_confirmed_user_idx on public.bot_telegram_pairings(bot_id, generation, user_id) where state = 'confirmed';
create unique index bot_telegram_pairings_confirmed_telegram_idx on public.bot_telegram_pairings(bot_id, generation, telegram_user_id) where state = 'confirmed';
create unique index bot_telegram_pairings_candidate_idx on public.bot_telegram_pairings(bot_id, user_id) where state in ('pending','claimed');

create table public.bot_telegram_inbox (
  id uuid primary key,
  bot_id uuid not null references public.bot_telegram_connections(bot_id) on delete cascade,
  generation uuid not null,
  update_id bigint not null check (update_id >= 0),
  pairing_id uuid null references public.bot_telegram_pairings(id) on delete cascade,
  user_id uuid null references public.user_profiles(id) on delete cascade,
  channel_id uuid null references public.bot_channels(id) on delete cascade,
  message_id uuid not null unique,
  run_id uuid null references public.bot_runs(id) on delete set null,
  state text not null default 'received' check (state in ('received','preparing','transcribing','ready','admitting','admission_uncertain','admitted','quota_rejected','settled','rejected')),
  request_kind text not null default 'message' check (request_kind in ('message','media','voice','command')),
  cancel_requested_at timestamptz null,
  payload_envelope jsonb not null check (jsonb_typeof(payload_envelope) = 'object' and octet_length(payload_envelope::text) <= 262144),
  error_code text null check (error_code ~ '^[a-z0-9_]{1,100}$'),
  attempts integer not null default 0 check (attempts between 0 and 100),
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bot_id, generation, update_id),
  check (state = 'rejected' or (pairing_id is not null and user_id is not null and channel_id is not null))
);
create index bot_telegram_inbox_poll_idx on public.bot_telegram_inbox(bot_id, generation, next_attempt_at, created_at) where state not in ('settled','rejected');
create index bot_telegram_inbox_lane_idx on public.bot_telegram_inbox(bot_id, generation, request_kind, next_attempt_at, update_id) where state not in ('settled','rejected');
create index bot_telegram_inbox_pairing_idx on public.bot_telegram_inbox(pairing_id);
create index bot_telegram_inbox_user_idx on public.bot_telegram_inbox(user_id);
create index bot_telegram_inbox_channel_idx on public.bot_telegram_inbox(channel_id);
create index bot_telegram_inbox_run_idx on public.bot_telegram_inbox(run_id);

-- Preparing a transcript may enlarge an already admitted transport envelope.
-- Enforce byte reservations on growth too. UPDATE already locks its inbox row;
-- NOWAIT avoids inverting ingest/purge's connection -> inbox lock ordering.
create function public.devryan_bot_telegram_inbox_growth_quota()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare retained_bytes bigint; normal_bytes bigint; control_bytes bigint; incoming_bytes bigint;
begin
  incoming_bytes := octet_length(new.payload_envelope::text);
  if incoming_bytes <= octet_length(old.payload_envelope::text) then return new; end if;
  begin
    perform 1 from public.bot_telegram_connections where bot_id = new.bot_id for update nowait;
  exception when lock_not_available then
    raise exception using errcode='55P03', message='telegram_inbox_busy';
  end;
  select coalesce(sum(octet_length(payload_envelope::text)),0),
    coalesce(sum(octet_length(payload_envelope::text)) filter (where state not in ('settled','rejected','quota_rejected') and request_kind <> 'command'),0),
    coalesce(sum(octet_length(payload_envelope::text)) filter (where state not in ('settled','rejected','quota_rejected') and request_kind = 'command'),0)
  into retained_bytes, normal_bytes, control_bytes from public.bot_telegram_inbox where bot_id = new.bot_id and id <> new.id;
  if retained_bytes + incoming_bytes > 134217728 then raise exception 'telegram_inbox_storage_limit'; end if;
  if new.state not in ('settled','rejected','quota_rejected') then
    if new.request_kind = 'command' and control_bytes + incoming_bytes > 4194304 then raise exception 'telegram_control_limit'; end if;
    if new.request_kind <> 'command' and normal_bytes + incoming_bytes > 100663296 then raise exception 'telegram_inbox_limit'; end if;
  end if;
  return new;
end;
$$;
create trigger bot_telegram_inbox_growth_quota before update of payload_envelope on public.bot_telegram_inbox
for each row execute function public.devryan_bot_telegram_inbox_growth_quota();
revoke all on function public.devryan_bot_telegram_inbox_growth_quota() from public, anon, authenticated;
grant execute on function public.devryan_bot_telegram_inbox_growth_quota() to service_role;

create table public.bot_telegram_outbox (
  id uuid primary key,
  bot_id uuid not null references public.bot_telegram_connections(bot_id) on delete cascade,
  generation uuid not null,
  pairing_id uuid not null references public.bot_telegram_pairings(id) on delete cascade,
  user_id uuid not null references public.user_profiles(id) on delete cascade,
  channel_id uuid not null references public.bot_channels(id) on delete cascade,
  source_key text not null check (char_length(source_key) between 1 and 200),
  kind text not null check (kind in ('notice','result','voice')),
  state text not null default 'pending' check (state in ('pending','sending','synthesis_pending','synthesizing','delivered','failed','uncertain','cancelled')),
  payload_envelope jsonb not null check (jsonb_typeof(payload_envelope) = 'object' and octet_length(payload_envelope::text) <= 20971520),
  part_index integer not null default 0 check (part_index between 0 and 1024),
  attempts integer not null default 0 check (attempts between 0 and 10000),
  next_attempt_at timestamptz not null default now(),
  error_code text null check (error_code ~ '^[a-z0-9_]{1,100}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bot_id, generation, pairing_id, source_key)
);
create index bot_telegram_outbox_poll_idx on public.bot_telegram_outbox(bot_id, generation, next_attempt_at, created_at) where state in ('pending','sending','synthesis_pending','synthesizing');
create index bot_telegram_outbox_pairing_idx on public.bot_telegram_outbox(pairing_id);
create index bot_telegram_outbox_user_idx on public.bot_telegram_outbox(user_id);
create index bot_telegram_outbox_channel_idx on public.bot_telegram_outbox(channel_id);

-- Limit retained ciphertext by both entry count and bytes, including large audio.
-- Serialize quota checks with the per-connection row, not a racy count in UI code.
create function public.devryan_bot_telegram_outbox_quota()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare retained_count bigint; retained_bytes bigint;
begin
  if tg_op = 'UPDATE' and octet_length(new.payload_envelope::text) <= octet_length(old.payload_envelope::text) then return new; end if;
  perform 1 from public.bot_telegram_connections where bot_id = new.bot_id for update;
  select count(*), coalesce(sum(octet_length(payload_envelope::text)),0) into retained_count, retained_bytes
    from public.bot_telegram_outbox where bot_id = new.bot_id and id <> new.id;
  if retained_count >= 1000 or retained_bytes + octet_length(new.payload_envelope::text) > 134217728 then
    raise exception 'telegram_outbox_limit';
  end if;
  return new;
end;
$$;
create trigger bot_telegram_outbox_quota before insert or update of payload_envelope on public.bot_telegram_outbox
for each row execute function public.devryan_bot_telegram_outbox_quota();
revoke all on function public.devryan_bot_telegram_outbox_quota() from public, anon, authenticated;
grant execute on function public.devryan_bot_telegram_outbox_quota() to service_role;

do $$
declare tab text;
begin
  foreach tab in array array['bot_telegram_connections','bot_telegram_pairings','bot_telegram_inbox','bot_telegram_outbox'] loop
    execute format('alter table public.%I enable row level security', tab);
    execute format('alter table public.%I force row level security', tab);
    execute format('revoke all on table public.%I from public, anon, authenticated', tab);
    execute format('grant select, insert, update, delete on table public.%I to service_role', tab);
    execute format('create trigger %I before update on public.%I for each row execute function public.devryan_set_updated_at()', tab || '_updated_at', tab);
  end loop;
end;
$$;

create function public.devryan_bot_telegram_lease(p_bot_id uuid, p_generation uuid, p_owner uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update public.bot_telegram_connections set lease_owner = p_owner, lease_until = now() + interval '35 seconds'
  where bot_id = p_bot_id and generation = p_generation and enabled
    and (lease_owner = p_owner or lease_until is null or lease_until < now());
  return found;
end;
$$;

create function public.devryan_bot_telegram_ingest(p_bot_id uuid, p_generation uuid, p_owner uuid, p_items jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare connection public.bot_telegram_connections%rowtype; item jsonb; highest bigint;
  retained_count bigint; retained_bytes bigint; normal_count bigint; normal_bytes bigint;
  control_count bigint; control_bytes bigint; incoming_bytes bigint; item_bytes bigint; terminal record;
begin
  select * into connection from public.bot_telegram_connections where bot_id = p_bot_id for update;
  if not found or not connection.enabled or connection.generation <> p_generation
    or connection.lease_owner is distinct from p_owner or connection.lease_until is null or connection.lease_until < now() then return false; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 25 then raise exception 'telegram_batch_invalid'; end if;
  if octet_length(p_items::text) > 8388608 then raise exception 'telegram_batch_invalid'; end if;
  select count(*), coalesce(sum(octet_length(payload_envelope::text)),0),
    count(*) filter (where state not in ('settled','rejected','quota_rejected') and request_kind <> 'command'),
    coalesce(sum(octet_length(payload_envelope::text)) filter (where state not in ('settled','rejected','quota_rejected') and request_kind <> 'command'),0),
    count(*) filter (where state not in ('settled','rejected','quota_rejected') and request_kind = 'command'),
    coalesce(sum(octet_length(payload_envelope::text)) filter (where state not in ('settled','rejected','quota_rejected') and request_kind = 'command'),0)
  into retained_count, retained_bytes, normal_count, normal_bytes, control_count, control_bytes
  from public.bot_telegram_inbox where bot_id = p_bot_id;
  select coalesce(sum(octet_length((value->'payload_envelope')::text)),0) into incoming_bytes from jsonb_array_elements(p_items);
  -- Retain active work. Terminal outcomes have bounded retention: at most
  -- 5,000 rows / 128 MiB per Bot, so rejected floods cannot fill durable storage.
  for terminal in select id, octet_length(payload_envelope::text) as bytes from public.bot_telegram_inbox
    where bot_id = p_bot_id and state in ('settled','rejected','quota_rejected') order by created_at,id loop
    exit when retained_count + jsonb_array_length(p_items) <= 5000 and retained_bytes + incoming_bytes <= 134217728;
    delete from public.bot_telegram_inbox where id = terminal.id;
    retained_count := retained_count - 1; retained_bytes := retained_bytes - terminal.bytes;
  end loop;
  if retained_count + jsonb_array_length(p_items) > 5000 or retained_bytes + incoming_bytes > 134217728 then raise exception 'telegram_inbox_storage_limit'; end if;
  highest := connection.update_offset;
  for item in select value from jsonb_array_elements(p_items) loop
    highest := greatest(highest, (item->>'update_id')::bigint + 1);
    if (item->>'update_id')::bigint < connection.update_offset then continue; end if;
    if exists (select 1 from public.bot_telegram_inbox where bot_id=p_bot_id and generation=p_generation and update_id=(item->>'update_id')::bigint) then continue; end if;
    if item->>'state' not in ('received','rejected') then raise exception 'telegram_batch_invalid'; end if;
    if item->>'state' <> 'rejected' and not exists (
      select 1 from public.bot_telegram_pairings p
      join public.user_profiles u on u.id = p.user_id and u.status = 'active'
      join public.bot_memberships m on m.bot_id = p.bot_id and m.user_id = p.user_id and m.revoked_at is null and m.activated_at <= now()
      join public.bot_channels c on c.id = p.channel_id and c.owner_user_id = p.user_id and c.bot_id = p.bot_id and c.lifecycle = 'active'
      where p.id = (item->>'pairing_id')::uuid and p.bot_id = p_bot_id and p.generation = p_generation and p.state = 'confirmed'
        and p.user_id = (item->>'user_id')::uuid and p.channel_id = (item->>'channel_id')::uuid
    ) then
      item := item || jsonb_build_object('state','rejected','error_code','telegram_access_revoked','pairing_id',null,'user_id',null,'channel_id',null);
    end if;
    item_bytes := octet_length((item->'payload_envelope')::text);
    if item->>'state' = 'received' then
      -- Control has its own bounded reserve; full ordinary queues cannot block
      -- an authenticated /cancel. Each refused update still commits an outcome.
      if coalesce(item->>'request_kind','message') = 'command' then
        if control_count >= 100 or control_bytes + item_bytes > 4194304 then
          item := item || jsonb_build_object('state','quota_rejected','error_code','telegram_control_limit');
        else control_count := control_count + 1; control_bytes := control_bytes + item_bytes; end if;
      else
        if normal_count >= 1000 or normal_bytes + item_bytes > 100663296 then
          item := item || jsonb_build_object('state','quota_rejected','error_code','telegram_inbox_limit');
        else normal_count := normal_count + 1; normal_bytes := normal_bytes + item_bytes; end if;
      end if;
      if item->>'state' = 'quota_rejected' then
        -- This separate envelope contains only the update identity, not the
        -- rejected prompt or media. Empty metadata is safe for older callers.
        item := item || jsonb_build_object('payload_envelope',case when jsonb_typeof(item->'rejection_envelope')='object' and octet_length((item->'rejection_envelope')::text)<=1024 then item->'rejection_envelope' else '{}'::jsonb end);
      end if;
    end if;
    insert into public.bot_telegram_inbox(id, bot_id, generation, update_id, pairing_id, user_id, channel_id, message_id, state, request_kind, payload_envelope, error_code)
    values ((item->>'id')::uuid, p_bot_id, p_generation, (item->>'update_id')::bigint,
      (item->>'pairing_id')::uuid, (item->>'user_id')::uuid, (item->>'channel_id')::uuid,
      (item->>'message_id')::uuid, item->>'state', coalesce(item->>'request_kind','message'), item->'payload_envelope', item->>'error_code')
    on conflict (bot_id, generation, update_id) do nothing;
  end loop;
  update public.bot_telegram_connections set update_offset = highest where bot_id = p_bot_id;
  return true;
end;
$$;

create function public.devryan_bot_telegram_confirm(p_bot_id uuid, p_generation uuid, p_pairing_id uuid, p_user_id uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare candidate public.bot_telegram_pairings%rowtype;
begin
  -- Serialize replacement with configuration and other claims for this Bot.
  perform 1 from public.bot_telegram_connections where bot_id = p_bot_id and generation = p_generation and enabled for update;
  if not found then return false; end if;
  select * into candidate from public.bot_telegram_pairings
    where id = p_pairing_id and bot_id = p_bot_id and generation = p_generation and user_id = p_user_id
      and state = 'claimed' and expires_at > now() for update;
  if not found then return false; end if;
  if not exists (select 1 from public.user_profiles u
    join public.bot_memberships m on m.user_id = u.id and m.bot_id = p_bot_id and m.revoked_at is null and m.activated_at <= now()
    join public.bot_channels c on c.id = candidate.channel_id and c.owner_user_id = p_user_id and c.bot_id = p_bot_id and c.lifecycle = 'active'
    where u.id = p_user_id and u.status = 'active') then return false; end if;
  if exists (select 1 from public.bot_telegram_pairings where bot_id = p_bot_id and generation = p_generation
    and telegram_user_id = candidate.telegram_user_id and user_id <> p_user_id and state = 'confirmed') then return false; end if;
  update public.bot_telegram_pairings set state = 'revoked', nonce_hash = null
    where bot_id = p_bot_id and user_id = p_user_id and state = 'confirmed';
  update public.bot_telegram_pairings set state = 'confirmed', nonce_hash = null, confirmed_at = now() where id = candidate.id;
  return true;
end;
$$;

create function public.devryan_bot_telegram_prune()
returns void language plpgsql security invoker set search_path = '' as $$
begin
  update public.bot_telegram_pairings set state = 'revoked', nonce_hash = null
    where state in ('pending','claimed') and expires_at < now();
  -- Changed generations must not retain deliverable or executable work forever.
  update public.bot_telegram_outbox o set state = 'cancelled', error_code = 'telegram_connection_changed'
    from public.bot_telegram_connections c where o.bot_id = c.bot_id and o.generation <> c.generation and o.state not in ('delivered','cancelled');
  update public.bot_telegram_inbox i set state = 'rejected', error_code = 'telegram_connection_changed'
    from public.bot_telegram_connections c where i.bot_id = c.bot_id and i.generation <> c.generation and i.state not in ('settled','rejected');
  delete from public.bot_telegram_outbox where created_at < now() - interval '7 days' and state in ('delivered','cancelled');
  delete from public.bot_telegram_inbox where created_at < now() - interval '7 days' and state in ('settled','rejected','quota_rejected');
  delete from public.bot_telegram_outbox where created_at < now() - interval '30 days' and state in ('failed','uncertain');
  delete from public.bot_telegram_pairings where state = 'revoked' and updated_at < now() - interval '30 days';
end;
$$;

create function public.devryan_bot_telegram_routine_results(p_bot_id uuid, p_generation uuid)
returns table(id uuid, bot_id uuid, channel_id uuid, state text, created_at timestamptz, context_snapshot jsonb)
language sql stable security invoker set search_path = '' as $$
  select r.id, r.bot_id, r.channel_id, r.state, r.created_at, r.context_snapshot
  from public.bot_runs r
  join public.bot_telegram_connections c on c.bot_id = r.bot_id and c.enabled and c.generation = p_generation
  join public.bot_telegram_pairings p on p.bot_id = c.bot_id and p.generation = c.generation
    and p.channel_id = r.channel_id and p.state = 'confirmed' and p.routine_delivery
  join public.user_profiles u on u.id = p.user_id and u.status = 'active'
  join public.bot_memberships m on m.bot_id = p.bot_id and m.user_id = p.user_id
    and m.revoked_at is null and m.activated_at <= now()
  where r.bot_id = p_bot_id and r.state in ('completed','failed','cancelled','interrupted')
    and jsonb_typeof(r.context_snapshot->'routine') = 'object' and r.created_at >= coalesce(p.routine_subscribed_at,p.confirmed_at)
    and r.created_at >= now() - interval '7 days'
    and not exists (select 1 from public.bot_telegram_outbox o
      where o.bot_id = r.bot_id and o.generation = c.generation and o.pairing_id = p.id and o.source_key = 'run:' || r.id::text)
  order by r.created_at, r.id limit 25;
$$;

revoke all on function public.devryan_bot_telegram_lease(uuid,uuid,uuid), public.devryan_bot_telegram_ingest(uuid,uuid,uuid,jsonb), public.devryan_bot_telegram_confirm(uuid,uuid,uuid,uuid), public.devryan_bot_telegram_prune() from public, anon, authenticated;
grant execute on function public.devryan_bot_telegram_lease(uuid,uuid,uuid), public.devryan_bot_telegram_ingest(uuid,uuid,uuid,jsonb), public.devryan_bot_telegram_confirm(uuid,uuid,uuid,uuid), public.devryan_bot_telegram_prune() to service_role;
revoke all on function public.devryan_bot_telegram_routine_results(uuid,uuid) from public, anon, authenticated;
grant execute on function public.devryan_bot_telegram_routine_results(uuid,uuid) to service_role;

comment on table public.bot_telegram_connections is 'Service-only native Telegram configuration; credentials remain in a separate host vault.';
comment on table public.bot_telegram_inbox is 'Encrypted Telegram updates durably committed before acknowledging their offset. Stable message IDs prevent duplicate Bot admission.';
comment on column public.bot_telegram_inbox.request_kind is 'Server-classified bounded scheduling lane; no message or media payload is exposed in work scans.';
comment on column public.bot_telegram_inbox.cancel_requested_at is 'Durable cancellation intent follows this exact update and canonical run across admission races and restarts.';
comment on table public.bot_telegram_outbox is 'Encrypted delivery queue. Sending after a crash is uncertain and is never automatically replayed.';
