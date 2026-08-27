-- Production Bot assistant turns resolve into either one result message or a
-- durable acknowledgment followed by a separate result message. The pending
-- phase preserves low-latency streaming until the first tool boundary or idle
-- determines which public phase the checkpoint owns.

alter table public.bot_messages
  add column assistant_phase text;

-- Existing finalized assistant rows are protected by the previous migration's
-- immutability trigger. Suspend that trigger only for this deterministic
-- backfill; the migration is transactional and immediately restores it before
-- installing the phase-aware trigger function below.
alter table public.bot_messages
  disable trigger bot_messages_protect_finalized;

update public.bot_messages
set assistant_phase = 'result'
where role = 'assistant';

alter table public.bot_messages
  enable trigger bot_messages_protect_finalized;

alter table public.bot_messages
  add constraint bot_messages_assistant_phase_check check (
    (role = 'assistant' and assistant_phase in ('pending', 'acknowledgment', 'result'))
    or (role <> 'assistant' and assistant_phase is null)
  );

drop index public.bot_messages_one_assistant_per_run_idx;

create unique index bot_messages_one_assistant_phase_per_run_idx
  on public.bot_messages (run_id, assistant_phase)
  where run_id is not null and role = 'assistant';

-- Message identity remains immutable except for the single unresolved phase
-- promotion. A finalized message can never be promoted or otherwise changed.
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
  if new.assistant_phase is distinct from old.assistant_phase
    and not (
      old.role = 'assistant'
      and old.assistant_phase = 'pending'
      and new.assistant_phase in ('acknowledgment', 'result')
      and old.finalized_at is null
    ) then
    raise exception using errcode = '23514', message = 'Bot assistant message phase is immutable';
  end if;
  if old.finalized_at is not null and new is distinct from old then
    raise exception using errcode = '23514', message = 'finalized Bot message is immutable';
  end if;
  return new;
end;
$$;

create or replace function public.devryan_bot_schema_version()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select '20260826130000'::text;
$$;

revoke all on function public.devryan_bot_schema_version()
  from public, anon, authenticated;
grant execute on function public.devryan_bot_schema_version()
  to service_role;

comment on column public.bot_messages.assistant_phase is
  'Unresolved checkpoint, pre-tool acknowledgment, or post-tool/final assistant result.';
