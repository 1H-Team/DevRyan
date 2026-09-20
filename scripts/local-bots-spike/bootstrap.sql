-- Disposable PostgreSQL prerequisites, not a production migration or Auth service.
-- All Bot business rules and profile rules are replayed from the original files.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role authenticator login noinherit;
grant service_role to authenticator;
create schema extensions;
create extension pgcrypto with schema extensions;
create extension pgtap with schema extensions;
grant usage on schema public, extensions to service_role;
revoke create on schema public from public;
alter default privileges in schema public revoke execute on functions from public;

-- Identity references only: these records cannot authenticate or issue sessions.
create schema auth;
create table auth.users (id uuid primary key, email text);
revoke all on schema auth from public;

-- The original migration records its encrypted object bucket here. Local bytes
-- are stored by the host; no Storage HTTP service or public policy is exposed.
create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean not null default false);
revoke all on schema storage from public;
