-- Per-user feature overrides for policy sections that need more than
-- read/edit page permissions:
--   { "agents": { "hidePermissionsUi": true }, "mcp": { "<serverName>": "on" | "off" } }
-- Absent keys inherit the role default (no restriction).
alter table public.user_policies
  add column if not exists feature_overrides jsonb not null default '{}'::jsonb;
