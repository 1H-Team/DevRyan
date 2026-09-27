-- Local Bot database prerequisites, applied once to each new Bot database
-- (live, candidate, or import source) before the reviewed migration inventory.
-- Every Bot and profile business rule comes from the unchanged migrations.
create schema extensions;
create extension pgcrypto with schema extensions;
grant usage on schema public, extensions to service_role;
revoke create on schema public from public;
alter default privileges in schema public revoke execute on functions from public;

-- Identity references only. These rows cannot authenticate, issue sessions or
-- grant authority: authorization is decided by the host for every request.
create schema auth;
create table auth.users (
  id uuid primary key,
  email text
);
revoke all on schema auth from public;

-- The Bot migration records its encrypted object bucket here. Ciphertext is
-- stored by the host; no Storage HTTP service or policy exists.
create schema storage;
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false
);
revoke all on schema storage from public;

-- Host-owned bookkeeping. Not exposed through PostgREST (only `public` is
-- served) and not readable by service_role.
create schema devryan_local;
revoke all on schema devryan_local from public;

create table devryan_local.installation (
  singleton boolean primary key default true check (singleton),
  database_id uuid not null,
  inventory_format integer not null check (inventory_format = 1),
  created_at timestamptz not null default now()
);

create table devryan_local.schema_migrations (
  ordinal integer primary key check (ordinal >= 0),
  name text not null unique check (name ~ '^[a-z]+:[0-9A-Za-z_.-]+$'),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('supporting', 'bot', 'local')),
  applied_at timestamptz not null default now()
);
