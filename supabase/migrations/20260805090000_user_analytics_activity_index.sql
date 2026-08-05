-- Supports bounded per-user daily analytics queries without introducing a
-- second telemetry store. Occurrence time is written to activity_logs.created_at
-- before the durable outbox acknowledges analytics events.
create index if not exists activity_logs_actor_action_created_idx
  on public.activity_logs (actor_user_id, action, created_at desc, id desc);
