-- Clearing the review list must not delete the retained security ledger.
create table public.bot_audit_cleared_events (
  event_id uuid primary key references public.bot_audit_events(event_id) on delete cascade,
  cleared_by uuid references public.user_profiles(id) on delete set null,
  cleared_at timestamptz not null default now()
);
create index bot_audit_cleared_events_actor_idx
  on public.bot_audit_cleared_events(cleared_by) where cleared_by is not null;
alter table public.bot_audit_cleared_events enable row level security;
alter table public.bot_audit_cleared_events force row level security;
revoke all on public.bot_audit_cleared_events from public, anon, authenticated;
grant select, insert, update, delete on public.bot_audit_cleared_events to service_role;

create view public.bot_audit_review_events with (security_invoker = true) as
select event.id, event.event_id, event.bot_id, event.actor_user_id,
  event.target_type, event.target_id, event.action, event.result,
  event.metadata, event.created_at
from public.bot_audit_events event
where not exists (
  select 1 from public.bot_audit_cleared_events cleared
  where cleared.event_id = event.event_id
);
revoke all on public.bot_audit_review_events from public, anon, authenticated;
grant select on public.bot_audit_review_events to service_role;

create function public.devryan_clear_bot_audit(
  p_actor_id uuid,
  p_since timestamptz,
  p_until timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  cleared_count bigint;
begin
  if p_until is null or not isfinite(p_until)
    or (p_since is not null and (not isfinite(p_since) or p_since > p_until)) then
    raise exception using errcode = '22023', message = 'Invalid Bot audit clear range';
  end if;
  if not exists (
    select 1 from public.user_profiles where id = p_actor_id and role = 'admin' and status = 'active'
  ) then
    raise exception using errcode = '42501', message = 'Administrator access required';
  end if;

  insert into public.bot_audit_cleared_events(event_id, cleared_by)
  select event.event_id, p_actor_id from public.bot_audit_events event
  where event.created_at <= p_until
    and (p_since is null or event.created_at >= p_since)
  on conflict (event_id) do nothing;
  get diagnostics cleared_count = row_count;

  return jsonb_build_object('clearedCount', cleared_count);
end;
$$;
revoke all on function public.devryan_clear_bot_audit(uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.devryan_clear_bot_audit(uuid, timestamptz, timestamptz)
  to service_role;

comment on function public.devryan_clear_bot_audit(uuid, timestamptz, timestamptz) is
  'Clears an administrator Bot Audit review snapshot while retaining immutable events and UUID detail access.';
